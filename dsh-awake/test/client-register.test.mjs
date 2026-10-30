import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { API as HOST_API } from '../lib/host/protocol.js'

/**
 * 用假 `window.__ModuleLoader__` + 假 react 装载浏览器半边。
 * ESM 只会执行一次模块体，所以工厂结果缓存在模块级。
 * @returns {Promise<any>} 客户端模块导出。
 */
let clientModule
async function loadClient() {
  if (clientModule !== undefined) return clientModule
  const captured = {}
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        captured.spec = spec
      },
    },
  }
  await import('../lib/client.js')
  assert.equal(captured.spec?.id, 'dsh-plugin-awake')
  const fakeReact = {
    createElement: (type, props, children) => ({ type, props, children }),
    useEffect: () => {},
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
  clientModule = captured.spec.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`unexpected require: ${name}`)
  })
  return clientModule
}

/**
 * 假服务的 JSON 响应。
 * @param {any} payload 体。
 * @param {number} [status] 状态码。
 * @returns {any} 假 Response。
 */
function json(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

test('浏览器半边只注册一个座位：发送栏按钮', async () => {
  const exported = await loadClient()
  assert.equal(typeof exported.apply, 'function')
  assert.deepEqual(exported.inject, ['slots'])

  const registrations = []
  const dictionaries = []
  const injectedSlots = []
  const fakeCtx = {
    get: (name) => (name === 'locale'
      ? { register: (ns, dict) => dictionaries.push({ ns, dict }), bind: () => (key) => key }
      : undefined),
    effect: (fn) => fn(),
    inject: (_deps, callback) => callback({
      slots: {
        inject: (slot, mount) => {
          injectedSlots.push(slot)
          mount()
        },
        register: (options, component) => {
          registrations.push({ options, component })
          return () => {}
        },
      },
    }),
  }
  exported.apply(fakeCtx)

  assert.deepEqual(injectedSlots, ['conversation.input.right'], '不再注册 shell.bottom 状态条')
  assert.deepEqual(
    registrations.map((entry) => entry.options.name),
    ['conversation.input.right'],
  )
  for (const entry of registrations) {
    assert.equal(entry.options.id, 'dsh-awake')
    assert.equal(entry.options.order, 40)
    assert.equal(entry.options.locale, 'dsh-awake')
    assert.equal(typeof entry.component, 'function')
  }
  assert.deepEqual(registrations[0].options.inject(), {}, 'session 作用域按钮要带 inject 钩子')

  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].ns, 'dsh-awake')
  assert.deepEqual(Object.keys(dictionaries[0].dict.zh).sort(), Object.keys(dictionaries[0].dict.en).sort())
  assert.deepEqual(Object.keys(dictionaries[0].dict.zh).sort(), ['button.off', 'button.on'], '状态条词条已删除')
})

test('客户端路由常量与宿主协议一致（两份真相靠这条测试绑住）', async () => {
  const exported = await loadClient()
  assert.deepEqual(exported.API, HOST_API)
})

test('渲染：按钮带 aria-pressed / 标题，图标是纯描边、无蒸汽', async () => {
  const exported = await loadClient()
  const registrations = []
  const fakeCtx = {
    get: (name) => (name === 'locale' ? { register: () => {}, bind: () => (key) => key } : undefined),
    effect: (fn) => fn(),
    inject: (_deps, callback) => callback({
      slots: {
        inject: (_slot, mount) => mount(),
        register: (options, component) => {
          registrations.push({ options, component })
          return () => {}
        },
      },
    }),
  }
  exported.apply(fakeCtx)

  const [buttonSeat] = registrations
  // 注册的是 withT 包了一层的外壳，先剥掉再渲染（外壳只做 t 注入）。
  const bound = buttonSeat.component({})
  const button = bound.type(bound.props)
  assert.equal(button.type, 'button')
  assert.equal(button.props['aria-pressed'], 'false')
  assert.equal(button.props['aria-label'], 'button.off')
  assert.equal(button.props.className, 'dsh-awake-btn')
  assert.equal(typeof button.props.onClick, 'function')

  // 图标：24 栅格 / 渲染 14px / 1.5 圆头圆角、纯描边，只有杯身 + 把手。
  const iconElement = button.children
  const svg = iconElement.type(iconElement.props)
  assert.equal(svg.type, 'svg')
  assert.equal(svg.props.viewBox, '0 0 24 24')
  assert.equal(svg.props.width, 14)
  assert.equal(svg.props.height, 14)
  assert.equal(svg.props.fill, 'none')
  assert.equal(svg.props.stroke, 'currentColor')
  assert.equal(svg.props.strokeWidth, 1.5)
  assert.equal(svg.props.strokeLinecap, 'round')
  assert.equal(svg.props.strokeLinejoin, 'round')
  assert.deepEqual(svg.children.map((child) => child.props.key), ['cup', 'handle'], '不画蒸汽，也不填充杯身')
  for (const path of svg.children) assert.equal(path.props.fill, undefined, '颜色只走 currentColor')
})

test('store：挂载读一次 status，开关走 POST 且带 x-dsh-plugin: awake', async () => {
  const exported = await loadClient()
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers })
    if (url.endsWith('/status')) return json({ ok: true, active: false, pid: null, startedAt: null })
    if (url.endsWith('/start')) return json({ ok: true, active: true, pid: 777, startedAt: 1700000000000 })
    return json({ ok: true, active: false, pid: null, startedAt: null })
  }
  try {
    const store = exported.createStore()
    const seen = []
    const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot()))

    await store.refresh()
    assert.deepEqual(store.getSnapshot(), { active: false, pid: null, startedAt: null, ready: true, busy: false, error: null })

    // 并发刷新合并成一次 GET。
    calls.length = 0
    await Promise.all([store.refresh(), store.refresh()])
    assert.equal(calls.filter((entry) => entry.method === 'GET').length, 1)

    await store.toggle()
    assert.deepEqual(store.getSnapshot(), { active: true, pid: 777, startedAt: 1700000000000, ready: true, busy: false, error: null })

    assert.equal(calls.at(-1).method, 'POST')
    assert.equal(calls.at(-1).url, '/plugins/awake/start')
    assert.deepEqual(calls.at(-1).headers, { 'x-dsh-plugin': 'awake' })

    await store.toggle()
    assert.equal(calls.at(-1).url, '/plugins/awake/stop')
    assert.equal(store.getSnapshot().active, false)

    assert.ok(seen.length >= 3)
    unsubscribe()
  } finally {
    globalThis.fetch = original
  }
})

test('store：403 时保持原状态并记下错误，不乐观更新', async () => {
  const exported = await loadClient()
  const original = globalThis.fetch
  globalThis.fetch = async () => json({ ok: false, code: 'E_FORBIDDEN', error: 'forbidden' }, 403)
  try {
    const store = exported.createStore()
    await store.toggle()
    const state = store.getSnapshot()
    assert.equal(state.active, false)
    assert.equal(state.busy, false)
    assert.match(state.error, /forbidden/)
  } finally {
    globalThis.fetch = original
  }
})

test('客户端不轮询、不订阅 SSE、不再有底部状态条（单按钮 + 两色）', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /setInterval/)
  assert.doesNotMatch(source, /EventSource/)
  assert.match(source, /x-dsh-plugin/)
  assert.match(source, /conversation\.input\.right/)
  assert.doesNotMatch(source, /shell\.bottom/, '不再注册 shell.bottom')
  assert.doesNotMatch(source, /dsh-awake-bar/, '状态条样式已删除')
  assert.doesNotMatch(source, /bar\.(label|stop)/, '状态条词条已删除')
  // 开 / 关只靠颜色：关 = label-primary（与相邻 ✨ 同色），开 = 强调蓝；底色走 5% / hover 9%。
  assert.match(source, /--dsw-alias-label-primary/)
  assert.doesNotMatch(source, /--dsw-alias-label-secondary/, '不再用次级灰')
  assert.match(source, /\.dsh-awake-btn\[aria-pressed="true"\]\{color:var\(--dsw-alias-state-business-primary/)
  assert.match(source, /color-mix\(in srgb, var\(--dsw-alias-label-primary[^)]*\) 5%/)
  assert.match(source, /color-mix\(in srgb, var\(--dsw-alias-label-primary[^)]*\) 9%/)
})

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

test('浏览器半边注册两个座位：发送栏按钮 + 底部状态条', async () => {
  const exported = await loadClient()
  assert.equal(typeof exported.apply, 'function')
  assert.deepEqual(exported.inject, ['slots'])

  const registrations = []
  const dictionaries = []
  const fakeCtx = {
    get: (name) => (name === 'locale'
      ? { register: (ns, dict) => dictionaries.push({ ns, dict }), bind: () => (key) => key }
      : undefined),
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

  assert.deepEqual(
    registrations.map((entry) => entry.options.name),
    ['conversation.input.right', 'shell.bottom'],
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
  assert.match(dictionaries[0].dict.zh['bar.label'], /保持唤醒/)
  assert.match(dictionaries[0].dict.zh['bar.stop'], /关闭/)
})

test('客户端路由常量与宿主协议一致（两份真相靠这条测试绑住）', async () => {
  const exported = await loadClient()
  assert.deepEqual(exported.API, HOST_API)
})

test('渲染：按钮带 aria-pressed / 标题，状态条 inactive 时返回 null（不占位）', async () => {
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

  const [buttonSeat, barSeat] = registrations
  // 注册的是 withT 包了一层的外壳，先剥掉再渲染（外壳只做 t 注入）。
  const bound = buttonSeat.component({})
  const button = bound.type(bound.props)
  assert.equal(button.type, 'button')
  assert.equal(button.props['aria-pressed'], 'false')
  assert.equal(button.props['aria-label'], 'button.off')
  assert.equal(button.props.className, 'dsh-awake-btn')
  assert.equal(typeof button.props.onClick, 'function')

  // inactive 时状态条必须渲染成 null：shell.bottom 空内容不预留空间。
  const barBound = barSeat.component({})
  assert.equal(barBound.type(barBound.props), null)
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

    // 并发挂载（按钮 + 状态条同时挂）只发一次 GET。
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

test('客户端不轮询、不订阅 SSE（状态只靠挂载读 + 动作返回值）', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /setInterval/)
  assert.doesNotMatch(source, /EventSource/)
  assert.match(source, /x-dsh-plugin/)
  assert.match(source, /shell\.bottom/)
  assert.match(source, /conversation\.input\.right/)
})

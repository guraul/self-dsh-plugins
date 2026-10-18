import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { API } from '../lib/host/protocol.js'
import { compareVersions } from '../lib/host/semver.js'

/**
 * 迷你 react：够把浏览器半边**真渲染成文本**（只实现这两个组件用到的 hook）。
 * 不追求 React 语义完整，只求「挂载 → 跑完异步 effect → 再渲染」这条链是真的。
 * @returns {object} react 替身 + `mount`。
 */
function makeReact() {
  const slots = { state: [], ref: [], cb: [], effect: [] }
  let idx = { state: 0, ref: 0, cb: 0, effect: 0 }
  let comp = null
  let props = {}
  let pending = false
  let tree = null

  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const render = () => {
    idx = { state: 0, ref: 0, cb: 0, effect: 0 }
    tree = comp(props)
  }

  return {
    createElement(type, elementProps, ...children) {
      const flat = []
      const push = (child) => {
        if (Array.isArray(child)) {
          child.forEach(push)
          return
        }
        if (child === null || child === undefined || child === false || child === true) return
        flat.push(child)
      }
      children.forEach(push)
      return { type, props: elementProps ?? {}, children: flat }
    },
    useState(initial) {
      const i = idx.state++
      if (i >= slots.state.length) slots.state[i] = typeof initial === 'function' ? initial() : initial
      const set = (updater) => {
        const next = typeof updater === 'function' ? updater(slots.state[i]) : updater
        if (!Object.is(next, slots.state[i])) {
          slots.state[i] = next
          pending = true
        }
      }
      return [slots.state[i], set]
    },
    useRef(initial) {
      const i = idx.ref++
      if (i >= slots.ref.length) slots.ref[i] = { current: initial }
      return slots.ref[i]
    },
    useCallback(fn, deps) {
      const i = idx.cb++
      const prev = slots.cb[i]
      if (prev === undefined || !sameDeps(prev.deps, deps)) {
        slots.cb[i] = { fn, deps }
        return fn
      }
      return prev.fn
    },
    useEffect(fn, deps) {
      const i = idx.effect++
      const prev = slots.effect[i]
      if (prev === undefined || !sameDeps(prev.deps, deps)) {
        slots.effect[i] = { deps }
        fn()
      }
    },
    /** 挂载组件、把异步 effect 跑完，返回渲染出的元素树。 */
    async mount(component, componentProps = {}) {
      slots.state = []
      slots.ref = []
      slots.cb = []
      slots.effect = []
      comp = component
      props = componentProps
      pending = false
      render()
      for (let i = 0; i < 30; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (pending) {
          pending = false
          render()
        }
      }
      return tree
    },
  }
}

/**
 * 把元素树里所有文本收集成一段（够做包含/正则断言）。
 * @param {any} node 元素 / 数组 / 文本。
 * @returns {string} 拼接后的文本。
 */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'object') return textOf(node.children)
  return ''
}

/**
 * 把元素树里所有满足条件的节点收集起来（够做「有哪些按钮」这类结构断言）。
 * @param {any} node 元素 / 数组。
 * @param {(node:any)=>boolean} predicate 命中条件。
 * @param {any[]} [out] 累积数组。
 * @returns {any[]} 命中的节点。
 */
function collect(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, predicate, out))
    return out
  }
  if (predicate(node)) out.push(node)
  collect(node.children, predicate, out)
  return out
}

/**
 * 装一个假 fetch；路由表按 URL 命中，未命中的一律 `ok:false`（方便暴露漏打的请求）。
 * @param {Record<string, object>} routes URL → JSON。
 * @returns {void}
 */
function stubFetch(routes) {
  globalThis.fetch = async (url) => ({
    status: 200,
    json: async () => (Object.hasOwn(routes, url) ? routes[url] : { ok: false, error: `unexpected request: ${url}` }),
  })
}

const react = makeReact()
const captured = {}
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured.spec = spec
    },
  },
}
await import('../lib/client.js')
assert.equal(captured.spec?.id, 'dsh-plugin-auto-upgrade')
const exported = captured.spec.factory((name) => {
  if (name === 'react') return react
  throw new Error(`unexpected require: ${name}`)
})

// 用「没有 locale 服务」的 ctx 挂载：两个组件都会退回中文字典，正好拿来断言文案。
const registrations = []
exported.apply({
  get: () => undefined,
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
})
const bySlot = (name) => registrations.find((entry) => entry.options.name === name).component
const Settings = bySlot('settings.section')
const Overlay = bySlot('shell.overlay')

const pluginRoutes = {
  [API.plugins]: { ok: true, plugins: [] },
  [API.restartDiagnostics]: { ok: true, log: [], result: null, payload: null },
}

/**
 * 造一份 `/status` 快照。
 * @param {object} lastCheck 上次检测结论。
 * @param {{dismissed?:boolean, overlay?:boolean}} [settings] 浮层设置。
 * @returns {object} 快照。
 */
function statusWith(lastCheck, settings = { dismissed: false, overlay: true }) {
  return {
    ok: true,
    dsh: { installed: '0.2.0-rc.2' },
    policy: { channel: 'latest', exactVersion: '', dailyCheck: true },
    settings,
    capabilities: {},
    pendingRestart: null,
    lastCheck,
  }
}

const TAGS = { latest: '0.2.0-rc.2', alpha: '0.2.1-alpha.5', next: '0.2.1-rc.2' }

test('设置页：有更新时渲染升级入口，无更新时不渲染（且不受「不再提示」影响）', async () => {
  stubFetch({
    ...pluginRoutes,
    [API.status]: statusWith(
      { date: '2026-10-18', decision: 'update-available', installed: '0.2.0-rc.2', target: '0.2.1-rc.2', channel: 'next', tags: TAGS, incompatible: [] },
      // 浮层被「不再提示」关掉，且浮层开关也关了——设置页的入口仍须在。
      { dismissed: true, overlay: false },
    ),
  })
  const withUpdate = textOf(await react.mount(Settings, {}))
  assert.match(withUpdate, /发现新版本 0\.2\.1-rc\.2（当前 0\.2\.0-rc\.2）/, '有更新时必须出现升级入口')
  assert.match(withUpdate, /升级/, '入口必须带「升级」按钮')
  assert.match(withUpdate, /浮层已被「不再提示」关闭/, '同一份快照确实处在 dismissed 状态')

  stubFetch({
    ...pluginRoutes,
    [API.status]: statusWith({ date: '2026-10-18', decision: 'up-to-date', installed: '0.2.1-rc.2', target: '0.2.1-rc.2', channel: 'next', tags: TAGS, incompatible: [] }),
  })
  const upToDate = textOf(await react.mount(Settings, {}))
  assert.doesNotMatch(upToDate, /发现新版本/, '无更新时不该出现升级入口')
})

test('设置页：降级护栏给出出路并点名建议渠道', async () => {
  stubFetch({
    ...pluginRoutes,
    [API.status]: statusWith(
      { date: '2026-10-18', decision: 'downgrade-guard', installed: '0.2.1-alpha.5', target: '0.2.0-rc.2', channel: 'latest', tags: TAGS, incompatible: [] },
      { dismissed: true, overlay: false },
    ),
  })
  const text = textOf(await react.mount(Settings, {}))
  assert.match(text, /本机版本高于发布源（0\.2\.1-alpha\.5 > 0\.2\.0-rc\.2）/, '要说清现象')
  assert.match(text, /当前渠道 latest 最新 0\.2\.0-rc\.2，本机 0\.2\.1-alpha\.5/, '要点出本机版本与当前渠道最新版')
  assert.match(text, /把发布渠道改成 next 就能继续升级/, '要给出路并点名建议渠道')
  assert.match(text, /切到 next/, '要有一个切换渠道的按钮')
})

test('浮层：降级护栏给出出路并点名建议渠道', async () => {
  stubFetch({
    ...pluginRoutes,
    [API.status]: statusWith({ date: '2026-10-18', decision: 'downgrade-guard', installed: '0.2.1-alpha.5', target: '0.2.0-rc.2', channel: 'latest', tags: TAGS, incompatible: [] }),
  })
  const text = textOf(await react.mount(Overlay, {}))
  assert.match(text, /本机版本高于发布源（0\.2\.1-alpha\.5 > 0\.2\.0-rc\.2）/)
  assert.match(text, /把发布渠道改成 next 就能继续升级/)
  assert.match(text, /切到 next/)
})

test('浮层：去掉「稍后」与「重新检查」，只剩升级 / 不再提示 + 右上角 ×', async () => {
  stubFetch({
    ...pluginRoutes,
    [API.status]: statusWith({ date: '2026-10-18', decision: 'update-available', installed: '0.2.0-rc.2', target: '0.2.1-rc.2', channel: 'next', tags: TAGS, incompatible: [] }),
  })
  const tree = await react.mount(Overlay, {})
  const text = textOf(tree)
  assert.doesNotMatch(text, /重新检查/, '浮层不再提供「重新检查」：手动重检的正式入口是设置页的「立即检查」')
  assert.doesNotMatch(text, /稍后/, '浮层不再提供「稍后」：右上角 × 就是「本次隐藏」')

  // 结构断言：动作区**恰好**只剩「升级」与「不再提示」两个按钮（多一个都会立刻打脸）。
  const row = collect(tree, (node) => node.props?.className === 'dsh-au-row')
  assert.equal(row.length, 1, '浮层动作区应当只有一个')
  const actionTexts = collect(row[0], (node) => node.type === 'button').map(textOf)
  assert.deepEqual(actionTexts, ['升级', '不再提示'], '动作区只能是升级 + 不再提示')
  // × 仍在（它没有文字子节点，只能按类名找），且「本次隐藏」与「不再提示」都还接在原动作上。
  const close = collect(tree, (node) => node.props?.className === 'dsh-au-close')
  assert.equal(close.length, 1, '右上角 × 必须还在')
  assert.equal(close[0].props['aria-label'], '关闭')
})

test('浮层：错误态也不再有「重新检查」按钮（所有状态一致）', async () => {
  stubFetch({
    ...pluginRoutes,
    [API.status]: statusWith({ date: '2026-10-18', decision: 'unknown', installed: '0.2.1-rc.2', target: null, channel: 'latest', tags: TAGS, registryError: 'ETIMEDOUT', incompatible: [] }),
  })
  const tree = await react.mount(Overlay, {})
  const text = textOf(tree)
  assert.match(text, /无法确认是否有更新（ETIMEDOUT）/, '这确实是错误态')
  assert.doesNotMatch(text, /重新检查/)
  assert.doesNotMatch(text, /稍后/)
  // 错误态的动作区同样只剩「不再提示」——多一个「重新检查」都会立刻打脸。
  const row = collect(tree, (node) => node.props?.className === 'dsh-au-row')
  assert.equal(row.length, 1, '浮层动作区应当只有一个')
  assert.deepEqual(collect(row[0], (node) => node.type === 'button').map(textOf), ['不再提示'])
})

test('suggestChannel：挑 tags 里版本号最高的渠道；全相等 / 缺失 / 不可比一律 undefined', () => {
  assert.equal(exported.suggestChannel(TAGS), 'next')
  assert.equal(exported.suggestChannel({ latest: '0.2.0-rc.2', next: '0.2.1-rc.2', alpha: '0.2.1-alpha.5' }), 'next')
  assert.equal(exported.suggestChannel({ latest: '0.2.0-rc.2', next: '0.2.1-rc.2' }), 'next')
  assert.equal(exported.suggestChannel({ a: '1.0.0', b: '1.0.0', c: '1.0.0' }), undefined, '全相等时没有「更好的渠道」')
  assert.equal(exported.suggestChannel({ only: '1.0.0' }), undefined)
  assert.equal(exported.suggestChannel({}), undefined)
  assert.equal(exported.suggestChannel(null), undefined)
  assert.equal(exported.suggestChannel(undefined), undefined)
  assert.equal(exported.suggestChannel('latest'), undefined)
  assert.equal(exported.suggestChannel({ a: 'not-a-version', b: '1.0.0' }), undefined, '不可比的条目不算数')
})

test('suggestChannel 与宿主 compareVersions 语义一致（防止浏览器半边自己那份比较器漂移）', () => {
  const pairs = [
    ['0.2.1-rc.2', '0.2.1-alpha.5'],
    ['0.2.1-alpha.5', '0.2.1-rc.2'],
    ['1.0.0', '1.0.0'],
    ['0.2.0-rc.2', '0.2.0'],
    ['0.2.1', '0.2.0-rc.2'],
    ['v0.2.0-rc.2', '0.2.0-rc.2'],
    ['1.0.0+build.7', '1.0.0'],
    ['0.0.1', '0.1.0'],
    ['1.0.0-alpha.2', '1.0.0-alpha.10'],
  ]
  for (const [left, right] of pairs) {
    const delta = compareVersions(left, right)
    const expected = delta > 0 ? 'left' : (delta < 0 ? 'right' : undefined)
    assert.equal(exported.suggestChannel({ left, right }), expected, `${left} vs ${right} 的判定应与宿主一致`)
  }
})

test('浮层与设置页共用同一份计划卡 / 降级出路渲染（不许各写一份好漂移）', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const countOf = (needle) => source.split(needle).length - 1
  // 各一份定义 + 浮层/设置页各一次调用 = 3；定义多于一份或某边自己抄一份都会立刻打脸。
  assert.equal(countOf('function renderPlanPanel('), 1, '计划卡只能有一份定义')
  assert.equal(countOf('renderPlanPanel('), 3, '计划卡必须由浮层与设置页共用（一份定义 + 两次调用）')
  assert.equal(countOf('function renderDowngradeExit('), 1, '降级出路只能有一份定义')
  assert.equal(countOf('renderDowngradeExit('), 3, '降级出路必须由浮层与设置页共用（一份定义 + 两次调用）')
  assert.equal(countOf('createUpgradeFlow('), 3, '升级流程必须由浮层与设置页共用（一份定义 + 两次调用）')
  assert.equal(countOf('plan.notes.available === true'), 1, '更新说明的渲染只留一份')
  assert.equal(countOf('E_SESSIONS_RUNNING'), 1, '会话门禁分支只留一份')
  assert.equal(countOf('E_PLUGIN_INCOMPATIBLE'), 1, '插件不兼容门禁分支只留一份')
})

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
    /** 跑完挂载后由事件处理函数触发的 setState，把最新元素树交回来。 */
    async flush() {
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
 * 装一个假 fetch；路由表按 URL 命中（先在完整 URL 上找，找不到再按去掉查询串的路径找），
 * 未命中的一律 `ok:false`（方便暴露漏打的请求）。`calls` 记录每次请求，供断言「按哪个版本取数」。
 * @param {Record<string, object>} routes URL 或路径 → JSON。
 * @returns {{calls:{url:string, method:string, body:string|undefined}[]}} 调用记录。
 */
function stubFetch(routes) {
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const exact = String(url)
    const path = exact.split('?')[0]
    const key = Object.hasOwn(routes, exact) ? exact : path
    calls.push({ url: exact, method: options.method ?? 'GET', body: options.body })
    // 路由值可以是响应体，也可以是一个返回 Promise<响应> 的函数（用来把请求挂住、观察中间态）。
    const value = Object.hasOwn(routes, key) ? routes[key] : { ok: false, error: `unexpected request: ${exact}` }
    if (typeof value === 'function') return value()
    return {
      status: 200,
      json: async () => value,
    }
  }
  return { calls }
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
/**
 * 真实世界的阻塞形态：一个插件把 12 个 `@deepseek-ai/*` 钉成精确版本。
 * 这里取 5 条（>3，正好验证「最多 3 条 + 等 N 项」的折叠）。
 */
const BRIDGE = {
  name: '@mhfire/dsh-im-bridge',
  version: '0.4.4-ws.1',
  compatible: false,
  exempted: false,
  known: true,
  peers: {
    '@deepseek-ai/dsh-agent': '0.2.1-rc.2',
    '@deepseek-ai/dsh-tools': '0.2.1-rc.2',
    '@deepseek-ai/dsh-cli': '0.2.1-rc.2',
    '@deepseek-ai/dsh-app-boot': '0.2.1-rc.2',
    '@deepseek-ai/dsh-web': '0.2.1-rc.2',
  },
}

const TODAY = new Date().toISOString().slice(0, 10)

const RISK_CHECK = {
  date: '2026-10-29',
  decision: 'update-with-plugin-risk',
  installed: '0.2.1-rc.2',
  target: '0.2.1-rc.4',
  channel: 'next',
  tags: TAGS,
  incompatible: [BRIDGE],
}

/**
 * 门禁放行、但插件在 `dsh.compatibility.dshReleases` 里自述不兼容的现场（issue #106）。
 * 宿主把这类记录放在 `check.flagged` 里，`sources` 与门禁的 `gate` 区分。
 */
const DECLARED_BAD = {
  name: '@mhfire/dsh-im-bridge',
  version: '0.5.0-ws.1',
  compatible: true,
  exempted: false,
  known: true,
  peers: {},
  declared: { verdict: 'incompatible', source: 'self-declared' },
  sources: ['self-declared'],
  source: 'self-declared',
}

/** 矩阵里根本没有目标版本：`unverified`（从未验证）。 */
const DECLARED_UNKNOWN = {
  name: 'dsh-plugin-awake',
  version: '0.1.0',
  compatible: true,
  exempted: false,
  known: true,
  peers: {},
  declared: { verdict: 'unverified', source: 'self-declared' },
  sources: ['self-declared'],
  source: 'self-declared',
}

/** 门禁放行 + 自述有问题：`decision` 仍是 `update-available`（自述矩阵不许阻断升级）。 */
const DECLARED_CHECK = {
  date: TODAY,
  decision: 'update-available',
  installed: '0.2.1-rc.4',
  target: '0.2.2-alpha.2',
  channel: 'alpha',
  tags: TAGS,
  incompatible: [],
  flagged: [DECLARED_BAD, DECLARED_UNKNOWN],
}

/**
 * 升级成功后的真实现场：已装 `0.2.2-alpha.2`，但缓存里还是升级前那次检测（0.2.1-rc.5）。
 * `stale` / `staleReason` 由宿主在 `/status` 上标注（issue #100）。
 */
const STALE_CHECK = {
  date: TODAY,
  checkedAt: new Date().toISOString(),
  decision: 'update-available',
  installed: '0.2.1-rc.5',
  target: '0.2.2-alpha.2',
  channel: 'alpha',
  tags: TAGS,
  incompatible: [],
  cached: false,
  stale: true,
  staleReason: 'installed-changed',
}

/**
 * 造一份「已装版本是 X」的 `/status` 快照。
 * @param {object} lastCheck 上次检测结论。
 * @param {string} installed 实时已装版本。
 * @param {{dismissed?:boolean, overlay?:boolean}} [settings] 浮层设置。
 * @returns {object} 快照。
 */
function statusAt(lastCheck, installed, settings = { dismissed: false, overlay: true }) {
  return { ...statusWith(lastCheck, settings), dsh: { installed } }
}

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
    // 「当前版本」现在一律取实时已装版本，夹具里两边必须一致才是真实现场。
    [API.status]: statusAt(
      { date: '2026-10-18', decision: 'downgrade-guard', installed: '0.2.1-alpha.5', target: '0.2.0-rc.2', channel: 'latest', tags: TAGS, incompatible: [] },
      '0.2.1-alpha.5',
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
    [API.status]: statusAt(
      { date: '2026-10-18', decision: 'downgrade-guard', installed: '0.2.1-alpha.5', target: '0.2.0-rc.2', channel: 'latest', tags: TAGS, incompatible: [] },
      '0.2.1-alpha.5',
    ),
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
  assert.equal(countOf('function renderPluginBlock('), 1, '门禁拒绝块只能有一份定义')
  assert.equal(countOf('renderPluginBlock('), 3, '门禁拒绝块必须由浮层与设置页共用（一份定义 + 两次调用）')
  assert.equal(countOf('function namedPlugins('), 1, '点名合并（门禁 + 自述）只能有一份定义')
  assert.equal(countOf('namedPlugins('), 3, '点名合并必须由浮层与设置页共用（一份定义 + 两次调用）')
  assert.equal(countOf("t('overlay.declaredIncompatible')"), 1, '自述不兼容的渲染只留一份')
  assert.equal(countOf("t('overlay.unverifiedFold'"), 1, '自述未验证的折叠行只留一份')
  assert.equal(countOf("t('overlay.declaredUnverified')"), 0, '未验证不再逐条占位（旧的逐条文案必须删掉）')
  assert.equal(countOf('function makeIssueReporter('), 1, '开 issue 的提交器只能有一份定义')
  assert.equal(countOf('makeIssueReporter('), 3, '开 issue 必须由浮层与设置页共用（一份定义 + 两次调用）')
  assert.equal(countOf('createUpgradeFlow('), 3, '升级流程必须由浮层与设置页共用（一份定义 + 两次调用）')
  assert.equal(countOf('plan.notes.available === true'), 1, '更新说明的渲染只留一份')
  assert.equal(countOf('E_SESSIONS_RUNNING'), 1, '会话门禁分支只留一份')
  assert.equal(countOf('E_PLUGIN_INCOMPATIBLE'), 1, '插件不兼容门禁分支只留一份')
})

test('浮层：门禁拒绝时点名插件，要求最多列 3 条、其余折叠，并给修法与开 issue 入口', async () => {
  stubFetch({
    ...pluginRoutes,
    [API.status]: statusWith(RISK_CHECK),
  })
  const tree = await react.mount(Overlay, {})
  const text = textOf(tree)
  assert.match(text, /不能升级到 0\.2\.1-rc\.4：/, '拒绝时必须点名目标版本')
  assert.match(
    text,
    /@mhfire\/dsh-im-bridge@0\.4\.4-ws\.1 要求 @deepseek-ai\/dsh-agent 精确 0\.2\.1-rc\.2/,
    '必须点名插件与精确要求',
  )
  assert.doesNotMatch(text, /个插件不兼容/, '不能再只说数量')

  const details = collect(tree, (node) => node.type === 'details')
  assert.equal(details.length, 1, '要求明细必须放在 details 里（卡片只有 280px）')
  const detailText = textOf(details[0])
  assert.match(detailText, /要求明细（5 项）/)
  assert.match(detailText, /等 2 项/, '超过 3 条要折叠成「等 N 项」')
  assert.doesNotMatch(detailText, /dsh-app-boot/, '第 4 条起不直接铺开')

  assert.match(text, /修法：放宽该插件的 peer 声明后重跑其装配验收/)
  assert.match(text, /开 issue 记录这个不兼容/)
})

test('设置页：兼容性清单撤掉后不再拉 /plugins，阻塞仍由检测结果点名', async () => {
  const { calls } = stubFetch({
    ...pluginRoutes,
    [API.status]: statusWith(RISK_CHECK, { dismissed: true, overlay: false }),
  })
  const text = textOf(await react.mount(Settings, {}))
  assert.doesNotMatch(text, /已装插件兼容性/, '插件兼容清单已删除（#422）')
  assert.match(text, /不兼容/, '门禁阻塞仍要逐条点名')
  assert.match(text, /开 issue 记录这个不兼容/, '设置页也要有开 issue 入口')
  assert.ok(!calls.some((call) => call.url.startsWith(API.plugins)), '设置页不许再拉插件清单')
})

test('浮层：点「开 issue」走 report-issue，成功后同块显示 #N 链接', async () => {
  const { calls } = stubFetch({
    ...pluginRoutes,
    [API.status]: statusWith(RISK_CHECK),
    [API.reportIssue]: {
      ok: true,
      number: 71,
      url: 'https://github.com/guraul/self-dsh-plugins/issues/71',
      created: true,
    },
  })
  const tree = await react.mount(Overlay, {})
  const buttons = collect(tree, (node) => node.type === 'button' && textOf(node) === '开 issue 记录这个不兼容')
  assert.equal(buttons.length, 1)
  await buttons[0].props.onClick()

  const after = await react.flush()
  assert.match(textOf(after), /已记录为 issue/)
  const links = collect(after, (node) => node.type === 'a' && textOf(node) === '#71')
  assert.equal(links.length, 1, '成功后必须保持可见的 #N 链接')
  assert.equal(links[0].props.href, 'https://github.com/guraul/self-dsh-plugins/issues/71')

  const posted = calls.find((call) => call.url === API.reportIssue)
  assert.equal(posted.method, 'POST')
  assert.deepEqual(JSON.parse(posted.body), { target: '0.2.1-rc.4' }, '只允许传目标版本')
})

test('浮层：门禁放行但插件自述不兼容时逐条点名、给矩阵原文与开 issue；unverified 折叠成一行', async () => {
  stubFetch({
    ...pluginRoutes,
    [API.status]: statusWith(DECLARED_CHECK),
  })
  const tree = await react.mount(Overlay, {})
  const text = textOf(tree)
  assert.match(text, /门禁已放行，但插件自述有问题（目标 0\.2\.2-alpha\.2）/, '必须说清门禁已放行')
  assert.doesNotMatch(text, /不能升级到/, '门禁放行时不许用「不能升级」的口径')
  assert.match(
    text,
    /@mhfire\/dsh-im-bridge@0\.5\.0-ws\.1[\s\S]*插件自述已知不兼容/,
    '必须点名自述不兼容的插件',
  )
  assert.match(
    text,
    /dsh\.compatibility\.dshReleases\["0\.2\.2-alpha\.2"\] = "incompatible"/,
    '必须给出矩阵原文',
  )
  // unverified 不再逐条占位：只留一行计数，名单藏在 details 里。
  assert.match(text, /另有 1 个插件未验证该版本/, 'unverified 折叠成一行计数')
  assert.doesNotMatch(text, /该版本从未验证/, 'unverified 不许再逐条占位')
  assert.doesNotMatch(text, /没有记录（= 从未验证）/, 'unverified 不渲染矩阵缺失的逐条修法说明')
  const folds = collect(tree, (node) => node.type === 'details' && /另有 1 个插件未验证该版本/.test(textOf(node)))
  assert.equal(folds.length, 1, '未验证必须折叠在 details 里')
  assert.match(textOf(folds[0]), /dsh-plugin-awake@0\.1\.0/, '展开后要能看到名单')
  // 折叠行本身不许带开 issue 入口：整块只有一个按钮，且属于不兼容那条。
  assert.equal(collect(folds[0], (node) => node.type === 'button').length, 0, '未验证那行不许有按钮')

  assert.match(text, /自述矩阵是人工实测记录（官方门禁不读它，所以不会阻断升级）/, '修法要说明它不阻断升级')
  assert.match(text, /开 issue 记录这个不兼容/, '自述不兼容也能开 issue')

  const upgrade = collect(tree, (node) => node.type === 'button' && textOf(node) === '升级')
  assert.equal(upgrade.length, 1, '升级入口必须还在')
  assert.notEqual(upgrade[0].props.disabled, true, '自述矩阵不许阻断升级')
  // 动作区仍只有「升级 + 不再提示」：自述块只加正文，不加第二个升级按钮。
  const row = collect(tree, (node) => node.props?.className === 'dsh-au-row')
  assert.deepEqual(collect(row[0], (node) => node.type === 'button').map(textOf), ['升级', '不再提示'])
})

test('设置页：自述不兼容逐条点名，unverified 折叠成一行，升级入口仍在', async () => {
  stubFetch({
    ...pluginRoutes,
    [API.status]: statusWith(DECLARED_CHECK, { dismissed: true, overlay: false }),
  })
  const tree = await react.mount(Settings, {})
  const text = textOf(tree)
  assert.match(text, /发现新版本 0\.2\.2-alpha\.2（当前 0\.2\.0-rc\.2）/, '升级入口常驻')
  assert.match(text, /门禁已放行，但插件自述有问题（目标 0\.2\.2-alpha\.2）/)
  assert.match(text, /另有 1 个插件未验证该版本/, '设置页同样折叠未验证')
  assert.doesNotMatch(text, /该版本从未验证/)
  assert.match(text, /插件自述已知不兼容/)
  assert.match(text, /开 issue 记录这个不兼容/, '设置页同样能开 issue')
  const upgrade = collect(tree, (node) => node.type === 'button' && textOf(node) === '升级')
  assert.equal(upgrade.length, 1)
  assert.notEqual(upgrade[0].props.disabled, true, '自述矩阵不许阻断升级')
})

test('只有 unverified：浮层与设置页都只折叠一行，绝不给开 issue 入口', async () => {
  // 夹具把「自述不兼容」那条摘掉，只剩 unverified——「我没测过」不是已知不兼容。
  const onlyUnverified = { ...DECLARED_CHECK, flagged: [DECLARED_UNKNOWN] }
  stubFetch({
    ...pluginRoutes,
    [API.status]: statusWith(onlyUnverified),
  })
  const overlay = await react.mount(Overlay, {})
  const overlayText = textOf(overlay)
  assert.match(overlayText, /另有 1 个插件未验证该版本/, '只有 unverified 时仍要如实提示')
  assert.match(overlayText, /dsh-plugin-awake@0\.1\.0/, '折叠行要能展开看到名单')
  assert.doesNotMatch(overlayText, /开 issue 记录这个不兼容/, '只有 unverified 时不许有开 issue 按钮')
  assert.equal(
    collect(overlay, (node) => node.type === 'button' && /开 issue/.test(textOf(node))).length,
    0,
    '整块不许出现任何开 issue 按钮',
  )
  assert.doesNotMatch(overlayText, /插件自述已知不兼容|不能升级到/, '没有已知不兼容就别说「不兼容」')
  assert.doesNotMatch(overlayText, /自述矩阵是人工实测记录/, '只有 unverified 时不渲染自述矩阵修法')

  stubFetch({
    ...pluginRoutes,
    [API.status]: statusWith(onlyUnverified, { dismissed: true, overlay: false }),
  })
  const settings = await react.mount(Settings, {})
  const settingsText = textOf(settings)
  assert.match(settingsText, /另有 1 个插件未验证该版本/)
  assert.match(settingsText, /dsh-plugin-awake@0\.1\.0/)
  assert.doesNotMatch(settingsText, /开 issue 记录这个不兼容/, '设置页同样不许有开 issue 入口')
  assert.equal(
    collect(settings, (node) => node.type === 'button' && /开 issue/.test(textOf(node))).length,
    0,
    '设置页整块不许出现任何开 issue 按钮',
  )
})

test('过期缓存：自述矩阵（flagged）属于过期快照，同样不许铺开', async () => {
  exported.resetStaleRecheck()
  const held = new Promise(() => {})
  stubFetch({
    ...pluginRoutes,
    [API.status]: statusAt({ ...STALE_CHECK, flagged: [DECLARED_BAD] }, '0.2.2-alpha.2'),
    [API.checkRun]: () => held,
  })
  const text = textOf(await react.mount(Overlay, {}))
  assert.doesNotMatch(text, /插件自述已知不兼容/, '过期快照里的自述结论同样不能当结论')
})

test('过期缓存：不把旧结论当结论，改用实时 installed，且每页最多一次 /check/run', async () => {
  exported.resetStaleRecheck()
  // 把补检挂住，好观察「正在重新检测…」这个中间态（而不是被新结论立刻覆盖）。
  const held = new Promise(() => {})
  const { calls } = stubFetch({
    ...pluginRoutes,
    [API.status]: statusAt(STALE_CHECK, '0.2.2-alpha.2'),
    [API.checkRun]: () => held,
  })
  const tree = await react.mount(Overlay, {})
  const text = textOf(tree)
  assert.match(text, /正在重新检测…/, '补检期间必须说清正在做什么')
  assert.match(text, /上次检查时是 0\.2\.1-rc\.5/, '缓存里的 installed 只能用来解释过去')
  assert.doesNotMatch(text, /当前 0\.2\.1-rc\.5/, '「当前版本」不许用缓存里的旧值')
  assert.doesNotMatch(text, /有新版本 0\.2\.2-alpha\.2/, '过期的 update-available 不许当结论')
  const row = collect(tree, (node) => node.props?.className === 'dsh-au-row')
  assert.deepEqual(
    collect(row[0], (node) => node.type === 'button').map(textOf),
    ['不再提示'],
    '过期结论不许给出升级按钮',
  )

  // 设置页同时打开：与浮层共用同一个闸门，同一份页面不该再打一次。
  const settingsText = textOf(await react.mount(Settings, {}))
  assert.match(settingsText, /正在重新检测…/)
  assert.match(settingsText, /上次检查时是 0\.2\.1-rc\.5/)
  assert.doesNotMatch(settingsText, /发现新版本 0\.2\.2-alpha\.2/, '设置页同样不许铺过期结论')
  assert.equal(
    calls.filter((call) => call.url === API.checkRun && call.method === 'POST').length,
    1,
    '每次页面加载最多触发一次 /check/run（浮层 + 设置页共用）',
  )
})

test('过期缓存：补检拿到新结论后替换旧结论（不重复打 /check/run）', async () => {
  exported.resetStaleRecheck()
  const { calls } = stubFetch({
    ...pluginRoutes,
    [API.status]: statusAt(STALE_CHECK, '0.2.2-alpha.2'),
    [API.checkRun]: {
      ok: true,
      decision: 'up-to-date',
      installed: '0.2.2-alpha.2',
      target: '0.2.2-alpha.2',
      channel: 'alpha',
      tags: TAGS,
      cached: false,
      stale: false,
      staleReason: null,
      incompatible: [],
    },
  })
  const text = textOf(await react.mount(Overlay, {}))
  assert.match(text, /已是最新（0\.2\.2-alpha\.2）/, '补检结论必须替换过期结论')
  assert.doesNotMatch(text, /正在重新检测/)
  assert.doesNotMatch(text, /上次检查时是/, '结论已与实时版本对齐，不再解释过去')
  assert.equal(calls.filter((call) => call.url === API.checkRun).length, 1, '只补检一次')
})

test('「当前版本」一律用实时已装版本；缓存 installed 只说明「上次检查时是 X」', async () => {
  exported.resetStaleRecheck()
  stubFetch({
    ...pluginRoutes,
    [API.status]: statusAt({ ...STALE_CHECK, stale: false, staleReason: null }, '0.2.0-rc.2'),
  })
  const overlay = textOf(await react.mount(Overlay, {}))
  assert.match(overlay, /有新版本 0\.2\.2-alpha\.2（当前 0\.2\.0-rc\.2）/, '「当前版本」必须是实时值')
  assert.match(overlay, /上次检查时是 0\.2\.1-rc\.5/)
  const settings = textOf(await react.mount(Settings, {}))
  assert.match(settings, /发现新版本 0\.2\.2-alpha\.2（当前 0\.2\.0-rc\.2）/, '设置页同样用实时值')
  assert.match(settings, /上次检查时是 0\.2\.1-rc\.5/)
})

/** 一份「没有升级、没有阻塞」的 /status 快照：让新面板的断言不被别的区块干扰。 */
const CALM_STATUS = statusWith(
  { date: TODAY, decision: 'up-to-date', installed: '0.2.0-rc.2', target: '0.2.0-rc.2', channel: 'latest', tags: TAGS, incompatible: [] },
  { dismissed: true, overlay: false },
)

/** 升级卡要铺的工具链体检（`GET /preflight` 的 `preflight` 键）。 */
const PREFLIGHT_FACTS = {
  dsh: { version: '0.2.1-rc.2' },
  npm: { command: 'npm install -g @deepseek-ai/dsh@0.2.2-alpha.2' },
  paths: { backupBase: '/Users/gubin/.dsh-backups' },
}

/**
 * 预检结果四类现场：通过 / 未验证 / 装不上（P1 要求未满足）/ 装配失败（P2 装不上）。
 * 计数：兼容 3/4、试装 1/2、未验证 1 个、blocked。
 */
const PREFLIGHT_BLOCKED = {
  schema: 1,
  at: Date.UTC(2026, 10, 14, 8, 0, 0),
  target: '0.2.2-alpha.2',
  plugins: [
    {
      name: 'dsh-awake', version: '0.1.4', enabled: true,
      p1: { ok: true, verdict: 'ok', requirements: {}, declared: 'compatible' },
      p2: { ok: true, reason: '装配通过' },
    },
    {
      name: 'dsh-usage-panel', version: '0.2.3-fork.1', enabled: true,
      p1: { ok: true, verdict: 'unverified', requirements: {}, declared: 'unverified' },
      p2: { ok: true, skipped: true, reason: '未试装（不是 link:/file: 依赖）' },
    },
    {
      name: 'dsh-subagents', version: '0.5.0', enabled: true,
      p1: { ok: false, verdict: 'requirements', requirements: { '@deepseek-ai/dsh-tools': '0.2.1-rc.2' }, declared: 'compatible' },
      p2: { ok: true, skipped: true, reason: '未试装（不是 link:/file: 依赖）' },
    },
    {
      name: 'dsh-plugin-memx', version: '0.3.0', enabled: true,
      p1: { ok: true, verdict: 'ok', requirements: {}, declared: 'compatible' },
      p2: { ok: false, reason: 'plugin add 退出码 1' },
    },
  ],
  blocked: true,
  warnings: [],
}

/** 同一份结果的通过版：只剩一个插件，未 blocked。 */
const PREFLIGHT_OK = { ...PREFLIGHT_BLOCKED, plugins: [PREFLIGHT_BLOCKED.plugins[0]], blocked: false }

/** 有更新、且已装版本与检测快照一致（不触发过期补检）。 */
const PLAN_STATUS = statusAt(
  { date: TODAY, decision: 'update-available', installed: '0.2.1-rc.2', target: '0.2.2-alpha.2', channel: 'alpha', tags: TAGS, incompatible: [] },
  '0.2.1-rc.2',
  { dismissed: true, overlay: false },
)

/**
 * 在已挂载的元素树里点一个按钮，并把重新渲染后的树交回来。
 * @param {any} tree 元素树。
 * @param {string} label 按钮文案。
 * @returns {Promise<any>} 重新渲染后的树。
 */
async function clickButton(tree, label) {
  const button = collect(tree, (node) => node.type === 'button' && textOf(node) === label)[0]
  assert.ok(button !== undefined, `找不到按钮 ${label}`)
  button.props.onClick()
  return react.flush()
}

test('设置页：试装 / 冒烟 / 兼容三块面板已删除（按钮与标题都不再渲染）', async () => {
  stubFetch({
    ...pluginRoutes,
    [API.status]: {
      ...CALM_STATUS,
      capabilities: { restart: true, rollback: true },
      pendingRestart: { mode: 'upgrade', from: '0.2.0-rc.2', to: '0.2.1-rc.2' },
    },
  })
  const tree = await react.mount(Settings, {})
  const labels = collect(tree, (node) => node.type === 'button').map((node) => textOf(node))
  assert.ok(!labels.includes('跑一次试装'), '「跑一次试装」必须删除（#422）')
  assert.ok(!labels.includes('跑一次冒烟'), '「跑一次冒烟」必须删除（#422）')
  const text = textOf(tree)
  for (const gone of ['试装结论', '冒烟结论', '已装插件兼容性']) {
    assert.ok(!text.includes(gone), `「${gone}」区块必须删除（#422）`)
  }
  // #422 明确保留的控制项还在。
  for (const kept of ['立即检查', '本机体检', '重启服务', '回滚到 0.2.0-rc.2']) {
    assert.ok(labels.includes(kept), `保留的控制项缺失：${kept}`)
  }
})

test('升级卡两段式：目标 + 预检分项 + 逐插件待处理；blocked 时「开始升级」禁用', async () => {
  stubFetch({
    ...pluginRoutes,
    [API.status]: PLAN_STATUS,
    [API.preflight]: {
      ok: true,
      preflight: PREFLIGHT_FACTS,
      runner: { running: false, startedAt: null, target: null, error: null },
      result: PREFLIGHT_BLOCKED,
    },
  })
  let tree = await react.mount(Settings, {})
  tree = await clickButton(tree, '升级')
  const text = textOf(tree)
  assert.match(text, /目标 0\.2\.2-alpha\.2（当前 0\.2\.1-rc\.2）/, '第一段：目标版本')
  assert.match(text, /兼容判定 3\/4 · 1 个待处理/, '第二段：兼容判定 N/M 与待处理数')
  assert.match(text, /试装 1\/2/, '第二段：试装 N/M（跳过的不算进分母）')
  assert.match(text, /启动预演 未接入（P3）/, 'P3 没接入时必须如实显示「未接入」')
  assert.match(text, /⚠ dsh-usage-panel 未验证：插件没有记录该版本的验证结论/)
  assert.match(text, /⚠ dsh-subagents 装不上：@deepseek-ai\/dsh-tools 精确 0\.2\.1-rc\.2/)
  assert.match(text, /⚠ dsh-plugin-memx 装配失败：plugin add 退出码 1/)
  assert.doesNotMatch(text, /⚠ dsh-awake/, '通过的插件不逐条占位')

  const planButtons = collect(tree, (node) => node.type === 'button'
    && ['取消', '重新预检', '开始升级', '仍要升级'].includes(textOf(node)))
  assert.deepEqual(planButtons.map((node) => textOf(node)), ['取消', '重新预检', '开始升级', '仍要升级'])
  const byLabel = (label) => planButtons.find((node) => textOf(node) === label)
  assert.equal(byLabel('开始升级').props.disabled, true, 'blocked 时「开始升级」必须禁用')
  assert.equal(byLabel('仍要升级').props.disabled, false, '「仍要升级」是留痕出口，保持可用')
})

test('升级卡：结果缺失时「开始升级」禁用；「仍要升级」带 force:true 提交', async () => {
  const { calls } = stubFetch({
    ...pluginRoutes,
    [API.status]: PLAN_STATUS,
    [API.preflight]: {
      ok: true,
      preflight: PREFLIGHT_FACTS,
      runner: { running: false, startedAt: null, target: null, error: null },
      result: null,
    },
    [API.update]: { ok: false, code: 'E_TEST', error: '测试桩到此为止' },
  })
  let tree = await react.mount(Settings, {})
  tree = await clickButton(tree, '升级')
  const text = textOf(tree)
  assert.match(text, /还没有预检结果/, '结果缺失必须说清楚')
  const find = (label) => collect(tree, (node) => node.type === 'button' && textOf(node) === label)[0]
  assert.equal(find('开始升级').props.disabled, true, '结果缺失时不许「开始升级」')
  assert.equal(find('仍要升级').props.disabled, false)

  tree = await clickButton(tree, '仍要升级')
  const updates = calls.filter((call) => call.url === API.update && call.method === 'POST')
  assert.equal(updates.length, 1, '「仍要升级」必须打 /update')
  assert.deepEqual(JSON.parse(updates[0].body), { version: '0.2.2-alpha.2', force: true })
})

test('升级卡：结果通过且未 blocked 时「开始升级」可用，提交不带 force', async () => {
  const { calls } = stubFetch({
    ...pluginRoutes,
    [API.status]: PLAN_STATUS,
    [API.preflight]: {
      ok: true,
      preflight: PREFLIGHT_FACTS,
      runner: { running: false, startedAt: null, target: null, error: null },
      result: PREFLIGHT_OK,
    },
    [API.update]: { ok: false, code: 'E_TEST', error: '测试桩到此为止' },
  })
  let tree = await react.mount(Settings, {})
  tree = await clickButton(tree, '升级')
  assert.match(textOf(tree), /兼容判定 1\/1/)
  const start = collect(tree, (node) => node.type === 'button' && textOf(node) === '开始升级')[0]
  assert.equal(start.props.disabled, false, '通过时「开始升级」必须可点')
  tree = await clickButton(tree, '开始升级')
  const updates = calls.filter((call) => call.url === API.update && call.method === 'POST')
  assert.deepEqual(JSON.parse(updates[0].body), { version: '0.2.2-alpha.2', force: false })
})

test('升级卡：重新预检走 POST 并轮询 GET，结果回来后才替换卡片', async () => {
  let gets = 0
  const { calls } = stubFetch({
    ...pluginRoutes,
    [API.status]: PLAN_STATUS,
    [API.preflight]: () => {
      const call = calls[calls.length - 1]
      if (call.method === 'POST') {
        return { status: 202, json: async () => ({ ok: true, startedAt: Date.now(), target: '0.2.2-alpha.2', taskId: 'p-1' }) }
      }
      gets += 1
      // 1 = 进页、2 = 打开升级卡：都还没有结果；3 = POST 后的第一拍仍在跑；4 = 写完。
      const payload = {
        ok: true,
        preflight: PREFLIGHT_FACTS,
        runner: { running: gets === 3, startedAt: null, target: null, error: null },
        result: gets >= 4 ? PREFLIGHT_OK : null,
      }
      return { status: 200, json: async () => payload }
    },
  })
  let tree = await react.mount(Settings, {})
  tree = await clickButton(tree, '升级')
  assert.match(textOf(tree), /还没有预检结果/)

  tree = await clickButton(tree, '重新预检')
  assert.match(textOf(tree), /预检正在跑/, 'POST 之后要如实显示正在跑')
  assert.equal(
    calls.filter((call) => call.url === API.preflight && call.method === 'POST').length,
    1,
    '「重新预检」必须 POST 一次',
  )

  await new Promise((resolve) => setTimeout(resolve, 1200))
  tree = await react.flush()
  assert.match(textOf(tree), /兼容判定 1\/1/, '轮询到结论后必须替换卡片')
  assert.doesNotMatch(textOf(tree), /预检正在跑/)
  assert.ok(gets >= 4, `必须轮询到 runner 停下，实际 GET 了 ${String(gets)} 次`)
})

test('设置页底部：预检摘要一行可展开，逐插件原因与目标/时间都在', async () => {
  stubFetch({
    ...pluginRoutes,
    [API.status]: CALM_STATUS,
    [API.preflight]: {
      ok: true,
      preflight: PREFLIGHT_FACTS,
      runner: { running: false, startedAt: null, target: null, error: null },
      result: PREFLIGHT_BLOCKED,
    },
  })
  const tree = await react.mount(Settings, {})
  const text = textOf(tree)
  assert.match(text, /最近一次预检：3 个问题 · 4 个插件（1 个未验证）/)
  const summary = collect(tree, (node) => node.type === 'details' && textOf(node).includes('最近一次预检'))
  assert.equal(summary.length, 1, '摘要必须是一个可展开的 details')
  const body = textOf(summary[0])
  assert.match(body, /目标 0\.2\.2-alpha\.2 · 结论时间/)
  assert.match(body, /⚠ dsh-subagents 装不上：/)
  assert.match(body, /⚠ dsh-plugin-memx 装配失败：plugin add 退出码 1/)
  // 摘要必须贴在设置页底部（最后一个面板）。
  const panels = collect(tree, (node) => node.props?.className === 'dsh-au-panel')
  assert.match(textOf(panels[panels.length - 1]), /最近一次预检/)
})

test('设置页底部：还没有预检结果时摘要如实说「还没跑过」，不编数字', async () => {
  stubFetch({
    ...pluginRoutes,
    [API.status]: CALM_STATUS,
    [API.preflight]: {
      ok: true,
      preflight: PREFLIGHT_FACTS,
      runner: { running: false, startedAt: null, target: null, error: null },
      result: null,
    },
  })
  const text = textOf(await react.mount(Settings, {}))
  assert.match(text, /最近一次预检：还没有跑过/)
  assert.doesNotMatch(text, /最近一次启动检查/, 'boot-check 还没有端点，不许先写半截')
})

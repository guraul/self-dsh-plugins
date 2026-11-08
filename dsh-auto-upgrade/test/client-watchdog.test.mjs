import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/**
 * issue #293 R2：watchdog 不能再无限承诺「页面会自动重新连接」——token 是进程级的，
 * 新宿主对本页旧 token 永远 401。连续失败约 30s（15 次 × 2s）后必须切到
 * 「令牌已更换」状态，文案改成可执行指引（打开 .dsh-web/url.txt / grep 日志）。
 */

let loaded
/**
 * 装载浏览器半边（与 client-register.test.mjs 同款夹具：假 ModuleLoader + 假 react）。
 * @returns {Promise<any>} 工厂返回的模块导出。
 */
async function loadClient() {
  if (loaded === undefined) {
    const captured = {}
    globalThis.window = {
      __ModuleLoader__: {
        load(spec) {
          captured.spec = spec
        },
      },
    }
    await import('../lib/client.js')
    const fakeReact = { createElement: () => null }
    loaded = captured.spec.factory((name) => {
      if (name === 'react') return fakeReact
      throw new Error(`unexpected require: ${name}`)
    })
  }
  return loaded
}

/**
 * 跑一次 apply 捕获注册进 locale 的 zh/en 字典。
 * @param {any} exported 客户端导出。
 * @returns {Promise<{zh:Record<string,string>, en:Record<string,string}>} 两份字典。
 */
async function captureDicts(exported) {
  const dictionaries = []
  const fakeCtx = {
    get: (name) => (name === 'locale'
      ? { register: (_ns, dict) => dictionaries.push(dict), bind: () => (key) => key }
      : undefined),
    effect: (fn) => fn(),
    inject: (_deps, callback) => callback({
      slots: {
        inject: (_slot, mount) => mount(),
        register: () => () => {},
      },
    }),
  }
  exported.apply(fakeCtx)
  assert.equal(dictionaries.length, 1)
  return dictionaries[0]
}

/**
 * 与产品内 makeT 同规则的翻译函数（测试侧夹具，用字典喂 phaseText）。
 * @param {Record<string,string>} dict 字典。
 * @returns {(key:string, params?:Record<string,unknown>) => string} 翻译函数。
 */
const makeT = (dict) => (key, params) => {
  const template = dict[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
}

test('watchdog 连续失败到阈值后切「令牌已更换」，此前一直报重启中（#293）', async () => {
  const exported = await loadClient()
  const states = []
  const ref = { current: null }
  globalThis.fetch = async () => ({ status: 401, json: async () => ({ ok: false }) })

  exported.startWatchdog(ref, null, (state) => states.push(state), { intervalMs: 2, tokenTicks: 3 })

  const deadline = Date.now() + 5000
  while (!states.includes('token-rotated') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  clearInterval(ref.current)
  ref.current = null
  const seen = [...states]

  assert.deepEqual(seen.slice(0, 2), ['reconnecting', 'reconnecting'], '阈值之内只许说重启中')
  assert.equal(seen[2], 'token-rotated', '第 N 次连续失败（N = tokenTicks）当次就必须切「令牌已更换」')
  assert.equal(seen[seen.length - 1], 'token-rotated', '之后保持「令牌已更换」')
})

test('「令牌已更换」文案给可执行指引且不再承诺自动重连，渲染共用 phaseText（#293）', async () => {
  const exported = await loadClient()
  const dicts = await captureDicts(exported)

  const zh = exported.phaseText(makeT(dicts.zh), 'token-rotated')
  assert.match(zh, /\.dsh-web\/url\.txt/, '必须给出 url.txt 这条出路')
  assert.match(zh, /grep 'dsh web: http' \| tail -1/, '必须给出日志 grep 这条出路')
  assert.equal(zh.includes('自动重新连接'), false, '终态文案不许再承诺「会自动重新连接」')

  const en = exported.phaseText(makeT(dicts.en), 'token-rotated')
  assert.match(en, /\.dsh-web\/url\.txt/)
  assert.equal(en.includes('reconnect automatically'), false, '英文文案同样不许承诺自动重连')

  // 阈值之内仍用「重启中」文案（那时承诺还没被证伪，键也不许删）
  assert.equal(exported.phaseText(makeT(dicts.zh), 'reconnecting'), dicts.zh['overlay.reconnecting'])
  assert.match(exported.phaseText(makeT(dicts.zh), 'reconnecting'), /自动重新连接/)
  // 其它交接相位（如 preflight）保持原来 handingOff 文案
  assert.equal(exported.phaseText(makeT(dicts.zh), 'preflight'), '正在交接给升级助手（preflight）…')

  // 三处渲染都必须走 phaseText——内联回 reconnecting 三元等于把假承诺改回来
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok((source.match(/phaseText\(/g) ?? []).length >= 4, 'phaseText 至少被定义一次 + 三处渲染调用')
  assert.doesNotMatch(source, /handoff\.step === 'reconnecting'/, '浮层渲染不许绕过 phaseText')
  assert.doesNotMatch(source, /progress\.step === 'reconnecting'/, '设置页渲染不许绕过 phaseText')
  // 线上节奏：2s × 15 ≈ 30s（issue #293 要求约 30s）
  assert.match(source, /const WATCHDOG_INTERVAL_MS = 2000/)
  assert.match(source, /const WATCHDOG_TOKEN_TICKS = 15/)
})

test('#300 深度口径：自述兼容但深度只到 L1（或没记）→ 显示「可装配，未验证行为」', async () => {
  const exported = await loadClient()
  const cases = [
    [{ declared: { verdict: 'compatible' }, depth: 'L1' }, true, '只到装配'],
    [{ declared: { verdict: 'compatible' } }, true, '没记深度（老记录）'],
    [{ declared: { verdict: 'compatible' }, depth: 'L2' }, false, '启动+冒烟通过才叫兼容'],
    [{ declared: { verdict: 'compatible' }, depth: 'L3' }, false],
    [{ declared: { verdict: 'compatible' }, depth: 'L4' }, false],
    [{ declared: { verdict: 'incompatible' }, depth: 'L1' }, false, '不兼容本来就不显示兼容'],
    [{ declared: { verdict: 'unverified' } }, false],
    [undefined, false, '没有判定项不炸'],
  ]
  for (const [plugin, expected] of cases) {
    assert.equal(exported.behaviourUnverified(plugin), expected, JSON.stringify(plugin))
  }
})

test('#300 深度口径：门禁放行的插件按「未验证 / 可装配 / 兼容」三态显示，不许把没验过的叫兼容', async () => {
  const exported = await loadClient()
  assert.equal(exported.passState({ declared: { verdict: 'compatible' }, depth: 'L2' }), 'ok')
  assert.equal(exported.passState({ declared: { verdict: 'compatible' }, depth: 'L1' }), 'assembled')
  assert.equal(exported.passState({ declared: { verdict: 'compatible' } }), 'assembled', '没记深度同样只能算可装配')
  assert.equal(exported.passState({ declared: { verdict: 'unverified' } }), 'unverified', '从没验过就该显示未验证')
  assert.equal(exported.passState({}), 'unverified')
})

test('#375 令牌取值：URL 上有就用 URL 的，没有就用之前存的，都没有返回空串', async () => {
  const exported = await loadClient()
  assert.equal(exported.pickToken('?token=URLTOKEN', null), 'URLTOKEN')
  assert.equal(exported.pickToken('?token=URLTOKEN', 'STORED'), 'URLTOKEN', 'URL 优先（重启后页面地址是最新的）')
  assert.equal(exported.pickToken('', 'STORED'), 'STORED', '页面内跳转后 query 丢了，要用存下的')
  assert.equal(exported.pickToken('?x=1', 'STORED'), 'STORED')
  assert.equal(exported.pickToken('', null), '')
  assert.equal(exported.pickToken(undefined, undefined), '')
})

test('#375 401 给人话提示且清掉回退值；409/500 原样透传', async () => {
  const exported = await loadClient()
  const realFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ({ status: 401, json: async () => ({ ok: false, code: 'E_UNAUTHORIZED' }) })
    const unauthorized = await exported.request('/x', { method: 'POST' })
    assert.equal(unauthorized.httpStatus, 401)
    assert.equal(unauthorized.code, 'E_UNAUTHORIZED')
    assert.match(unauthorized.error, /令牌已更换/, '要给人话提示，不能是 t is not defined')
    assert.equal(unauthorized.error.includes('settings.'), false, '不能把文案 key 当文案返回（字典缺键时 makeT 会回退成 key）')

    globalThis.fetch = async () => ({ status: 409, json: async () => ({ ok: false, code: 'E_BUSY' }) })
    const busy = await exported.request('/x', { method: 'POST' })
    assert.equal(busy.httpStatus, 409, '非 401 要原样透传')
    assert.equal(busy.code, 'E_BUSY')

    globalThis.fetch = async () => ({ status: 500, json: async () => ({ ok: false, error: 'boom' }) })
    const broken = await exported.request('/x', { method: 'POST' })
    assert.equal(broken.httpStatus, 500, '500 也要原样透传')
    assert.equal(broken.error, 'boom')
  } finally {
    globalThis.fetch = realFetch
  }
})

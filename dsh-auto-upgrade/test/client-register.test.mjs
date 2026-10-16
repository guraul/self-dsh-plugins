import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 找本机 dsh 安装（installAnchor）；找不到就跳过依赖它的用例。
 * @returns {string|undefined} manifest 路径。
 */
function findInstallAnchor() {
  if (typeof process.env.DSH_INSTALL_ANCHOR === 'string' && process.env.DSH_INSTALL_ANCHOR !== '') {
    return process.env.DSH_INSTALL_ANCHOR
  }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    const candidate = join(root, '@deepseek-ai', 'dsh', 'package.json')
    if (existsSync(candidate)) return candidate
  } catch {
    /* 环境不具备时跳过 */
  }
  return undefined
}

/**
 * 用假 `window.__ModuleLoader__` + 假 react 装载浏览器半边，
 * 验证它真的注册进 `shell.overlay` / `settings.section`（不改产品代码就能测的接缝）。
 * @returns {Promise<any>} 客户端模块导出。
 */
async function loadClient() {
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
  const fakeReact = { createElement: () => null }
  return captured.spec.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`unexpected require: ${name}`)
  })
}

test('浏览器半边注册两个座位，选项带 id/order/locale', async () => {
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

  assert.deepEqual(registrations.map((entry) => entry.options.name), ['shell.overlay', 'settings.section'])
  assert.equal(registrations[0].options.id, 'dsh-auto-upgrade')
  assert.equal(registrations[0].options.order, 1000)
  assert.equal(registrations[0].options.locale, 'dsh-auto-upgrade')
  assert.equal(registrations[1].options.order, 40)
  assert.equal(typeof registrations[1].options.label, 'function')
  assert.equal(typeof registrations[0].component, 'function')
  assert.equal(typeof registrations[1].component, 'function')

  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].ns, 'dsh-auto-upgrade')
  assert.equal(typeof dictionaries[0].dict.zh['settings.label'], 'string')
  assert.equal(typeof dictionaries[0].dict.en['settings.label'], 'string')
  assert.deepEqual(Object.keys(dictionaries[0].dict.zh).sort(), Object.keys(dictionaries[0].dict.en).sort())
})

test('客户端源码里有重连 watchdog 与任务日志跟随（交接后页面靠它自己回来）', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /function startWatchdog/)
  assert.match(source, /window\.location\.reload\(\)/)
  assert.match(source, /followTask/)
  assert.match(source, /E_SESSIONS_RUNNING/)
  assert.match(source, /E_PLUGIN_INCOMPATIBLE/)
})

test('样式继承 dsh 字体，且只用主题里真实存在的 token', async (t) => {
  const anchor = findInstallAnchor()
  if (anchor === undefined) return t.skip('no global @deepseek-ai/dsh installation found')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  // 根因回归：设置页/浮层必须吃应用的字体简写 token，而不是自带 font-family
  assert.match(source, /\.dsh-au-card,\.dsh-au-section\{font:var\(--dsw-font-s-14/, '根规则必须用 --dsw-font-s-14')
  assert.match(source, /var\(--dsw-font-family,/, 'font-family 只作为 token 的兜底出现')
  // 曾经抄了不存在的语义色 token，导致颜色静默退回硬编码
  assert.doesNotMatch(source, /--dsw-alias-label-(warning|danger|success)/)
  // 按钮尺寸必须照 primitives（md=36px / 0 14px），不要再自造 32px
  assert.match(source, /\.dsh-au-btn\{[^}]*height:36px;padding:0 14px;/)
  // 开关照 primitives 的 Switch（36x20 胶囊 + aria-checked）
  assert.match(source, /\.dsh-au-switch\{[^}]*width:36px;height:20px/)
  assert.match(source, /\.dsh-au-switch\[aria-checked="true"\]/)

  const theme = await readFile(join(anchor, '..', 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js'), 'utf8')
  const defined = new Set([...theme.matchAll(/--(?:dsw|ds)-[a-z0-9-]+(?=\s*:)/g)].map((match) => match[0]))
  assert.ok(defined.has('--dsw-font-family'), 'theme must define --dsw-font-family')

  const used = [...source.matchAll(/var\((--(?:dsw|ds)-[a-z0-9-]+)\s*(,)?/g)]
  assert.ok(used.length > 10, 'expected the client to style itself through tokens')
  const undefinedWithoutFallback = [...new Set(used
    .filter(([, name, fallback]) => !defined.has(name) && fallback !== ',')
    .map(([, name]) => name))]
  assert.deepEqual(undefinedWithoutFallback, [], 'every var(--dsw-*) must exist in the theme or carry a fallback')
})

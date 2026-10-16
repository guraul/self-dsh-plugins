import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { loadOfficialAppBoot } from '../lib/host/official.js'

/**
 * 找本机 dsh 安装（installAnchor）。
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

test('dsh.client.inject 里的包在运行的那版 dsh 里真实存在', async (t) => {
  const anchor = findInstallAnchor()
  if (anchor === undefined) return t.skip('no global @deepseek-ai/dsh installation found')
  const own = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const inject = own?.dsh?.client?.inject ?? []
  assert.ok(inject.length > 0, 'client half must declare the client packages it consumes')

  const installDir = dirname(anchor)
  for (const name of inject) {
    const packageDir = join(installDir, 'node_modules', name)
    assert.ok(existsSync(packageDir), `${name} is declared in dsh.client.inject but is not part of the running dsh installation`)
  }
  // 声明的正是浏览器半边真的会用的服务
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /ctx\.inject\(\['slots', 'locale'\]/)
})

test('真实 API：product-subagents 的 peer 范围在 0.2.0 上判不兼容，写豁免后可放行', async (t) => {
  const anchor = findInstallAnchor()
  if (anchor === undefined) return t.skip('no global @deepseek-ai/dsh installation found')
  const manifestPath = process.env.DSH_TEST_PLUGIN_MANIFEST
    ?? join(homedir(), 'workspace', 'dsh-plugin-product-subagents', 'package.json')
  if (!existsSync(manifestPath)) return t.skip(`fixture plugin not found: ${manifestPath}`)

  const official = await loadOfficialAppBoot(anchor)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

  const bare = official.evaluatePluginCompatibility(manifest, {}, '0.2.0')
  assert.notEqual(bare, undefined, 'expected the declared peer range to reject dsh 0.2.0')
  assert.equal(bare.exempted, false)
  assert.ok(Object.keys(bare.peers).length > 0)

  const exempted = official.evaluatePluginCompatibility(
    manifest,
    { [`${manifest.name}@${manifest.version}`]: ['0.2.0'] },
    '0.2.0',
  )
  assert.notEqual(exempted, undefined, 'an exemption still reports the mismatch, but flags it as exempted')
  assert.equal(exempted.exempted, true)
  assert.match(official.pluginCompatibilityWarning(bare), /incompatible/)
})

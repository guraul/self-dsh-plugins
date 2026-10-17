import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
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

/**
 * 夹具 manifest：一个「落后一个世代」的第三方插件。
 *
 * 真实世界的同一案例是 `dsh-plugin-product-subagents`（它的 peer 范围曾长期不含 0.2.x，
 * 在 0.2.0-rc.2 上纯靠 `compatibility.json` 里的精确版本豁免活着）。这里不依赖那个外部仓库——
 * 它会挪位置、会升级——而是用内联夹具，保证测的是**官方 API 的语义**：
 * 范围不含运行时 → 判不兼容；写了精确版本豁免 → 报不兼容但标记 exempted。
 * @type {object}
 */
const FIXTURE_MANIFEST = {
  name: 'fixture-plugin',
  version: '0.4.0',
  peerDependencies: {
    '@deepseek-ai/dsh-subagent': '^0.0.1-rc.5 || ^0.1.0-rc.2 || ^0.1.5-alpha.1',
  },
}

test('真实 API：peer 范围不含运行时 → 判不兼容；写精确版本豁免后仍报不兼容但标记 exempted', async (t) => {
  const anchor = findInstallAnchor()
  if (anchor === undefined) return t.skip('no global @deepseek-ai/dsh installation found')

  const official = await loadOfficialAppBoot(anchor)
  const manifest = FIXTURE_MANIFEST

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

  // 同一个插件在它自己声明的世代里必须是兼容的（否则夹具本身就是坏的）
  assert.equal(official.evaluatePluginCompatibility(manifest, {}, '0.1.5-alpha.1'), undefined)
})

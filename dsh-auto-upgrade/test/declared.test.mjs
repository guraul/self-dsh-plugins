import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { declaredVerdict, evaluatePlugins, SELF_DECLARED } from '../lib/host/compat.js'

/**
 * 造一个带自述矩阵的 manifest。
 * @param {object|undefined} releases `dsh.compatibility.dshReleases`；undefined 表示整段缺失。
 * @returns {object} manifest。
 */
function manifestWith(releases) {
  return {
    name: 'fixture-plugin',
    version: '1.0.0',
    ...(releases === undefined ? {} : { dsh: { compatibility: { dshReleases: releases } } }),
  }
}

test('自述矩阵三态：compatible / incompatible / 缺失（= unverified）', () => {
  assert.deepEqual(
    declaredVerdict(manifestWith({ '0.2.2-alpha.2': 'compatible' }), '0.2.2-alpha.2'),
    { verdict: 'compatible', source: SELF_DECLARED },
  )
  assert.deepEqual(
    declaredVerdict(manifestWith({ '0.2.2-alpha.2': 'incompatible' }), '0.2.2-alpha.2'),
    { verdict: 'incompatible', source: SELF_DECLARED },
  )
  // 缺失有三种现场：整段没有、矩阵里没有这个版本、manifest 根本读不到。
  assert.deepEqual(
    declaredVerdict(manifestWith(undefined), '0.2.2-alpha.2'),
    { verdict: 'unverified', source: SELF_DECLARED },
    '没有 dsh.compatibility.dshReleases = 从未验证',
  )
  assert.deepEqual(
    declaredVerdict(manifestWith({ '0.2.1-rc.4': 'compatible' }), '0.2.2-alpha.2'),
    { verdict: 'unverified', source: SELF_DECLARED },
    '矩阵里没有这个版本 = 从未验证',
  )
  assert.deepEqual(
    declaredVerdict(undefined, '0.2.2-alpha.2'),
    { verdict: 'unverified', source: SELF_DECLARED },
    '读不到 manifest = 无法声称验证过',
  )
})

test('自述矩阵：非法记录值一律按 unverified 处理（没有可用的结论）', () => {
  for (const recorded of ['unknown', 'COMPATIBLE', '', null, 1, { verdict: 'incompatible' }, ['compatible']]) {
    assert.equal(
      declaredVerdict(manifestWith({ '0.2.2-alpha.2': recorded }), '0.2.2-alpha.2').verdict,
      'unverified',
      `${JSON.stringify(recorded)} 不是合法的矩阵记录`,
    )
  }
  // 整段 dsh.compatibility 写成数组之类也不会崩，只当没有记录。
  assert.equal(declaredVerdict({ dsh: { compatibility: { dshReleases: ['x'] } } }, '0.2.2-alpha.2').verdict, 'unverified')
})

test('evaluatePlugins：declared 逐条挂上，incompatible 与 unverified 都进 flagged 且来源可区分', async () => {
  // 这里的 official 只是一个「门禁全放行」的替身：本用例测的是本插件的合并口径，
  // 官方判定语义由 `official-compat.test.mjs` 用真 API 守着。
  const official = {
    readProfileVersionExemptions: () => ({}),
    evaluatePluginCompatibility: () => undefined,
  }
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-au-declared-'))
  try {
    const plugins = [
      { name: 'declared-bad', version: '1.0.0', releases: { '9.9.9': 'incompatible' } },
      { name: 'declared-unknown', version: '1.0.0', releases: { '0.2.1-rc.4': 'compatible' } },
      { name: 'declared-ok', version: '1.0.0', releases: { '9.9.9': 'compatible' } },
    ]
    const dependencies = []
    for (const plugin of plugins) {
      const dir = join(profileDir, 'node_modules', plugin.name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify({
        name: plugin.name,
        version: plugin.version,
        dsh: { compatibility: { dshReleases: plugin.releases } },
      }))
      dependencies.push({ name: plugin.name, version: plugin.version, bundle: true, enabled: true })
    }

    const verdict = await evaluatePlugins({ official, profileDir, dependencies, targetVersion: '9.9.9' })
    assert.deepEqual(verdict.plugins.map((plugin) => plugin.declared.verdict), ['incompatible', 'unverified', 'compatible'])
    assert.equal(verdict.incompatible.length, 0, '门禁放行：自述矩阵不许把自己变成 incompatible')

    const byName = Object.fromEntries(verdict.flagged.map((plugin) => [plugin.name, plugin]))
    assert.deepEqual(byName['declared-bad'].sources, ['self-declared'])
    assert.deepEqual(byName['declared-unknown'].sources, ['self-declared'])
    assert.equal(byName['declared-ok'], undefined, '自述 compatible 不进点名')
    assert.equal(verdict.flagged.length, 2)
  } finally {
    await rm(profileDir, { recursive: true, force: true })
  }
})

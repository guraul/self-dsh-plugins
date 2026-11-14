import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { ensureProbeProfile } from '../lib/host/probe-profile.js'

const run = promisify(execFile)

test('#392 建出可用的空 profile：package.json 形状对、目录在', async () => {
  const home = await mkdtemp(join(tmpdir(), 'probe-profile-test-'))
  try {
    const dir = await ensureProbeProfile(home, 'probe')
    assert.equal(dir, join(home, 'profiles', 'probe'))
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    assert.equal(pkg.name, 'dsh-profile-probe')
    assert.equal(pkg.private, true)
    assert.deepEqual(pkg.dependencies, {})
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('#392 建完之后 dsh --dump-config 不再报「profile 不存在」（本机集成，CI 无 dsh 会 skip）', async (t) => {
  let dshBin
  try {
    dshBin = (await run('which', ['dsh'])).stdout.trim()
  } catch {
    return t.skip('no dsh on PATH')
  }
  if (dshBin === '') return t.skip('no dsh on PATH')

  // 不建 profile：确认这正是真机失败的原因
  const bare = await mkdtemp(join(tmpdir(), 'probe-bare-'))
  try {
    await assert.rejects(
      run(dshBin, ['--profile', 'probe', '--dump-config'], { env: { ...process.env, DSH_HOME: bare } }),
      /does not exist|Command failed/,
      'profile 不存在时 dump 必须失败（这就是 9/10 的根因）',
    )
  } finally {
    await rm(bare, { recursive: true, force: true })
  }

  // 建了 profile：dump 通过
  const home = await mkdtemp(join(tmpdir(), 'probe-ok-'))
  try {
    await ensureProbeProfile(home, 'probe')
    const { stdout } = await run(dshBin, ['--profile', 'probe', '--dump-config'], {
      env: { ...process.env, DSH_HOME: home },
    })
    assert.equal(typeof stdout, 'string', '建好 profile 后 dump 应正常返回')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('#400 顺序：先建 profile 再跑探针；建失败就不跑（不依赖真实 dsh，CI 可跑）', async () => {
  const { runProbeWithProfile } = await import('../lib/host/probe-run.js')

  // 正常路径：ensure 必须先于 probes
  const calls = []
  const result = await runProbeWithProfile({
    dshHome: '/tmp/h',
    profileName: 'probe',
    ensure: async (home, name) => { calls.push(`ensure:${home}:${name}`) },
    probes: async () => { calls.push('probes'); return { ok: true } },
  })
  assert.deepEqual(calls, ['ensure:/tmp/h:probe', 'probes'], '建 profile 必须发生在跑探针之前')
  assert.deepEqual(result, { ok: true })

  // 建失败：probes 一次都不能跑（拿不存在的 profile 去 dump 只会误报「基线不可用」）
  const skipped = []
  await assert.rejects(
    runProbeWithProfile({
      dshHome: '/tmp/h',
      profileName: 'probe',
      ensure: async () => { throw new Error('mkdir 失败') },
      probes: async () => { skipped.push('probes') },
    }),
    /mkdir 失败/,
  )
  assert.deepEqual(skipped, [], '建 profile 失败时不能跑探针')
})

test('#400 接线：index.js → runProbePass → runProbeWithProfile（删掉就红）', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  // helper 单测测不到「调用方忘了用它」这类回归（#400 review 轮 1 实测：删掉接线仍全绿）。
  // #421 起 /probe 与预检 P2 共用 `preflight-run.js` 的 runProbePass，接线跟着搬到那里。
  assert.match(source, /runProbePass\(/, 'index.js 必须调用 runProbePass')
  const runner = await readFile(new URL('../lib/host/preflight-run.js', import.meta.url), 'utf8')
  assert.match(runner, /runProbeWithProfile\(/, 'preflight-run.js 必须调用 runProbeWithProfile')
  assert.match(runner, /probes: \(\) => runProbes\(/, '探针必须作为 probes 回调传入')
  // 默认实现必须留在 probe-run 里，别让调用方各自拼一遍
  const helper = await readFile(new URL('../lib/host/probe-run.js', import.meta.url), 'utf8')
  assert.match(helper, /options\.ensure \?\? ensureProbeProfile/, '默认 ensure 必须是真实实现')
})

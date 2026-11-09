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

test('#392 建完之后 dsh --dump-config 不再报「profile 不存在」', async (t) => {
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

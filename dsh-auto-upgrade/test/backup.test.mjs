import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { backupPath, createBackup, findLatestBackup, restoreBackup, timestamp } from '../lib/host/backup.js'

/**
 * 造一个假的 `~/.dsh`。
 * @param {string} root 根目录。
 * @returns {Promise<string>} 数据目录。
 */
async function makeHome(root) {
  const home = join(root, '.dsh')
  await mkdir(join(home, 'profiles', 'web'), { recursive: true })
  await writeFile(join(home, 'settings.yaml.imported'), 'theme: light\n')
  await writeFile(join(home, 'profiles', 'web', 'package.json'), '{"name":"dsh-profile-web"}\n')
  return home
}

test('备份：整棵拷贝 + UPGRADE-INFO.txt + 可被 findLatestBackup 找到', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-au-backup-'))
  const home = await makeHome(root)
  const logs = []
  const result = await createBackup({
    dshHome: home,
    ts: '20261012-120000',
    meta: { dshBefore: '0.2.0-rc.2', target: '0.3.0' },
    onLog: (line) => logs.push(line),
  })
  assert.equal(result.ok, true)
  assert.equal(result.target, backupPath(home, '20261012-120000'))
  assert.equal(await readFile(join(result.target, 'profiles', 'web', 'package.json'), 'utf8'), '{"name":"dsh-profile-web"}\n')
  assert.match(await readFile(join(result.target, 'UPGRADE-INFO.txt'), 'utf8'), /dshBefore: 0\.2\.0-rc\.2/)
  assert.equal(result.files, 2)
  assert.equal(await findLatestBackup(home), result.target)
  assert.ok(logs.some((line) => line.includes('备份')))

  // 同名备份已存在时必须拒绝，而不是默默覆盖
  const again = await createBackup({ dshHome: home, ts: '20261012-120000' })
  assert.equal(again.ok, false)
  assert.match(again.error, /已存在/)
})

test('备份：数据目录不存在时跳过而不是失败', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-au-backup-'))
  const result = await createBackup({ dshHome: join(root, '.dsh'), ts: 'x' })
  assert.equal(result.ok, true)
  assert.equal(result.target, '')
})

test('恢复：现场先让路，再从备份覆盖回来', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-au-restore-'))
  const home = await makeHome(root)
  const source = join(root, 'snapshot')
  await mkdir(join(source, 'profiles'), { recursive: true })
  await writeFile(join(source, 'marker.txt'), 'from-backup\n')

  const moved = await restoreBackup({ dshHome: home, source, ts: '20261012-130000' })
  assert.equal(moved.ok, true)
  assert.equal(moved.movedAside, `${home}.before-restore-20261012-130000`)
  assert.equal(await readFile(join(home, 'marker.txt'), 'utf8'), 'from-backup\n')
  // 现场还在原处（只是改了名），没有被删
  assert.equal((await stat(moved.movedAside)).isDirectory(), true)
  assert.ok((await readdir(moved.movedAside)).includes('settings.yaml.imported'))
})

test('恢复：备份不存在时明确失败', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-au-restore-'))
  const home = await makeHome(root)
  const result = await restoreBackup({ dshHome: home, source: join(root, 'missing'), ts: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.error, /备份不存在/)
  assert.equal((await stat(home)).isDirectory(), true)
  await rm(root, { recursive: true, force: true })
})

test('timestamp 用本地时间且零填充', () => {
  assert.equal(timestamp(new Date(2026, 9, 12, 3, 4, 5)), '20261012-030405')
})

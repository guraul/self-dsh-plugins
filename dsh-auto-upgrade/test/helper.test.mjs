import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildUpgradeScript, installArgs, plainInstallArgs, shellQuote } from '../lib/host/upgrade.js'

/**
 * 造一套假工具链与 payload。
 * @param {{npmExit?:number, dshVersion?:string, launchctlExit?:number, launchdLabel?:string}} [options] 选项。
 * @returns {Promise<{payload:object, dir:string, marker:string, out:string, result:string, launchctlMarker:string}>} 测试夹具。
 */
async function makeFixture(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-au-helper-'))
  const bin = join(dir, 'bin')
  await mkdir(bin, { recursive: true })
  const marker = join(dir, 'npm-calls.txt')
  const out = join(dir, 'web.out.log')
  const result = join(dir, 'result.json')
  const launchctlMarker = join(dir, 'launchctl-calls.txt')

  const npm = join(bin, 'npm')
  await writeFile(npm, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(marker)}\nexit ${options.npmExit ?? 0}\n`)
  await chmod(npm, 0o755)

  const launchctl = join(bin, 'launchctl')
  await writeFile(
    launchctl,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${shellQuote(launchctlMarker)}`,
      'case "$1" in',
      `  print) exit ${options.printExit ?? 0} ;;`,
      `  kickstart) exit ${options.kickstartExit ?? 0} ;;`,
      'esac',
      'exit 0',
      '',
    ].join('\n'),
  )
  await chmod(launchctl, 0o755)

  const dsh = join(bin, 'dsh')
  await writeFile(
    dsh,
    `#!/bin/sh\ncase "$1" in\n  --version) printf '%s\\n' ${shellQuote(options.dshVersion ?? '9.9.9')} ;;\n  *) printf 'smoke ok\\n' ;;\nesac\nexit 0\n`,
  )
  await chmod(dsh, 0o755)

  const payload = {
    mode: 'update',
    hostPid: 999999, // 不存在的 pid：helper 立刻越过等待
    port: 59999, // 没人监听：端口视为空闲
    npm,
    dshBin: dsh,
    package: '@deepseek-ai/dsh',
    profile: 'web',
    current: '0.2.0-rc.2',
    target: '9.9.9',
    backup: join(dir, '.dsh.bak-20261012-000000'),
    execPath: '/bin/echo',
    args: ['--profile', 'web', '--no-open'],
    cwd: dir,
    stateDir: dir,
    logPath: join(dir, 'restart.log'),
    resultPath: result,
    outLog: out,
    smokeOut: join(dir, 'smoke.out'),
    allowScripts: 'koffi,node-pty',
    launchctl,
    launchdLabel: options.launchdLabel ?? '',
  }
  return { payload, dir, marker, out, result, launchctlMarker }
}

/**
 * 跑一遍生成的 helper。
 * @param {object} payload payload。
 * @param {string} dir 工作目录。
 * @returns {{status:number|null, stdout:string, stderr:string}} 结果。
 */
function runHelper(payload, dir) {
  const script = join(dir, 'upgrade.sh')
  writeFileSync(script, buildUpgradeScript(payload))
  return spawnSync('/bin/sh', [script], { encoding: 'utf8', timeout: 60000 })
}

/**
 * 轮询等待文件出现并匹配（helper 的后台拉起是异步的，测试必须等它落地）。
 * @param {string} path 文件。
 * @param {RegExp} pattern 期望内容。
 * @param {number} [timeoutMs] 超时。
 * @returns {Promise<string>} 文件内容。
 */
async function waitForFile(path, pattern, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    try {
      last = await readFile(path, 'utf8')
      if (pattern.test(last)) return last
    } catch {
      /* 还没创建 */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path} to match ${pattern}; last=${JSON.stringify(last)}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test('纯函数：installArgs / plainInstallArgs 与 shell 转义', () => {
  assert.deepEqual(installArgs({ version: '9.9.9', allowScripts: 'a,b' }), [
    'install', '-g', '--allow-scripts=a,b', '@deepseek-ai/dsh@9.9.9',
  ])
  assert.deepEqual(plainInstallArgs({ version: '9.9.9' }), ['install', '-g', '@deepseek-ai/dsh@9.9.9'])
  assert.equal(shellQuote("a'b c"), `'a'\\''b c'`)
})

test('生成的脚本把带引号/空格的参数安全落到重新拉起的命令行', () => {
  const script = buildUpgradeScript({
    mode: 'restart',
    hostPid: 1,
    port: 3080,
    npm: '/usr/bin/npm',
    dshBin: '/usr/bin/dsh',
    execPath: '/usr/bin/node',
    args: ['/tmp/a b/bin.js', "it's", '--profile', 'web'],
    cwd: '/tmp',
    stateDir: '/tmp',
    logPath: '/tmp/restart.log',
    resultPath: '/tmp/result.json',
    outLog: '/tmp/out.log',
    smokeOut: '/tmp/smoke.out',
  })
  assert.ok(script.includes(`'/tmp/a b/bin.js' 'it'\\''s' '--profile' 'web'`))
  assert.match(script, /write_result true null/)
})

test('helper 成功路径：装 → 对版 → 冒烟 → 重新拉起，并写下 ok:true', async () => {
  const fixture = await makeFixture()
  const run = runHelper(fixture.payload, fixture.dir)
  assert.equal(run.status, 0, run.stderr)

  const calls = await readFile(fixture.marker, 'utf8')
  assert.match(calls, /install -g --allow-scripts=koffi,node-pty @deepseek-ai\/dsh@9\.9\.9/)

  const result = JSON.parse(await readFile(fixture.result, 'utf8'))
  assert.equal(result.ok, true)
  assert.equal(result.failedStep, null)
  assert.equal(result.to, '9.9.9')

  const relaunched = await waitForFile(fixture.out, /--profile web --no-open/)

  const log = await readFile(fixture.payload.logPath, 'utf8')
  assert.match(log, /profile smoke test passed/)
  assert.match(log, /done/)
})

test('helper 安装失败：仍在跑旧树 → 拉起旧树，结果如实报 install 失败', async () => {
  const fixture = await makeFixture({ npmExit: 1, dshVersion: '0.2.0-rc.2' })
  const run = runHelper(fixture.payload, fixture.dir)
  assert.equal(run.status, 1)
  const result = JSON.parse(await readFile(fixture.result, 'utf8'))
  assert.equal(result.ok, false)
  assert.equal(result.failedStep, 'install')
  const log = await readFile(fixture.payload.logPath, 'utf8')
  assert.match(log, /on-disk tree is still 0\.2\.0-rc\.2/)
  await waitForFile(fixture.out, /--profile/)
})

test('helper 对版失败：绝不拉起带病的树', async () => {
  const fixture = await makeFixture({ dshVersion: '0.1.0' })
  const run = runHelper(fixture.payload, fixture.dir)
  assert.equal(run.status, 1)
  const result = JSON.parse(await readFile(fixture.result, 'utf8'))
  assert.equal(result.ok, false)
  assert.equal(result.failedStep, 'verify')
  const log = await readFile(fixture.payload.logPath, 'utf8')
  assert.match(log, /NOT restarting the service/)
  await assert.rejects(readFile(fixture.out, 'utf8'))
})

test('launchd 管理下：用 kickstart 拉起，而不是 fork 孤儿进程', async () => {
  const fixture = await makeFixture({ launchdLabel: 'com.test.dsh-web' })
  const run = runHelper(fixture.payload, fixture.dir)
  assert.equal(run.status, 0, run.stderr)

  const calls = await readFile(fixture.launchctlMarker, 'utf8')
  assert.match(calls, /print gui\/\d+\/com\.test\.dsh-web/)
  assert.match(calls, /kickstart -k gui\/\d+\/com\.test\.dsh-web/)

  const log = await readFile(fixture.payload.logPath, 'utf8')
  assert.match(log, /relaunching through launchd/)
  assert.match(log, /kickstart ok/)
  await assert.rejects(readFile(fixture.out, 'utf8'), 'kickstart 路径不应再自己 spawn 一份')
})

test('launchd 在但 kickstart 失败时退回 detached spawn', async () => {
  const fixture = await makeFixture({ launchdLabel: 'com.test.dsh-web', kickstartExit: 1 })
  const run = runHelper(fixture.payload, fixture.dir)
  assert.equal(run.status, 0, run.stderr)
  const log = await readFile(fixture.payload.logPath, 'utf8')
  assert.match(log, /kickstart failed; falling back to a detached spawn/)
  await waitForFile(fixture.out, /--profile web --no-open/)
})

test('launchd 里没有这个 job 时退回 detached spawn', async () => {
  const fixture = await makeFixture({ launchdLabel: 'com.test.dsh-web', printExit: 1 })
  const run = runHelper(fixture.payload, fixture.dir)
  assert.equal(run.status, 0, run.stderr)
  const log = await readFile(fixture.payload.logPath, 'utf8')
  assert.match(log, /no launchd job named com\.test\.dsh-web/)
  await waitForFile(fixture.out, /--profile web --no-open/)
})

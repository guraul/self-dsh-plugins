import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

test('helper 生成的脚本：relaunch 前抓 baseline，刷新只认 --previous（#293）', () => {
  const script = buildUpgradeScript({
    mode: 'restart',
    hostPid: 1,
    port: 3080,
    npm: '/usr/bin/npm',
    dshBin: '/usr/bin/dsh',
    execPath: '/usr/bin/node',
    args: ['--profile', 'web'],
    cwd: '/tmp',
    stateDir: '/tmp',
    logPath: '/tmp/restart.log',
    resultPath: '/tmp/result.json',
    outLog: '/tmp/out.log',
    smokeOut: '/tmp/smoke.out',
    refreshScript: '/opt/dsh/lib/host/refresh-url.mjs',
  })
  const printAt = script.indexOf('--print-latest')
  const relaunchCallAt = script.indexOf('\nrelaunch\n')
  assert.ok(printAt > 0, '必须生成 baseline 捕获（--print-latest）')
  assert.ok(relaunchCallAt > 0, '必须生成列首的 relaunch 调用')
  assert.ok(printAt < relaunchCallAt, 'baseline 必须在 relaunch 之前抓，否则抓到的还是旧 URL')
  assert.match(script, /"\$EXEC" "\$REFRESH_SCRIPT" --previous "\$BASELINE"/)
  assert.ok(script.indexOf('if refresh_url; then') > relaunchCallAt, '刷新循环在 relaunch 之后')
  assert.doesNotMatch(script, /say "[^"]*\$BASELINE/, 'baseline 是旧 token 的 URL，只报存在性、绝不回显')
})

test('端到端：relaunch 前抓 baseline → 新 URL 认证 303 后才写 url.txt（#293）', async () => {
  const fixture = await makeFixture()
  const { payload, dir, out } = fixture
  const urlFile = join(dir, 'url.txt')

  // 假宿主服务：任何 token URL 都回 303（模拟「新 token 被接受后换址」）。
  const server = createServer((_req, res) => {
    res.writeHead(303, { location: '/' })
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const oldUrl = `${origin}/?token=PRE_RESTART_BASELINE_1`
  const newUrl = `${origin}/?token=POST_RESTART_CANDIDATE_2`

  try {
    // 重启前日志里只有旧 URL（真实竞态现场：新实例还没打印）。
    await writeFile(out, `dsh web: ${oldUrl}\n`)

    // 假宿主：被 relaunch 拉起时往日志追加新 URL（模拟新实例打印），4s 后自己退出。
    const fakeHost = join(dir, 'fake-host.mjs')
    await writeFile(fakeHost, [
      "import { appendFileSync } from 'node:fs'",
      `appendFileSync(${JSON.stringify(out)}, ${JSON.stringify(`dsh web: ${newUrl}\n`)})`,
      'setTimeout(() => {}, 4000)',
      '',
    ].join('\n'))
    payload.execPath = process.execPath
    payload.args = [fakeHost, '--profile', 'web', '--no-open']
    payload.refreshScript = fileURLToPath(new URL('../lib/host/refresh-url.mjs', import.meta.url))

    // 异步跑 helper：同进程的假宿主服务要靠事件循环应答，spawnSync 会把它冻住。
    const status = await runHelperAsync(payload, dir, 45000)

    assert.equal(status, 0, `helper exit=${status}`)
    assert.equal(await readFile(urlFile, 'utf8'), `${newUrl}\n`, '必须写入重启后的新 URL，而不是 baseline')
    const log = await readFile(payload.logPath, 'utf8')
    assert.match(log, /baseline: log already has a token URL/)
    assert.match(log, /url\.txt refreshed/)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})

/**
 * 异步跑一遍生成的 helper（同进程里的假宿主服务需要事件循环，不能用 spawnSync）。
 * @param {object} payload payload。
 * @param {string} dir 工作目录。
 * @param {number} [timeoutMs] 超时兜底（超时杀掉 helper 并返回 'timeout' 让用例红）。
 * @param {string} [pathEnv] 覆盖 PATH（测试用假 sleep 压缩重试节奏）。
 * @returns {Promise<number|string>} 退出码或 'timeout'。
 */
function runHelperAsync(payload, dir, timeoutMs, pathEnv) {
  const script = join(dir, 'upgrade.sh')
  writeFileSync(script, buildUpgradeScript(payload))
  const env = pathEnv === undefined ? process.env : { ...process.env, PATH: pathEnv }
  const child = spawn('/bin/sh', [script], { stdio: 'ignore', env })
  const exit = new Promise((resolve) => child.on('close', (status) => resolve(status)))
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve('timeout')
    }, timeoutMs)
  })
  return Promise.race([exit, timeout]).finally(() => clearTimeout(timer))
}

test('刷新循环耗尽必须留 WARNING 且 url.txt 原封不动——静默“成功”即红（#293）', async () => {
  // ① 生成脚本层面：耗尽路径必须显形（标记 + 上限 + 成功/失败两分支 + grep 指引）。
  const script = buildUpgradeScript({
    mode: 'restart',
    hostPid: 1,
    port: 3080,
    npm: '/usr/bin/npm',
    dshBin: '/usr/bin/dsh',
    execPath: '/usr/bin/node',
    args: ['--profile', 'web'],
    cwd: '/tmp',
    stateDir: '/tmp',
    logPath: '/tmp/restart.log',
    resultPath: '/tmp/result.json',
    outLog: '/tmp/out.log',
    smokeOut: '/tmp/smoke.out',
    refreshScript: '/opt/dsh/lib/host/refresh-url.mjs',
  })
  assert.match(script, /REFRESHED=0/, '必须有刷新成功标记')
  assert.match(script, /while \[ "\$i" -lt 60 \]/, '重试上限 60 次')
  assert.match(script, /if \[ "\$REFRESHED" -eq 1 \]; then/, '耗尽与成功必须分两支')
  assert.match(script, /say "url\.txt refreshed"/, '成功仍记 refreshed')
  assert.match(script, /WARNING: url\.txt was NOT refreshed \(no new token URL authenticated within 60 retries\)/, '耗尽必须写 WARNING')
  assert.match(script, /grep 'dsh web: http' \$OUT \| tail -1/, 'WARNING 必须给 grep 最新 URL 的出路')

  // ② 端到端：日志里只有重启前的 URL、新实例一直不打印 → 60 次全部失败。
  const fixture = await makeFixture()
  const { payload, dir, out } = fixture
  const urlFile = join(dir, 'url.txt')
  const stale = 'http://127.0.0.1:3080/?token=STALE_EVEN_OLDER_2\n'
  await writeFile(out, 'dsh web: http://127.0.0.1:3080/?token=PRE_RESTART_BASELINE_1\n')
  await writeFile(urlFile, stale)

  // 新实例（noop 宿主）永远不再打印 URL：复刻「拿不到可认证新 URL」的冷启动现场。
  const noopHost = join(dir, 'noop-host.mjs')
  await writeFile(noopHost, 'setTimeout(() => {}, 1000)\n')
  payload.execPath = process.execPath
  payload.args = [noopHost, '--profile', 'web', '--no-open']
  payload.refreshScript = fileURLToPath(new URL('../lib/host/refresh-url.mjs', import.meta.url))

  // 假 sleep（PATH 前置）：60 次重试的真实节奏是 1 分钟起步，测试里压到几秒。
  const bin = join(dir, 'bin')
  await mkdir(bin, { recursive: true })
  const fakeSleep = join(bin, 'sleep')
  await writeFile(fakeSleep, '#!/bin/sh\nexit 0\n')
  await chmod(fakeSleep, 0o755)

  const status = await runHelperAsync(payload, dir, 60000, `${bin}:${process.env.PATH}`)

  assert.equal(status, 0, `helper exit=${status}`)
  const log = await readFile(payload.logPath, 'utf8')
  assert.match(log, /WARNING: url\.txt was NOT refreshed \(no new token URL authenticated within 60 retries\)/, '耗尽必须在日志里留 WARNING')
  assert.match(log, /grep 'dsh web: http'/, 'WARNING 必须带 grep 指引（$OUT 已展开成真实路径）')
  assert.match(log, /\| tail -1/)
  assert.doesNotMatch(log, /url\.txt refreshed/, '耗尽时不许说 refreshed')
  assert.equal(await readFile(urlFile, 'utf8'), stale, 'url.txt 必须原封不动')
  assert.match(log, /done/)
})

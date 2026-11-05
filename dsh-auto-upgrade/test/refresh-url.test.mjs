import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * issue #293 的两条判据（`lib/host/refresh-url.mjs` 的 CLI 行为，端到端跑真进程）：
 *   1. 只认重启后新出现的 URL（helper 用 --print-latest 抓 baseline，刷新时 --previous 传回）；
 *   2. 候选 URL 必须真能认证（fetch + redirect:manual，状态 ∈ {200,302,303}）。
 * 两条都不满足时 exit 1 且**绝不写 url.txt**——helper 的重试循环靠这个继续转。
 */
const REFRESH = fileURLToPath(new URL('../lib/host/refresh-url.mjs', import.meta.url))

/**
 * 跑一次 refresh-url.mjs（异步：假服务在本进程，spawnSync 会冻住事件循环让应答超时）。
 * @param {string[]} args 命令行参数。
 * @returns {Promise<{status:number|null, stdout:string, stderr:string}>} 结果。
 */
function refresh(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [REFRESH, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

/**
 * 起一个本机假服务，按给定状态码应答（303 带 Location，模拟 dsh web 的换址跳转）。
 * @param {number} status HTTP 状态码。
 * @param {(origin:string) => Promise<void>} fn 用完即关的服务回调。
 * @returns {Promise<void>} 完成。
 */
async function withServer(status, fn) {
  const server = createServer((_req, res) => {
    res.writeHead(status, status === 302 || status === 303 ? { location: '/' } : {})
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await fn(`http://127.0.0.1:${server.address().port}`)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

/**
 * 造一个实例日志目录（web.out.log + url.txt 各就位）。
 * @returns {Promise<{dir:string, log:string, urlFile:string}>} 夹具路径。
 */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-au-refresh-'))
  return { dir, log: join(dir, 'web.out.log'), urlFile: join(dir, 'url.txt') }
}

test('baseline 未变：日志最后一条还是重启前的 URL → exit 1 且不写 url.txt（#293 判据一）', async () => {
  const { log, urlFile } = await fixture()
  // 故意让 baseline URL 也返回 303（认证能过）：判据一一旦被改坏，就会走到认证并写入，
  // 本用例立刻红——这样判据一是被独立证明的，不靠「反正连不上」蒙混。
  await withServer(303, async (origin) => {
    const baseline = `${origin}/?token=PRE_RESTART_BASELINE_1`
    const stale = 'http://127.0.0.1:3080/?token=STALE_EVEN_OLDER_2\n'
    await writeFile(log, `dsh web: ${baseline}\n`)
    await writeFile(urlFile, stale)

    const run = await refresh(['--previous', baseline, log, urlFile])

    assert.equal(run.status, 1, `exit=${run.status} stdout=${run.stdout} stderr=${run.stderr}`)
    assert.equal(await readFile(urlFile, 'utf8'), stale, 'baseline 未变时绝不许动 url.txt')
  })
})

test('候选 URL 认证不过（401）→ exit 1 且不写 url.txt（#293 判据二）', async () => {
  const { log, urlFile } = await fixture()
  await withServer(401, async (origin) => {
    const baseline = 'http://127.0.0.1:3080/?token=PRE_RESTART_BASELINE_1'
    const candidate = `${origin}/?token=POST_RESTART_CANDIDATE_2`
    const stale = 'http://127.0.0.1:3080/?token=STALE_EVEN_OLDER_2\n'
    await writeFile(log, `dsh web: ${baseline}\ndsh web: ${candidate}\n`)
    await writeFile(urlFile, stale)

    const run = await refresh(['--previous', baseline, log, urlFile])

    assert.equal(run.status, 1, `exit=${run.status} stdout=${run.stdout} stderr=${run.stderr}`)
    assert.equal(await readFile(urlFile, 'utf8'), stale, '401 的候选绝不许写进 url.txt')
  })
})

test('新 URL 且认证 303 → 写入 url.txt 并 exit 0（#293）', async () => {
  const { log, urlFile } = await fixture()
  await withServer(303, async (origin) => {
    const baseline = 'http://127.0.0.1:3080/?token=PRE_RESTART_BASELINE_1'
    const candidate = `${origin}/?token=POST_RESTART_CANDIDATE_2`
    await writeFile(log, `dsh web: ${baseline}\ndsh web: ${candidate}\n`)
    await writeFile(urlFile, 'http://127.0.0.1:3080/?token=STALE_EVEN_OLDER_2\n')

    const run = await refresh(['--previous', baseline, log, urlFile])

    assert.equal(run.status, 0, `exit=${run.status} stdout=${run.stdout} stderr=${run.stderr}`)
    assert.equal(await readFile(urlFile, 'utf8'), `${candidate}\n`)
  })
})

test('候选 URL 连不上（无服务）→ exit 1 且不写 url.txt（fetch 失败不算认证通过）', async () => {
  const { log, urlFile } = await fixture()
  // 先占一个端口再关掉：之后没人监听，fetch 必然连接被拒。
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  await new Promise((resolve) => server.close(resolve))

  const baseline = 'http://127.0.0.1:3080/?token=PRE_RESTART_BASELINE_1'
  const candidate = `${origin}/?token=POST_RESTART_CANDIDATE_2`
  const stale = 'http://127.0.0.1:3080/?token=STALE_EVEN_OLDER_2\n'
  await writeFile(log, `dsh web: ${baseline}\ndsh web: ${candidate}\n`)
  await writeFile(urlFile, stale)

  const run = await refresh(['--previous', baseline, log, urlFile])

  assert.equal(run.status, 1, `exit=${run.status} stdout=${run.stdout} stderr=${run.stderr}`)
  assert.equal(await readFile(urlFile, 'utf8'), stale)
})

test('--print-latest 回显日志里最后一条 token URL（helper 抓 baseline 用）', async () => {
  const { log } = await fixture()
  const first = 'http://127.0.0.1:3080/?token=FIRST_START_TOKEN_1'
  const last = 'http://127.0.0.1:3080/?token=LAST_START_TOKEN_2'
  await writeFile(log, `dsh web: ${first}\nnoise\ndsh web: ${last}\n`)

  const run = await refresh(['--print-latest', log])

  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, `${last}\n`)
})

test('--print-latest：日志还没有 token URL → exit 1 且无输出', async () => {
  const { log } = await fixture()
  await writeFile(log, 'dsh starting…\n')

  const run = await refresh(['--print-latest', log])

  assert.equal(run.status, 1, run.stderr)
  assert.equal(run.stdout, '')
})

test('缺参数 → exit 2（bad usage）', async () => {
  assert.equal((await refresh([])).status, 2)
  assert.equal((await refresh(['--previous', 'http://127.0.0.1:3080/?token=ONLY_ONE_ARG_1'])).status, 2)
})

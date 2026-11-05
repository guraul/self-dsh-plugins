import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SERVER = new URL('../lib/host/progress-server.mjs', import.meta.url).pathname

/** 假宿主：任何请求都回 303（模拟「新令牌可用」）。 */
async function fakeHost() {
  const server = createServer((_req, res) => {
    res.writeHead(303, { location: '/' })
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${String(server.address().port)}`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}

/** 起进度服务并等它写出端口。 */
async function startProgress(stateDir, urlFile, base) {
  const child = spawn(process.execPath, [SERVER, '--state', stateDir, '--url-file', urlFile, '--port', '0',
    ...(base === undefined ? [] : ['--base', base])], {
    stdio: 'ignore',
  })
  const portFile = join(stateDir, 'progress-port.json')
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      const { port } = JSON.parse(await readFile(portFile, 'utf8'))
      return { base: `http://127.0.0.1:${String(port)}`, kill: () => child.kill('SIGKILL') }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  child.kill('SIGKILL')
  throw new Error('进度服务没写出端口')
}

test('#300 重启进度服务：就绪时 /state 报 done 并给出可直接打开的新地址', async () => {
  const host = await fakeHost()
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-au-progress-'))
  const urlFile = join(stateDir, 'url.txt')
  const url = `${host.origin}/?token=TEST_TOKEN_0123456789`
  const progress = await startProgress(stateDir, urlFile)
  try {
    // 新地址要在服务起来之后才出现（起来之前 url.txt 里的内容属于「本轮之前」）。
    await writeFile(urlFile, `${url}\n`)
    const state = await (await fetch(`${progress.base}/state`)).json()
    assert.equal(state.phase, 'done')
    assert.equal(state.url, url, '完成时必须把新地址交给页面')
    assert.ok(typeof state.elapsedMs === 'number')

    const page = await fetch(`${progress.base}/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /dsh web 正在重启/, '进度页要能直接打开（宿主已死时它仍在）')
    assert.equal(page.headers.get('access-control-allow-origin'), null, '同源轮询，不该开 CORS（免得任意网页探到带令牌的地址）')
  } finally {
    progress.kill()
    await host.close()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('#300 重启进度服务：result.json 报失败时 /state 报 failed，不假装在跑', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-au-progress-'))
  await writeFile(join(stateDir, 'url.txt'), '')
  const progress = await startProgress(stateDir, join(stateDir, 'url.txt'))
  try {
    // 只认本轮写的 result.json：写在服务起来之后才算「这轮的失败」。
    await writeFile(join(stateDir, 'result.json'), JSON.stringify({ ok: false, failedStep: 'install' }))
    const state = await (await fetch(`${progress.base}/state`)).json()
    assert.equal(state.phase, 'failed')
    assert.match(state.detail, /install/)
    assert.match(state.hint, /url\.txt/, '失败时要给「怎么回到界面」的出路，不能把用户晾在死页')
  } finally {
    progress.kill()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('#300 进度服务：点击时 url.txt 里的旧令牌不算就绪（#293 同源的坑）', async () => {
  const host = await fakeHost()
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-au-progress-'))
  const urlFile = join(stateDir, 'url.txt')
  const oldUrl = `${host.origin}/?token=OLD_TOKEN_STILL_VALID_01`
  // 点击那一刻：url.txt 是旧进程的有效令牌（还能 303），修复前会立刻判 done。
  await writeFile(urlFile, `${oldUrl}\n`)
  const progress = await startProgress(stateDir, urlFile)
  try {
    const early = await (await fetch(`${progress.base}/state`)).json()
    assert.notEqual(early.phase, 'done', '旧令牌仍有效，但它不是本轮的新地址')
    assert.equal(early.url, undefined, '没到 done 就不许给地址')
    await writeFile(urlFile, `${host.origin}/?token=NEW_TOKEN_AFTER_RESTART_2\n`)
    const later = await (await fetch(`${progress.base}/state`)).json()
    assert.equal(later.phase, 'done', '换成新令牌后才算完成')
  } finally {
    progress.kill()
    await host.close()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('#300 进度服务：上一轮的 result.json 不算本轮失败', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-au-progress-'))
  await writeFile(join(stateDir, 'url.txt'), '')
  // 上一轮留下的失败记录：写在服务启动之前 → 必须被忽略。
  await writeFile(join(stateDir, 'result.json'), JSON.stringify({ ok: false, failedStep: 'install' }))
  const progress = await startProgress(stateDir, join(stateDir, 'url.txt'))
  try {
    const state = await (await fetch(`${progress.base}/state`)).json()
    assert.notEqual(state.phase, 'failed', '陈旧 result.json 不该让重试立刻误报失败')
  } finally {
    progress.kill()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('#300 进度：3080 没人应答时是「停止/等待」，不是一直 waiting（否则页面看着像没动）', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-au-progress-'))
  // 指一个必然没人听的端口：等价于「旧进程已经停了」。
  const progress = await startProgress(stateDir, join(stateDir, 'url.txt'), 'http://127.0.0.1:1')
  try {
    const state = await (await fetch(`${progress.base}/state`)).json()
    assert.equal(state.phase, 'stopping', '端口不通就该报「正在等新进程」，而不是干等')
    assert.equal(state.url, undefined)
  } finally {
    progress.kill()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('#300 进度：3080 起来了但 url.txt 还没换新令牌 → 「校验新地址」', async () => {
  const host = await fakeHost()
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-au-progress-'))
  const urlFile = join(stateDir, 'url.txt')
  await writeFile(urlFile, `${host.origin}/?token=OLD_TOKEN_STILL_VALID_01\n`)
  const progress = await startProgress(stateDir, urlFile, host.origin)
  try {
    const state = await (await fetch(`${progress.base}/state`)).json()
    assert.equal(state.phase, 'verifying', '端口活着但地址还没换新，就是在校验')
  } finally {
    progress.kill()
    await host.close()
    await rm(stateDir, { recursive: true, force: true })
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SERVER = new URL('../lib/host/progress-server.mjs', import.meta.url).pathname

/**
 * 起一个假宿主：任何请求都回 303（模拟「新令牌可用」）。
 * @returns {Promise<{origin: string, close: () => Promise<void>}>} 假宿主。
 */
async function fakeHost() {
  const server = createServer((_req, res) => {
    res.writeHead(303, { location: '/' })
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${String(server.address().port)}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(resolve)
    }),
  }
}

/**
 * 起进度服务并等它把端口写出来。
 * @param {string} stateDir 状态目录。
 * @param {string} urlFile url.txt 路径。
 * @returns {Promise<{base: string, kill: () => void}>} 进度服务。
 */
async function startProgress(stateDir, urlFile) {
  const child = spawn(process.execPath, [SERVER, '--state', stateDir, '--url-file', urlFile, '--port', '0'], {
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
  await writeFile(urlFile, `${url}\n`)
  const progress = await startProgress(stateDir, urlFile)
  try {
    const state = await (await fetch(`${progress.base}/state`)).json()
    assert.equal(state.phase, 'done')
    assert.equal(state.url, url, '完成时必须把新地址交给页面')
    assert.ok(typeof state.elapsedMs === 'number')

    const page = await fetch(`${progress.base}/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /dsh web 正在重启/, '进度页要能直接打开（宿主已死时它仍在）')
    assert.equal(page.headers.get('access-control-allow-origin'), '*', '页面要能跨源轮询')
  } finally {
    progress.kill()
    await host.close()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('#300 重启进度服务：result.json 报失败时 /state 报 failed，不假装在跑', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-au-progress-'))
  await writeFile(join(stateDir, 'result.json'), JSON.stringify({ ok: false, failedStep: 'install' }))
  await writeFile(join(stateDir, 'url.txt'), '')
  const progress = await startProgress(stateDir, join(stateDir, 'url.txt'))
  try {
    const state = await (await fetch(`${progress.base}/state`)).json()
    assert.equal(state.phase, 'failed')
    assert.match(state.detail, /install/)
  } finally {
    progress.kill()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('#300 客户端：后端给了 progressUrl 就跳过去，否则保持原来的 watchdog 行为', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /window\.location\.href = result\.progressUrl/, '升级/重启后要跳到进度页')
  const count = (source.match(/result\.progressUrl/g) ?? []).length
  assert.ok(count >= 2, '升级流程与通用 handoff 都要处理（两处）')
  assert.match(source, /startWatchdog\(/, '没有进度服务时仍要退回 watchdog（不许两条都丢）')
})

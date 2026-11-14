import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { symlinkSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { CHECK_GRACE_MS, checkLine, resolveCheck } from '../lib/host/progress-server.mjs'

const SERVER = new URL('../lib/host/progress-server.mjs', import.meta.url).pathname

/** 本轮的冒烟结果文件（契约由后续 PR 落盘）。 */
function bootCheck(overrides = {}) {
  return JSON.stringify({
    schema: 1,
    at: Date.now(),
    problems: 0,
    disabled: [],
    unverified: [],
    results: [],
    ...overrides,
  })
}

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

/**
 * 起进度服务并等它写出端口。
 * @param {string} stateDir 状态目录。
 * @param {string} urlFile `url.txt` 路径。
 * @param {string} [base] 宿主地址。
 * @param {string[]} [extra] 额外参数。
 * @param {string} [entry] 要执行的脚本路径（默认真实路径；软链用例传软链）。
 */
async function startProgress(stateDir, urlFile, base, extra = [], entry = SERVER) {
  const child = spawn(process.execPath, [entry, '--state', stateDir, '--url-file', urlFile, '--port', '0',
    ...(base === undefined ? [] : ['--base', base]), ...extra], {
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
    await writeFile(join(stateDir, 'boot-check.json'), bootCheck())
    const state = await (await fetch(`${progress.base}/state`)).json()
    assert.equal(state.phase, 'done')
    assert.equal(state.url, url, '完成时必须把新地址交给页面')
    assert.ok(typeof state.elapsedMs === 'number')
    assert.equal(state.check?.state, 'done', '有新地址 + 本轮冒烟结果才算完成')
    assert.equal(state.check?.problems, 0)

    const page = await fetch(`${progress.base}/`)
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /dsh web 正在重启/, '进度页要能直接打开（宿主已死时它仍在）')
    assert.match(html, /id=smoke/, '跳转前要有一行冒烟检查')
    assert.match(html, /冒烟检查：/, '页面文案与服务端同一份实现')
    // 内联脚本必须能编译：`checkLine` 是以源码形式注入的，写坏了页面会整段不动。
    assert.doesNotThrow(() => new Function(/<script>([\s\S]+)<\/script>/.exec(html)[1]))
    assert.equal(page.headers.get('access-control-allow-origin'), null, '同源轮询，不该开 CORS（免得任意网页探到带令牌的地址）')
  } finally {
    progress.kill()
    await host.close()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('#423 入口守卫：经软链启动也要起服务并写 progress-port.json', async () => {
  // 复现现场：profile 用 link: 挂包，脚本路径是软链，`argv[1]` 与 `import.meta.url` 的 realpath 不同。
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-au-progress-'))
  const linkDir = await mkdtemp(join(tmpdir(), 'dsh-au-link-'))
  const entry = join(linkDir, 'progress-server.mjs')
  symlinkSync(SERVER, entry)
  let progress
  try {
    // 起得来 = 入口守卫认出了软链，写端口文件是 main() 跑过的直接证据。
    // `--base` 指一个必然没人听的端口，保证判定与「本机是否真在跑 dsh web」无关。
    progress = await startProgress(stateDir, join(stateDir, 'url.txt'), 'http://127.0.0.1:1',
      ['--check-grace-ms', '100'], entry)
    const state = await (await fetch(`${progress.base}/state`)).json()
    assert.equal(state.phase, 'stopping', '软链启动的进度服务要能正常答话')
  } finally {
    progress?.kill()
    await rm(stateDir, { recursive: true, force: true })
    await rm(linkDir, { recursive: true, force: true })
  }
})

test('#423 进度页：内联的 checkLine 在页面上下文里真跑三态，且整段脚本无 ReferenceError', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-au-progress-'))
  const progress = await startProgress(stateDir, join(stateDir, 'url.txt'))
  try {
    const html = await (await fetch(`${progress.base}/`)).text()
    const script = /<script>([\s\S]+)<\/script>/.exec(html)[1]
    // 最小 DOM / fetch 桩：只要脚本能整段执行完、不炸 ReferenceError，就说明内联没写坏。
    const node = () => ({ textContent: '', className: '', dataset: {}, style: {} })
    const sandbox = createContext({
      document: { getElementById: node, querySelectorAll: () => [] },
      fetch: async () => ({ json: async () => ({ phase: 'stopping' }) }),
      setTimeout: () => 0,
      location: { replace: () => {} },
    })
    assert.doesNotThrow(() => runInContext(script, sandbox))
    const line = (check) => runInContext(`checkLine(${JSON.stringify(check)})`, sandbox)
    assert.equal(
      line({ state: 'done', problems: 3, disabled: 2, unverified: 1 }),
      '冒烟检查：3 个问题 / 已临时禁用 2 个 / 1 个未验证',
    )
    assert.equal(line({ state: 'timeout', problems: 0, disabled: 0, unverified: 0 }), '冒烟检查：检查未完成')
    assert.equal(line({ state: 'pending', problems: 0, disabled: 0, unverified: 0 }), '冒烟检查：进行中…')
    assert.equal(line(null), '', '没有摘要时不能把 undefined 渲染进页面')
  } finally {
    progress.kill()
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
    await writeFile(join(stateDir, 'boot-check.json'), bootCheck())
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

test('#300 进度：3080 活着、新地址还没出来 → 「校验新地址」', async () => {
  const host = await fakeHost()
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-au-progress-'))
  const urlFile = join(stateDir, 'url.txt')
  // 地址指向一个没人听的端口：等价于「新令牌还没写出来」，此时端口活着就是在校验。
  await writeFile(urlFile, 'http://127.0.0.1:1/?token=NOT_READY_YET_01\n')
  const progress = await startProgress(stateDir, urlFile, host.origin)
  try {
    const state = await (await fetch(`${progress.base}/state`)).json()
    assert.equal(state.phase, 'verifying', '端口活着但地址还不能认证，就是在校验')
  } finally {
    progress.kill()
    await host.close()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('#300 进度：端口活着但旧令牌还能认证 → 报「旧进程正在退出」，不倒退成「校验新地址」', async () => {
  const host = await fakeHost()
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-au-progress-'))
  const urlFile = join(stateDir, 'url.txt')
  // 点击那一刻的 url.txt：旧令牌仍然有效（这是最容易误判成「已就绪」的现场）。
  await writeFile(urlFile, `${host.origin}/?token=OLD_TOKEN_STILL_VALID_01\n`)
  const progress = await startProgress(stateDir, urlFile, host.origin)
  try {
    const state = await (await fetch(`${progress.base}/state`)).json()
    assert.equal(state.phase, 'stopping', '旧进程还没退干净，不该显示「已启动」')
  } finally {
    progress.kill()
    await host.close()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('#423 冒烟检查：新地址可达但结果文件没落盘 → 先等，落盘后才 done 并给出计数', async () => {
  const host = await fakeHost()
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-au-progress-'))
  const urlFile = join(stateDir, 'url.txt')
  const url = `${host.origin}/?token=NEW_TOKEN_SMOKE_WAIT_01`
  const progress = await startProgress(stateDir, urlFile)
  try {
    await writeFile(urlFile, `${url}\n`)
    const early = await (await fetch(`${progress.base}/state`)).json()
    assert.equal(early.phase, 'verifying', '结果没出来不许宣布完成')
    assert.equal(early.check?.state, 'pending')
    assert.equal(early.url, undefined, '冒烟没结束前不给跳转地址')

    await writeFile(join(stateDir, 'boot-check.json'), bootCheck({ problems: 2, disabled: ['dsh-awake'], unverified: ['x', 'y'] }))
    const later = await (await fetch(`${progress.base}/state`)).json()
    assert.equal(later.phase, 'done')
    assert.equal(later.url, url)
    assert.deepEqual(later.check, { state: 'done', problems: 2, disabled: 1, unverified: 2 })
  } finally {
    progress.kill()
    await host.close()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('#423 冒烟检查：超过等待上限标 timeout，但照常 done 并给地址（不阻塞跳转）', async () => {
  const host = await fakeHost()
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-au-progress-'))
  const urlFile = join(stateDir, 'url.txt')
  const url = `${host.origin}/?token=NEW_TOKEN_SMOKE_TIMEOUT_1`
  // 把 20 秒压到 100ms：验证的是「超时后照常跳转」的判定，不是真等。
  const progress = await startProgress(stateDir, urlFile, undefined, ['--check-grace-ms', '100'])
  try {
    await writeFile(urlFile, `${url}\n`)
    let state = await (await fetch(`${progress.base}/state`)).json()
    const deadline = Date.now() + 3000
    while (state.check?.state !== 'timeout' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30))
      state = await (await fetch(`${progress.base}/state`)).json()
    }
    assert.equal(state.check?.state, 'timeout', '结果文件始终缺失 → timeout')
    assert.equal(state.phase, 'done', '超时不能把用户卡在进度页')
    assert.equal(state.url, url, '超时也照常跳转')
    assert.match(state.detail, /冒烟检查未完成/)
  } finally {
    progress.kill()
    await host.close()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('#423 冒烟检查：结果文件缺失 → 先 pending，到 20s 才 timeout（注入时钟，不真等）', () => {
  const liveSince = 1_000_000
  const before = resolveCheck({ raw: '', fresh: false, now: liveSince + CHECK_GRACE_MS - 1, liveSinceMs: liveSince })
  assert.deepEqual(before, { state: 'pending', problems: 0, disabled: 0, unverified: 0 })
  const atDeadline = resolveCheck({ raw: '', fresh: false, now: liveSince + CHECK_GRACE_MS, liveSinceMs: liveSince })
  assert.equal(atDeadline.state, 'timeout')
  // 地址还没就绪（liveSince 为 null）时，等多久都不算超时——等待只在「新地址可达」后开始。
  const notLive = resolveCheck({ raw: '', fresh: false, now: liveSince + CHECK_GRACE_MS * 10, liveSinceMs: null })
  assert.equal(notLive.state, 'pending')
  // 上一轮留下的文件（fresh=false）不算本轮结果。
  const stale = resolveCheck({ raw: bootCheck(), fresh: false, now: liveSince + CHECK_GRACE_MS, liveSinceMs: liveSince })
  assert.equal(stale.state, 'timeout')
})

test('#423 冒烟检查：problems / disabled / unverified 计数正确', () => {
  const raw = bootCheck({ problems: 3, disabled: ['a', 'b'], unverified: ['c'] })
  const check = resolveCheck({ raw, fresh: true, now: 10, liveSinceMs: 0 })
  assert.deepEqual(check, { state: 'done', problems: 3, disabled: 2, unverified: 1 })
})

test('#423 冒烟检查：无问题时三个计数都是 0', () => {
  const check = resolveCheck({ raw: bootCheck(), fresh: true, now: 10, liveSinceMs: 0 })
  assert.deepEqual(check, { state: 'done', problems: 0, disabled: 0, unverified: 0 })
})

test('#423 冒烟检查：未知 schema 当「还没有结果」，不拿读不懂的文件下结论', () => {
  const raw = JSON.stringify({ schema: 2, problems: 0, disabled: [], unverified: [] })
  assert.equal(resolveCheck({ raw, fresh: true, now: 0, liveSinceMs: null }).state, 'pending')
})

test('#423 冒烟检查文案：disabled 非空时照实说「已临时禁用 X 个」', () => {
  assert.equal(
    checkLine({ state: 'done', problems: 3, disabled: 2, unverified: 1 }),
    '冒烟检查：3 个问题 / 已临时禁用 2 个 / 1 个未验证',
  )
  assert.equal(checkLine({ state: 'timeout', problems: 0, disabled: 0, unverified: 0 }), '冒烟检查：检查未完成')
  assert.equal(checkLine({ state: 'pending', problems: 0, disabled: 0, unverified: 0 }), '冒烟检查：进行中…')
})

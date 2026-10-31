import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { API } from '../lib/host/protocol.js'
import { issueTitle } from '../lib/host/report-issue.js'
import { localDate } from '../lib/host/state.js'
import { apply } from '../lib/index.js'

/**
 * 找到本机正在运行的 dsh 安装（测试用它当 installAnchor）；找不到就跳过。
 * @returns {string|undefined} dsh 的 package.json 绝对路径。
 */
function findInstallAnchor() {
  if (typeof process.env.DSH_INSTALL_ANCHOR === 'string' && process.env.DSH_INSTALL_ANCHOR !== '') {
    return process.env.DSH_INSTALL_ANCHOR
  }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    const candidate = join(root, '@deepseek-ai', 'dsh', 'package.json')
    if (existsSync(candidate)) return candidate
  } catch {
    /* 找不到就当环境不具备，测试跳过 */
  }
  return undefined
}

/**
 * 造一个最小可解析的 profile 目录。
 * @param {{plugins?:{name:string, version:string, peerDependencies?:object, dsh?:object}[]}} [options] 选项。
 * @returns {Promise<string>} profile 目录。
 */
async function makeProfile(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-au-profile-'))
  const dependencies = {}
  const bundles = []
  for (const plugin of options.plugins ?? []) {
    const pluginDir = join(dir, 'node_modules', plugin.name)
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
      join(pluginDir, 'package.json'),
      `${JSON.stringify({
        name: plugin.name,
        version: plugin.version,
        peerDependencies: plugin.peerDependencies ?? {},
        dsh: plugin.dsh ?? { bundle: { patch: './cordis.patch.yml' } },
      }, null, 2)}\n`,
    )
    await writeFile(join(pluginDir, 'cordis.patch.yml'), `\n- insert:\n    - id: ${plugin.name}\n      name: '${plugin.name}'\n`)
    dependencies[plugin.name] = plugin.version
    bundles.push(plugin.name)
  }
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'dsh-profile-test', private: true, dependencies, dsh: { profile: { bundles } } }, null, 2)}\n`,
  )
  return dir
}

/**
 * 起一个假 npm registry。
 * @param {Record<string,string>} tags dist-tags。
 * @returns {Promise<{url:string, close:()=>Promise<void>}>} 服务信息。
 */
async function makeRegistry(tags) {
  const versions = Object.fromEntries(Object.values(tags).map((version) => [version, {}]))
  const server = createServer((req, res) => {
    if (!String(req.url).startsWith('/@deepseek-ai')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ 'dist-tags': tags, versions }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * 起一个假 GitHub release API。
 * @param {Record<string,object>} releases tag → release；没列出的 tag 返回 404。
 * @returns {Promise<{url:string, calls:string[], close:()=>Promise<void>}>} 服务信息。
 */
async function makeGithub(releases) {
  const calls = []
  const server = createServer((req, res) => {
    calls.push(String(req.url))
    const tag = decodeURIComponent(String(req.url).split('/releases/tags/')[1] ?? '')
    const release = releases[tag]
    if (release === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"message":"Not Found"}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(release))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * 用假 ctx 挂载插件，并把注册出来的路由接到真 http 服务上。
 * @param {{anchor:string, profileDir:string, registry:string, githubApiBase?:string, agents?:object, home:string, stateDir:string}} options 输入。
 * @returns {Promise<{base:string, routes:any[], close:()=>Promise<void>}>} 服务信息。
 */
async function startHost(options) {
  const routes = []
  const scheduled = []
  const exits = []
  const ctx = {
    profileContext: {
      name: 'web',
      dir: options.profileDir,
      installAnchor: options.anchor,
      home: options.home,
      cwd: process.cwd(),
      startedBundles: [],
      overlays: [],
      telemetryDisabledEnv: undefined,
    },
    get: (name) => (name === 'agents' ? options.agents : undefined),
    inject: (_deps, callback) => {
      callback({ webServer: { register: (route) => { routes.push(route); return () => {} }, port: 3080 } })
    },
    effect: (fn) => fn(),
  }
  apply(ctx, {
    registry: options.registry,
    githubApiBase: options.githubApiBase,
    stateDir: options.stateDir,
    exit: (code) => exits.push(code),
    ...(options.runGh === undefined ? {} : { runGh: options.runGh }),
    scheduleHelper: async ({ stateDir, payload }) => {
      await mkdir(stateDir, { recursive: true })
      const payloadPath = join(stateDir, 'helper-payload.json')
      await writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`)
      scheduled.push(payload)
      return { scriptPath: join(stateDir, 'upgrade.sh'), payloadPath, pid: 4242 }
    },
  })
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    const route = routes.find((candidate) => candidate.path === path)
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"ok":false,"error":"no route"}')
      return
    }
    return route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    routes,
    scheduled,
    exits,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * 造一个临时环境。
 * @param {{plugins?:any[]}} [options] 选项。
 * @returns {Promise<object>} 环境。
 */
async function makeEnvironment(options = {}) {
  const anchor = findInstallAnchor()
  if (anchor === undefined) return { skip: 'no global @deepseek-ai/dsh installation found' }
  const root = await mkdtemp(join(tmpdir(), 'dsh-au-test-'))
  const home = join(root, '.dsh')
  const stateDir = join(root, 'state')
  await mkdir(home, { recursive: true })
  const profileDir = await makeProfile({ plugins: options.plugins ?? [] })
  const registry = await makeRegistry({ latest: '9.9.9', next: '9.9.9' })
  const github = await makeGithub({
    'dsh-v9.9.9': { name: 'dsh v9.9.9', body: '## 亮点\n- 假 registry 里的更新说明', html_url: 'https://example.invalid/releases/tag/dsh-v9.9.9' },
  })
  const host = await startHost({
    anchor,
    profileDir,
    registry: registry.url,
    githubApiBase: github.url,
    agents: options.agents,
    home,
    stateDir,
    runGh: options.runGh,
  })
  return {
    anchor,
    root,
    home,
    stateDir,
    profileDir,
    host,
    github,
    async close() {
      await host.close()
      await registry.close()
      await github.close()
    },
  }
}

const installedVersion = (anchor) => JSON.parse(execFileSync('node', ['-p', `JSON.stringify(require(${JSON.stringify(anchor)}).version)`], { encoding: 'utf8' }))

/**
 * 轮询等待一个条件成立（交接是 202 之后异步做的，测试不能立刻断言）。
 * @param {() => boolean} predicate 条件。
 * @param {string} what 描述。
 * @param {number} [timeoutMs] 超时。
 * @returns {Promise<void>} 完成。
 */
async function waitFor(predicate, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test('GET /status 报告真实安装版本与本机事实', async (t) => {
  const env = await makeEnvironment()
  if (env.skip !== undefined) return t.skip(env.skip)
  try {
    const response = await fetch(`${env.host.base}${API.status}`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.dsh.installed, installedVersion(env.anchor))
    assert.equal(body.capabilities.update, process.platform !== 'win32')
    assert.equal(body.helperSupported, process.platform !== 'win32')
    assert.equal(body.sessions.available, false)
  } finally {
    await env.close()
  }
})

test('GET /notes 取到假 GitHub 的更新说明，第二次走内存缓存', async (t) => {
  const env = await makeEnvironment()
  if (env.skip !== undefined) return t.skip(env.skip)
  try {
    const first = await (await fetch(`${env.host.base}${API.notes}?version=9.9.9`)).json()
    assert.equal(first.ok, true)
    assert.equal(first.version, '9.9.9')
    assert.equal(first.slug, 'deepseek-ai/deepseek-harness')
    assert.equal(first.available, true)
    assert.equal(first.tag, 'dsh-v9.9.9')
    assert.match(first.notes, /假 registry 里的更新说明/)
    assert.equal(first.cached, false)
    assert.equal(env.github.calls.length, 1)

    const second = await (await fetch(`${env.host.base}${API.notes}?version=9.9.9`)).json()
    assert.equal(second.cached, true)
    assert.equal(env.github.calls.length, 1, '缓存命中时不该再打 GitHub')
  } finally {
    await env.close()
  }
})

test('GET /notes：没有这个版本时如实说没有；版本号不合法则 400', async (t) => {
  const env = await makeEnvironment()
  if (env.skip !== undefined) return t.skip(env.skip)
  try {
    const missing = await (await fetch(`${env.host.base}${API.notes}?version=1.2.3`)).json()
    assert.equal(missing.ok, true)
    assert.equal(missing.available, false)
    assert.match(missing.reason, /dsh-v1\.2\.3/)

    const bad = await fetch(`${env.host.base}${API.notes}?version=not-a-version`)
    assert.equal(bad.status, 400)

    // 不给 version 时退回「当前安装版本」，本机装的是 0.2.x，假 GitHub 上也没有
    const fallback = await (await fetch(`${env.host.base}${API.notes}`)).json()
    assert.equal(fallback.version, installedVersion(env.anchor))
    assert.equal(fallback.available, false)
  } finally {
    await env.close()
  }
})

test('POST /check/auto 判定有更新，且当天第二次走缓存', async (t) => {
  const env = await makeEnvironment()
  if (env.skip !== undefined) return t.skip(env.skip)
  try {
    const first = await (await fetch(`${env.host.base}${API.checkAuto}`, { method: 'POST', body: '{}' })).json()
    assert.equal(first.decision, 'update-available')
    assert.equal(first.target, '9.9.9')
    assert.equal(first.cached, false)
    const second = await (await fetch(`${env.host.base}${API.checkAuto}`, { method: 'POST', body: '{}' })).json()
    assert.equal(second.cached, true)
    const forced = await (await fetch(`${env.host.base}${API.checkAuto}`, {
      method: 'POST',
      body: JSON.stringify({ force: true }),
    })).json()
    assert.equal(forced.cached, false)
  } finally {
    await env.close()
  }
})

test('过期缓存：installed / channel 变了就标 stale，/check/auto 必须重算而不是回放（issue #100）', async (t) => {
  const env = await makeEnvironment()
  if (env.skip !== undefined) return t.skip(env.skip)
  try {
    const installed = installedVersion(env.anchor)
    const today = localDate()
    const checkedAt = new Date().toISOString()
    await mkdir(env.stateDir, { recursive: true })

    /** 直接落一份「今天已检测过」的旧结论，跳过真实检测。 */
    const seedLastCheck = async (lastCheck) => {
      await writeFile(join(env.stateDir, 'state.json'), `${JSON.stringify({
        lastCheckDate: today,
        lastCheck: { date: today, checkedAt, cached: false, tags: null, incompatible: [], ...lastCheck },
      }, null, 2)}\n`)
    }

    // ① 已装版本变了（升级成功的现场）：旧结论描述的是升级前那次检测。
    await seedLastCheck({ decision: 'update-available', channel: 'latest', installed: '0.2.1-rc.5', target: '9.9.9' })
    const status = await (await fetch(`${env.host.base}${API.status}`)).json()
    assert.equal(status.lastCheck.stale, true, '升级后旧结论必须标过期')
    assert.equal(status.lastCheck.staleReason, 'installed-changed')
    assert.equal(status.dsh.installed, installed, '/status 的已装版本仍是实时值')
    assert.equal(status.lastCheck.installed, '0.2.1-rc.5', '缓存里的 installed 如实保留（用来解释「上次检查时是 X」）')

    const recomputed = await (await fetch(`${env.host.base}${API.checkAuto}`, { method: 'POST', body: '{}' })).json()
    assert.equal(recomputed.cached, false, '当天幂等不能把过期结论锁死一天，必须重算')
    assert.equal(recomputed.stale, false, '刚算出来的结论自己不过期')
    assert.equal(recomputed.installed, installed, '重算用的是实时已装版本')
    assert.equal(recomputed.decision, 'update-available')

    // ② 只换了渠道（installed 没变）：同样是过期结论。
    await seedLastCheck({ decision: 'update-available', channel: 'latest', installed, target: '9.9.9' })
    await writeFile(join(env.stateDir, 'policy.json'), `${JSON.stringify({ channel: 'next' }, null, 2)}\n`)
    const channelStatus = await (await fetch(`${env.host.base}${API.status}`)).json()
    assert.equal(channelStatus.lastCheck.stale, true, '换渠道后缓存也必须失效')
    assert.equal(channelStatus.lastCheck.staleReason, 'channel-changed')

    const channelRecomputed = await (await fetch(`${env.host.base}${API.checkAuto}`, { method: 'POST', body: '{}' })).json()
    assert.equal(channelRecomputed.cached, false, '换渠道后必须按新渠道重算')
    assert.equal(channelRecomputed.channel, 'next')
    assert.equal(channelRecomputed.target, '9.9.9', '新渠道的 dist-tag 就是新目标')

    // ③ 两项都变：优先报 installed-changed。
    await seedLastCheck({ decision: 'update-available', channel: 'alpha', installed: '0.2.1-rc.5', target: '9.9.9' })
    const bothStatus = await (await fetch(`${env.host.base}${API.status}`)).json()
    assert.equal(bothStatus.lastCheck.staleReason, 'installed-changed', '两项都变时优先 installed-changed')

    // ④ 前提没变：不 stale，当天第二次仍然走缓存（原本的幂等没被破坏）。
    const fresh = await (await fetch(`${env.host.base}${API.checkAuto}`, { method: 'POST', body: '{}' })).json()
    const consistent = await (await fetch(`${env.host.base}${API.status}`)).json()
    assert.equal(consistent.lastCheck.stale, false)
    assert.equal(consistent.lastCheck.staleReason, null)
    const cached = await (await fetch(`${env.host.base}${API.checkAuto}`, { method: 'POST', body: '{}' })).json()
    assert.equal(cached.cached, true, '前提仍成立时不许无脑重算')
    assert.equal(cached.checkedAt, fresh.checkedAt, '缓存回放的必须是同一条结论')
  } finally {
    await env.close()
  }
})

test('不兼容插件：/plugins 报不兼容，检测降级为风险，/update 拒绝且不可绕过', async (t) => {
  const env = await makeEnvironment({
    plugins: [
      {
        name: 'fake-plugin',
        version: '1.0.0',
        peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.2' },
      },
    ],
  })
  if (env.skip !== undefined) return t.skip(env.skip)
  try {
    const inventory = await (await fetch(`${env.host.base}${API.plugins}?version=9.9.9`)).json()
    assert.equal(inventory.incompatible.length, 1)
    assert.equal(inventory.incompatible[0].name, 'fake-plugin')
    assert.equal(inventory.plugins[0].exempted, false)

    const check = await (await fetch(`${env.host.base}${API.checkAuto}`, { method: 'POST', body: '{}' })).json()
    assert.equal(check.decision, 'update-with-plugin-risk')

    for (const body of [{ version: '9.9.9' }, { version: '9.9.9', acceptPluginRisk: true }, { version: '9.9.9', force: true }]) {
      const response = await fetch(`${env.host.base}${API.update}`, { method: 'POST', body: JSON.stringify(body) })
      assert.equal(response.status, 409)
      const payload = await response.json()
      assert.equal(payload.code, 'E_PLUGIN_INCOMPATIBLE')
      assert.equal(payload.detail.bypassable, false)
    }
  } finally {
    await env.close()
  }
})

test('会话门禁：有会话在跑先 409（可强制），强制后交接给 helper 并正常退出', async (t) => {
  const agents = {
    list: () => [{ status: 'running', session: { id: 'session-1', header: { title: '长任务' } } }, { status: 'idle', session: { id: 'session-2' } }],
  }
  const env = await makeEnvironment({ agents })
  if (env.skip !== undefined) return t.skip(env.skip)
  try {
    const status = await (await fetch(`${env.host.base}${API.status}`)).json()
    assert.equal(status.sessions.available, true)
    assert.equal(status.sessions.sessions.length, 1)

    const blocked = await fetch(`${env.host.base}${API.update}`, { method: 'POST', body: JSON.stringify({ version: '9.9.9' }) })
    assert.equal(blocked.status, 409)
    const blockedBody = await blocked.json()
    assert.equal(blockedBody.code, 'E_SESSIONS_RUNNING')
    assert.equal(blockedBody.detail.bypassable, true)

    const forced = await fetch(`${env.host.base}${API.update}`, { method: 'POST', body: JSON.stringify({ version: '9.9.9', force: true }) })
    assert.equal(forced.status, 202)
    const accepted = await forced.json()
    assert.equal(accepted.handoff, true)
    await waitFor(() => env.host.scheduled.length === 1, 'the helper to be scheduled')
    const payload = env.host.scheduled[0]
    assert.equal(payload.mode, 'update')
    assert.equal(payload.target, '9.9.9')
    assert.equal(payload.current, JSON.parse(await readFile(env.anchor, 'utf8')).version)
    assert.equal(payload.hostPid, process.pid)
    assert.equal(payload.port, 3080)
    assert.equal(payload.profile, 'web')
    assert.ok(Array.isArray(payload.args) && payload.args.length > 0)

    const task = await (await fetch(`${env.host.base}${API.task}?taskId=${accepted.taskId}`)).json()
    assert.equal(task.ok, true)
    assert.equal(task.task.kind, 'update')
    assert.ok(task.task.log.length > 0)

    await waitFor(() => env.host.exits.length === 1, 'the host handoff exit')
    assert.deepEqual(env.host.exits, [0], '交接后宿主必须正常退出（exit 0），否则会被 KeepAlive 再拉一次')
  } finally {
    await env.close()
  }
})

test('回滚：没有目标时 400，给出目标后交接给 helper', async (t) => {
  const env = await makeEnvironment({ agents: { list: () => [] } })
  if (env.skip !== undefined) return t.skip(env.skip)
  try {
    assert.equal((await fetch(`${env.host.base}${API.rollback}`, { method: 'POST', body: '{}' })).status, 400)
    const response = await fetch(`${env.host.base}${API.rollback}`, { method: 'POST', body: JSON.stringify({ version: '0.1.5-rc.3' }) })
    assert.equal(response.status, 202)
    await waitFor(() => env.host.scheduled.length === 1, 'the rollback helper to be scheduled')
    assert.equal(env.host.scheduled[0].mode, 'rollback')
    assert.equal(env.host.scheduled[0].target, '0.1.5-rc.3')
  } finally {
    await env.close()
  }
})

test('只重启：不安装任何东西，诊断接口回显 payload', async (t) => {
  const env = await makeEnvironment({ agents: { list: () => [] } })
  if (env.skip !== undefined) return t.skip(env.skip)
  try {
    const response = await fetch(`${env.host.base}${API.restart}`, { method: 'POST', body: '{}' })
    assert.equal(response.status, 202)
    await waitFor(() => env.host.scheduled.length === 1, 'the restart helper to be scheduled')
    assert.equal(env.host.scheduled[0].mode, 'restart')
    assert.equal(env.host.scheduled[0].target, '')

    const diagnostics = await (await fetch(`${env.host.base}${API.restartDiagnostics}`)).json()
    assert.equal(diagnostics.ok, true)
    assert.equal(diagnostics.result, null)
    assert.equal(diagnostics.payload.mode, 'restart')
    assert.equal(diagnostics.payload.port, 3080)
  } finally {
    await env.close()
  }
})

test('profileContext 缺失时优雅降级：状态 200、能力关闭、变更端点 500', async (t) => {
  const anchor = findInstallAnchor()
  if (anchor === undefined) return t.skip('no global @deepseek-ai/dsh installation found')
  const root = await mkdtemp(join(tmpdir(), 'dsh-au-degraded-'))
  const stateDir = join(root, 'state')
  const routes = []
  const ctx = {
    profileContext: {},
    get: () => undefined,
    inject: (_deps, callback) => callback({ webServer: { register: (route) => { routes.push(route); return () => {} }, port: 3080 } }),
    effect: (fn) => fn(),
  }
  apply(ctx, { registry: 'http://127.0.0.1:1', stateDir, exit: () => {}, scheduleHelper: async () => ({}) })
  const server = createServer((req, res) => {
    const route = routes.find((candidate) => candidate.path === new URL(req.url, 'http://127.0.0.1').pathname)
    if (route === undefined) {
      res.writeHead(404, { end: true })
      res.end('{}')
      return
    }
    return route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const status = await (await fetch(`${base}${API.status}`)).json()
    assert.equal(status.ok, true)
    assert.equal(status.dsh.installed, null)
    assert.match(status.dsh.error, /profileContext/)
    assert.equal(status.capabilities.update, false)
    assert.equal(status.capabilities.check, true)

    const facts = await fetch(`${base}${API.preflight}`)
    assert.equal(facts.status, 500)
    assert.equal((await facts.json()).code, 'E_PRECONDITION')

    const update = await fetch(`${base}${API.update}`, { method: 'POST', body: JSON.stringify({ version: '9.9.9' }) })
    assert.equal(update.status, 500)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('参数校验：版本、渠道、方法', async (t) => {
  const env = await makeEnvironment()
  if (env.skip !== undefined) return t.skip(env.skip)
  try {
    const current = JSON.parse(await readFile(env.anchor, 'utf8')).version
    assert.equal((await fetch(`${env.host.base}${API.update}`, { method: 'POST', body: '{}' })).status, 400)
    assert.equal((await fetch(`${env.host.base}${API.update}`, { method: 'POST', body: JSON.stringify({ version: current }) })).status, 400)
    assert.equal((await fetch(`${env.host.base}${API.update}`, { method: 'POST', body: JSON.stringify({ version: '^9.9.9' }) })).status, 400)

    const bad = await fetch(`${env.host.base}${API.policy}`, { method: 'POST', body: JSON.stringify({ channel: 'nightly' }) })
    assert.equal(bad.status, 400)
    const auto = await fetch(`${env.host.base}${API.policy}`, { method: 'POST', body: JSON.stringify({ mode: 'auto' }) })
    assert.equal(auto.status, 400)

    const good = await (await fetch(`${env.host.base}${API.policy}`, { method: 'POST', body: JSON.stringify({ channel: 'next' }) })).json()
    assert.equal(good.policy.channel, 'next')
    const persisted = await (await fetch(`${env.host.base}${API.policy}`)).json()
    assert.equal(persisted.policy.channel, 'next')

    assert.equal((await fetch(`${env.host.base}${API.status}`, { method: 'POST', body: '{}' })).status, 405)
    assert.equal((await fetch(`${env.host.base}/api/dsh-auto-upgrade/nope`)).status, 404)
  } finally {
    await env.close()
  }
})

/**
 * 造一个假的 `gh` 执行器（`apply(ctx, { runGh })` 测试缝）。
 * @param {{existing?:object[], listError?:string, createError?:string, createUrl?:string}} [options] 输入。
 * @returns {{calls:string[][], runGh:(args:string[])=>Promise<object>}} 执行器与调用记录。
 */
function makeGh(options = {}) {
  const calls = []
  async function runGh(args) {
    calls.push(args)
    if (args[0] === 'issue' && args[1] === 'list') {
      if (options.listError !== undefined) return { ok: false, stdout: '', error: options.listError }
      return { ok: true, stdout: JSON.stringify(options.existing ?? []) }
    }
    if (options.createError !== undefined) return { ok: false, stdout: '', error: options.createError }
    return { ok: true, stdout: `${options.createUrl ?? 'https://github.com/guraul/self-dsh-plugins/issues/71'}\n` }
  }
  return { calls, runGh }
}

const BLOCKING_PLUGIN = {
  name: 'fake-plugin',
  version: '1.0.0',
  peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.2' },
}

test('POST /report-issue：宿主自己生成标题/正文并调 gh 创建，返回 number/url', async (t) => {
  const gh = makeGh()
  const env = await makeEnvironment({ plugins: [BLOCKING_PLUGIN], runGh: gh.runGh })
  if (env.skip !== undefined) return t.skip(env.skip)
  try {
    const response = await fetch(`${env.host.base}${API.reportIssue}`, {
      method: 'POST',
      body: JSON.stringify({ target: '9.9.9' }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.created, true)
    assert.equal(body.number, 71)
    assert.equal(body.url, 'https://github.com/guraul/self-dsh-plugins/issues/71')

    assert.equal(gh.calls.length, 2, '必须先查重再创建')
    const [list, create] = gh.calls
    const title = issueTitle({ target: '9.9.9', plugins: [{ name: 'fake-plugin' }] })
    assert.deepEqual(list.slice(0, 2), ['issue', 'list'])
    assert.ok(list.includes('--repo') && list.includes('guraul/self-dsh-plugins'), 'repo 取自本插件 package.json')
    assert.equal(list[list.indexOf('--search') + 1], title, '查重用的标题必须与创建时完全一致')
    assert.equal(list[list.indexOf('--state') + 1], 'open')

    assert.deepEqual(create.slice(0, 2), ['issue', 'create'])
    assert.equal(create[create.indexOf('--title') + 1], title)
    const text = create[create.indexOf('--body') + 1]
    assert.match(text, /目标 dsh：`9\.9\.9`/)
    assert.match(text, /fake-plugin@1\.0\.0/, '正文必须点名阻塞插件')
    assert.match(text, /`@deepseek-ai\/dsh-tools` 要求 `\^0\.1\.0-rc\.2`/, '正文必须带 requirements')
    assert.match(text, /curl -sS -X POST http:\/\/127\.0\.0\.1:\d+\/api\/dsh-auto-upgrade\/check\/run/)
    assert.match(text, /plugins\?version=9\.9\.9/, '正文必须带复现命令')
    assert.match(text, /install-check\.sh/, '正文必须带修法')
    assert.doesNotMatch(text, /gho_|ghp_|token=/i, '不许回显任何 token')
  } finally {
    await env.close()
  }
})

test('POST /report-issue：同名 open issue 已存在时不重复创建', async (t) => {
  const title = issueTitle({ target: '9.9.9', plugins: [{ name: 'fake-plugin' }] })
  const gh = makeGh({
    existing: [{ number: 70, title, url: 'https://github.com/guraul/self-dsh-plugins/issues/70' }],
  })
  const env = await makeEnvironment({ plugins: [BLOCKING_PLUGIN], runGh: gh.runGh })
  if (env.skip !== undefined) return t.skip(env.skip)
  try {
    const body = await (await fetch(`${env.host.base}${API.reportIssue}`, {
      method: 'POST',
      body: JSON.stringify({ target: '9.9.9' }),
    })).json()
    assert.equal(body.ok, true)
    assert.equal(body.created, false)
    assert.equal(body.number, 70)
    assert.equal(gh.calls.length, 1, '命中同名 issue 时不许再调 gh issue create')
  } finally {
    await env.close()
  }
})

test('POST /report-issue：gh 不存在/未登录时 500 并给出原因', async (t) => {
  const listFailure = await makeEnvironment({
    plugins: [BLOCKING_PLUGIN],
    runGh: makeGh({ listError: 'gh: command not found' }).runGh,
  })
  if (listFailure.skip !== undefined) return t.skip(listFailure.skip)
  try {
    const response = await fetch(`${listFailure.host.base}${API.reportIssue}`, {
      method: 'POST',
      body: JSON.stringify({ target: '9.9.9' }),
    })
    assert.equal(response.status, 500)
    const body = await response.json()
    assert.equal(body.code, 'E_INTERNAL')
    assert.match(body.error, /gh issue list 失败/)
    assert.match(body.error, /command not found/)
  } finally {
    await listFailure.close()
  }

  const createFailure = await makeEnvironment({
    plugins: [BLOCKING_PLUGIN],
    runGh: makeGh({ createError: 'HTTP 401: Bad credentials' }).runGh,
  })
  if (createFailure.skip !== undefined) return t.skip(createFailure.skip)
  try {
    const response = await fetch(`${createFailure.host.base}${API.reportIssue}`, {
      method: 'POST',
      body: JSON.stringify({ target: '9.9.9' }),
    })
    assert.equal(response.status, 500)
    const body = await response.json()
    assert.match(body.error, /gh issue create 失败/)
    assert.match(body.error, /Bad credentials/)
  } finally {
    await createFailure.close()
  }
})

test('POST /report-issue：只接受精确 target，GET 不被允许，没有阻塞插件时拒绝', async (t) => {
  const gh = makeGh()
  const env = await makeEnvironment({ plugins: [BLOCKING_PLUGIN], runGh: gh.runGh })
  if (env.skip !== undefined) return t.skip(env.skip)
  try {
    assert.equal((await fetch(`${env.host.base}${API.reportIssue}`, { method: 'POST', body: '{}' })).status, 400)
    assert.equal((await fetch(`${env.host.base}${API.reportIssue}`, {
      method: 'POST',
      body: JSON.stringify({ target: '^9.9.9' }),
    })).status, 400)
    assert.equal((await fetch(`${env.host.base}${API.reportIssue}`)).status, 405)
    assert.equal(gh.calls.length, 0, '校验失败时绝不该调用 gh')
  } finally {
    await env.close()
  }

  const clean = await makeEnvironment({ runGh: gh.runGh })
  if (clean.skip !== undefined) return t.skip(clean.skip)
  try {
    const response = await fetch(`${clean.host.base}${API.reportIssue}`, {
      method: 'POST',
      body: JSON.stringify({ target: '9.9.9' }),
    })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /没有被阻塞的插件/)
    assert.equal(gh.calls.length, 0)
  } finally {
    await clean.close()
  }
})

/**
 * 门禁会放行、但 `dsh.compatibility.dshReleases` 自述不兼容的插件。
 * peer 用宽范围 `>=0.1.0`：9.9.9 满足它，所以官方门禁判「兼容」——这正是 issue #106 的现场。
 * @type {object}
 */
const DECLARED_INCOMPATIBLE = {
  name: 'declared-bad',
  version: '1.0.0',
  peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0' },
  dsh: {
    bundle: { patch: './cordis.patch.yml' },
    compatibility: { dshReleases: { '9.9.9': 'incompatible' } },
  },
}

test('自述矩阵：门禁放行但 declared=incompatible 仍点名，升级不被阻断，开 issue 正文带矩阵证据', async (t) => {
  const gh = makeGh()
  const env = await makeEnvironment({ plugins: [DECLARED_INCOMPATIBLE], runGh: gh.runGh })
  if (env.skip !== undefined) return t.skip(env.skip)
  try {
    const inventory = await (await fetch(`${env.host.base}${API.plugins}?version=9.9.9`)).json()
    assert.equal(inventory.incompatible.length, 0, '门禁确实放行了')
    const plugin = inventory.plugins[0]
    assert.equal(plugin.compatible, true)
    assert.deepEqual(plugin.declared, { verdict: 'incompatible', source: 'self-declared' }, '每个插件都带自述三态')
    assert.equal(inventory.flagged.length, 1, '自述 incompatible 必须进点名列表')
    assert.deepEqual(inventory.flagged[0].sources, ['self-declared'], '能与门禁来源区分')
    assert.equal(inventory.flagged[0].source, 'self-declared')

    const check = await (await fetch(`${env.host.base}${API.checkAuto}`, { method: 'POST', body: '{}' })).json()
    assert.equal(check.decision, 'update-available', '自述矩阵不许把检测降级成 plugin-risk')
    assert.equal(check.flagged.length, 1, '检测结果里也要有这份点名')

    const reported = await fetch(`${env.host.base}${API.reportIssue}`, {
      method: 'POST',
      body: JSON.stringify({ target: '9.9.9' }),
    })
    assert.equal(reported.status, 200)
    const create = gh.calls.find((args) => args[0] === 'issue' && args[1] === 'create')
    assert.notEqual(create, undefined, '必须真的去创建 issue')
    assert.match(create[create.indexOf('--title') + 1], /自述兼容性有问题/, '门禁放行时标题不能诬陷它「阻塞」')
    const text = create[create.indexOf('--body') + 1]
    assert.match(text, /## 自述兼容矩阵证据/, '正文必须有自述矩阵一节')
    assert.match(text, /\| `declared-bad@1\.0\.0` \| `self-declared` \| `9\.9\.9` \| `"incompatible"` \| `incompatible` \|/, '正文要带来源、矩阵原文与 verdict')
    assert.doesNotMatch(text, /没有任何矩阵记录/, '有记录就别写成缺失')

    // 关键边界：自述矩阵**不阻断升级**——门禁放行时 /update 必须照常交接。
    const update = await fetch(`${env.host.base}${API.update}`, {
      method: 'POST',
      body: JSON.stringify({ version: '9.9.9' }),
    })
    assert.equal(update.status, 202, '自述矩阵不许阻断升级')
    await waitFor(() => env.host.scheduled.length === 1, 'the helper to be scheduled')
    assert.equal(env.host.scheduled[0].target, '9.9.9')
  } finally {
    await env.close()
  }
})

test('自述矩阵：只有 unverified 时不点名、不开 issue（/report-issue 回 400），自述 compatible 同样不进点名', async (t) => {
  const gh = makeGh()
  const env = await makeEnvironment({
    plugins: [
      // 没有任何 dsh.compatibility.dshReleases：从未验证。
      { name: 'never-verified', version: '2.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0' } },
      // 明确记了 compatible：不许进点名列表。
      {
        name: 'verified-ok',
        version: '3.0.0',
        peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0' },
        dsh: {
          bundle: { patch: './cordis.patch.yml' },
          compatibility: { dshReleases: { '9.9.9': 'compatible' } },
        },
      },
    ],
    runGh: gh.runGh,
  })
  if (env.skip !== undefined) return t.skip(env.skip)
  try {
    const inventory = await (await fetch(`${env.host.base}${API.plugins}?version=9.9.9`)).json()
    assert.equal(inventory.incompatible.length, 0)
    const byName = Object.fromEntries(inventory.plugins.map((plugin) => [plugin.name, plugin]))
    assert.deepEqual(byName['never-verified'].declared, { verdict: 'unverified', source: 'self-declared' })
    assert.deepEqual(byName['verified-ok'].declared, { verdict: 'compatible', source: 'self-declared' })
    assert.deepEqual(inventory.flagged.map((plugin) => plugin.name), ['never-verified'], '接口仍如实报告未验证的插件（UI 用它折叠成一行）')

    // 「我没测过」不是「已知不兼容」：没有可开的 issue。
    const response = await fetch(`${env.host.base}${API.reportIssue}`, {
      method: 'POST',
      body: JSON.stringify({ target: '9.9.9' }),
    })
    assert.equal(response.status, 400, '只有 unverified 时必须拒绝开 issue')
    const body = await response.json()
    assert.match(body.error, /只有 1 个未验证的插件，没有已知不兼容，无需开 issue/, '错误文案要说明为什么不开')
    assert.equal(gh.calls.length, 0, '拒绝时绝不该调用 gh')
  } finally {
    await env.close()
  }
})

test('自述矩阵：已知不兼容与 unverified 混在一起时，issue 只列不兼容，unverified 只作背景一行', async (t) => {
  const gh = makeGh()
  const env = await makeEnvironment({
    plugins: [
      DECLARED_INCOMPATIBLE,
      // 没有矩阵记录：未验证，只能当背景计数。
      { name: 'never-verified', version: '2.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0' } },
    ],
    runGh: gh.runGh,
  })
  if (env.skip !== undefined) return t.skip(env.skip)
  try {
    const inventory = await (await fetch(`${env.host.base}${API.plugins}?version=9.9.9`)).json()
    assert.deepEqual(inventory.flagged.map((plugin) => plugin.name).sort(), ['declared-bad', 'never-verified'], '接口仍报告两份')

    const reported = await fetch(`${env.host.base}${API.reportIssue}`, {
      method: 'POST',
      body: JSON.stringify({ target: '9.9.9' }),
    })
    assert.equal(reported.status, 200, '有已知不兼容就必须能开 issue')
    const create = gh.calls.find((args) => args[0] === 'issue' && args[1] === 'create')
    assert.notEqual(create, undefined, '必须真的去创建 issue')
    const text = create[create.indexOf('--body') + 1]
    assert.match(text, /\| `declared-bad@1\.0\.0` \|/, '已知不兼容要进表格')
    assert.doesNotMatch(text, /never-verified/, 'unverified 不许出现在表格或点名里')
    assert.match(text, /另有 1 个插件未验证该版本/, 'unverified 只能作一行背景')
  } finally {
    await env.close()
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { API } from '../lib/host/protocol.js'
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
 * @param {{plugins?:{name:string, version:string, peerDependencies?:object}[]}} [options] 选项。
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
        dsh: { bundle: { patch: './cordis.patch.yml' } },
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

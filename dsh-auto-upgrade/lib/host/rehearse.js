/**
 * 升级预检 P3：启动预演（issue #425）。
 *
 * 在 P2 那个一次性 `DSH_HOME` / profile 里用**目标版本**的 dsh 真启动一次 web，
 * 按插件条目判定是否 `active`。预演只负责「起得来吗、条目挂上了吗」，结论只进
 * `preflight.json` 的 `p3` 与 `warnings`，**不改变 `blocked`**（起不来的原因可能与环境有关，
 * 误伤代价高）。
 *
 * 启动形态（review #426）：
 * - 不用当前宿主的 dsh：在一次性 HOME 里 `npm install --prefix <tmp> @deepseek-ai/dsh@<target>`
 *   装出目标版本，用 `<tmp>/node_modules/.bin/dsh` 启动；装不上就是 `launch: 'failed'`，
 *   **绝不**静默回退到当前二进制（那会把「目标版本起不来」伪装成「起得来」）。
 * - 必须跑 web app：`--port 0`（OS 选空闲端口）+ `--no-open`（别弹浏览器）。裸 `dsh`
 *   没有 app 参数，装出来的 profile 也没有 base/web-app，根本不会打印 URL。
 * - 从 stdout 的 `dsh web: http://127.0.0.1:<port>/?token=…` 取端口，轮询 `/`（401 也算起来）
 *   直到就绪，再收集探针标记并 kill。token 不落日志、不进错误文案。
 * - ⚠️ 不能用 `dsh web --profile probe`：`dsh web` 会展开成 `--profile web`，再加 `--profile`
 *   会报 `select a profile only once`（0.2.2-rc.3 实测）。自定义 profile 的等价形态是
 *   `dsh --profile <probe> --patch <file> --port 0 --no-open`。
 *
 * 判定口径：
 * - 装目标版本失败 / 启动器抛错 / 90s 内没有可访问的 web 端口 / 日志出现 `StartupError`
 *   → `launch: 'failed'`；
 * - 否则 `launch: 'ok'`，逐插件看探针标记：`[dsh-rehearsal] <包名> active|inactive`。
 *
 * 探针是一个只在预演时通过 `--patch` 注入的极小插件：它等 `appReady` 提交后遍历
 * Loader 条目（`entry.fiber.state === 2` 即 ACTIVE），把包名与状态写到 stdout，再写一行
 * `[dsh-rehearsal] done`。**不调用 `appExit`**：进程由预演侧在收到 `done` 后 kill，
 * 这样探针不依赖 web app 是否提供 `appExit`。这样「active」来自真实启动后的 Loader 状态，
 * 而不是猜日志文本。
 * @module dsh-plugin-auto-upgrade/host/rehearse
 */
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { dirname, join } from 'node:path'

import { DSH_PACKAGE } from './protocol.js'
import { isExactVersion } from './semver.js'

/** 启动预演上限：超过就按失败落盘，不能让 `/preflight` 任务悬着。 */
export const REHEARSAL_TIMEOUT_MS = 90_000
/** 目标版本安装上限（首次从 registry 拉整棵 dsh 树，比启动慢得多）。 */
export const REHEARSAL_INSTALL_TIMEOUT_MS = 180_000
/** 探针在 stdout 上的标记前缀。 */
export const REHEARSAL_MARKER = '[dsh-rehearsal]'
/** 探针跑完所有条目的结束标记（预演侧据此 kill，而不是等 `appExit`）。 */
export const REHEARSAL_DONE = `${REHEARSAL_MARKER} done`
/** 注入到一次性 profile 里的探针文件名（相对 profile 目录）。 */
export const REHEARSAL_PROBE_FILE = '.dsh-rehearsal-probe.mjs'
/** `--patch` overlay 文件名。 */
export const REHEARSAL_PATCH_FILE = '.dsh-rehearsal.patch.yml'
/** 目标版本 dsh 的安装前缀（相对一次性 `DSH_HOME`）。 */
export const REHEARSAL_TARGET_DIR = '.dsh-rehearsal-target'
/** 一次性 profile 必须带的 bundle：web app 的完整启动图，插件 bundle 排在它们后面。 */
export const REHEARSAL_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
/** 就绪轮询间隔。 */
const READY_POLL_MS = 50

/**
 * 预演探针源码。
 *
 * `entry.fiber.state === 2` 是 cordis 的 `FiberState.ACTIVE`（const enum 运行时被擦除，
 * 所以这里写字面量）。条目没有 fiber（被禁用 / 未挂载）一律算 inactive。
 * @returns {string} ESM 源码。
 */
export function rehearsalProbeSource() {
  return `export const name = 'dsh-auto-upgrade-rehearsal'
export const inject = ['loader', 'appReady']

export function apply(ctx) {
  ctx.appReady.onReady(() => {
    for (const entry of ctx.loader.entries()) {
      const label = entry.options?.name ?? entry.options?.id ?? 'unknown'
      const state = entry.fiber?.state === 2 ? 'active' : 'inactive'
      process.stdout.write('[dsh-rehearsal] ' + label + ' ' + state + '\\n')
    }
    process.stdout.write('[dsh-rehearsal] done\\n')
  })
}
`
}

/**
 * 把探针插进一次性 profile 的 `--patch` overlay。
 * @returns {string} YAML。
 */
export function rehearsalPatchSource() {
  return `- insert:
    - id: dsh-auto-upgrade-rehearsal
      name: './${REHEARSAL_PROBE_FILE}'
`
}

/**
 * 去重后的预期条目名（保持输入顺序）。
 * @param {string[]} names 插件包名。
 * @returns {string[]} 去重结果。
 */
export function expectedEntries(names) {
  return [...new Set((names ?? []).filter((name) => typeof name === 'string' && name !== ''))]
}

/**
 * 从启动日志里收集探针标记。
 * @param {string} log stdout + stderr。
 * @returns {Map<string, 'active'|'inactive'>} 包名 → 状态（同一包名后出现的标记覆盖前面的）。
 */
export function parseRehearsalMarkers(log) {
  const states = new Map()
  const pattern = /^\[dsh-rehearsal\]\s+(.+?)\s+(active|inactive)\s*$/
  for (const raw of String(log ?? '').split('\n')) {
    const matched = pattern.exec(raw.trim())
    if (matched !== null) states.set(matched[1], matched[2])
  }
  return states
}

/**
 * 从启动日志里取出 web 端口。
 *
 * 只认 dsh 自己打印的 `dsh web: <url>` 行；**刻意丢掉 query**（里面有 token），
 * 返回值只用于轮询和错误文案。
 * @param {string} log stdout + stderr。
 * @returns {{origin:string, port:number}|null} 端口信息；没打印 / 解析失败返回 null。
 */
export function parseWebUrlLine(log) {
  const matched = /dsh web:\s+(https?:\/\/\S+)/.exec(String(log ?? ''))
  if (matched === null) return null
  let url
  try {
    url = new URL(matched[1])
  } catch {
    return null
  }
  const port = Number(url.port)
  if (!Number.isInteger(port) || port <= 0) return null
  return { origin: `${url.protocol}//${url.hostname}:${port}`, port }
}

/**
 * web 启动参数。
 *
 * 启动器只吃自己的 `--profile` / `--patch`，第一个不认识的参数（`--port`）起后面全部
 * 原样转给 web app——所以顺序不能换。
 * @param {string} profileName 一次性 profile 名。
 * @param {string} patchPath `--patch` overlay 路径。
 * @returns {string[]} argv。
 */
export function buildRehearsalArgs(profileName, patchPath) {
  return ['--profile', profileName, '--patch', patchPath, '--port', '0', '--no-open']
}

/**
 * 把一次性 profile 补成「能启动 web」：`dsh.profile.bundles` 前面补 base + web-app。
 *
 * P2 建的 profile 只有 `plugin add` 自动激活的插件 bundle，没有 web app；
 * 不补的话 `dsh --profile probe` 挂完插件就退出，永远不会打印 URL。
 * 依赖与其它 `dsh.profile` 字段原样保留。
 * @param {string} profileDir profile 目录。
 * @returns {Promise<object>} 写回后的 manifest。
 */
export async function prepareRehearsalProfile(profileDir) {
  await mkdir(profileDir, { recursive: true })
  const manifestPath = join(profileDir, 'package.json')
  let manifest = {}
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) manifest = parsed
  } catch {
    manifest = {}
  }
  const current = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const bundles = [
    ...REHEARSAL_BUNDLES.filter((name) => !current.includes(name)),
    ...current,
  ]
  const next = {
    name: typeof manifest.name === 'string' ? manifest.name : `dsh-profile-rehearsal`,
    private: true,
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh?.profile,
        bundles,
      },
    },
  }
  await writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/**
 * 默认 npm 可执行文件：与当前 Node 同目录（nvm 多版本时不要用 PATH 里碰巧那个）。
 * @returns {string} npm 路径。
 */
export function defaultNpmBinary() {
  const name = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return join(dirname(process.execPath), name)
}

/**
 * 跑一条命令，永不抛错（超时也折成结果）。
 * @param {string} command 可执行文件。
 * @param {string[]} args 参数。
 * @param {{timeoutMs:number, cwd?:string, env?:Record<string,string>}} options 选项。
 * @returns {Promise<{status:number|null, stdout:string, stderr:string}>} 结果。
 */
function runCommand(command, args, options) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: options.timeoutMs,
        cwd: options.cwd,
        env: options.env,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const status = error === null ? 0 : (typeof error.code === 'number' ? error.code : null)
        resolve({ status, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })
}

/**
 * 错误文案里的 stderr 截断（不把整段 npm 日志塞进 `preflight.json`）。
 * @param {unknown} text 文本。
 * @returns {string} 单行、最多 300 字符。
 */
function shortText(text) {
  return String(text ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '').join(' / ').slice(0, 300)
}

/**
 * 在一次性目录里装出**目标版本**的 dsh。
 *
 * 只用 `npm install --prefix` 装到临时目录，不碰全局安装。失败一律返回
 * `{ok:false, error}`，由调用方落成 `launch: 'failed'`——**没有回退**。
 * @param {object} options 输入。
 * @param {string} options.version 目标版本（精确版本号）。
 * @param {string} options.dir 安装前缀（`<dir>/node_modules/...`）。
 * @param {string} [options.npmBin] npm 可执行文件。
 * @param {Record<string,string>} [options.env] 子进程环境。
 * @param {number} [options.timeoutMs] 安装超时。
 * @param {(command:string, args:string[], options:object) => Promise<{status:number|null, stdout?:string, stderr?:string}>} [options.run] 执行器（测试缝）。
 * @returns {Promise<{ok:true, dshBin:string} | {ok:false, error:string}>} 安装结果。
 */
export async function installTargetDsh(options) {
  const version = options.version
  if (!isExactVersion(version)) {
    return { ok: false, error: `目标版本不是精确版本号：${String(version)}` }
  }
  const dir = options.dir
  const spec = `${DSH_PACKAGE}@${version}`
  const npmBin = options.npmBin ?? defaultNpmBinary()
  const run = options.run ?? runCommand
  try {
    await mkdir(dir, { recursive: true })
    const result = await run(
      npmBin,
      ['install', '--prefix', dir, '--no-audit', '--no-fund', '--loglevel', 'error', spec],
      { timeoutMs: options.timeoutMs ?? REHEARSAL_INSTALL_TIMEOUT_MS, env: options.env },
    )
    if (result?.status !== 0) {
      const detail = shortText(result?.stderr)
      return {
        ok: false,
        error: `安装目标版本 ${version} 失败（npm 退出码 ${String(result?.status ?? 'null')}）${detail === '' ? '' : `：${detail}`}`,
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: `安装目标版本 ${version} 失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const dshBin = join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
  try {
    await stat(dshBin)
  } catch {
    return { ok: false, error: `安装目标版本 ${version} 后找不到可执行文件 ${dshBin}` }
  }
  return { ok: true, dshBin }
}

/**
 * 默认启动器：spawn 一个进程，把 stdout / stderr 累积成日志。
 *
 * 返回句柄而不是 Promise，因为预演要在进程还活着的时候做就绪轮询。
 * @param {string} command 可执行文件。
 * @param {string[]} args 参数。
 * @param {{cwd?:string, env?:Record<string,string>}} options 选项。
 * @returns {{output:() => string, exited:Promise<{code:number|null, signal:string|null}|{code:null, error:Error}>, kill:(signal?:NodeJS.Signals) => void}} 句柄。
 */
export function launchDsh(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let log = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => { log += chunk })
  child.stderr?.on('data', (chunk) => { log += chunk })
  const exited = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }))
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  return {
    output: () => log,
    exited,
    kill: (signal = 'SIGTERM') => {
      try {
        child.kill(signal)
      } catch {
        // 已经退出：kill 抛错没有意义。
      }
    },
  }
}

/**
 * 轮询 web 根路径：**任何** HTTP 响应（含 401）都算起来了。
 * @param {number} port 端口。
 * @param {number} [timeoutMs] 单次请求超时。
 * @returns {Promise<{ok:boolean, status?:number}>} 结果。
 */
export function checkHttpRoot(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const request = httpGet({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (response) => {
      response.resume()
      resolve({ ok: true, status: response.statusCode })
    })
    request.on('timeout', () => {
      request.destroy()
      resolve({ ok: false })
    })
    request.on('error', () => resolve({ ok: false }))
  })
}

/**
 * 等就绪、等探针跑完，然后 kill。
 *
 * 三种结束方式：收到 `done`、进程自己退出、整个 90s 预算用尽（`timedOut`）。
 * @param {{output:() => string, exited:Promise<object>, kill:() => void}} handle 进程句柄。
 * @param {{timeoutMs:number, checkReady:(port:number) => Promise<{ok:boolean}>}} options 选项。
 * @returns {Promise<{url:{origin:string, port:number}|null, ready:boolean, timedOut:boolean, exit:object|null, log:string}>} 观察结果。
 */
async function waitForLaunch(handle, options) {
  const deadline = Date.now() + options.timeoutMs
  let exitInfo = null
  void handle.exited.then((info) => { exitInfo = info })
  let url = null
  let ready = false
  let timedOut = false
  for (;;) {
    const text = handle.output()
    if (url === null) url = parseWebUrlLine(text)
    if (url !== null && !ready) {
      let check
      try {
        check = await options.checkReady(url.port)
      } catch {
        check = { ok: false }
      }
      ready = check?.ok === true
    }
    if (ready && text.includes(REHEARSAL_DONE)) break
    if (exitInfo !== null) break
    if (Date.now() >= deadline) {
      timedOut = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
  }
  let exit = /** @type {object|null} */ (exitInfo)
  if (exit === null) {
    handle.kill()
    exit = await Promise.race([
      handle.exited,
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ])
  }
  return { url, ready, timedOut, exit, log: handle.output() }
}

/**
 * 纯判定一次预演结果。
 * @param {object} options 输入。
 * @param {number|string|null} [options.exitCode] 进程退出码（spawn 失败为 null）。
 * @param {boolean} [options.timedOut] 是否超时。
 * @param {boolean} [options.ready] web 端口是否可访问（旧调用方不传则跳过该检查）。
 * @param {string} [options.log] stdout + stderr。
 * @param {string[]} [options.entries] 预期插件包名。
 * @param {number} [options.timeoutMs] 超时上限（错误文案用）。
 * @returns {{ok:boolean, launch:'ok'|'failed', entries:Record<string,'active'|'inactive'>, error?:string}} P3 结论。
 */
export function judgeRehearsal(options = {}) {
  const entries = expectedEntries(options.entries)
  const allInactive = Object.fromEntries(entries.map((name) => [name, 'inactive']))
  const timeoutMs = options.timeoutMs ?? REHEARSAL_TIMEOUT_MS
  if (options.timedOut === true) {
    return {
      ok: false,
      launch: 'failed',
      entries: allInactive,
      error: `启动预演超时（${timeoutMs}ms）`,
    }
  }
  const log = String(options.log ?? '')
  if (log.includes('StartupError')) {
    return {
      ok: false,
      launch: 'failed',
      entries: allInactive,
      error: '启动日志出现 StartupError',
    }
  }
  // 收到 done 说明探针跑完了；进程是被我们 kill 的，退出码不可用。
  const finished = log.includes(REHEARSAL_DONE)
  if (!finished && options.exitCode !== 0) {
    return {
      ok: false,
      launch: 'failed',
      entries: allInactive,
      error: `dsh 退出码 ${String(options.exitCode ?? 'null')}`,
    }
  }
  if (options.ready === false) {
    return {
      ok: false,
      launch: 'failed',
      entries: allInactive,
      error: `启动后没有可访问的 web 端口（${timeoutMs}ms 内未就绪）`,
    }
  }
  const observed = parseRehearsalMarkers(log)
  const states = {}
  for (const name of entries) {
    states[name] = observed.get(name) === 'active' ? 'active' : 'inactive'
  }
  return {
    ok: entries.every((name) => states[name] === 'active'),
    launch: 'ok',
    entries: states,
  }
}

/**
 * 在一次性 `DSH_HOME` 的 profile 里真启动一次并判定。
 *
 * `install` / `launch` / `checkReady` 都可注入：单测用假实现，不真起进程、不联网。
 * 安装目标和启动器抛错都折成 `launch: 'failed'`，保证 `/preflight` 任务不会因为预演本身
 * 而整体失败。
 * @param {object} options 输入。
 * @param {string} options.targetVersion 目标 dsh 版本（**必须**是精确版本号）。
 * @param {string} options.dshHome 一次性 DSH_HOME（P2 已建好 profile 并试装）。
 * @param {string} options.profileName 一次性 profile 名。
 * @param {string[]} [options.entries] 预期插件包名。
 * @param {number} [options.timeoutMs] 启动预演超时上限。
 * @param {string} [options.npmBin] npm 可执行文件（默认与当前 Node 同目录）。
 * @param {string} [options.cwd] 子进程工作目录（默认一次性 HOME）。
 * @param {Function} [options.install] 装目标版本（测试缝）。
 * @param {(command:string, args:string[], options:object) => Promise<object>} [options.launch] 启动器（测试缝）。
 * @param {(port:number) => Promise<{ok:boolean}>} [options.checkReady] 就绪探测（测试缝）。
 * @param {Function} [options.run] 安装命令执行器（测试缝，透传给 `installTargetDsh`）。
 * @returns {Promise<{ok:boolean, launch:'ok'|'failed', entries:Record<string,'active'|'inactive'>, error?:string}>} P3 结论。
 */
export async function runRehearsal(options) {
  const timeoutMs = options.timeoutMs ?? REHEARSAL_TIMEOUT_MS
  const entries = expectedEntries(options.entries)
  const inactive = () => Object.fromEntries(entries.map((name) => [name, 'inactive']))
  const profileDir = join(options.dshHome, 'profiles', options.profileName)
  const probePath = join(profileDir, REHEARSAL_PROBE_FILE)
  const patchPath = join(profileDir, REHEARSAL_PATCH_FILE)
  const env = {
    ...process.env,
    DSH_HOME: options.dshHome,
    // 预演不需要遥测；也不读取真实 profile 的开关。
    DSH_TELEMETRY_DISABLED: '1',
  }
  try {
    await prepareRehearsalProfile(profileDir)
    await writeFile(probePath, rehearsalProbeSource(), 'utf8')
    await writeFile(patchPath, rehearsalPatchSource(), 'utf8')
    const install = options.install ?? installTargetDsh
    const installed = await install({
      version: options.targetVersion,
      dir: join(options.dshHome, REHEARSAL_TARGET_DIR),
      npmBin: options.npmBin,
      env,
      run: options.run,
    })
    if (installed?.ok !== true) {
      return {
        ok: false,
        launch: 'failed',
        entries: inactive(),
        error: installed?.error ?? '无法安装目标版本 dsh',
      }
    }
    const launch = options.launch
      ?? ((command, args, launchOptions) => Promise.resolve(launchDsh(command, args, launchOptions)))
    const handle = await launch(installed.dshBin, buildRehearsalArgs(options.profileName, patchPath), {
      cwd: options.cwd ?? options.dshHome,
      env,
      timeoutMs,
    })
    const outcome = await waitForLaunch(handle, {
      timeoutMs,
      checkReady: options.checkReady ?? checkHttpRoot,
    })
    return judgeRehearsal({
      exitCode: outcome.exit !== null && typeof outcome.exit === 'object' ? (outcome.exit.code ?? null) : null,
      timedOut: outcome.timedOut,
      ready: outcome.ready,
      log: outcome.log,
      entries,
      timeoutMs,
    })
  } catch (error) {
    return {
      ok: false,
      launch: 'failed',
      entries: inactive(),
      error: `启动预演执行失败：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    await rm(probePath, { force: true }).catch(() => {})
    await rm(patchPath, { force: true }).catch(() => {})
  }
}

/**
 * 宿主半边：自升级插件的路由族。
 *
 * 设计权威见 `docs/design/dsh-auto-upgrade-T1.md`。
 *
 * 两半的分界很清楚：
 * - **只读半边**（status / check / preflight / plugins / policy / settings）在宿主里直接跑；
 * - **变更半边**（update / rollback / restart）宿主只做「门禁 → 备份 → 落 payload → fork
 *   脱离进程的 helper → 正常退出」，真正的停服 / `npm install -g` / 校验 / 拉起都在 helper 里
 *   （见 `lib/host/upgrade.js` 的说明）。
 * @module dsh-plugin-auto-upgrade
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createBackup, findLatestBackup, timestamp } from './host/backup.js'
import { evaluatePlugins, readInventory } from './host/compat.js'
import { entryCandidates, linkTargets, pluginIdFromSource, probeCacheEntries, runProbes } from './host/probe.js'
import { runSmokes } from './host/smoke.js'
import { appendCompatRow, buildRefillPlan, compatRow, patchCompatibility } from './host/refill.js'
import { openRefillPullRequest } from './host/refill-pr.js'
import { runProbeWithProfile } from './host/probe-run.js'
import { maybeReportSmokeFailures } from './host/smoke-issue.js'
import { originDecision, tokenAccepted, tokenOf } from './host/token-url.js'
import { refreshUrlFile, repoRootFrom } from './host/url-file.mjs'
import { createRoute, readJsonBody, RequestError, writeJson } from './host/http.js'
import { isLoopbackRequest } from './host/loopback.js'
import { DEFAULT_GITHUB_API, fetchReleaseNotes, repositorySlug } from './host/notes.js'
import { loadOfficialAppBoot } from './host/official.js'
import {
  defaultRunGh,
  issueBody,
  issueTitle,
  ReportError,
  reportablePlugins,
  reportIssue as createIssue,
  unverifiedPlugins,
} from './host/report-issue.js'
import { ALLOW_SCRIPTS, API, CHANNELS, CODE, DECISION, DEFAULT_REGISTRY, DSH_PACKAGE } from './host/protocol.js'
import { fetchPackument } from './host/registry.js'
import { compareVersions, isExactVersion } from './host/semver.js'
import { listRunningSessions } from './host/sessions.js'
import { checkStaleness } from './host/staleness.js'
import { localDate, openStores, resolveStateDir } from './host/state.js'
import { TaskRegistry } from './host/tasks.js'
import { preflight, readInstalledVersion, resolveInstallation, run } from './host/toolchain.js'
import {
  LOG_FILE,
  RESULT_FILE,
  readPayload,
  readResult,
  scheduleHelper as defaultScheduleHelper,
} from './host/upgrade.js'

/** 一次性试装用的 profile 名：建目录与跑探针两处必须一致（#392）。 */
const PROBE_PROFILE_NAME = 'probe'
const ownPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const BIN_NAME = 'dsh'
const RESTART_LOG_TAIL_BYTES = 16384
const HANDOFF_EXIT_DELAY_MS = 600

/** 插件 id（cordis 里就是包名）。 */
export const name = 'dsh-auto-upgrade'
/** 需要的宿主服务。`agents` 用 `ctx.get` 可选获取，不在这里硬性声明。 */
export const inject = ['webServer']

/**
 * 读取有界文本文件尾部。
 * @param {string} path 文件。
 * @param {number} bytes 上限。
 * @returns {string[]} 行数组；读不到返回空数组。
 */
function tailLines(path, bytes = RESTART_LOG_TAIL_BYTES) {
  try {
    const raw = readFileSync(path, 'utf8')
    return raw.slice(-bytes).split('\n').filter((line) => line !== '')
  } catch {
    return []
  }
}

/**
 * release notes 的内存缓存时长：同一天里反复打开确认卡不必反复打 GitHub。
 * 只缓存「这次请求的结果」，不落盘——它随时可以再取。
 */
const NOTES_CACHE_TTL_MS = 10 * 60 * 1000

/**
 * 校验请求体是 JSON 对象。
 * @param {unknown} body 请求体。
 * @param {string} what 用途描述。
 * @returns {Record<string, unknown>} 对象。
 * @throws {RequestError} 400。
 */
function expectObject(body, what) {
  if (body === undefined) return {}
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError(400, CODE.BAD_REQUEST, `${what} must be a JSON object`)
  }
  return body
}

/**
 * 校验精确版本号字段。
 * @param {unknown} value 候选值。
 * @param {string} field 字段名。
 * @returns {string|undefined} 合法时返回字符串。
 * @throws {RequestError} 400。
 */
function expectVersion(value, field) {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || !isExactVersion(value)) {
    throw new RequestError(400, CODE.BAD_REQUEST, `${field} must be an exact semantic version`)
  }
  return value
}

/**
 * 挂载路由族。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文。
 * @param {object} [config] 入口配置；`stateDir` / `registry` 是正式字段，`exit` / `scheduleHelper` 是测试缝。
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const profileContext = ctx.profileContext ?? {}
  const profileDir = typeof profileContext.dir === 'string' ? profileContext.dir : undefined
  const installAnchor = typeof profileContext.installAnchor === 'string' ? profileContext.installAnchor : undefined
  const dshHome = typeof profileContext.home === 'string' && profileContext.home !== ''
    ? profileContext.home
    : join(process.env.HOME ?? '', '.dsh')
  const stateDir = typeof config.stateDir === 'string' && config.stateDir !== '' ? config.stateDir : resolveStateDir()
  // `url.txt` 是**配置文件**：它记着当前进程的启动地址（含令牌）。插件每次启动会刷新它（#365）。
  // 默认从插件自身位置推仓库根，测试/特殊部署可用 `config.urlFile` 覆盖。
  const urlFile = typeof config.urlFile === 'string' && config.urlFile !== ''
    ? config.urlFile
    : (() => {
      const root = repoRootFrom(import.meta.url)
      return root === undefined ? '' : join(root, '.dsh-web', 'url.txt')
    })()
  const registry = typeof config.registry === 'string' && config.registry !== '' ? config.registry : DEFAULT_REGISTRY
  /** GitHub API 基址；只读、只为取 release notes，单测会指到假服务器。 */
  const githubApiBase = typeof config.githubApiBase === 'string' && config.githubApiBase !== ''
    ? config.githubApiBase
    : DEFAULT_GITHUB_API
  const stores = openStores(stateDir)
  const tasks = new TaskRegistry()
  const restartLogPath = join(stateDir, LOG_FILE)
  const restartResultPath = join(stateDir, RESULT_FILE)
  /** 测试缝：默认真的退进程（交接就是这么设计的）。 */
  const exitProcess = typeof config.exit === 'function' ? config.exit : (code) => process.exit(code)
  /** 测试缝：默认真的 fork helper。 */
  const scheduleHelperSeam = typeof config.scheduleHelper === 'function' ? config.scheduleHelper : defaultScheduleHelper
  /** 测试缝：默认真的执行 `gh`。 */
  const runGhSeam = typeof config.runGh === 'function' ? config.runGh : defaultRunGh
  /** helper 是 POSIX sh 脚本，Windows 上不假装支持。 */
  const helperSupported = process.platform !== 'win32'

  let installation
  let installationError
  /** release notes 缓存：`<slug>@<version>` → `{at, value}`。 */
  const notesCache = new Map()
  try {
    installation = resolveInstallation(profileContext)
  } catch (error) {
    installationError = error instanceof Error ? error.message : String(error)
  }

  /** @returns {any} 当前活着的 AgentRegistry（可能不可用）。 */
  const getAgents = () => {
    try {
      if (typeof ctx.get === 'function') {
        const service = ctx.get('agents')
        if (service !== undefined) return service
      }
    } catch {
      /* 服务未提供时继续尝试属性访问 */
    }
    try {
      return ctx.agents
    } catch {
      return undefined
    }
  }

  /**
   * 前置体检（只读）。
   * @returns {Promise<object>} 体检结果。
   */
  const runPreflight = async () => {
    if (installation === undefined) {
      throw new RequestError(500, CODE.PRECONDITION, installationError ?? 'dsh installation is unresolved')
    }
    return preflight({
      installation,
      profileName: profileContext.name,
      dshHome,
      stateDir,
      backupBase: `${dshHome}.bak-<时间戳>`,
    })
  }

  /**
   * 读 profile 插件并按目标版本判定兼容性。
   * @param {string} targetVersion 目标版本。
   * @returns {Promise<object>} 判定结果。
   */
  const inspectPlugins = async (targetVersion) => {
    if (profileDir === undefined || installAnchor === undefined) {
      return {
        plugins: [],
        incompatible: [],
        flagged: [],
        exemptions: {},
        inventoryError: 'profileContext is unavailable; cannot inspect profile plugins',
      }
    }
    const official = await loadOfficialAppBoot(installAnchor)
    const { dependencies, error } = await readInventory(official, { binName: BIN_NAME, profileDir, installAnchor })
    const verdict = await evaluatePlugins({ official, profileDir, dependencies, targetVersion })
    return { ...verdict, inventoryError: error }
  }

  /**
   * 一次完整检测：registry → 目标版本 → 插件预检 → 体检 → 当日幂等。
   * @param {{trigger:'auto'|'manual', force?:boolean}} options 触发方式。
   * @returns {Promise<object>} 检测结果。
   */
  const performCheck = async (options) => {
    const today = localDate()
    const policy = await stores.policy.read()
    const installed = installation === undefined ? undefined : await readInstalledVersion(installation.manifestPath)

    if (options.trigger === 'auto' && options.force !== true) {
      const state = await stores.state.read()
      if (state.lastCheckDate === today && state.lastCheck !== null) {
        // 「当天只检测一次」只对**前提仍然成立**的快照生效：升级成功或换渠道之后，
        // 旧结论描述的是过去，回放它就是在拿过期缓存当结论（issue #100）。
        if (checkStaleness(state.lastCheck, { installed, channel: policy.channel }).stale !== true) {
          return { ...state.lastCheck, stale: false, staleReason: null, cached: true, sessions: listRunningSessions(getAgents()) }
        }
      }
    }

    const packument = policy.channel === 'exact'
      ? { ok: true, tags: {}, versions: [] }
      : await fetchPackument(registry, DSH_PACKAGE)
    const target = policy.channel === 'exact'
      ? (policy.exactVersion === '' ? undefined : policy.exactVersion)
      : (packument.ok ? packument.tags[policy.channel] : undefined)

    const compat = installation === undefined
      ? { plugins: [], incompatible: [], flagged: [], exemptions: {}, inventoryError: installationError }
      : await inspectPlugins(target ?? installed ?? '0.0.0')
    const facts = installation === undefined ? null : await runPreflight().catch((error) => ({ error: error.message }))

    let decision
    if (!packument.ok) decision = DECISION.UNKNOWN
    else if (target === undefined) decision = DECISION.UNKNOWN
    else if (installed === undefined) decision = DECISION.UNKNOWN
    else {
      const delta = compareVersions(target, installed)
      if (delta < 0) decision = DECISION.DOWNGRADE_GUARD
      else if (delta === 0) decision = DECISION.UP_TO_DATE
      else decision = compat.incompatible.length > 0 ? DECISION.UPDATE_WITH_PLUGIN_RISK : DECISION.UPDATE_AVAILABLE
    }

    const payload = {
      checkedAt: new Date().toISOString(),
      date: today,
      trigger: options.trigger,
      cached: false,
      // 刚算出来的结论，前提就是此刻的已装版本与渠道：必然不过期。
      stale: false,
      staleReason: null,
      decision,
      channel: policy.channel,
      installed,
      target,
      tags: packument.ok ? packument.tags : null,
      registry,
      registryError: packument.ok ? null : packument.error,
      plugins: compat.plugins,
      incompatible: compat.incompatible,
      // 自述矩阵的点名项（含 `unverified`）：只用于提示与开 issue，**不参与 decision**。
      flagged: compat.flagged,
      exemptions: compat.exemptions,
      inventoryError: compat.inventoryError ?? null,
      preflight: facts,
      sessions: listRunningSessions(getAgents()),
    }
    await stores.state.patch({
      lastCheckDate: today,
      lastCheck: payload,
      installed: installed ?? null,
      updatedAt: payload.checkedAt,
    })
    return payload
  }

  /**
   * 升级门禁：会话（可强制继续）与插件不兼容（不升级，只警告）。
   * @param {{targetVersion:string, force?:boolean}} options 输入。
   * @returns {Promise<{sessions:object, plugins:object}>} 通过门禁时返回现场事实。
   * @throws {RequestError} 409。
   */
  const assertUpgradeAllowed = async (options) => {
    const sessions = listRunningSessions(getAgents())
    if (options.force !== true && sessions.sessions.length > 0) {
      throw new RequestError(
        409,
        CODE.SESSIONS_RUNNING,
        `有 ${sessions.sessions.length} 个会话正在执行；升级会中断它们`,
        { sessions: sessions.sessions, bypassable: true },
      )
    }
    const plugins = await inspectPlugins(options.targetVersion)
    if (plugins.incompatible.length > 0) {
      throw new RequestError(
        409,
        CODE.PLUGIN_INCOMPATIBLE,
        `目标版本 ${options.targetVersion} 与 ${plugins.incompatible.length} 个已装插件不兼容；按当前策略不执行升级`,
        { plugins: plugins.incompatible, bypassable: false },
      )
    }
    return { sessions, plugins }
  }

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    /** @type {(() => void)[]} */
    const disposers = []
    /**
     * 注册一条路径（同路径的各方法在这里分派）。
     * @param {string} path 绝对路径。
     * @param {Record<string, Function>} handlers 方法表。
     * @returns {void}
     */
    /**
     * 启动时 url.txt 里的令牌 = **上一个进程**的令牌；重启后没重开的页面还拿着它（#377）。
     *
     * **同步读**：异步读的话，抓取完成前到达的写请求会拿到 undefined，旧页面照样 401（#383 的用例抓到的）。
     * 文件只有一个 URL，同步读的代价可以忽略。
     */
    let previousToken
    try {
      previousToken = tokenOf(readFileSync(urlFile, 'utf8'))
    } catch {
      previousToken = undefined
    }
    /** 上一个令牌的宽限期：够用户点一下按钮，又不至于让旧令牌长期可用。 */
    const PREVIOUS_TOKEN_GRACE_MS = 10 * 60 * 1000
    const loadedAt = Date.now()

    /**
     * 写操作要不要放行（issue #363 → #379）。
     *
     * 宿主给浏览器用的是 **HttpOnly + SameSite=Strict** 的 cookie，并把带令牌的地址 303 重定向到干净地址，
     * 所以页面 URL 里根本没有 `?token=`——强求浏览器带令牌必然 401（真机实测）。
     * 改成按**请求来源**判定：
     *   - `Sec-Fetch-Site: same-origin` → 放行（GUI 自己；这个头由浏览器设置，网页伪造不了）；
     *   - `cross-site` / `same-site` → 拒绝（跨站 CSRF 的真正威胁）；
     *   - 没有这个头（curl / 脚本）→ 仍要令牌（`url.txt` 是 0600，脚本读得到）。
     * @param {import('node:http').IncomingMessage} req 请求。
     * @returns {Promise<boolean>} 放行返回 true。
     */
    const writeAllowed = async (req) => {
      const site = req.headers['sec-fetch-site']
      const from = Array.isArray(site) ? site[0] : site
      const decision = originDecision(from)
      if (decision === 'allow') return true
      if (decision === 'deny') return false
      return tokenValid(req)
    }

    /**
     * 令牌校验：只用于没有 `Sec-Fetch-Site` 的调用方（脚本 / curl）。
     * 当前令牌永远可用；上一个令牌只在启动后 10 分钟内可用（#377）。
     * @param {import('node:http').IncomingMessage} req 请求。
     * @returns {Promise<boolean>} 令牌正确返回 true。
     */
    const tokenValid = async (req) => {
      if (urlFile === '') return false
      let current
      try {
        current = tokenOf(await readFile(urlFile, 'utf8'))
      } catch {
        return false
      }
      if (current === undefined) return false
      const header = req.headers['x-dsh-token']
      const fromHeader = Array.isArray(header) ? header[0] : header
      const presented = typeof fromHeader === 'string'
        ? fromHeader
        : new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token')
      return tokenAccepted({
        current,
        previous: previousToken,
        presented: presented ?? undefined,
        ageMs: Date.now() - loadedAt,
        graceMs: PREVIOUS_TOKEN_GRACE_MS,
      })
    }

    /** 把写操作包上令牌校验；读操作原样透传。 */
    const guardWrites = (handlers) => {
      const wrapped = {}
      for (const [method, handler] of Object.entries(handlers)) {
        wrapped[method] = method === 'POST'
          ? async (req, res) => {
            if (!(await writeAllowed(req))) {
              throw new RequestError(401, CODE.UNAUTHORIZED, '缺少或无效的启动令牌（x-dsh-token）')
            }
            return handler(req, res)
          }
          : handler
      }
      return wrapped
    }

    const route = (path, handlers) => {
      disposers.push(webServer.register({ kind: 'exact', path, handler: createRoute(guardWrites(handlers), isLoopbackRequest) }))
    }

    /**
     * 起一个「重启进度服务」（issue #300 的重启 UI）。
     *
     * 点升级/重启后本宿主会退出，页面就再也问不到进度；而重启完又换了新令牌，旧页面
     * 连新宿主都问不了（401）。所以进度必须由**不随宿主死掉**的独立进程来报。
     * 它 detached 存活，端口由系统分配（写进 `progress-port.json`），完成或超时后自己退出。
     * @returns {Promise<string|undefined>} 进度页地址；起不来则 undefined（退回 watchdog 行为）。
     */
    const startProgressServer = async () => {
      const scriptPath = fileURLToPath(new URL('./host/progress-server.mjs', import.meta.url))
      const portFile = join(stateDir, 'progress-port.json')
      await rm(portFile, { force: true }).catch(() => {})
      try {
        const child = spawn(process.execPath, [
          scriptPath,
          '--state', stateDir,
          '--label', typeof process.env.XPC_SERVICE_NAME === 'string' ? process.env.XPC_SERVICE_NAME : '',
          // 不再传 stateDir/url.txt：**没有任何代码写那份文件**，读它只会拿到过期令牌（issue #365）。
          // 进度页服务自己会从 launchd 找到正确路径；找不到就该报错，而不是读一个没人维护的文件。
          '--port', '0',
        ], { detached: true, stdio: 'ignore' })
        child.unref()
        for (let i = 0; i < 40; i += 1) {
          try {
            const { port } = JSON.parse(await readFile(portFile, 'utf8'))
            return `http://127.0.0.1:${String(port)}/`
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
        }
      } catch (error) {
        console.warn(`[dsh-auto-upgrade] 进度服务启动失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return undefined
    }

    /**
     * 组装 helper payload 的公共部分（不变式：宿主进程与它的原始命令行）。
     * @returns {object} payload 基础字段。
     */
    const payloadBase = () => ({
      hostPid: process.pid,
      port: typeof webServer.port === 'number' ? webServer.port : 3080,
      npm: installation?.npm,
      dshBin: installation?.dshBin,
      package: DSH_PACKAGE,
      profile: profileContext.name ?? 'web',
      execPath: process.execPath,
      args: process.argv.slice(1),
      cwd: process.cwd(),
      // 被 launchd 拉起时带回 job label：交接后优先用 kickstart 让服务仍在 launchd 名下，
      // 而不是 fork 一个不受管理的孤儿进程。
      launchdLabel: typeof process.env.XPC_SERVICE_NAME === 'string' ? process.env.XPC_SERVICE_NAME : '',
      stateDir,
      logPath: restartLogPath,
      resultPath: restartResultPath,
      outLog: join(stateDir, 'web.out.log'),
      // The helper refreshes `<log dir>/url.txt` after a restart: the launch
      // token is process-scoped and only ever printed to stdout, so the log is
      // the one durable source for the current URL.
      refreshScript: fileURLToPath(new URL('./host/refresh-url.mjs', import.meta.url)),
      smokeOut: join(stateDir, 'smoke.out'),
      allowScripts: ALLOW_SCRIPTS,
    })

    /**
     * 交接：备份 → 落 payload → fork 脱离进程的 helper → 正常退出。
     * 任何一步失败都留在宿主里如实报错（绝不退出）。
     * @param {{task:any, mode:'update'|'rollback'|'restart', target?:string, current?:string, skipBackup?:boolean}} options 输入。
     * @returns {Promise<void>} 完成。
     */
    const runHandoff = async (options) => {
      const { task } = options
      try {
        let backupTarget = ''
        if (options.mode !== 'restart' && options.skipBackup !== true) {
          task.setPhase('backup')
          const backup = await createBackup({
            dshHome,
            ts: timestamp(),
            meta: {
              dshBefore: options.current ?? 'unknown',
              target: options.target ?? '',
              dshBin: installation?.dshBin ?? '',
              npm: installation?.npm ?? '',
            },
            onLog: (line) => task.append(line),
          })
          if (backup.ok !== true) {
            task.append(`备份失败：${backup.error}`)
            task.finish({ ok: false, error: backup.error })
            return
          }
          backupTarget = backup.target
        } else if (options.mode !== 'restart') {
          const latest = await findLatestBackup(dshHome)
          task.append(latest === undefined ? '按请求跳过备份' : `按请求跳过新备份；已有备份：${latest}`)
          backupTarget = latest ?? ''
        }

        if (installation === undefined) {
          const message = installationError ?? 'dsh installation is unresolved'
          task.append(`失败：${message}`)
          task.finish({ ok: false, error: message })
          return
        }

        task.setPhase('stop')
        task.append('把控制权交给脱离进程的升级助手（本进程随后正常退出）')
        const payload = {
          ...payloadBase(),
          mode: options.mode,
          target: options.target ?? '',
          current: options.current ?? '',
          backup: backupTarget,
        }
        const scheduled = await scheduleHelperSeam({ stateDir, payload })
        task.append(`已调度 ${scheduled.scriptPath}（pid ${scheduled.pid ?? '?'}）`)
        await stores.state.patch({
          pendingRestart: {
            mode: options.mode,
            from: options.current ?? null,
            to: options.target ?? null,
            backup: backupTarget === '' ? null : backupTarget,
            startedAt: new Date().toISOString(),
          },
        })
        task.setPhase('restart')
        task.append('页面会在新服务就绪后自动重连；进度见 restart.log')
        setTimeout(() => exitProcess(0), HANDOFF_EXIT_DELAY_MS)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        task.append(`失败：${message}`)
        task.finish({ ok: false, error: message })
      }
    }

    route(API.status, {
      GET: async (_req, res) => {
        const [state, policy, settings] = await Promise.all([
          stores.state.read(),
          stores.policy.read(),
          stores.settings.read(),
        ])
        const installed = installation === undefined ? null : await readInstalledVersion(installation.manifestPath)
        const active = tasks.active('update') ?? tasks.active('rollback') ?? tasks.active('restart')
        writeJson(res, 200, {
          ok: true,
          plugin: { name: ownPackage.name, version: ownPackage.version },
          dsh: {
            package: DSH_PACKAGE,
            installed,
            manifestPath: installation?.manifestPath ?? null,
            installDir: installation?.dshDir ?? null,
            bin: installation?.dshBin ?? null,
            error: installationError ?? null,
          },
          profile: { name: profileContext.name ?? null, dir: profileDir ?? null },
          stateDir,
          registry,
          policy,
          settings,
          // 只标「过期」，绝不在这里联网重算：重算由 /check/auto（宿主）或客户端的一次性 /check/run 负责。
          lastCheck: state.lastCheck === null
            ? null
            : { ...state.lastCheck, ...checkStaleness(state.lastCheck, { installed, channel: policy.channel }) },
          pendingRestart: state.pendingRestart,
          sessions: listRunningSessions(getAgents()),
          task: active === undefined ? null : { id: active.id, kind: active.kind, phase: active.phase },
          capabilities: {
            check: true,
            preflight: true,
            plugins: true,
            update: helperSupported && installation !== undefined,
            rollback: helperSupported && installation !== undefined,
            restart: helperSupported,
          },
          helperSupported,
          platform: process.platform,
        })
      },
    })

    route(API.checkAuto, {
      POST: async (req, res) => {
        const body = expectObject(await readJsonBody(req), 'body')
        writeJson(res, 200, { ok: true, ...(await performCheck({ trigger: 'auto', force: body.force === true })) })
      },
    })

    route(API.checkRun, {
      POST: async (req, res) => {
        const body = expectObject(await readJsonBody(req), 'body')
        writeJson(res, 200, { ok: true, ...(await performCheck({ trigger: 'manual', force: body.force !== false })) })
      },
    })

    route(API.preflight, {
      GET: async (_req, res) => {
        writeJson(res, 200, { ok: true, preflight: await runPreflight() })
      },
    })

    // —— 升级前「试装」探针（issue #300）——
    // 现有 preflight 只读声明，看不出「声明覆盖但装不上」。探针在一个一次性
    // DSH_HOME 里把每个 link:/file: 插件真装一遍；结论只作警告，不进阻断判定。
    const probeCachePath = join(stateDir, 'probe-cache.json')
    /** @type {null | {startedAt:number, target:string|null}} */
    let probeRun = null
    /** 上一轮探针的整体异常（前端据此提示，而不是看着「没动静」）。 */
    let probeError = null

    /**
     * 把缓存文件的键拆回字段，供 UI 直接用。
     * 解析与过滤都在 `probeCacheEntries` 里（键格式带 schema 前缀，旧键要丢——见 issue #359）。
     */
    const probeEntries = (cache, now) => probeCacheEntries(cache, now)

    route(API.probe, {
      GET: async (_req, res) => {
        let cache = {}
        try {
          cache = JSON.parse(await readFile(probeCachePath, 'utf8'))
        } catch {
          cache = {}
        }
        writeJson(res, 200, {
          ok: true,
          running: probeRun !== null,
          startedAt: probeRun === null ? null : probeRun.startedAt,
          target: probeRun === null ? null : probeRun.target,
          error: probeError,
          entries: probeEntries(cache, Date.now()),
        })
      },
      POST: async (_req, res) => {
        // 先占位再 await：否则两个并发 POST 都能穿过守卫（issue #300 review）。
        if (probeRun !== null) throw new RequestError(409, CODE.BUSY, '试装探针正在运行')
        probeRun = { startedAt: Date.now(), target: null }
        probeError = null
        try {
        if (installation === undefined || profileDir === undefined) {
          throw new RequestError(500, CODE.PRECONDITION, installationError ?? 'profile 信息不可用')
        }
        const target = (await readInstalledVersion(installation.manifestPath)) ?? 'unknown'
        /** @type {{name:string, path:string, mtimeMs?:number}[]} */
        let targets = []
        try {
          const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
          targets = linkTargets(manifest.dependencies)
        } catch (error) {
          throw new RequestError(500, CODE.PRECONDITION, `读 profile 依赖失败：${error instanceof Error ? error.message : String(error)}`)
        }
        // 补上每个插件**真正的 id**：dump-config 里是模块导出的 name，不是包名（见 issue #346）。
        for (const item of targets) {
          try {
            const manifestText = await readFile(join(item.path, 'package.json'), 'utf8')
            const pluginManifest = JSON.parse(manifestText)
            for (const candidate of entryCandidates(pluginManifest)) {
              let source
              try {
                source = await readFile(join(item.path, candidate), 'utf8')
              } catch {
                continue
              }
              const id = pluginIdFromSource(source)
              if (id !== undefined) {
                item.id = id
                break
              }
            }
          } catch {
            // 读不到就不设 id，runProbes 会回落到包名（行为与修复前一致）。
          }
        }
        if (targets.length === 0) {
          // 早退必须先释放占位，否则后续 POST 永远 409、GET 永远 running（#300 review 轮 2）。
          probeRun = null
          writeJson(res, 200, { ok: true, skipped: true, detail: 'profile 里没有 link:/file: 插件，无可试装项' })
          return
        }
        probeRun.target = target
        writeJson(res, 202, { ok: true, startedAt: probeRun.startedAt, target, count: targets.length })
        void (async () => {
          let home
          try {
            home = await mkdtemp(join(tmpdir(), 'dsh-au-probe-'))
            // 基线 dump 要求 profile **存在**：不存在时 `--dump-config` 直接 exit 1（#392）。
            let cache = {}
            try {
              cache = JSON.parse(await readFile(probeCachePath, 'utf8'))
            } catch {
              cache = {}
            }
            const { cache: next } = await runProbeWithProfile({
              dshHome: home,
              profileName: PROBE_PROFILE_NAME,
              probes: () => runProbes({
              targets,
              targetVersion: target,
              dshBin: installation.dshBin,
              profileName: PROBE_PROFILE_NAME,
              dshHome: home,
              cache,
              now: Date.now(),
                run: async (command, args, options) => {
                  const result = await run(command, args, { ...options, timeoutMs: 180000 })
                  return { status: result.code, stdout: result.stdout }
                },
              }),
            })
            await writeFile(probeCachePath, `${JSON.stringify(next, null, 2)}\n`)
          } catch (error) {
            probeError = error instanceof Error ? error.message : String(error)
            console.warn(`[dsh-auto-upgrade] 试装探针失败：${probeError}`)
          } finally {
            if (home !== undefined) await rm(home, { recursive: true, force: true }).catch(() => {})
            probeRun = null
          }
        })()
        } catch (error) {
          // 起跑前就失败（读 profile 失败等）：释放占位，否则会一直被 409 挡住。
          probeRun = null
          throw error
        }
      },
    })

    // —— 升级后「逐插件冒烟」（issue #300 P2）——
    // 试装只证明「装得上」；装得上但行为坏了要靠这里：宿主兜底三项 + 插件自报断言。
    const smokePath = join(stateDir, 'smoke.json')
    /** @type {null | {startedAt:number}} */
    let smokeRun = null
    /** 回填正在跑（防止两个 POST 并发抢同一个分支）。 */
    let refillRun = false
    let smokeError = null

    /** 从 profile 的依赖与插件 package.json 里拼出冒烟所需的插件事实。 */
    const collectSmokePlugins = async () => {
      const profile = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
      const plugins = []
      for (const [name, spec] of Object.entries(profile.dependencies ?? {})) {
        const matched = /^(?:link|file):(.+)$/.exec(String(spec))
        if (matched === null) continue
        const dir = matched[1]
        let manifest = {}
        try {
          manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
        } catch {
          manifest = {}
        }
        plugins.push({
          name,
          dirExists: existsSync(dir),
          inject: Array.isArray(manifest.dsh?.client?.inject) ? manifest.dsh.client.inject : [],
          ...(manifest.dsh?.smoke === undefined ? {} : { smoke: manifest.dsh.smoke }),
          dir,
        })
      }
      return { plugins, bundles: profile.dsh?.profile?.bundles ?? [] }
    }

    route(API.smoke, {
      GET: async (_req, res) => {
        let cached = {}
        try {
          cached = JSON.parse(await readFile(smokePath, 'utf8'))
        } catch {
          cached = {}
        }
        writeJson(res, 200, {
          ok: true,
          running: smokeRun !== null,
          startedAt: smokeRun === null ? null : smokeRun.startedAt,
          error: smokeError,
          ...cached,
        })
      },
      POST: async (_req, res) => {
        // 占位先落，再 await（与 /probe 同一条规矩）。
        if (smokeRun !== null) throw new RequestError(409, CODE.BUSY, '冒烟正在运行')
        smokeRun = { startedAt: Date.now() }
        smokeError = null
        try {
          if (profileDir === undefined) throw new RequestError(500, CODE.PRECONDITION, 'profile 信息不可用')
          const { plugins, bundles } = await collectSmokePlugins()
          if (plugins.length === 0) {
            smokeRun = null
            writeJson(res, 200, { ok: true, skipped: true, detail: '没有 link:/file: 插件可冒烟' })
            return
          }
          writeJson(res, 202, { ok: true, startedAt: smokeRun.startedAt, count: plugins.length })
          void (async () => {
            try {
              const { results } = await runSmokes({
                plugins,
                bundles,
                // 宿主事实：插件的断言要对着**宿主实际加载的那份** dsh 验，而不是插件自己 node_modules 里的旧副本。
                context: {
                  dshVersion: installation === undefined ? undefined : await readInstalledVersion(installation.manifestPath),
                  dshDir: installation === undefined ? undefined : installation.dshDir,
                },
                resolvable: (pkg) => existsSync(join(profileDir, 'node_modules', pkg)),
                importModule: (plugin, modulePath) => import(pathToFileURL(join(plugin.dir, modulePath)).href),
              })
              const at = Date.now()
              await writeFile(smokePath, `${JSON.stringify({ at, results }, null, 2)}\n`)
              // 冒烟失败 → 自动开 issue（同版本按标题去重）；开单失败只降级成 reason，不影响冒烟结果。
              const reported = await maybeReportSmokeFailures({
                // `installation` 可能为 undefined（resolveInstallation 失败）：冒烟本身只要 profileDir，
                // 这里不能直接把 undefined 传下去，否则整个冒烟被误判成失败（review 轮 1 的 major）。
                version: installation === undefined ? undefined : await readInstalledVersion(installation.manifestPath),
                results,
                at,
                slug: repositorySlug(ownPackage),
                report: (input) => createIssue({ ...input, runGh: runGhSeam }),
              })
              if (reported.opened) {
                console.warn(`[dsh-auto-upgrade] 冒烟失败已关联 issue #${String(reported.number)}（created=${String(reported.created)}）`)
              } else if (reported.reason !== 'no-failures') {
                console.warn(`[dsh-auto-upgrade] 冒烟失败但未开 issue：${String(reported.reason)}`)
              }
            } catch (error) {
              smokeError = error instanceof Error ? error.message : String(error)
              console.warn(`[dsh-auto-upgrade] 冒烟失败：${smokeError}`)
            } finally {
              smokeRun = null
            }
          })()
        } catch (error) {
          smokeRun = null
          throw error
        }
      },
    })

    // —— 实测结论回填计划（issue #300 P4）——
    // 只读：把「哪些插件该记什么结论、package.json 会变成什么样」算出来给前端看。
    // 真正写盘并开 PR 是下一步（会走独立的 git worktree，不碰用户工作区）。
    route(API.refillPlan, {
      GET: async (_req, res) => {
        let cached = {}
        try {
          cached = JSON.parse(await readFile(smokePath, 'utf8'))
        } catch {
          cached = {}
        }
        const results = Array.isArray(cached.results) ? cached.results : []
        if (results.length === 0) {
          writeJson(res, 200, { ok: true, skipped: true, detail: '还没有冒烟结果；先跑一次 POST /smoke' })
          return
        }
        if (profileDir === undefined || installation === undefined) {
          throw new RequestError(500, CODE.PRECONDITION, installationError ?? 'profile 信息不可用')
        }
        const version = await readInstalledVersion(installation.manifestPath)
        if (typeof version !== 'string' || version === '') {
          // 拿不到版本就绝不能生成补丁：`String(undefined)` 会写出键名 `"undefined"` 的垃圾记录。
          throw new RequestError(500, CODE.PRECONDITION, '读不到当前 dsh 版本，无法回填')
        }
        const plan = buildRefillPlan({ version, results })
        const date = new Date().toISOString().slice(0, 10)
        // 复用冒烟那套「从 profile 依赖还原插件目录」的逻辑，避免再写一遍路径解析。
        const { plugins: installed } = await collectSmokePlugins()
        const byName = new Map(installed.map((plugin) => [plugin.name, plugin]))
        const entries = []
        for (const entry of plan.entries) {
          const plugin = byName.get(entry.name)
          if (plugin === undefined) continue
          let text
          let packageVersion
          try {
            text = await readFile(join(plugin.dir, 'package.json'), 'utf8')
            packageVersion = JSON.parse(text).version
            if (typeof packageVersion !== 'string' || packageVersion === '') {
              entries.push({ name: entry.name, depth: entry.depth, changed: false, error: '插件 package.json 缺 version 字段' })
              continue
            }
          } catch {
            continue
          }
          try {
            const patched = patchCompatibility({ text, version, verdict: entry.verdict, depth: entry.depth })
            entries.push({
              name: entry.name,
              depth: patched.depth,
              changed: patched.changed,
              row: compatRow({ name: entry.name, packageVersion: `${entry.name}@${String(packageVersion)}`, version, depth: patched.depth, date }),
            })
          } catch (error) {
            entries.push({ name: entry.name, depth: entry.depth, changed: false, error: error instanceof Error ? error.message : String(error) })
          }
        }
        writeJson(res, 200, { ok: true, version: version ?? null, entries })
      },
    })

    // —— 真的回填并开 PR（issue #300 P4 下半）——
    // 只在临时 worktree 里改（从 origin/main 切），**绝不碰用户当前工作区**；跑完即清场。
    route(API.refillRun, {
      POST: async (_req, res) => {
        if (refillRun) throw new RequestError(409, CODE.BUSY, '回填正在运行')
        if (probeRun !== null || smokeRun !== null) {
          throw new RequestError(409, CODE.BUSY, '试装/冒烟正在运行，等它结束再回填')
        }
        refillRun = true
        try {
        if (profileDir === undefined || installation === undefined) {
          throw new RequestError(500, CODE.PRECONDITION, installationError ?? 'profile 信息不可用')
        }
        const version = await readInstalledVersion(installation.manifestPath)
        if (typeof version !== 'string' || version === '') {
          throw new RequestError(500, CODE.PRECONDITION, '读不到当前 dsh 版本，无法回填')
        }
        // 回填要改仓库文件并开 PR：只在 link: 装进本仓时可用。
        const repoRoot = dirname(dirname(fileURLToPath(new URL('../package.json', import.meta.url))))
        if (!existsSync(join(repoRoot, '.git'))) {
          throw new RequestError(501, CODE.NOT_IMPLEMENTED, `插件不是 link: 装进仓库的（${repoRoot} 里没有 .git），无法自动回填`)
        }
        let cached = {}
        try {
          cached = JSON.parse(await readFile(smokePath, 'utf8'))
        } catch {
          cached = {}
        }
        const results = Array.isArray(cached.results) ? cached.results : []
        const plan = buildRefillPlan({ version, results })
        const { plugins: installed } = await collectSmokePlugins()
        const byName = new Map(installed.map((plugin) => [plugin.name, plugin]))
        const date = new Date().toISOString().slice(0, 10)
        const entries = []
        for (const entry of plan.entries) {
          const plugin = byName.get(entry.name)
          if (plugin === undefined) continue
          // 用**仓库内相对路径**，落在仓库外的一律跳过（那是别人的仓，不该被这个 PR 改）。
          const relDir = relative(repoRoot, plugin.dir)
          if (relDir === '' || relDir.startsWith('..')) continue
          let dry
          let manifestText
          let packageVersion = ''
          try {
            manifestText = await readFile(join(plugin.dir, 'package.json'), 'utf8')
            packageVersion = String(JSON.parse(manifestText).version ?? '')
            dry = patchCompatibility({ text: manifestText, version, verdict: 'compatible', depth: entry.depth })
          } catch {
            continue
          }
          if (packageVersion === '') continue
          if (!dry.changed) continue
          entries.push({
            name: entry.name,
            relDir,
            depth: dry.depth,
            changed: true,
            row: compatRow({ name: entry.name, packageVersion: `${entry.name}@${packageVersion}`, version, depth: dry.depth, date }),
          })
        }
        const outcome = await openRefillPullRequest({
          repoRoot,
          worktreePath: join(repoRoot, '.worktrees'),
          version,
          entries,
          git: async (args, cwd) => {
            const result = await run('git', args, { cwd, timeoutMs: 120000 })
            return {
              ok: result.code === 0,
              stdout: result.stdout,
              error: String(result.stderr || result.error || `退出码 ${String(result.code)}`),
            }
          },
          // gh 必须带 cwd（worktree 里跑）+ `--head`：否则会按宿主 cwd 的当前分支开 PR。
          gh: (args, cwd) => runGhSeam(args, { cwd }),
          patch: patchCompatibility,
          appendRow: appendCompatRow,
        })
        writeJson(res, outcome.ok ? 200 : 500, { ok: outcome.ok, version, ...outcome })
        } finally {
          // 占位必须复位：任何一条抛错路径卡住它，端点就会永久 409（只能重启宿主恢复）。
          refillRun = false
        }
      },
    })

    route(API.plugins, {
      GET: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const requested = url.searchParams.get('version')
        const installed = installation === undefined ? undefined : await readInstalledVersion(installation.manifestPath)
        const target = requested !== null && requested !== '' ? requested : (installed ?? '0.0.0')
        writeJson(res, 200, { ok: true, target, ...(await inspectPlugins(target)) })
      },
    })

    route(API.pluginAction, {
      POST: async (req, res) => {
        expectObject(await readJsonBody(req), 'body')
        throw new RequestError(501, CODE.NOT_IMPLEMENTED, '插件处置动作（豁免/禁用）尚未实现')
      },
    })

    route(API.policy, {
      GET: async (_req, res) => {
        writeJson(res, 200, { ok: true, policy: await stores.policy.read(), channels: CHANNELS })
      },
      POST: async (req, res) => {
        const body = expectObject(await readJsonBody(req), 'body')
        const patch = {}
        if (body.channel !== undefined) {
          if (!CHANNELS.includes(body.channel)) {
            throw new RequestError(400, CODE.BAD_REQUEST, `channel must be one of ${CHANNELS.join(', ')}`)
          }
          patch.channel = body.channel
        }
        if (body.exactVersion !== undefined) {
          if (typeof body.exactVersion !== 'string') {
            throw new RequestError(400, CODE.BAD_REQUEST, 'exactVersion must be a string')
          }
          if (body.exactVersion !== '' && !isExactVersion(body.exactVersion)) {
            throw new RequestError(400, CODE.BAD_REQUEST, 'exactVersion must be an exact semantic version')
          }
          patch.exactVersion = body.exactVersion
        }
        if (body.mode !== undefined) {
          if (body.mode !== 'notify') {
            throw new RequestError(400, CODE.NOT_IMPLEMENTED, '只有 mode="notify" 受支持；静默自动升级尚未实现')
          }
          patch.mode = body.mode
        }
        if (body.dailyCheck !== undefined) {
          if (typeof body.dailyCheck !== 'boolean') {
            throw new RequestError(400, CODE.BAD_REQUEST, 'dailyCheck must be a boolean')
          }
          patch.dailyCheck = body.dailyCheck
        }
        const current = await stores.policy.read()
        const merged = { ...current, ...patch }
        if (merged.channel === 'exact' && (typeof merged.exactVersion !== 'string' || merged.exactVersion === '')) {
          throw new RequestError(400, CODE.BAD_REQUEST, 'channel="exact" 需要同时给出 exactVersion')
        }
        writeJson(res, 200, { ok: true, policy: await stores.policy.write(merged) })
      },
    })

    route(API.settings, {
      GET: async (_req, res) => {
        writeJson(res, 200, { ok: true, settings: await stores.settings.read() })
      },
      POST: async (req, res) => {
        const body = expectObject(await readJsonBody(req), 'body')
        const patch = {}
        for (const key of ['overlay', 'dismissed']) {
          if (body[key] === undefined) continue
          if (typeof body[key] !== 'boolean') throw new RequestError(400, CODE.BAD_REQUEST, `${key} must be a boolean`)
          patch[key] = body[key]
        }
        if (body.locale !== undefined) {
          if (body.locale !== null && typeof body.locale !== 'string') {
            throw new RequestError(400, CODE.BAD_REQUEST, 'locale must be a string or null')
          }
          patch.locale = body.locale
        }
        writeJson(res, 200, { ok: true, settings: await stores.settings.patch(patch) })
      },
    })

    route(API.task, {
      GET: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const id = url.searchParams.get('taskId')
        const since = Number(url.searchParams.get('since') ?? '0')
        const wanted = id === null || id === '' ? tasks.active('update') : tasks.get(id)
        if (wanted === undefined) {
          writeJson(res, 404, { ok: false, code: CODE.BAD_REQUEST, error: 'unknown task' })
          return
        }
        writeJson(res, 200, { ok: true, task: wanted.view(Number.isFinite(since) ? since : 0) })
      },
    })

    route(API.update, {
      POST: async (req, res) => {
        const body = expectObject(await readJsonBody(req), 'body')
        if (!helperSupported) {
          throw new RequestError(501, CODE.NOT_IMPLEMENTED, `升级助手目前只支持 macOS / Linux（当前：${process.platform}）`)
        }
        if (installation === undefined) {
          throw new RequestError(500, CODE.PRECONDITION, installationError ?? 'dsh installation is unresolved')
        }
        const target = expectVersion(body.version, 'version')
        if (target === undefined) throw new RequestError(400, CODE.BAD_REQUEST, 'version is required')
        const installed = await readInstalledVersion(installation.manifestPath)
        if (installed !== undefined && target === installed) {
          throw new RequestError(400, CODE.BAD_REQUEST, `already running ${target}`)
        }
        const busy = tasks.active('update') ?? tasks.active('rollback') ?? tasks.active('restart')
        if (busy !== undefined) throw new RequestError(409, CODE.BUSY, `a ${busy.kind} task is already running`)

        await assertUpgradeAllowed({ targetVersion: target, force: body.force === true })

        const task = tasks.start('update', { from: installed ?? null, to: target })
        task.setPhase('preflight')
        task.append(`目标：${installed ?? '未知'} → ${target}`)
        const progressUrl = await startProgressServer()
        writeJson(res, 202, { ok: true, taskId: task.id, handoff: true, ...(progressUrl === undefined ? {} : { progressUrl }) })
        void runHandoff({
          task,
          mode: 'update',
          target,
          current: installed,
          skipBackup: body.backup === false,
        })
      },
    })

    route(API.rollback, {
      POST: async (req, res) => {
        const body = expectObject(await readJsonBody(req), 'body')
        if (!helperSupported) {
          throw new RequestError(501, CODE.NOT_IMPLEMENTED, `升级助手目前只支持 macOS / Linux（当前：${process.platform}）`)
        }
        if (installation === undefined) {
          throw new RequestError(500, CODE.PRECONDITION, installationError ?? 'dsh installation is unresolved')
        }
        const state = await stores.state.read()
        const target = expectVersion(body.version, 'version') ?? state.pendingRestart?.from ?? undefined
        if (target === undefined) {
          throw new RequestError(400, CODE.BAD_REQUEST, 'no rollback target: pass version, or roll back after an upgrade')
        }
        const installed = await readInstalledVersion(installation.manifestPath)
        if (installed !== undefined && target === installed) {
          throw new RequestError(400, CODE.BAD_REQUEST, `already running ${target}`)
        }
        const busy = tasks.active('update') ?? tasks.active('rollback') ?? tasks.active('restart')
        if (busy !== undefined) throw new RequestError(409, CODE.BUSY, `a ${busy.kind} task is already running`)

        const sessions = listRunningSessions(getAgents())
        if (body.force !== true && sessions.sessions.length > 0) {
          throw new RequestError(
            409,
            CODE.SESSIONS_RUNNING,
            `有 ${sessions.sessions.length} 个会话正在执行；回滚会中断它们`,
            { sessions: sessions.sessions, bypassable: true },
          )
        }

        const task = tasks.start('rollback', { from: installed ?? null, to: target })
        task.setPhase('preflight')
        task.append(`回滚：${installed ?? '未知'} → ${target}`)
        const progressUrl = await startProgressServer()
        writeJson(res, 202, { ok: true, taskId: task.id, handoff: true, ...(progressUrl === undefined ? {} : { progressUrl }) })
        void runHandoff({ task, mode: 'rollback', target, current: installed, skipBackup: body.backup !== true })
      },
    })

    route(API.restart, {
      POST: async (req, res) => {
        const body = expectObject(await readJsonBody(req), 'body')
        if (!helperSupported) {
          throw new RequestError(501, CODE.NOT_IMPLEMENTED, `重启助手目前只支持 macOS / Linux（当前：${process.platform}）`)
        }
        const busy = tasks.active('update') ?? tasks.active('rollback') ?? tasks.active('restart')
        if (busy !== undefined) throw new RequestError(409, CODE.BUSY, `a ${busy.kind} task is already running`)
        const sessions = listRunningSessions(getAgents())
        if (body.force !== true && sessions.sessions.length > 0) {
          throw new RequestError(
            409,
            CODE.SESSIONS_RUNNING,
            `有 ${sessions.sessions.length} 个会话正在执行；重启会中断它们`,
            { sessions: sessions.sessions, bypassable: true },
          )
        }
        const task = tasks.start('restart', {})
        task.setPhase('stop')
        task.append('只重启，不安装任何东西')
        const progressUrl = await startProgressServer()
        writeJson(res, 202, { ok: true, taskId: task.id, handoff: true, ...(progressUrl === undefined ? {} : { progressUrl }) })
        void runHandoff({ task, mode: 'restart' })
      },
    })

    route(API.restartDiagnostics, {
      GET: async (_req, res) => {
        const [result, payload] = await Promise.all([readResult(stateDir), readPayload(stateDir)])
        writeJson(res, 200, {
          ok: true,
          path: restartLogPath,
          log: tailLines(restartLogPath),
          result: result ?? null,
          payload: payload === undefined
            ? null
            : {
              mode: payload.mode,
              current: payload.current,
              target: payload.target,
              backup: payload.backup,
              profile: payload.profile,
              port: payload.port,
              launchdLabel: payload.launchdLabel ?? '',
              args: payload.args,
              npm: payload.npm,
            },
        })
      },
    })

    route(API.notes, {
      GET: async (req, res) => {
        if (installation === undefined) {
          throw new RequestError(500, CODE.PRECONDITION, installationError ?? 'dsh installation is unresolved')
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const requested = url.searchParams.get('version')
        const version = requested === null || requested === ''
          ? await readInstalledVersion(installation.manifestPath)
          : expectVersion(requested, 'version')
        if (version === undefined) {
          throw new RequestError(400, CODE.BAD_REQUEST, 'version is required')
        }

        let manifest
        try {
          manifest = JSON.parse(await readFile(installation.manifestPath, 'utf8'))
        } catch (error) {
          throw new RequestError(500, CODE.INTERNAL, `cannot read ${installation.manifestPath}: ${error instanceof Error ? error.message : String(error)}`)
        }
        const slug = repositorySlug(manifest)
        if (slug === undefined) {
          writeJson(res, 200, {
            ok: true,
            version,
            slug: null,
            available: false,
            reason: 'the installed dsh package declares no GitHub repository',
          })
          return
        }

        const cacheKey = `${slug}@${version}`
        const cached = notesCache.get(cacheKey)
        const fresh = cached !== undefined && Date.now() - cached.at < NOTES_CACHE_TTL_MS
        const result = fresh ? cached.value : await fetchReleaseNotes({ slug, version, apiBase: githubApiBase })
        if (!fresh) notesCache.set(cacheKey, { at: Date.now(), value: result })
        writeJson(res, 200, { ok: true, version, slug, cached: fresh, ...result })
      },
    })

    route(API.reportIssue, {
      POST: async (req, res) => {
        const body = expectObject(await readJsonBody(req), 'body')
        const target = expectVersion(body.target, 'target')
        if (target === undefined) throw new RequestError(400, CODE.BAD_REQUEST, 'target is required')
        const slug = repositorySlug(ownPackage)
        if (slug === undefined) {
          throw new RequestError(400, CODE.BAD_REQUEST, 'package.json declares no GitHub repository; cannot open an issue')
        }

        // 标题与正文只由宿主根据检测结果生成：请求体里的 target 已校验为精确版本号，
        // 任何额外字段都不会被写进 issue。
        //
        // 点名列表取**实时**判定（只读本地 manifest，不联网）。但只有**已知不兼容**才进 issue：
        // 门禁阻塞（`gate`）或自述 `incompatible`。`unverified`（从未验证）不点名、不开 issue——
        // 「我没测过」不是「已知不兼容」，塞进 issue 只会变成噪音；它只作为一行背景计数进正文。
        const state = await stores.state.read()
        const lastCheck = state.lastCheck ?? null
        const inspected = await inspectPlugins(target)
        const flagged = inspected.flagged ?? []
        const named = reportablePlugins(flagged)
        const unverified = unverifiedPlugins(flagged)
        if (named.length === 0) {
          throw new RequestError(400, CODE.BAD_REQUEST, unverified.length > 0
            ? `目标版本 ${target} 只有 ${unverified.length} 个未验证的插件，没有已知不兼容，无需开 issue`
            : `目标版本 ${target} 没有被阻塞的插件，也没有自述兼容性问题的插件，无需开 issue`)
        }

        const installed = installation === undefined
          ? (lastCheck?.installed ?? null)
          : ((await readInstalledVersion(installation.manifestPath)) ?? lastCheck?.installed ?? null)
        const title = issueTitle({ target, plugins: named })
        const text = issueBody({
          target,
          installed,
          profile: profileContext.name ?? 'web',
          plugins: named,
          unverifiedCount: unverified.length,
          port: typeof webServer.port === 'number' ? webServer.port : 3080,
        })
        try {
          writeJson(res, 200, await createIssue({ runGh: runGhSeam, slug, title, body: text }))
        } catch (error) {
          if (error instanceof ReportError) throw new RequestError(error.status, CODE.INTERNAL, error.message)
          throw error
        }
      },
    })

    // 把 `.dsh-web/url.txt` 刷成**当前**地址（issue #365）。
    //
    // 时序是关键：插件 apply **早于**宿主打印 `dsh web: http…`，加载那一刻日志最后一条还是
    // 上一个进程的地址（已 401）。所以先记下日志长度，之后只接受**新写进来**的那一段，
    // 并在后台轮询一小段时间等宿主打印。
    void (async () => {
      const repoRoot = repoRootFrom(import.meta.url)
      if (repoRoot === undefined) return
      const port = typeof webServer.port === 'number' ? webServer.port : undefined
      // 端口未知就不猜：猜错会把别的端口的历史地址写进去。
      if (port === undefined) {
        console.warn('[dsh-auto-upgrade] url.txt 未刷新：拿不到宿主端口')
        return
      }
      const logPath = join(repoRoot, '.dsh-web', 'web.out.log')
      // 基线必须是**字符数**（与 `log.slice` 同口径）：`stat().size` 是字节，中文日志下差几万。
      let initial
      try {
        initial = await readFile(logPath, 'utf8')
      } catch {
        console.warn(`[dsh-auto-upgrade] url.txt 未刷新：读不到 ${logPath}`)
        return
      }
      const since = initial.length
      // 最多等 ~30 秒：宿主启动通常几秒内就会打印地址。
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          const outcome = await refreshUrlFile({ repoRoot, port, since })
          if (outcome.changed) {
            console.log(`[dsh-auto-upgrade] url.txt 已刷新为当前地址（端口 ${String(port)}）`)
            return
          }
        } catch (error) {
          console.warn(`[dsh-auto-upgrade] url.txt 刷新失败：${error instanceof Error ? error.message : String(error)}`)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      console.warn('[dsh-auto-upgrade] url.txt 未刷新：等了 30 秒仍没等到新地址')
    })()

    ctx.effect(() => () => {
      for (const dispose of disposers) dispose()
    })
  })
}

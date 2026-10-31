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
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createBackup, findLatestBackup, timestamp } from './host/backup.js'
import { evaluatePlugins, readInventory } from './host/compat.js'
import { createRoute, readJsonBody, RequestError, writeJson } from './host/http.js'
import { isLoopbackRequest } from './host/loopback.js'
import { DEFAULT_GITHUB_API, fetchReleaseNotes, repositorySlug } from './host/notes.js'
import { loadOfficialAppBoot } from './host/official.js'
import {
  defaultRunGh,
  issueBody,
  issueTitle,
  ReportError,
  reportIssue as createIssue,
} from './host/report-issue.js'
import { ALLOW_SCRIPTS, API, CHANNELS, CODE, DECISION, DEFAULT_REGISTRY, DSH_PACKAGE } from './host/protocol.js'
import { fetchPackument } from './host/registry.js'
import { compareVersions, isExactVersion } from './host/semver.js'
import { listRunningSessions } from './host/sessions.js'
import { checkStaleness } from './host/staleness.js'
import { localDate, openStores, resolveStateDir } from './host/state.js'
import { TaskRegistry } from './host/tasks.js'
import { preflight, readInstalledVersion, resolveInstallation } from './host/toolchain.js'
import {
  LOG_FILE,
  RESULT_FILE,
  readPayload,
  readResult,
  scheduleHelper as defaultScheduleHelper,
} from './host/upgrade.js'

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
      ? { plugins: [], incompatible: [], exemptions: {}, inventoryError: installationError }
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
    const route = (path, handlers) => {
      disposers.push(webServer.register({ kind: 'exact', path, handler: createRoute(handlers, isLoopbackRequest) }))
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
        writeJson(res, 202, { ok: true, taskId: task.id, handoff: true })
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
        writeJson(res, 202, { ok: true, taskId: task.id, handoff: true })
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
        writeJson(res, 202, { ok: true, taskId: task.id, handoff: true })
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
        const state = await stores.state.read()
        const lastCheck = state.lastCheck ?? null
        const blockers = lastCheck !== null && lastCheck.target === target && Array.isArray(lastCheck.incompatible)
          ? lastCheck.incompatible
          : (await inspectPlugins(target)).incompatible
        if (blockers.length === 0) {
          throw new RequestError(400, CODE.BAD_REQUEST, `目标版本 ${target} 没有被阻塞的插件，无需开 issue`)
        }

        const installed = installation === undefined
          ? (lastCheck?.installed ?? null)
          : ((await readInstalledVersion(installation.manifestPath)) ?? lastCheck?.installed ?? null)
        const title = issueTitle({ target, plugins: blockers })
        const text = issueBody({
          target,
          installed,
          profile: profileContext.name ?? 'web',
          plugins: blockers,
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

    ctx.effect(() => () => {
      for (const dispose of disposers) dispose()
    })
  })
}

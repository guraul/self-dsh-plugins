/**
 * 升级预检 P3：启动预演（issue #425）。
 *
 * 在 P2 那个一次性 `DSH_HOME` / profile 里用 dsh **真启动一次**，按插件条目判定是否
 * `active`。预演只负责「起得来吗、条目挂上了吗」，结论只进 `preflight.json` 的 `p3`
 * 与 `warnings`，**不改变 `blocked`**（起不来的原因可能与环境有关，误伤代价高）。
 *
 * 判定口径：
 * - 启动器超时 / 进程退出码非 0 / 日志出现 `StartupError` → `launch: 'failed'`；
 * - 否则 `launch: 'ok'`，逐插件看探针标记：`[dsh-rehearsal] <包名> active|inactive`。
 *
 * 探针是一个只在预演时通过 `--patch` 注入的极小插件：它等 `appReady` 提交后遍历
 * Loader 条目（`entry.fiber.state === 2` 即 ACTIVE），把包名与状态写到 stdout，再请求
 * `appExit(0)`。这样「active」来自真实启动后的 Loader 状态，而不是猜日志文本。
 * @module dsh-plugin-auto-upgrade/host/rehearse
 */
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 启动预演上限：超过就按失败落盘，不能让 `/preflight` 任务悬着。 */
export const REHEARSAL_TIMEOUT_MS = 90_000
/** 探针在 stdout 上的标记前缀。 */
export const REHEARSAL_MARKER = '[dsh-rehearsal]'
/** 注入到一次性 profile 里的探针文件名（相对 profile 目录）。 */
export const REHEARSAL_PROBE_FILE = '.dsh-rehearsal-probe.mjs'
/** `--patch` overlay 文件名。 */
export const REHEARSAL_PATCH_FILE = '.dsh-rehearsal.patch.yml'

/**
 * 预演探针源码。
 *
 * `entry.fiber.state === 2` 是 cordis 的 `FiberState.ACTIVE`（const enum 运行时被擦除，
 * 所以这里写字面量）。条目没有 fiber（被禁用 / 未挂载）一律算 inactive。
 * @returns {string} ESM 源码。
 */
export function rehearsalProbeSource() {
  return `export const name = 'dsh-auto-upgrade-rehearsal'
export const inject = ['loader', 'appReady', 'appExit']

export function apply(ctx) {
  ctx.appReady.onReady(() => {
    for (const entry of ctx.loader.entries()) {
      const label = entry.options?.name ?? entry.options?.id ?? 'unknown'
      const state = entry.fiber?.state === 2 ? 'active' : 'inactive'
      process.stdout.write('[dsh-rehearsal] ' + label + ' ' + state + '\\n')
    }
    process.stdout.write('[dsh-rehearsal] done\\n')
    ctx.appExit(0)
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
 * 纯判定一次预演结果。
 * @param {object} options 输入。
 * @param {number|string|null} [options.exitCode] 进程退出码（spawn 失败为 null）。
 * @param {boolean} [options.timedOut] 是否超时。
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
  if (options.exitCode !== 0) {
    return {
      ok: false,
      launch: 'failed',
      entries: allInactive,
      error: `dsh 退出码 ${String(options.exitCode ?? 'null')}`,
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
 * 默认启动器：跑一次 dsh，超时杀掉，不抛错。
 * @param {string} command dsh 可执行文件。
 * @param {string[]} args 参数。
 * @param {{timeoutMs:number, cwd?:string, env?:Record<string,string>}} options 选项。
 * @returns {Promise<{status:number|string|null, stdout:string, stderr:string, timedOut:boolean}>} 原始结果。
 */
export function runDsh(command, args, options) {
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
        resolve({
          status: error === null ? 0 : (error.code ?? null),
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut: error !== null && (error.killed === true || error.signal === 'SIGTERM'),
        })
      },
    )
  })
}

/**
 * 在一次性 `DSH_HOME` 的 profile 里真启动一次并判定。
 *
 * `run` 可注入：单测用假实现，不真起进程。启动器抛错也折成 `launch: 'failed'`，
 * 保证 `/preflight` 任务不会因为预演本身而整体失败。
 * @param {object} options 输入。
 * @param {string} options.dshBin dsh 可执行文件。
 * @param {string} options.dshHome 一次性 DSH_HOME（P2 已建好 profile 并试装）。
 * @param {string} options.profileName 一次性 profile 名。
 * @param {string[]} [options.entries] 预期插件包名。
 * @param {number} [options.timeoutMs] 超时上限。
 * @param {string} [options.cwd] 子进程工作目录（默认一次性 HOME）。
 * @param {(command:string, args:string[], options:object) => Promise<{status?:number|string|null, code?:number|string|null, stdout?:string, stderr?:string, timedOut?:boolean}>} [options.run] 启动器。
 * @returns {Promise<{ok:boolean, launch:'ok'|'failed', entries:Record<string,'active'|'inactive'>, error?:string}>} P3 结论。
 */
export async function runRehearsal(options) {
  const timeoutMs = options.timeoutMs ?? REHEARSAL_TIMEOUT_MS
  const entries = expectedEntries(options.entries)
  const profileDir = join(options.dshHome, 'profiles', options.profileName)
  const probePath = join(profileDir, REHEARSAL_PROBE_FILE)
  const patchPath = join(profileDir, REHEARSAL_PATCH_FILE)
  try {
    await mkdir(profileDir, { recursive: true })
    await writeFile(probePath, rehearsalProbeSource(), 'utf8')
    await writeFile(patchPath, rehearsalPatchSource(), 'utf8')
    const runner = options.run ?? runDsh
    const outcome = await runner(
      options.dshBin,
      ['--profile', options.profileName, '--patch', patchPath],
      {
        cwd: options.cwd ?? options.dshHome,
        env: {
          ...process.env,
          DSH_HOME: options.dshHome,
          // 预演不需要遥测；也不读取真实 profile 的开关。
          DSH_TELEMETRY_DISABLED: '1',
        },
        timeoutMs,
      },
    )
    return judgeRehearsal({
      exitCode: outcome?.status ?? outcome?.code ?? null,
      timedOut: outcome?.timedOut === true,
      log: `${outcome?.stdout ?? ''}\n${outcome?.stderr ?? ''}`,
      entries,
      timeoutMs,
    })
  } catch (error) {
    return {
      ok: false,
      launch: 'failed',
      entries: Object.fromEntries(entries.map((name) => [name, 'inactive'])),
      error: `启动预演执行失败：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    await rm(probePath, { force: true }).catch(() => {})
    await rm(patchPath, { force: true }).catch(() => {})
  }
}

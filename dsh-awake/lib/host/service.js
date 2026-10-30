/**
 * 保持唤醒的状态机 —— 本插件唯一的业务逻辑，也是唯一被单测直接驱动的部分。
 *
 * 只有两个状态：
 *
 * ```
 *          start()                      子进程 exit / stop()
 *  inactive ────────► active ─────────────────────────► inactive
 *      ▲                 │
 *      └── spawn 立刻退出 ◄┘（观察窗口内退出 = 启动失败，绝不留在 active）
 * ```
 *
 * 三条不变式：
 * 1. **单实例**：`active` 时再 `start()` 只是回读状态，不会再 spawn 第二个 `caffeinate`。
 * 2. **自愈**：子进程被外部 kill 时 `exit` 监听把状态打回 inactive，
 *    界面下一次读 `GET /status` 就能看到真相。
 * 3. **不留孤儿**：`dispose()`（宿主卸载 / 插件 disable / 进程退出）一定 kill 掉子进程。
 *
 * 所有外部效应（spawn / 时钟 / 等待）都可注入，所以单测不碰真实 `caffeinate`。
 * @module dsh-plugin-awake/host/service
 */
import { spawn as nodeSpawn } from 'node:child_process'

import { ARGS, BINARY, CODE, SUPPORTED_PLATFORM, VERIFY_DELAY_MS } from './protocol.js'

/**
 * 状态机抛出的失败，携带应当映射成的 HTTP 状态码与统一错误码。
 */
export class AwakeError extends Error {
  /**
   * @param {number} status HTTP 状态码。
   * @param {string} code 统一错误码。
   * @param {string} message 人话原因。
   */
  constructor(status, code, message) {
    super(message)
    this.name = 'AwakeError'
    this.status = status
    this.code = code
  }
}

/**
 * 把任意抛出物转成一句话。
 * @param {unknown} error 抛出物。
 * @returns {string} 描述。
 */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 造一个保持唤醒服务。
 * @param {object} [options] 注入缝（生产代码全部走默认值）。
 * @param {(...args: any[]) => any} [options.spawn] 子进程工厂，默认 `child_process.spawn`。
 * @param {() => number} [options.now] 时钟，默认 `Date.now`。
 * @param {(ms: number) => Promise<void>} [options.wait] 观察窗口的等待实现。
 * @param {number} [options.verifyDelayMs] 观察窗口长度，默认 500ms。
 * @param {string} [options.platform] 平台，默认 `process.platform`。
 * @param {string} [options.binary] 可执行文件，默认 `caffeinate`。
 * @param {string[]} [options.args] 参数，默认 `['-i']`（永不带 `-t`）。
 * @returns {{
 *   status: () => { active: boolean, pid: number|null, startedAt: number|null },
 *   start: () => Promise<{ active: boolean, pid: number|null, startedAt: number|null }>,
 *   stop: () => Promise<{ active: boolean, pid: number|null, startedAt: number|null }>,
 *   dispose: () => Promise<void>,
 * }} 服务。
 */
export function createAwakeService(options = {}) {
  const spawnImpl = options.spawn ?? nodeSpawn
  const now = options.now ?? (() => Date.now())
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const verifyDelayMs = typeof options.verifyDelayMs === 'number' ? options.verifyDelayMs : VERIFY_DELAY_MS
  const platform = options.platform ?? process.platform
  const binary = options.binary ?? BINARY
  const args = options.args ?? ARGS

  /** @type {{ child: any, pid: number, startedAt: number }|null} 当前持有的子进程。 */
  let current = null
  /** @type {Promise<any>|null} 正在进行的启动（并发 start 合并成一次 spawn）。 */
  let pending = null

  /**
   * 当前状态快照。客户端每次挂载读一次，不轮询。
   * @returns {{active: boolean, pid: number|null, startedAt: number|null}} 快照。
   */
  function status() {
    return {
      active: current !== null,
      pid: current === null ? null : current.pid,
      startedAt: current === null ? null : current.startedAt,
    }
  }

  /**
   * 子进程自愈：只有「当前持有的那一个」退出才改状态。
   * @param {any} child 退出的子进程。
   * @returns {void}
   */
  function forget(child) {
    if (current !== null && current.child === child) current = null
  }

  /**
   * 真正拉起一次 `caffeinate -i`，并在观察窗口内确认它没有秒退。
   * @returns {Promise<{active: boolean, pid: number|null, startedAt: number|null}>} 启动后的状态。
   * @throws {AwakeError} 平台不支持 / spawn 失败 / 观察窗口内退出。
   */
  async function launch() {
    if (platform !== SUPPORTED_PLATFORM) {
      throw new AwakeError(
        501,
        CODE.UNSUPPORTED_PLATFORM,
        `${binary} only exists on macOS; this host reports platform "${platform}"`,
      )
    }

    let child
    try {
      // `detached: false`：留在宿主的进程组里，宿主被 kill 时子进程一起收走；
      // `stdio: 'ignore'`：`caffeinate` 不产出任何有用输出，别接管道。
      child = spawnImpl(binary, args, { stdio: 'ignore', detached: false })
    } catch (error) {
      throw new AwakeError(500, CODE.SPAWN_FAILED, `failed to spawn ${binary}: ${describe(error)}`)
    }

    /** 观察窗口的结果：`exit` 与 `error` 都算「没活下来」。 */
    const outcome = { settled: false, code: null, signal: null, error: null }
    child.once('error', (error) => {
      outcome.settled = true
      outcome.error = error
    })
    child.once('exit', (code, signal) => {
      outcome.settled = true
      outcome.code = code
      outcome.signal = signal
      forget(child)
    })

    await wait(verifyDelayMs)

    if (outcome.settled) {
      const reason = outcome.error === null
        ? `exited during the ${verifyDelayMs}ms startup window (code ${String(outcome.code)}, signal ${String(outcome.signal)})`
        : describe(outcome.error)
      throw new AwakeError(500, CODE.SPAWN_FAILED, `${binary} ${args.join(' ')}: ${reason}`)
    }
    if (typeof child.pid !== 'number') {
      throw new AwakeError(500, CODE.SPAWN_FAILED, `${binary} ${args.join(' ')}: spawned without a pid`)
    }

    current = { child, pid: child.pid, startedAt: now() }
    return status()
  }

  /**
   * 开启保持唤醒。已经在 active 时是**幂等**的：不叠加第二个子进程。
   * @returns {Promise<{active: boolean, pid: number|null, startedAt: number|null}>} 启动后的状态。
   * @throws {AwakeError} 启动失败。
   */
  function start() {
    if (current !== null) return Promise.resolve(status())
    if (pending !== null) return pending
    const run = launch()
    pending = run
    run.then(
      () => { pending = null },
      () => { pending = null },
    )
    return run
  }

  /**
   * 关闭保持唤醒。已经 inactive 时是幂等的空操作。
   * 若此刻正有一次启动在飞，先等它落地再杀，避免留下一个没人认领的 `caffeinate`。
   * @returns {Promise<{active: boolean, pid: number|null, startedAt: number|null}>} 停止后的状态。
   */
  async function stop() {
    if (pending !== null) {
      try {
        await pending
      } catch {
        // 启动本来就失败了，没有需要回收的东西。
      }
    }
    const entry = current
    if (entry === null) return status()
    current = null
    try {
      entry.child.kill('SIGTERM')
    } catch {
      // 已经退出了；状态已经是 inactive，不需要额外处理。
    }
    return status()
  }

  /**
   * 宿主卸载时的收尾：一定要杀掉子进程，不留孤儿 `caffeinate`。
   * @returns {Promise<void>} 完成。
   */
  async function dispose() {
    await stop()
  }

  return { status, start, stop, dispose }
}

/**
 * `zhihu-cli` 的唯一出口。
 *
 * 这一层只负责「起进程、拿回三个东西」：退出码、stdout、stderr。成败判定在
 * `parse.js`，排队在 `queue.js` —— 这里不重试、不解析、不吞错误。
 *
 * 环境变量走白名单：CLI 自己从系统凭证库读 Access Secret，插件进程既不读也不传，
 * 所以这里绝不会出现 `ZHIHU_ACCESS_SECRET` 之类的键。
 * @module dsh-plugin-zhihu-sidebar/host/cli
 */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 探针阶段放在插件目录里的二进制；后续可换成 `.runtime/` 或系统安装路径。 */
export const DEFAULT_BIN_PATH = fileURLToPath(new URL('../../.probe/bin/zhihu-cli', import.meta.url))

/** 单次调用上限。知乎侧最慢的是知识库上传（200s），本插件只用只读命令。 */
export const DEFAULT_TIMEOUT_MS = 20000

/** 白名单：够 CLI 找到系统工具与 Keychain，不含任何凭证。 */
const ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']

/**
 * 从宿主环境里挑出白名单变量。
 * @param {NodeJS.ProcessEnv} [source] 源环境。
 * @returns {Record<string, string>} 最小环境。
 */
export function minimalEnv(source = process.env) {
  /** @type {Record<string, string>} */
  const env = {}
  for (const key of ENV_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value !== '') env[key] = value
  }
  if (env.PATH === undefined) env.PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  return env
}

/**
 * 建一个 CLI 调用器。
 * @param {object} [options] 选项。
 * @param {string} [options.binPath] 二进制路径。
 * @param {number} [options.timeoutMs] 超时；由 libuv 杀进程，不依赖系统 `timeout`。
 * @param {Record<string, string>} [options.env] 追加/覆盖的环境变量（测试注入用）。
 * @param {typeof execFile} [options.exec] 注入的执行器（测试用）。
 * @param {number} [options.maxBuffer] stdout 上限，热榜/搜索远小于此。
 * @returns {{ binPath: string, timeoutMs: number, run: (args: string[]) => Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean, spawnError: string|null }> }} 调用器。
 */
export function createCli({
  binPath = DEFAULT_BIN_PATH,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env,
  exec = execFile,
  maxBuffer = 8 * 1024 * 1024,
} = {}) {
  const resolvedEnv = env === undefined ? minimalEnv() : { ...minimalEnv(), ...env }

  return {
    binPath,
    timeoutMs,
    /**
     * 跑一条命令。
     * @param {string[]} args 参数（不含二进制本身）。
     * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean, spawnError: string|null }>} 原始结果；`code` 为 null 表示进程没正常退出（ENOENT / 被信号杀掉）。
     */
    run(args) {
      return new Promise((resolve) => {
        exec(
          binPath,
          args,
          { timeout: timeoutMs, env: resolvedEnv, maxBuffer, encoding: 'utf8', windowsHide: true },
          (error, stdout, stderr) => {
            const out = typeof stdout === 'string' ? stdout : ''
            const err = typeof stderr === 'string' ? stderr : ''
            if (error === null || error === undefined) {
              resolve({ code: 0, stdout: out, stderr: err, timedOut: false, spawnError: null })
              return
            }
            const numeric = typeof error.code === 'number'
            resolve({
              code: numeric ? error.code : null,
              stdout: out,
              stderr: err,
              timedOut: error.killed === true,
              spawnError: numeric ? null : String(error.code ?? error.message),
            })
          },
        )
      })
    },
  }
}

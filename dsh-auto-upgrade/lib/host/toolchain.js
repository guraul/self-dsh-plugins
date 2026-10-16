/**
 * 工具链定位与前置体检。
 *
 * 移植自用户手写脚本 `upgrade-dsh.sh` 的 `preflight()`：**必须用 dsh 自己那个
 * Node 的 npm**，否则 nvm 多版本会把包装到另一个全局根，看着"升级成功"其实没变。
 * 本插件不用 `which dsh`，而是用宿主给的 `profileContext.installAnchor`（正在运行的
 * dsh 安装的 package.json），再由 `process.execPath` 定位同目录的 node/npm。
 * @module dsh-plugin-auto-upgrade/host/toolchain
 */
import { execFile } from 'node:child_process'
import { access, readFile, readdir, stat, statfs } from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * 跑一个一次性子进程。
 * @param {string} command 可执行文件。
 * @param {string[]} args 参数。
 * @param {{timeoutMs?:number, cwd?:string, env?:NodeJS.ProcessEnv}} [options] 选项。
 * @returns {Promise<{ok:boolean, code:number|string, stdout:string, stderr:string, error?:string}>} 结果（不抛错）。
 */
export function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      {
        timeout: options.timeoutMs ?? 20000,
        cwd: options.cwd,
        env: options.env,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolvePromise({
          ok: error === null,
          code: error === null ? 0 : (error.code ?? 1),
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          error: error === null ? undefined : (error.message ?? String(error)),
        })
      },
    )
  })
}

/**
 * 由宿主上下文推出工具链事实。
 * @param {{installAnchor?:string, dir?:string, name?:string, home?:string}} profileContext 宿主 profile 事实。
 * @param {{execPath?:string, platform?:string}} [runtime] 运行时可注入缝（单测用）。
 * @returns {{manifestPath:string, dshDir:string, node:string, npm:string, dshBin:string, binDir:string, platform:string}} 工具链。
 * @throws {Error} installAnchor 缺失时抛出。
 */
export function resolveInstallation(profileContext, runtime = {}) {
  const installAnchor = profileContext?.installAnchor
  if (typeof installAnchor !== 'string' || installAnchor === '') {
    throw new Error('profileContext.installAnchor is unavailable; the plugin requires a profile launched by dsh')
  }
  const platform = runtime.platform ?? process.platform
  const execPath = runtime.execPath ?? process.execPath
  const manifestPath = resolve(installAnchor)
  const dshDir = dirname(manifestPath)
  const binDir = dirname(execPath)
  const win = platform === 'win32'
  return {
    manifestPath,
    dshDir,
    binDir,
    platform,
    node: execPath,
    npm: join(binDir, win ? 'npm.cmd' : 'npm'),
    dshBin: join(binDir, win ? 'dsh.cmd' : 'dsh'),
  }
}

/**
 * 读安装目录里的 dsh 版本。
 * @param {string} manifestPath dsh 的 package.json 路径。
 * @returns {Promise<string|undefined>} 版本号；读不到返回 undefined。
 */
export async function readInstalledVersion(manifestPath) {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * 全局 npm 根目录（由安装目录反推：…/lib/node_modules/@deepseek-ai/dsh → …/lib/node_modules）。
 * @param {string} dshDir dsh 安装目录。
 * @returns {string} 推出来的全局根。
 */
export function expectedNpmRoot(dshDir) {
  return resolve(dshDir, '..', '..')
}

/**
 * 目录体积（有界遍历，避免把事件循环按住）。
 * @param {string} dir 目录。
 * @param {{maxEntries?:number}} [options] 选项。
 * @returns {Promise<{bytes:number, files:number, truncated:boolean}>} 统计结果。
 */
export async function directorySize(dir, options = {}) {
  const maxEntries = options.maxEntries ?? 200000
  let bytes = 0
  let files = 0
  let entries = 0
  let truncated = false
  /** @type {string[]} */
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let dirents
    try {
      dirents = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      entries += 1
      if (entries > maxEntries) {
        truncated = true
        return { bytes, files, truncated }
      }
      const full = join(current, dirent.name)
      if (dirent.isDirectory()) {
        stack.push(full)
      } else if (dirent.isFile()) {
        try {
          const { size } = await stat(full)
          bytes += size
          files += 1
        } catch {
          /* 读不到就跳过，不影响体检结论 */
        }
      }
    }
  }
  return { bytes, files, truncated }
}

/**
 * 磁盘剩余空间。
 * @param {string} path 任意已存在路径。
 * @returns {Promise<number|undefined>} 字节数；平台不支持时 undefined。
 */
export async function freeDiskBytes(path) {
  try {
    const info = await statfs(path)
    return Number(info.bavail) * Number(info.bsize)
  } catch {
    return undefined
  }
}

/**
 * 检查路径可写。
 * @param {string} path 目标路径。
 * @returns {Promise<boolean>} 可写返回 true。
 */
export async function isWritable(path) {
  try {
    await access(path, FS.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 前置体检：升级前把本机事实摊开给用户看。只读，不安装、不联网。
 * @param {object} options 输入。
 * @param {ReturnType<typeof resolveInstallation>} options.installation 工具链。
 * @param {string} options.profileName profile 名。
 * @param {string} [options.dshHome] DSH home（默认由 profileContext.home 推）。
 * @param {string} [options.stateDir] 插件状态目录。
 * @param {string} [options.backupBase] 备份目标（展示用）。
 * @returns {Promise<object>} 体检结果。
 */
export async function preflight(options) {
  const { installation, profileName } = options
  const dshHome = options.dshHome ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh')
  const version = await readInstalledVersion(installation.manifestPath)
  const npmRoot = await run(installation.npm, ['root', '-g'], { timeoutMs: 15000 })
  const npmRootG = npmRoot.ok ? npmRoot.stdout.trim() : undefined
  const npmVersion = await run(installation.npm, ['-v'], { timeoutMs: 15000 })
  const installScope = dirname(installation.dshDir)
  const [installWritable, scopeWritable, disk, home] = await Promise.all([
    isWritable(installation.dshDir),
    isWritable(installScope),
    freeDiskBytes(installScope),
    directorySize(dshHome, { maxEntries: 60000 }),
  ])
  return {
    dsh: {
      bin: installation.dshBin,
      manifestPath: installation.manifestPath,
      installDir: installation.dshDir,
      version,
    },
    node: { execPath: installation.node, version: process.version },
    npm: {
      command: installation.npm,
      version: npmVersion.ok ? npmVersion.stdout.trim() : undefined,
      rootG: npmRootG,
      expectedRoot: expectedNpmRoot(installation.dshDir),
      matchesInstall: npmRootG !== undefined && npmRootG === expectedNpmRoot(installation.dshDir),
      error: npmRoot.ok ? undefined : npmRoot.error,
    },
    profile: { name: profileName ?? undefined },
    paths: { dshHome, stateDir: options.stateDir, backupBase: options.backupBase },
    disk: { freeBytes: disk },
    dataDir: home,
    writable: { installDir: installWritable, installScope: scopeWritable },
  }
}

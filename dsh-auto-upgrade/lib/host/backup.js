/**
 * 数据目录备份与恢复。
 *
 * 只备份 `~/.dsh`（本机约 11 MB）——安装树 510 MB 不做整棵拷贝，
 * 回滚优先走「nvm 的 npm 重装旧版本」，与用户手写脚本 `upgrade-dsh.sh` 的策略一致。
 * @module dsh-plugin-auto-upgrade/host/backup
 */
import { cp as fsCp, mkdir, readdir, rename as fsRename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { directorySize } from './toolchain.js'

/**
 * 时间戳后缀（与用户脚本同样的 `YYYYmmdd-HHMMSS`）。
 * @param {Date} [now] 时刻。
 * @returns {string} 时间戳。
 */
export function timestamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * 备份目标路径。
 * @param {string} dshHome 数据目录（通常是 `~/.dsh`）。
 * @param {string} ts 时间戳。
 * @returns {string} 备份目录绝对路径。
 */
export function backupPath(dshHome, ts) {
  return `${dshHome}.bak-${ts}`
}

/**
 * 找最近一次备份。
 * @param {string} dshHome 数据目录。
 * @returns {Promise<string|undefined>} 备份目录；没有则 undefined。
 */
export async function findLatestBackup(dshHome) {
  const parent = dirname(dshHome)
  const prefix = `${basename(dshHome)}.bak-`
  try {
    const entries = await readdir(parent)
    const matches = entries.filter((name) => name.startsWith(prefix) && !name.includes('.before-restore-')).sort()
    const latest = matches[matches.length - 1]
    return latest === undefined ? undefined : join(parent, latest)
  } catch {
    return undefined
  }
}

/**
 * 备份数据目录（`cp -a` 语义）。
 * @param {{dshHome:string, ts:string, meta?:Record<string,string>, onLog?:(line:string)=>void, copy?:Function}} options 输入。
 * @returns {Promise<{ok:true, target:string, bytes:number, files:number}|{ok:false, error:string}>} 结果。
 */
export async function createBackup(options) {
  const copy = options.copy ?? fsCp
  const onLog = options.onLog ?? (() => {})
  const target = backupPath(options.dshHome, options.ts)
  try {
    await stat(options.dshHome)
  } catch {
    onLog(`${options.dshHome} 不存在，跳过备份`)
    return { ok: true, target: '', bytes: 0, files: 0 }
  }
  try {
    await stat(target)
    return { ok: false, error: `备份目标已存在：${target}` }
  } catch {
    /* 目标不存在，继续 */
  }
  const before = await directorySize(options.dshHome, { maxEntries: 60000 })
  onLog(`备份 ${options.dshHome}（约 ${before.files} 个文件）→ ${target}`)
  try {
    await copy(options.dshHome, target, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: true,
    })
  } catch (error) {
    return { ok: false, error: `备份失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const lines = Object.entries({ backupAt: options.ts, ...(options.meta ?? {}) })
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
  try {
    await writeFile(join(target, 'UPGRADE-INFO.txt'), `${lines}\n`, 'utf8')
  } catch {
    /* 附加信息写不进去不影响备份本身 */
  }
  return { ok: true, target, bytes: before.bytes, files: before.files }
}

/**
 * 用备份覆盖当前数据目录（先把现场改名让路，中途失败可还原）。
 * @param {{dshHome:string, source:string, ts:string, onLog?:(line:string)=>void, copy?:Function, rename?:Function}} options 输入。
 * @returns {Promise<{ok:true, movedAside?:string}|{ok:false, error:string}>} 结果。
 */
export async function restoreBackup(options) {
  const copy = options.copy ?? fsCp
  const move = options.rename ?? fsRename
  const onLog = options.onLog ?? (() => {})
  const movedAside = `${options.dshHome}.before-restore-${options.ts}`
  let moved = false
  try {
    await stat(options.source)
  } catch {
    return { ok: false, error: `备份不存在：${options.source}` }
  }
  try {
    await stat(options.dshHome)
    await mkdir(dirname(options.dshHome), { recursive: true })
    await move(options.dshHome, movedAside)
    moved = true
    onLog(`当前数据已移到 ${movedAside}`)
  } catch (error) {
    if (moved) return { ok: false, error: `移动当前数据失败：${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    await copy(options.source, options.dshHome, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: true,
    })
  } catch (error) {
    if (moved) {
      try {
        await move(movedAside, options.dshHome)
        onLog('恢复失败，已把现场还原回去')
      } catch {
        /* 还原也失败时保留现场路径给用户 */
      }
    }
    return { ok: false, error: `恢复备份失败：${error instanceof Error ? error.message : String(error)}` }
  }
  onLog(`已从备份恢复：${options.source}`)
  return { ok: true, movedAside: moved ? movedAside : undefined }
}

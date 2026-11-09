/**
 * 一次性 profile 的引导（issue #392）。
 *
 * `probe.js` 刻意保持无依赖（只做解析与判定），所以「建目录」这类副作用放在这里。
 *
 * 真机复现：全新的 `DSH_HOME` 里没有任何 profile 时，
 * `dsh --profile probe --dump-config` 直接 `exit 1`（`profile "probe" does not exist`），
 * 第一次基线 dump 必然失败，立刻重试也一样——0.9.7 的「重试一次」就是基于错误假设。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 在一次性 `DSH_HOME` 里建出可用的空 profile。
 * @param {string} dshHome 一次性 DSH_HOME。
 * @param {string} profileName profile 名。
 * @returns {Promise<string>} profile 目录。
 */
export async function ensureProbeProfile(dshHome, profileName) {
  const dir = join(dshHome, 'profiles', profileName)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: `dsh-profile-${profileName}`, private: true, dependencies: {} }, null, 2)}\n`,
  )
  return dir
}

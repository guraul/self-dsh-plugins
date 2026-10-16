/**
 * 载入「正在运行的那份 dsh」自带的官方模块。
 *
 * 为什么不直接 `import '@deepseek-ai/dsh-app-boot'`：profile 的 node_modules
 * 里没有官方包，pnpm 只会把我们声明的 peer 再装一份副本（版本还未必等于运行时）。
 * `ctx.profileContext.installAnchor` 是「正在运行的那份 dsh 安装的 package.json」，
 * 由它推出来的绝对路径，才是宿主此刻真正执行的那份代码。
 * @module dsh-plugin-auto-upgrade/host/official
 */
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** @type {Map<string, Promise<any>>} */
const cache = new Map()

/**
 * 载入官方 app-boot 模块（兼容性判定 / profile 插件清单 / 豁免读写都在里面）。
 * @param {string} installAnchor 正在运行的 dsh 安装的 package.json 绝对路径。
 * @returns {Promise<any>} 模块命名空间。
 */
export function loadOfficialAppBoot(installAnchor) {
  if (typeof installAnchor !== 'string' || installAnchor === '') {
    return Promise.reject(new Error('profileContext.installAnchor is unavailable; cannot locate the running dsh installation'))
  }
  const cached = cache.get(installAnchor)
  if (cached !== undefined) return cached
  const pending = (async () => {
    const entry = join(dirname(installAnchor), 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
    try {
      return await import(pathToFileURL(entry).href)
    } catch (error) {
      // 退化路径：极少数部署把官方包放进了 profile 的解析范围。
      try {
        return await import('@deepseek-ai/dsh-app-boot')
      } catch {
        throw new Error(`cannot load @deepseek-ai/dsh-app-boot from ${entry}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })()
  cache.set(installAnchor, pending)
  return pending
}

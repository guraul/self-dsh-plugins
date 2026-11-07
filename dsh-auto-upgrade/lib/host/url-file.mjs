/**
 * 让 `.dsh-web/url.txt` 始终是**当前**的启动地址（issue #365）。
 *
 * 背景：启动令牌是进程级的，每次重启都换。`url.txt` 原来只有「升级 helper」会刷新，
 * 而 `restart-once.sh`、手动 `launchctl kickstart`、登录自启都绕过它——于是文件经常停在旧令牌上，
 * 谁读谁 401。
 *
 * 这里改成**插件加载时刷新**：插件每次宿主启动都会被加载，所以不管谁触发启动，文件都是新鲜的。
 * 不动 LaunchAgent 配置（那属于宿主级改动，且要 bootout + bootstrap 才生效）。
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { latestTokenUrl } from './token-url.js'

/**
 * 从插件自己的位置推出仓库根：**往上找 `.git`**，不按固定层数剥
 * （`lib/host/*.mjs` 要四层、`lib/index.js` 只要三层，写死层数必错——#369 review 的 blocker）。
 * 注意：这里**只推路径、不判断**是不是 link 安装——从 npm 装时推出来的目录没有 `.dsh-web/`，
 * 调用方读日志会失败并静默放弃（见 `refreshUrlFile` 的「读不到日志」分支）。
 * @param {string} moduleUrl 当前模块的 `import.meta.url`。
 * @returns {string|undefined} 仓库根；不在仓库里返回 undefined。
 */
export function repoRootFrom(moduleUrl) {
  try {
    let dir = dirname(fileURLToPath(moduleUrl))
    // 不能按固定层数剥：`lib/host/x.mjs` 要四层，`lib/index.js` 只要三层。
    // 往上找**仓库标记**（`.git` 目录或 linked worktree 的 `.git` 文件）才靠谱。
    for (let depth = 0; depth < 8; depth += 1) {
      if (existsSync(join(dir, '.git'))) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 判断这个地址是不是「活的」：能连上且不需要重定向到别处。
 *
 * 旧令牌在重启瞬间可能仍然返回 303，所以这里只作**粗筛**（连不上就绝不写），
 * 真正的「是不是新的」由调用方拿 `latestTokenUrl` 的最后一条保证——日志里最后一条就是当前进程的地址。
 * @param {string} url 候选地址。
 * @param {typeof fetch} fetchImpl fetch 实现（测试可注入）。
 * @returns {Promise<boolean>} 认证通过返回 true。
 */
export async function authenticates(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) })
    return [200, 302, 303].includes(response.status)
  } catch {
    return false
  }
}

/**
 * 把日志里最新的启动地址写进 `url.txt`。
 *
 * 只在**内容真的变了**且**地址能认证**时写：写一个连不上的地址比不写更糟。
 * @param {object} options 输入。
 * @param {string} options.repoRoot 仓库根（其下有 `.dsh-web/`）。
 * @param {number} options.port 宿主端口（只取这个端口的地址）。
 * @param {number} [options.since] 只认日志中这个**字符偏移之后**的内容（默认 0）。
 *   ⚠️ 是**字符数**（`String.prototype.length`），不是字节数：日志里有中文，两者差着几万，
 *   用 `stat().size` 当偏移会直接切到文件末尾之外，永远读不到新地址（#365 review 轮 2 的 blocker）。
 *   关键：插件加载**早于**宿主打印地址，加载瞬间日志最后一条还是**上一个进程**的（已 401）。
 *   调用方要在加载时记下日志长度，之后只接受新写进来的那一段。
 * @param {() => Promise<string>} [options.readLog] 读日志（默认读 `<repo>/.dsh-web/web.out.log`）。
 * @param {() => Promise<string>} [options.readUrl] 读 url.txt（默认读 `<repo>/.dsh-web/url.txt`）。
 * @param {(text: string) => Promise<void>} [options.writeUrl] 写 url.txt。
 * @param {(url: string) => Promise<boolean>} [options.check] 认证检查。
 * @returns {Promise<{changed: boolean, url?: string, reason?: string}>} 结果。
 */
export async function refreshUrlFile(options) {
  const dir = join(options.repoRoot, '.dsh-web')
  const readLog = options.readLog ?? (() => readFile(join(dir, 'web.out.log'), 'utf8'))
  const readUrl = options.readUrl ?? (() => readFile(join(dir, 'url.txt'), 'utf8'))
  const writeUrl = options.writeUrl ?? ((text) => writeFile(join(dir, 'url.txt'), text))
  const check = options.check ?? ((url) => authenticates(url))

  let log
  try {
    log = await readLog()
  } catch {
    return { changed: false, reason: '读不到日志' }
  }
  // 只看「加载之后」新写进来的那一段：否则会把上一个进程的地址当成当前地址（#293 的坑）。
  const fresh = options.since === undefined || options.since <= 0 ? log : log.slice(options.since)
  const url = latestTokenUrl(fresh, options.port)
  if (url === undefined) return { changed: false, reason: '加载之后日志里还没有带令牌的启动地址' }

  let previous = ''
  try {
    previous = (await readUrl()).trim()
  } catch {
    previous = ''
  }
  if (previous === url) return { changed: false, url }

  // 写之前必须认证通过：写一个 401 的地址比留着旧地址更糟（旧地址至少曾经能用）。
  if (!(await check(url))) return { changed: false, url, reason: '候选地址认证失败' }

  await writeUrl(`${url}\n`)
  return { changed: true, url }
}

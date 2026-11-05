/**
 * dsh-subagents 的冒烟断言（契约见 `docs/plugins/dsh-auto-upgrade.md` 的 `dsh.smoke`）。
 *
 * 只验「纯函数 + 角色文件 + 导出面」这类 5 秒内能确定的事：真跑一次 subagent 委派属人工实测。
 * 目的是升级后立刻回答「这个插件还活着吗」——角色层坏了、任务卡契约漂了、导出没了，都要红。
 */
import { readFile } from 'node:fs/promises'

/**
 * 跑一遍断言。只验 5 秒内能确定的事（角色文件 / 任务卡契约 / 导出面）；真跑委派属人工实测。
 * @returns {Promise<{ok: boolean, checks: {name: string, ok: boolean, detail?: string}[]}>} 结果。
 */
export async function run() {
  /** @type {{name: string, ok: boolean, detail?: string}[]} */
  const checks = []
  /**
   * 跑一条断言：抛错也算失败（不把「断言本身崩了」当成通过）。
   * @param {string} name 断言名。
   * @param {() => Promise<{ok: boolean, detail?: string}>} fn 断言体。
   * @returns {Promise<void>} 无。
   */
  const check = async (name, fn) => {
    try {
      const { ok, detail } = await fn()
      checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  for (const role of ['executor', 'reviewer']) {
    await check(`角色文件 ${role}.json 可解析`, async () => {
      const parsed = JSON.parse(await readFile(new URL(`./roles/${role}.json`, import.meta.url), 'utf8'))
      return { ok: typeof parsed.description === 'string' && parsed.description !== '', detail: '含 description' }
    })
  }

  await check('任务卡能渲染并解析回来（契约没漂）', async () => {
    const card = await import('./lib/card.js')
    const rendered = card.renderCard({
      role: 'executor', goal: '冒烟：渲染一张任务卡', round: 1,
      boundaries: ['只改 smoke.mjs'], acceptance: ['run() 返回 ok'], pointers: ['docs/plugins/dsh-auto-upgrade.md'],
    })
    const parsed = card.parseCard(rendered)
    return { ok: typeof rendered === 'string' && parsed?.role === 'executor', detail: `role=${String(parsed?.role)}` }
  })

  await check('插件导出面完整（apply / inject / name）', async () => {
    const host = await import('./lib/index.js')
    return { ok: ['apply', 'inject', 'name'].every((key) => key in host) }
  })

  return { ok: checks.every((item) => item.ok), checks }
}

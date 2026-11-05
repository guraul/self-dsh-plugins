/**
 * dsh-subagents 的冒烟断言（契约见 `docs/plugins/dsh-auto-upgrade.md` 的 `dsh.smoke`）。
 *
 * 只验「纯函数 + 角色文件 + 导出面」这类 5 秒内能确定的事：真跑一次 subagent 委派属人工实测。
 * 目的是升级后立刻回答「这个插件还活着吗」——角色层坏了、任务卡契约漂了、导出没了，都要红。
 */
import { readFile } from 'node:fs/promises'

/**
 * 跑一遍断言。
 * @returns {Promise<{ok: boolean, checks: {name: string, ok: boolean, detail?: string}[]}>} 结果。
 */
export async function run() {
  const checks = []

  for (const role of ['executor', 'reviewer']) {
    try {
      const raw = await readFile(new URL(`./roles/${role}.json`, import.meta.url), 'utf8')
      const parsed = JSON.parse(raw)
      checks.push({
        name: `角色文件 ${role}.json 可解析`,
        ok: typeof parsed.description === 'string' && parsed.description !== '',
        detail: typeof parsed.description === 'string' ? '含 description' : '缺 description',
      })
    } catch (error) {
      checks.push({
        name: `角色文件 ${role}.json 可解析`,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  try {
    const card = await import('./lib/card.js')
    const rendered = card.renderCard({
      role: 'executor',
      goal: '冒烟：渲染一张任务卡',
      round: 1,
      boundaries: ['只改 smoke.mjs'],
      acceptance: ['run() 返回 ok'],
      pointers: ['docs/plugins/dsh-auto-upgrade.md'],
    })
    const parsed = card.parseCard(rendered)
    checks.push({
      name: '任务卡能渲染并解析回来（契约没漂）',
      ok: typeof rendered === 'string' && parsed?.role === 'executor',
      detail: `role=${String(parsed?.role)}`,
    })
  } catch (error) {
    checks.push({
      name: '任务卡能渲染并解析回来（契约没漂）',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    })
  }

  try {
    const host = await import('./lib/index.js')
    checks.push({
      name: '插件导出面完整（apply / inject / name）',
      ok: ['apply', 'inject', 'name'].every((key) => key in host),
    })
  } catch (error) {
    checks.push({
      name: '插件导出面完整（apply / inject / name）',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    })
  }

  return { ok: checks.every((check) => check.ok), checks }
}

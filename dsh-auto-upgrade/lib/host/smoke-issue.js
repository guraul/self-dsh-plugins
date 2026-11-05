/**
 * 冒烟失败 → 自动开 issue（issue #300 的 P2b）。
 *
 * 为什么要自动开：冒烟的价值在于**升级打挂插件后立刻有人知道**。结果只写进
 * `~/.dsh-auto-upgrade/smoke.json` 等于没人看——今天 im-bridge 那次就是这样，
 * 用户过了几小时才发现「插件好像没生效」。
 *
 * 边界：
 * - **只有失败才开**；`partial`（插件没写 `dsh.smoke`，只跑了兜底三项）不算失败，绝不开 issue；
 * - 标题带版本与插件名，复用 `reportIssue` 的同名 open issue 去重（同版本重复跑不会刷屏）；
 * - 开 issue 失败只记日志，**不影响冒烟本身的结果**。
 */

/** 标题里的插件名最多列几个，其余折叠（issue 标题不该长到看不完）。 */
const MAX_NAMES = 3

/**
 * 从冒烟结果里挑出真正失败的插件。
 * @param {object[]} results `runSmokes` 的结果。
 * @returns {object[]} 失败的项（`ok === false`）。
 */
export function failedResults(results) {
  return (results ?? []).filter((item) => item.ok === false)
}

/**
 * 组装 issue 标题。
 * @param {{version: string, failed: object[]}} input 输入。
 * @returns {string} 标题。
 */
export function smokeIssueTitle(input) {
  const names = input.failed.map((item) => item.name)
  const shown = names.slice(0, MAX_NAMES).join('、')
  const more = names.length > MAX_NAMES ? ` 等 ${String(names.length)} 个` : ''
  return `dsh-auto-upgrade：升级到 ${input.version} 后 ${String(names.length)} 个插件冒烟失败（${shown}${more}）`
}

/**
 * 把断言细节弄成可以进公开 issue 的样子：截断，并把本机家目录抹掉。
 * @param {string} detail 原始细节。
 * @returns {string} 处理后的细节。
 */
export function safeDetail(detail) {
  return String(detail ?? '').replace(/\/Users\/[^/\s]+/g, '~').slice(0, 200)
}

/**
 * 组装 issue 正文：逐插件列出失败断言，附复现方式。
 * @param {{version: string, failed: object[], at?: number}} input 输入。
 * @returns {string} Markdown 正文。
 */
export function smokeIssueBody(input) {
  const lines = [
    `升级到 **${input.version}** 后，下面的插件通过了装配（试装），但**冒烟断言失败**——`,
    '也就是「装得上，但行为坏了」。这类问题 `peerDependencies` 与试装都看不出来。',
    '',
    '| 插件 | 失败断言 | 说明 |',
    '|---|---|---|',
  ]
  for (const item of input.failed) {
    const bad = (item.checks ?? []).filter((check) => check.ok !== true)
    const names = bad.map((check) => `\`${check.name}\``).join('<br>')
    const details = bad.map((check) => safeDetail(check.detail)).filter((text) => text !== '').join('<br>')
    lines.push(`| \`${item.name}\` | ${names || '（整体失败）'} | ${details || item.detail || '—'} |`)
  }
  lines.push(
    '',
    '## 怎么复现',
    '',
    '```sh',
    'curl -s http://127.0.0.1:3080/api/dsh-auto-upgrade/smoke | jq .',
    'curl -s -X POST http://127.0.0.1:3080/api/dsh-auto-upgrade/smoke | jq .   # 重跑一次',
    '```',
    '',
    `> 由 dsh-auto-upgrade 在 ${new Date(input.at ?? Date.now()).toISOString()} 冒烟后自动创建；`,
    '> 同一版本的重复冒烟不会重复开单（按标题去重）。',
    '',
  )
  return lines.join('\n')
}

/**
 * 判定这次冒烟要不要开 issue，并给出标题与正文。
 * @param {{version: string, results: object[], at?: number}} input 输入。
 * @returns {{needed: boolean, title?: string, body?: string, failed: object[]}} 计划。
 */
export function planSmokeIssue(input) {
  const failed = failedResults(input.results)
  if (failed.length === 0) return { needed: false, failed }
  const version = input.version ?? 'unknown'
  return {
    needed: true,
    title: smokeIssueTitle({ version, failed }),
    body: smokeIssueBody({ version, failed, at: input.at }),
    failed,
  }
}

/**
 * 需要时开 issue：把「要不要开、开失败怎么办」都收在这里，宿主只负责传参。
 *
 * 返回值**永不抛错**——冒烟结果本身比开单更重要，开单失败只降级成 `reason`。
 * @param {object} input 输入。
 * @param {string} input.version 当前 dsh 版本。
 * @param {object[]} input.results 冒烟结果。
 * @param {number} [input.at] 时间戳。
 * @param {string|undefined} input.slug 仓库 slug（`owner/repo`）。
 * @param {(args: {slug: string, title: string, body: string}) => Promise<{number: number}>} input.report 开单函数。
 * @returns {Promise<{opened: boolean, number?: number, created?: boolean, reason?: string}>} 结果。
 */
export async function maybeReportSmokeFailures(input) {
  const plan = planSmokeIssue({ version: input.version, results: input.results, at: input.at })
  if (!plan.needed) return { opened: false, reason: 'no-failures' }
  if (typeof input.slug !== 'string' || input.slug === '') return { opened: false, reason: 'no-slug' }
  try {
    const created = await input.report({ slug: input.slug, title: plan.title, body: plan.body })
    return { opened: true, number: created.number, created: created.created }
  } catch (error) {
    return { opened: false, reason: `report-failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

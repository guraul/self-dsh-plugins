/**
 * publish：把一条审核记录变成 PR 上的动作（评论 + review 状态）。
 *
 * 判定 → 动作的映射是纯函数，便于单测；真正的网络调用由 `gh` 完成，
 * 身份取决于调用方的 `GH_CONFIG_DIR`（机器账号），插件不接触凭据。
 */
import { renderComment } from './comment.js'

/** 从 git remote URL 解析 owner/repo（SSH 与 HTTPS 两种形态）。 */
export function parseRemoteUrl(url) {
  const text = String(url ?? '').trim()
  const ssh = /^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/.exec(text)
  if (ssh) return `${ssh[1]}/${ssh[2]}`
  const https = /^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/.exec(text)
  if (https) return `${https[1]}/${https[2]}`
  return null
}

/** APPROVE → approve；REJECT → request-changes；ESCALATE → 只发评论，交回人工。 */
export function reviewAction(verdict) {
  if (verdict === 'APPROVE') return 'approve'
  if (verdict === 'REJECT') return 'request-changes'
  return 'none'
}

/**
 * @param {{ record: object, round: number, maxRounds?: number, summary?: string }} input
 * @returns {{ commentBody: string, action: 'approve'|'request-changes'|'none', reviewBody: string }}
 */
export function publishPlan({ record, round, maxRounds, summary }) {
  if (!record || typeof record.verdict !== 'string') {
    throw new Error('publishPlan: 记录缺少 verdict')
  }
  const action = reviewAction(record.verdict)
  const commentBody = renderComment({ result: record, round, maxRounds })
  const reviewBody =
    summary ??
    (action === 'approve'
      ? '审核通过（判定 APPROVE）。'
      : action === 'request-changes'
        ? '按评论里的「必须修」修复后重新提交。'
        : '判定 ESCALATE，已交回人工裁决。')
  return { commentBody, action, reviewBody }
}

/** 组装要执行的 gh 命令（不执行，便于单测与 --dry-run）。 */
export function ghCommands({ plan, pr, repo }) {
  const base = ['--repo', repo]
  const commands = [{ args: ['pr', 'comment', String(pr), ...base, '--body-file', '-'], stdin: plan.commentBody }]
  if (plan.action !== 'none') {
    commands.push({
      args: ['pr', 'review', String(pr), ...base, `--${plan.action}`, '--body', plan.reviewBody],
      stdin: null,
    })
  }
  return commands
}

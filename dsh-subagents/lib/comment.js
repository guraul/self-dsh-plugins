/**
 * PR comment：把一条审核记录渲染成给人看的结论。
 *
 * 只做渲染：不发评论、不提交 review 状态——对外动作由控制面用机器账号落地，
 * 这样 reviewer 子代理永远不需要拿到 bot 凭据。
 */
import { MAX_ROUNDS } from './card.js'

const VERDICT_LABEL = {
  APPROVE: 'APPROVE',
  REJECT: 'REQUEST_CHANGES',
  ESCALATE: 'ESCALATE（交回人工）',
}

const BLOCKING = new Set(['blocker', 'major'])

/** findings 的 message 是模型原文，进 markdown 前必须压平：换行会断列表、反引号会破行内代码、@ 会误 ping。 */
export function safeInline(text) {
  return String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/`/g, "'")
    .replace(/@/g, '@\u200b')
    .trim()
}

function bullet(items, empty = '（无）') {
  if (items.length === 0) return `- ${empty}`
  return items.map((item) => `- ${item}`).join('\n')
}

/**
 * @param {{ result: object, round: number, maxRounds?: number }} input
 *   `result` 形如审核记录：verdict / head_sha / form / model / durationMs / traceId / findings / evidence
 */
export function renderComment({ result, round, maxRounds = MAX_ROUNDS }) {
  if (!result || typeof result.verdict !== 'string') {
    throw new Error('renderComment: 缺少 result.verdict')
  }
  if (!Number.isInteger(round) || round < 1) {
    throw new Error('renderComment: round 必须是正整数')
  }
  const label = VERDICT_LABEL[result.verdict] ?? result.verdict
  const findings = Array.isArray(result.findings) ? result.findings : []
  const mustFix = findings
    .filter((finding) => BLOCKING.has(finding.severity))
    .map((finding) => `\`${safeInline(finding.file)}:${finding.line}\` ${safeInline(finding.message)}`)
  const suggestions = findings
    .filter((finding) => !BLOCKING.has(finding.severity))
    .map((finding) => `\`${safeInline(finding.file)}:${finding.line}\` ${safeInline(finding.message)}`)

  return [
    `## 审核判定：${label}（第 ${round} 次 / 共 ${maxRounds} 次）`,
    '',
    `**提交**：${result.head_sha}`,
    `**形态/模型**：${result.form} / ${result.model}`,
    `**耗时**：${Math.round((result.durationMs ?? 0) / 1000)}s　**traceId**：${result.traceId}`,
    result.errorCode ? `**错误码**：${result.errorCode}` : undefined,
    '',
    '### 必须修',
    bullet(mustFix),
    '',
    '### 建议（不阻塞）',
    bullet(suggestions),
    '',
    '### 证据',
    bullet(
      (Array.isArray(result.evidence) ? result.evidence : []).map((item) => `\`${safeInline(item)}\``),
    ),
    '',
  ]
    .filter((line) => line !== undefined)
    .join('\n')
}

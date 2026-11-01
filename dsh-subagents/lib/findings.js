/**
 * 从 reviewer 的输出里提取结构化 findings。
 *
 * 约定：reviewer 在判定行之前输出一个 ```json 代码块：
 *   {"findings":[{severity,file,line,message}], "evidence":["文件:行"]}
 *
 * 解析失败不抛错——审核不能因为「格式没跟上」就整体失败；返回 null 交给调用方
 * 用 `--findings` 兜底，或接受「有判定、无明细」。
 */
import { SEVERITIES } from './contract.js'

// 只认 ```json：把语言标记设为可选时，前面任意 ``` 块的**闭合**围栏会被当成新的开围栏，
// 与真正的 ```json 配对，捕获空串把真块吞掉（PR #151 审核发现的静默丢数据）。
const FENCE = /```json[ \t]*\r?\n([\s\S]*?)```/g

export function normalizeFinding(raw) {
  if (!raw || typeof raw !== 'object') return null
  const { severity, file, line, message } = raw
  if (!SEVERITIES.includes(severity)) return null
  if (typeof file !== 'string' || file.length === 0) return null
  if (!Number.isInteger(line) || line < 0) return null
  if (typeof message !== 'string' || message.length === 0) return null
  return { severity, file, line, message }
}

export function normalizeEvidence(raw) {
  if (!Array.isArray(raw)) return []
  return raw.filter((item) => typeof item === 'string' && item.length > 0)
}

/**
 * @returns {{ findings: object[], evidence: string[] } | null}
 */
const VERDICT_LINE = /^[A-Z2-7]{12}[ \t]+VERDICT:/m

export function extractFindings(text) {
  const full = String(text ?? '')
  // 只看判定行之前的内容：模型常会把文档里的示例块原样引用过来，
  // 示例排在真块前面时会顶替真结论。
  const verdict = full.match(VERDICT_LINE)
  const source = verdict ? full.slice(0, verdict.index) : full
  for (const match of source.matchAll(FENCE)) {
    let parsed
    try {
      parsed = JSON.parse(match[1])
    } catch (error) {
      console.warn(`[findings] json 块解析失败，已跳过: ${error.message}`)
      continue
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.findings)) continue
    const findings = parsed.findings.map(normalizeFinding).filter(Boolean)
    // 有 findings 字段但一条都不合法 → 视为没解析成功，继续找下一个块
    if (parsed.findings.length > 0 && findings.length === 0) continue
    return { findings, evidence: normalizeEvidence(parsed.evidence) }
  }
  return null
}

/**
 * 审核契约：随机标记、判定行解析、结果校验、高风险路径判定。
 *
 * 三条不变式在这里落地：
 *   I2 判定行必须带一次性随机标记，且与 SHA 写在同一行；
 *   I3 判定行缺失或多义一律 E_PARSE，绝不猜测；
 *   I5 命中高风险路径时，模型的判定不参与决策。
 */
import { randomBytes } from 'node:crypto'

export const NONCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const NONCE_PATTERN = /^[A-Z2-7]{12}$/
export const SHA_PATTERN = /^[0-9a-f]{40}$/
export const TRACE_ID_PATTERN = /^[0-9]{8}T[0-9]{6}Z-[a-z0-9]{8}$/
export const VERDICTS = ['APPROVE', 'REJECT', 'ESCALATE']
export const FORMS = ['native', 'cli', 'web']
export const SEVERITIES = ['blocker', 'major', 'minor', 'nit']
export const ERROR_CODES = [
  'E_UNAVAILABLE',
  'E_TIMEOUT',
  'E_PARSE',
  'E_SHA_MISMATCH',
  'E_BUDGET',
  'E_POLICY',
]
export const MAX_CHANGED_LINES = 400

export class ContractError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ContractError'
    this.code = code
  }
}

/** 生成 12 位 base32 随机标记（字母表排除易混字符）。 */
export function makeNonce(bytes = randomBytes(12)) {
  let out = ''
  for (const byte of bytes) out += NONCE_ALPHABET[byte % 32]
  return out
}

export function verdictPattern(nonce) {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new ContractError('E_PARSE', `随机标记格式非法: ${nonce}`)
  }
  return new RegExp(
    `^[ \\t]*${nonce}[ \\t]+VERDICT:[ \\t]*(APPROVE|REJECT|ESCALATE)[ \\t]+SHA:[ \\t]*([0-9a-f]{40})[ \\t]*$`,
    'gm',
  )
}

/**
 * 从 reviewer 的原始文本里取判定。
 * @returns {{ verdict: string, sha: string }}
 */
export function parseVerdict(text, { nonce, headSha }) {
  const matches = [...String(text ?? '').matchAll(verdictPattern(nonce))]
  if (matches.length === 0) {
    throw new ContractError('E_PARSE', '判定行缺失')
  }
  if (matches.length > 1) {
    throw new ContractError('E_PARSE', `判定行出现 ${matches.length} 次，无法确定采用哪一条`)
  }
  const [, verdict, sha] = matches[0]
  if (sha !== headSha) {
    throw new ContractError('E_SHA_MISMATCH', `判定针对 ${sha}，请求为 ${headSha}`)
  }
  return { verdict, sha }
}

/** diff 里出现随机标记 = 判定行可能来自被审内容，按注入处理。 */
export function nonceInDiff(diff, nonce) {
  return String(diff ?? '').includes(nonce)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const RESULT_FIELDS = new Set([
  'verdict',
  'head_sha',
  'nonce',
  'findings',
  'evidence',
  'form',
  'model',
  'durationMs',
  'traceId',
  'errorCode',
])

/**
 * 手写校验器，语义与 `schema/review-result.json` 一致。
 * 不引 JSON Schema 库：契约字段固定，引依赖会让每个 PR 自己触发高风险闸门。
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateResult(value) {
  const errors = []
  if (!isPlainObject(value)) return { ok: false, errors: ['结果不是对象'] }

  for (const key of Object.keys(value)) {
    if (!RESULT_FIELDS.has(key)) errors.push(`多余字段: ${key}`)
  }
  for (const key of RESULT_FIELDS) {
    if (key === 'errorCode') continue
    if (!(key in value)) errors.push(`缺少字段: ${key}`)
  }

  if (!VERDICTS.includes(value.verdict)) errors.push(`verdict 非法: ${value.verdict}`)
  if (typeof value.head_sha !== 'string' || !SHA_PATTERN.test(value.head_sha)) {
    errors.push('head_sha 必须是 40 位小写十六进制')
  }
  if (typeof value.nonce !== 'string' || !NONCE_PATTERN.test(value.nonce)) {
    errors.push('nonce 必须是 12 位 base32')
  }
  if (!FORMS.includes(value.form)) errors.push(`form 非法: ${value.form}`)
  if (typeof value.model !== 'string' || value.model.length === 0) errors.push('model 不能为空')
  if (!Number.isInteger(value.durationMs) || value.durationMs < 0) {
    errors.push('durationMs 必须是非负整数')
  }
  if (typeof value.traceId !== 'string' || !TRACE_ID_PATTERN.test(value.traceId)) {
    errors.push('traceId 格式非法')
  }
  if ('errorCode' in value && value.errorCode !== null && !ERROR_CODES.includes(value.errorCode)) {
    errors.push(`errorCode 非法: ${value.errorCode}`)
  }

  if (!Array.isArray(value.findings)) {
    errors.push('findings 必须是数组')
  } else {
    value.findings.forEach((finding, index) => {
      if (!isPlainObject(finding)) {
        errors.push(`findings[${index}] 不是对象`)
        return
      }
      const extra = Object.keys(finding).filter(
        (key) => !['severity', 'file', 'line', 'message'].includes(key),
      )
      if (extra.length > 0) errors.push(`findings[${index}] 多余字段: ${extra.join(',')}`)
      if (!SEVERITIES.includes(finding.severity)) {
        errors.push(`findings[${index}].severity 非法: ${finding.severity}`)
      }
      if (typeof finding.file !== 'string' || finding.file.length === 0) {
        errors.push(`findings[${index}].file 不能为空`)
      }
      if (!Number.isInteger(finding.line) || finding.line < 0) {
        errors.push(`findings[${index}].line 必须是非负整数`)
      }
      if (typeof finding.message !== 'string' || finding.message.length === 0) {
        errors.push(`findings[${index}].message 不能为空`)
      }
    })
  }

  if (!Array.isArray(value.evidence)) {
    errors.push('evidence 必须是数组')
  } else if (value.evidence.some((item) => typeof item !== 'string' || item.length === 0)) {
    errors.push('evidence 的每一项都必须是非空字符串')
  }

  return { ok: errors.length === 0, errors }
}

const HIGH_RISK_RULES = [
  { id: 'ci', path: /^\.github\//, reason: '改 CI 本身' },
  { id: 'pipeline', path: /^scripts\/pipeline\//, reason: '改交付流程本身' },
  { id: 'rules', path: /^(AGENTS\.md|docs\/pipeline\/)/, reason: '改规则与流程文档' },
  { id: 'gitignore', path: /(^|\/)\.gitignore$/, reason: '改白名单会让文件静默不入库' },
  {
    id: 'secrets',
    path: /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12))$|(^|\/)(deploy|rollback)\.sh$/,
    reason: '涉及凭据、密钥或部署脚本',
  },
]

/** package.json 的依赖段被改动 = 供应链风险。 */
export function dependencyChange(diff) {
  return /^[+-][ \t]*"(dependencies|devDependencies|optionalDependencies)"/m.test(String(diff ?? ''))
}

/**
 * @param {{ files: string[], addedLines?: number, diff?: string }} input
 * @returns {{ hit: boolean, reasons: string[] }}
 */
export function highRiskHit({ files = [], addedLines = 0, diff = '' }) {
  const reasons = []
  for (const file of files) {
    for (const rule of HIGH_RISK_RULES) {
      if (rule.path.test(file)) reasons.push(`${file}: ${rule.reason}`)
    }
    if (/(^|\/)package\.json$/.test(file) && dependencyChange(diff)) {
      reasons.push(`${file}: 依赖变更`)
    }
  }
  if (addedLines > MAX_CHANGED_LINES) {
    reasons.push(`变更 ${addedLines} 行，超过 ${MAX_CHANGED_LINES} 行上限`)
  }
  return { hit: reasons.length > 0, reasons }
}

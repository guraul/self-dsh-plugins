/**
 * 插件侧仅剩的契约零件：一次性随机标记与带错误码的错误类型。
 *
 * 判定行解析、结果校验、高风险判定都已搬进共享 pipeline 包
 * （@guraul/dsh-pipeline）——这里**不再保留第二份实现**，否则两处规则
 * 迟早漂移，而漂移的那一份没人测。
 */
import { randomBytes } from 'node:crypto'

export const NONCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

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

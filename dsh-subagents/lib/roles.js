/**
 * 角色层：角色决定「做什么」，与「怎么连」的接入形态解耦。
 *
 * 角色从本包自带的 `roles/` 加载；宿主可用 `config.rolesDir` 指向别的目录。
 * 与旧插件的差别只有一处：多了 `outputContract`——reviewer 与 executor 的本质
 * 区别就是「输出要不要过 schema」。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeModelName } from './provider.js'

export const PERMISSION_MODES = ['readonly', 'default', 'full']
export const OUTPUT_CONTRACTS = ['text', 'review-result']

export function defaultRolesDir() {
  return fileURLToPath(new URL('../roles/', import.meta.url))
}

/** 非法值一律降级到最保守的合法值，坏文件由调用方跳过。 */
export function normalizeRole(id, raw = {}) {
  return {
    id,
    description: typeof raw.description === 'string' ? raw.description : '',
    provider: typeof raw.provider === 'string' ? raw.provider : '',
    // 空串表示角色不钉模型，按调用方给的值走（issue #314：钉了才不会静默落到 CLI 默认模型）
    model: typeof raw.model === 'string' ? raw.model : '',
    // 软默认（issue #335）：只在调用方没传时生效，与上面的硬钉是两套语义
    defaultProvider: typeof raw.defaultProvider === 'string' ? raw.defaultProvider : '',
    defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : '',
    permissionMode: PERMISSION_MODES.includes(raw.permissionMode) ? raw.permissionMode : 'default',
    allowDelegation: raw.allowDelegation !== false,
    outputContract: OUTPUT_CONTRACTS.includes(raw.outputContract) ? raw.outputContract : 'text',
    instructions: typeof raw.instructions === 'string' ? raw.instructions : '',
  }
}

/**
 * @returns {{ roles: Map<string, object>, skipped: string[] }}
 */
export function loadRoles(dir = defaultRolesDir()) {
  const roles = new Map()
  const skipped = []
  if (!existsSync(dir)) return { roles, skipped }
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.json')) continue
    const file = join(dir, entry)
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const id = basename(entry, '.json')
      roles.set(id, normalizeRole(id, raw))
    } catch {
      skipped.push(file)
    }
  }
  return { roles, skipped }
}

/** 未知角色回退 `general`，与旧插件行为一致。 */
export function getRole(id, dir = defaultRolesDir()) {
  const { roles } = loadRoles(dir)
  if (roles.has(id)) return roles.get(id)
  if (roles.has('general')) return roles.get('general')
  return normalizeRole(id, {})
}

/**
 * 角色钉了 `provider` 时的取值：钉了以角色为准，调用方传了不一致的值直接报错。
 *
 * 为什么不静默覆盖：覆盖会让「这次到底派给了谁」事后无从复盘（issue #314）。
 * provider 不做任何规范化，直接字符串比较。
 */
export function resolveRoleProvider(role, requested) {
  const pinned = typeof role?.provider === 'string' ? role.provider : ''
  if (!pinned) return requested
  if (!requested) return pinned
  if (pinned !== requested) {
    throw new Error(`角色 ${role.id} 钉的 provider 是 ${pinned}，本次请求 ${requested}`)
  }
  return pinned
}

/**
 * 角色钉了 `model` 时的取值，规则同 `resolveRoleProvider`。
 *
 * 比对走 `normalizeModelName`（与 provider 自报模型名核对同一口径，忽略 `codebuddy/` 前缀），
 * 所以传 `glm-5.3-flash` 与传 `codebuddy/glm-5.3-flash` 视为同一次请求；**返回值始终是角色钉的
 * 带前缀形式**，保证下发给 CLI 的是同一个标识。
 */
export function resolveRoleModel(role, requested) {
  const pinned = typeof role?.model === 'string' ? role.model : ''
  if (!pinned) return requested
  if (!requested) return pinned
  if (normalizeModelName(pinned) !== normalizeModelName(requested)) {
    throw new Error(`角色 ${role.id} 钉的模型是 ${pinned}，本次请求 ${requested}`)
  }
  return pinned
}

/**
 * 一次算出本次委派实际下发的 provider / model。
 *
 * 这里有两套**不同**的语义，改动时别混：
 *
 * - **硬钉**（`role.provider` / `role.model`，reviewer 用）：调用方没传就用角色的值；
 *   传了不一致的值直接抛错。保的是「这次到底派给了谁 / 哪个模型」可复盘（issue #314）。
 * - **软默认**（`role.defaultProvider` / `role.defaultModel`，executor 用）：只在调用方**没传**
 *   时生效；传了就用传的，不做一致性校验。补的是「漏传 model → 不带 --model → 静默落到 CLI
 *   默认模型」这条漂移路径（issue #335）。
 *
 * 空串表示「没有这个值」，与 `normalizeRole()` 的归一化口径一致——调用方据此决定是否下发，
 * 而不是把空串当模型名传给 CLI。
 *
 * 软默认 model 不跨产品补位：调用方指定了别的 provider 且没给 model 时，model 返回空串
 * （由那个 CLI 自己决定），避免把 defaultProvider 的模型名发给另一个产品。
 *
 * @param {object} role 归一化后的角色
 * @param {{ provider?: string, model?: string }} [request] 调用方显式请求（缺省视为都没传）
 * @returns {{ provider: string, model: string }}
 */
export function resolveRoute(role, { provider, model } = {}) {
  const requestedProvider = provider || ''
  const resolvedProvider =
    resolveRoleProvider(role, requestedProvider) ||
    (typeof role?.defaultProvider === 'string' ? role.defaultProvider : '')

  // 硬钉优先：角色钉了模型时，软默认不参与，避免把硬钉的冲突放过去
  const pinned = typeof role?.model === 'string' ? role.model : ''
  if (pinned) return { provider: resolvedProvider || '', model: resolveRoleModel(role, model) || '' }

  if (model) return { provider: resolvedProvider || '', model }

  const defaultProvider = typeof role?.defaultProvider === 'string' ? role.defaultProvider : ''
  const defaultModel = typeof role?.defaultModel === 'string' ? role.defaultModel : ''
  // 只有「没传 provider」或「传的就是 defaultProvider」才允许补软默认 model
  const sameProduct = requestedProvider === '' || (defaultProvider !== '' && requestedProvider === defaultProvider)
  return { provider: resolvedProvider || '', model: sameProduct ? defaultModel : '' }
}

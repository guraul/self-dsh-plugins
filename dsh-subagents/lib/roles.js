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

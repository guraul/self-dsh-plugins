// dsh-usage-panel · product-subagents registry reader.
//
// `~/.dsh/product-subagents-registry.json` is the authoritative map from a DSH
// subagent session id to the external executor session it drives. The file is
// owned by another plugin and may be missing, half-written, or hand-edited, so
// every failure degrades to an empty map plus a diagnostic string — this reader
// never throws.
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface RegistryEntry {
  product: string
  remoteId: string
  cwd: string
  updatedAt: number
}

export interface RegistryLoad {
  entries: Map<string, RegistryEntry>
  errors: string[]
}

/** Session ids are sometimes branded with a `session-` prefix; registry keys are bare uuids. */
export function normalizeSessionId(id: unknown): string {
  return String(id ?? '').replace(/^session-/, '')
}

export function defaultRegistryPath(): string {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'product-subagents-registry.json')
}

function messageOf(err: unknown): string {
  return String((err as Error)?.message ?? err)
}

/**
 * Read the registry file. Missing file / invalid JSON / non-object roots all
 * return an empty map and push one error; individual malformed entries are
 * skipped. Never throws.
 */
export async function loadRegistry(filePath: string = defaultRegistryPath()): Promise<RegistryLoad> {
  const errors: string[] = []
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (err) {
    errors.push('registry: cannot read ' + filePath + ': ' + messageOf(err))
    return { entries: new Map(), errors }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    errors.push('registry: invalid JSON in ' + filePath + ': ' + messageOf(err))
    return { entries: new Map(), errors }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push('registry: root is not an object in ' + filePath)
    return { entries: new Map(), errors }
  }

  const entries = new Map<string, RegistryEntry>()
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const record = value as Record<string, unknown>
    const remoteId = typeof record.remoteId === 'string' ? record.remoteId.trim() : ''
    if (!remoteId) continue
    const id = normalizeSessionId(key)
    if (!id) continue
    entries.set(id, {
      product: typeof record.product === 'string' && record.product ? record.product : 'unknown',
      remoteId,
      cwd: typeof record.cwd === 'string' ? record.cwd : '',
      updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
    })
  }
  return { entries, errors }
}

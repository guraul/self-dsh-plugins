// dsh-usage-panel · collect the subagent drill-down payload.
//
// Joins three sources by session id:
//   1. DSH session records (`delegationDepth > 0`) — the row list.
//   2. The product-subagents registry — the remote executor session id.
//   3. External usage (opencode db / codebuddy jsonl) — real model + tokens.
//
// A missing external record stays `external: null`; the payload never invents
// zeros. External scans are expensive (the live opencode db is hundreds of MB),
// so results are cached for 60s with a key built from source mtimes.
import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine, SessionRecord } from '@deepseek-ai/dsh-session-query'
import type { ExecutorId, SubagentExternal, SubagentItem, SubagentsPayload, UsageTotals } from '../../shared/contract.ts'
import { emptyTotals } from '../../shared/usage.ts'
import { defaultCodebuddyProjectsDir, readCodebuddySession } from './codebuddy.ts'
import { defaultOpencodeDbPaths, readOpencodeSessions } from './opencode.ts'
import { defaultRegistryPath, loadRegistry, normalizeSessionId, type RegistryEntry } from './registry.ts'

const CACHE_TTL_MS = 60_000
const LABEL_MAX = 80

export interface SubagentDeps {
  sq: Pick<SessionQueryEngine, 'listSessions' | 'readTitle'>
  registryPath?: string
  projCacheDir?: string
  opencodeDbPaths?: string[]
  codebuddyProjectsDir?: string
  /** Override the 60s cache window (tests / callers that need fresh data). */
  ttlMs?: number
  now?: number
}

interface CacheEntry {
  key: string
  at: number
  payload: SubagentsPayload
}

let cache: CacheEntry | null = null

/** Drop the module-level cache (tests and explicit refreshes). */
export function clearSubagentCache(): void {
  cache = null
}

export function defaultProjCacheDir(): string {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'session_projcache', 'sessions')
}

function messageOf(err: unknown): string {
  return String((err as Error)?.message ?? err)
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function timeOrNull(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function totals(input: number, output: number, cacheRead: number, cacheWrite: number): UsageTotals {
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite }
}

function executorOf(product: string): ExecutorId {
  if (product === 'opencode' || product === 'codebuddy' || product === 'acp') return product
  return 'unknown'
}

interface RelayInfo {
  label: string | null
  model: string | null
  totals: UsageTotals
  firstTime: number | null
  lastTime: number | null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * Read the session projection cache for the subagent label (`rows.subagent.val.label`)
 * and the relay usage (`rows.usagePanel` / `rows.tokenUsage`). Missing or malformed
 * files yield null — callers fall back to the session title.
 */
async function readProjCache(dir: string, sessionId: string): Promise<RelayInfo | null> {
  const filePath = path.join(dir, sessionId + '.json')
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return null
  }
  let root: Record<string, unknown> | null
  try {
    root = record(JSON.parse(raw))
  } catch {
    return null
  }
  const rows = record(record(root?.record)?.rows)
  if (!rows) return null

  const subagent = record(record(rows.subagent)?.val)
  const label = typeof subagent?.label === 'string' && subagent.label ? subagent.label : null

  let model: string | null = null
  let relay = emptyTotals()
  let firstTime: number | null = null
  let lastTime: number | null = null

  const usagePanel = record(record(rows.usagePanel)?.val)
  const current = record(usagePanel?.current)
  if (current) {
    const currentTotals = record(current.totals)
    if (currentTotals) {
      const b = {
        input: num(currentTotals.input),
        output: num(currentTotals.output),
        cacheRead: num(currentTotals.cacheRead),
        cacheWrite: num(currentTotals.cacheWrite),
      }
      relay = { ...b, total: b.input + b.output + b.cacheRead + b.cacheWrite }
    }
    firstTime = timeOrNull(current.firstTime)
    lastTime = timeOrNull(current.lastTime)
    if (typeof usagePanel?.currentModel === 'string' && usagePanel.currentModel) model = usagePanel.currentModel
  }

  if (model === null) {
    const lastUsed = record(record(record(rows.modelSelection)?.val)?.lastUsed)
    if (lastUsed && typeof lastUsed.model === 'string' && lastUsed.model) model = lastUsed.model
  }

  // Fallback for sessions whose usagePanel cell did not fold yet.
  if (relay.total === 0) {
    const tu = record(record(record(rows.tokenUsage)?.val)?.totals)
    if (tu) {
      relay = totals(
        num(tu.uncachedInputTokens),
        num(tu.outputTokens),
        num(tu.cacheReadTokens),
        num(tu.cacheWriteTokens),
      )
    }
  }

  return { label, model, totals: relay, firstTime, lastTime }
}

async function titleLabel(sq: SubagentDeps['sq'], sessionId: string): Promise<string | null> {
  try {
    const snapshot = await sq.readTitle(sessionId as SessionId)
    const title = snapshot && typeof snapshot.title === 'string' ? snapshot.title : ''
    return title ? title.slice(0, LABEL_MAX) : null
  } catch {
    return null
  }
}

async function signaturePart(filePath: string): Promise<string> {
  try {
    const info = await stat(filePath)
    return filePath + ':' + info.mtimeMs + ':' + info.size
  } catch {
    return filePath + ':-'
  }
}

function codebuddyKey(cwd: string, remoteId: string): string {
  return cwd + '\u0000' + remoteId
}

/**
 * Build the subagent payload. `sq.listSessions()` failures reject (the RPC
 * maps them to an internal error); every external-reader failure is recorded in
 * `coverage.errors` and degrades that row to `external: null`.
 */
export async function collectSubagents(deps: SubagentDeps): Promise<SubagentsPayload> {
  const now = deps.now ?? Date.now()
  const ttl = deps.ttlMs ?? CACHE_TTL_MS
  const registryPath = deps.registryPath ?? defaultRegistryPath()
  const projCacheDir = deps.projCacheDir ?? defaultProjCacheDir()
  const codebuddyProjectsDir = deps.codebuddyProjectsDir ?? defaultCodebuddyProjectsDir()
  const dbPaths = deps.opencodeDbPaths ?? (await defaultOpencodeDbPaths())

  const signature = (
    await Promise.all([
      signaturePart(registryPath),
      signaturePart(projCacheDir),
      signaturePart(codebuddyProjectsDir),
      ...dbPaths.map((dbPath) => signaturePart(dbPath)),
    ])
  ).join('|')

  if (cache && cache.key === signature && now - cache.at < ttl) return cache.payload

  const sessions = await deps.sq.listSessions()
  const { entries, errors: registryErrors } = await loadRegistry(registryPath)
  const errors = [...registryErrors]
  const subagents = sessions.filter((rec: SessionRecord) => Number(rec?.header?.delegationDepth) > 0)

  const registryOf = (sessionId: string): RegistryEntry | undefined => entries.get(normalizeSessionId(sessionId))

  const opencodeIds: string[] = []
  const codebuddyTasks = new Map<string, ReturnType<typeof readCodebuddySession>>()
  for (const rec of subagents) {
    const entry = registryOf(String(rec.header.id))
    if (!entry) continue
    if (entry.product === 'opencode' || entry.product === 'acp') opencodeIds.push(entry.remoteId)
    if (entry.product === 'codebuddy') {
      const key = codebuddyKey(entry.cwd, entry.remoteId)
      if (!codebuddyTasks.has(key)) {
        codebuddyTasks.set(key, readCodebuddySession(entry.remoteId, entry.cwd, { projectsDir: codebuddyProjectsDir }))
      }
    }
  }

  const codebuddyEntries = [...codebuddyTasks.entries()]
  const [opencode, codebuddyResults] = await Promise.all([
    readOpencodeSessions(opencodeIds, { dbPaths }),
    Promise.all(codebuddyEntries.map(async ([key, pending]) => [key, await pending] as const)),
  ])
  errors.push(...opencode.errors)
  const codebuddyHits = new Map<string, SubagentExternal>()
  for (const [key, result] of codebuddyResults) {
    errors.push(...result.errors)
    if (result.hit) codebuddyHits.set(key, result.hit)
  }

  function externalOf(entry: RegistryEntry | undefined): SubagentExternal | null {
    if (!entry) return null
    if (entry.product === 'opencode' || entry.product === 'acp') {
      const hit = opencode.hits.get(entry.remoteId)
      return hit ? { ...hit, executor: executorOf(entry.product) } : null
    }
    if (entry.product === 'codebuddy') {
      return codebuddyHits.get(codebuddyKey(entry.cwd, entry.remoteId)) ?? null
    }
    return null
  }

  const items: SubagentItem[] = []
  for (const rec of subagents) {
    const header = rec.header
    const sessionId = String(header.id)
    const entry = registryOf(sessionId)
    const proj = await readProjCache(projCacheDir, normalizeSessionId(sessionId))
    let label = proj?.label ?? null
    if (!label) label = await titleLabel(deps.sq, sessionId)

    const external = externalOf(entry)
    const startCandidates: number[] = []
    if (timeOrNull(header.createdAt) !== null) startCandidates.push(Number(header.createdAt))
    if (proj?.firstTime !== null && proj?.firstTime !== undefined) startCandidates.push(proj.firstTime)
    if (external) startCandidates.push(external.startedAt)
    const startedAt = startCandidates.length > 0 ? Math.min(...startCandidates) : null

    const activeCandidates: number[] = []
    if (timeOrNull(header.createdAt) !== null) activeCandidates.push(Number(header.createdAt))
    if (proj?.lastTime !== null && proj?.lastTime !== undefined) activeCandidates.push(proj.lastTime)
    if (external) {
      activeCandidates.push(external.startedAt)
      if (external.endedAt !== null) activeCandidates.push(external.endedAt)
    }
    const lastActive = activeCandidates.length > 0 ? Math.max(...activeCandidates) : null

    items.push({
      sessionId,
      label,
      depth: Number(header.delegationDepth) || 0,
      startedAt,
      lastActive,
      relay: { model: proj?.model ?? null, totals: proj?.totals ?? emptyTotals() },
      external,
    })
  }

  items.sort((a, b) => {
    const left = a.startedAt ?? Number.NEGATIVE_INFINITY
    const right = b.startedAt ?? Number.NEGATIVE_INFINITY
    return right - left
  })

  const matched = items.reduce((count, item) => count + (item.external ? 1 : 0), 0)
  const payload: SubagentsPayload = {
    items,
    coverage: {
      total: items.length,
      matched,
      noExternal: items.length - matched,
      registryEntries: entries.size,
      errors,
    },
    updatedAt: now,
  }
  cache = { key: signature, at: now, payload }
  return payload
}

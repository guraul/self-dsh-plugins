// dsh-usage-panel · opencode session database reader.
//
// Uses Node's built-in `node:sqlite` (DatabaseSync, readOnly) — never a native
// dependency. The live database and rotated backups may both exist; ids are
// looked up in path order and the first hit wins. An unreadable / incompatible
// database is skipped with a diagnostic instead of failing the whole scan.
import { readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SubagentExternal, UsageTotals } from '../../shared/contract.ts'

const COLUMNS =
  'id, model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, time_created, time_updated'

export interface OpencodeRead {
  hits: Map<string, SubagentExternal>
  errors: string[]
}

export interface OpencodeOptions {
  /** Explicit database paths; defaults to the live db plus `~/backups/opencode-sessions-*`. */
  dbPaths?: string[]
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

function totalsOf(input: number, output: number, cacheRead: number, cacheWrite: number): UsageTotals {
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite }
}

/**
 * The `model` column stores JSON such as
 * `{"id":"deepseek-v4.1-flash-free","providerID":"opencode"}`; take `.id`.
 * Plain-text legacy values are kept as-is; anything else is unknown.
 */
export function parseOpencodeModel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const id = (parsed as Record<string, unknown>).id
        if (typeof id === 'string' && id) return id
        return null
      }
    } catch {
      // Malformed JSON: fall through and treat the raw text as the model name.
    }
  }
  return text
}

/** Candidate databases: the live store first, then rotated session backups. */
export async function defaultOpencodeDbPaths(): Promise<string[]> {
  const home = os.homedir()
  const paths = [path.join(home, '.local', 'share', 'opencode', 'opencode.db')]
  const backupsDir = path.join(home, 'backups')
  try {
    const entries = await readdir(backupsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('opencode-sessions-')) continue
      paths.push(path.join(backupsDir, entry.name, 'opencode.db'))
    }
  } catch {
    // No backups directory — the live store is still usable.
  }
  return paths
}

function queryRows(db: DatabaseSync, table: 'session_v2' | 'session', ids: string[]): Record<string, unknown>[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const statement = db.prepare('SELECT ' + COLUMNS + ' FROM ' + table + ' WHERE id IN (' + placeholders + ')')
  const rows = statement.all(...ids) as unknown[]
  return rows as Record<string, unknown>[]
}

function isMissingTable(err: unknown): boolean {
  return /no such table/i.test(messageOf(err))
}

/**
 * Count assistant messages for a session, independent of opencode's schema
 * generation. A session with no message table is worth one call (the session
 * itself was created by one delegation).
 */
function countCalls(db: DatabaseSync, table: 'session_v2' | 'session', id: string): number {
  if (table === 'session_v2') {
    try {
      const row = db.prepare("SELECT count(*) AS c FROM session_message WHERE session_id = ? AND type = 'assistant'").get(id) as
        | { c?: unknown }
        | undefined
      return num(row?.c)
    } catch {
      // Older schema without session_message.
    }
  }
  try {
    const row = db
      .prepare("SELECT count(*) AS c FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'")
      .get(id) as { c?: unknown } | undefined
    return num(row?.c)
  } catch {
    return 1
  }
}

function toExternal(db: DatabaseSync, table: 'session_v2' | 'session', row: Record<string, unknown>): SubagentExternal | null {
  const remoteId = typeof row.id === 'string' ? row.id : ''
  if (!remoteId) return null
  const input = num(row.tokens_input)
  const output = num(row.tokens_output)
  const cacheRead = num(row.tokens_cache_read)
  const cacheWrite = num(row.tokens_cache_write)
  const startedAt = timeOrNull(row.time_created)
  if (startedAt === null) return null
  return {
    executor: 'opencode',
    remoteId,
    model: parseOpencodeModel(row.model),
    totals: totalsOf(input, output, cacheRead, cacheWrite),
    calls: countCalls(db, table, remoteId),
    startedAt,
    endedAt: timeOrNull(row.time_updated),
    source: 'opencode-db',
  }
}

/**
 * Batch-read opencode sessions by remote id. Current schema `session_v2` is
 * tried first; ids absent there fall back to the legacy `session` table (old
 * databases only). Never throws.
 */
export async function readOpencodeSessions(remoteIds: readonly string[], options: OpencodeOptions = {}): Promise<OpencodeRead> {
  const hits = new Map<string, SubagentExternal>()
  const errors: string[] = []
  const wanted = [...new Set(remoteIds.filter((id) => typeof id === 'string' && id.length > 0))]
  if (wanted.length === 0) return { hits, errors }

  const dbPaths = options.dbPaths ?? (await defaultOpencodeDbPaths())
  for (const dbPath of dbPaths) {
    const pending = wanted.filter((id) => !hits.has(id))
    if (pending.length === 0) break
    let db: DatabaseSync
    try {
      db = new DatabaseSync(dbPath, { readOnly: true })
    } catch (err) {
      errors.push('opencode: cannot open ' + dbPath + ': ' + messageOf(err))
      continue
    }
    try {
      for (const table of ['session_v2', 'session'] as const) {
        const ids = table === 'session_v2' ? pending : wanted.filter((id) => !hits.has(id))
        if (ids.length === 0) continue
        let rows: Record<string, unknown>[]
        try {
          rows = queryRows(db, table, ids)
        } catch (err) {
          if (!isMissingTable(err)) errors.push('opencode: query ' + table + ' in ' + dbPath + ': ' + messageOf(err))
          continue
        }
        for (const row of rows) {
          const external = toExternal(db, table, row)
          if (external && !hits.has(external.remoteId)) hits.set(external.remoteId, external)
        }
      }
    } catch (err) {
      errors.push('opencode: scan ' + dbPath + ': ' + messageOf(err))
    } finally {
      try {
        db.close()
      } catch {
        // Closing a read-only handle should not fail, but never mask the scan.
      }
    }
  }
  return { hits, errors }
}

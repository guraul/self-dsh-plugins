// dsh-usage-panel · external usage from homebase (P3, self-dsh-plugins#208).
//
// Replaces the local opencode-db read with an HTTP call to homebase's
// `/api/internal/token-usage/query`. The response rows are already aggregated
// per (usage_date, source, provider, model, session_id); this module folds them
// back to one record per remote session so the join key stays `remoteId`.
//
// Failure policy: any error (missing token, unreachable host, bad payload)
// throws. The caller falls back to the local scanner — the usage panel must
// never go blank because homebase is down.
//
// Only opencode is routed here for now: its `session_id` equals the registry
// `remoteId` (`ses_xxx`). codebuddy rows use a traceId in homebase, which is a
// different keyspace, so that executor keeps reading local jsonl (see #208).
import https from 'node:https'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { URL } from 'node:url'
import type { SubagentExternal, UsageTotals } from '../../shared/contract.ts'
import { emptyTotals } from '../../shared/usage.ts'

export type ExternalSource = 'local' | 'homebase'

export interface HomebaseConfig {
  source: ExternalSource
  url: string
  token: string
  ca: string | null
  timeoutMs: number
}

const DEFAULT_TIMEOUT_MS = 8000

/** `~/.dsh/token-sync.env` — the same file the collector writes/reads (600). */
export function defaultTokenSyncEnvPath(home = os.homedir()): string {
  return path.join(home, '.dsh', 'token-sync.env')
}

/** Parse KEY=VALUE lines; trims quotes and `~`. Never logs values. */
export function parseTokenSyncEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value.startsWith('~/')) value = path.join(os.homedir(), value.slice(2))
    out[key] = value
  }
  return out
}

/** Read the collector's env file; returns {} when absent/unreadable (caller falls back). */
export function readTokenSyncEnv(file = defaultTokenSyncEnvPath()): Record<string, string> {
  try {
    return parseTokenSyncEnv(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Read config. Credentials come from process env first, then from the
 * collector's `~/.dsh/token-sync.env` (single source of truth; the plist is
 * committed to git and must never carry a token).
 */
export function homebaseConfigFromEnv(env: NodeJS.ProcessEnv = process.env, file?: string): HomebaseConfig {
  const raw = (env.DSH_USAGE_PANEL_DATA_SOURCE ?? '').trim().toLowerCase()
  const needsFile = !env.DSH_USAGE_PANEL_HOMEBASE_URL || !env.DSH_USAGE_PANEL_HOMEBASE_TOKEN
  const fileEnv = needsFile ? readTokenSyncEnv(file) : {}
  const url = ((env.DSH_USAGE_PANEL_HOMEBASE_URL ?? '') || fileEnv.HOMEBASE_URL || '').trim()
  const token = ((env.DSH_USAGE_PANEL_HOMEBASE_TOKEN ?? '') || fileEnv.HOMEBASE_INTERNAL_TOKEN || '').trim()
  const ca = ((env.DSH_USAGE_PANEL_HOMEBASE_CA ?? '') || fileEnv.HOMEBASE_CA || '').trim() || null
  const timeoutMs = Number(env.DSH_USAGE_PANEL_HOMEBASE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
  // Default local; 'homebase' without url+token silently stays local (the
  // caller logs why, so a typo is visible without breaking the page).
  const source: ExternalSource = raw === 'homebase' && url && token ? 'homebase' : 'local'
  return { source, url, token, ca, timeoutMs }
}

interface QueryRow {
  usage_date: string
  source: string
  provider: string
  model: string
  session_id: string
  calls?: number
  input_tokens?: number
  output_tokens?: number
  reasoning_tokens?: number
  cache_read?: number
  cache_write?: number
  total_tokens?: number
  first_at?: number
  last_at?: number
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 证书内容缓存：ca 是路径，https.request 需要 PEM 内容（传路径等于没配）。 */
const caCache = new Map<string, string | null>()

export function loadCaContents(caPath: string | null): string | undefined {
  if (!caPath) return undefined
  if (caCache.has(caPath)) {
    const cached = caCache.get(caPath)
    return cached ?? undefined
  }
  try {
    const pem = fs.readFileSync(caPath, 'utf8')
    caCache.set(caPath, pem)
    return pem
  } catch {
    // 读不到就当作没配 CA：请求会自然失败，调用方据此回退本地。
    caCache.set(caPath, null)
    return undefined
  }
}

function requestJson(config: HomebaseConfig, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let url: URL
    try {
      url = new URL(path, config.url)
    } catch (error) {
      reject(error)
      return
    }
    const isHttps = url.protocol === 'https:'
    const lib = isHttps ? https : http
    const ca = isHttps ? loadCaContents(config.ca) : undefined
    const req = lib.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: { 'x-internal-token': config.token },
        timeout: config.timeoutMs,
        ...(ca ? { ca } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () => {
          const status = res.statusCode ?? 0
          const text = Buffer.concat(chunks).toString('utf8')
          if (status < 200 || status >= 300) {
            reject(new Error(`homebase ${status}: ${text.slice(0, 200)}`))
            return
          }
          try {
            resolve(JSON.parse(text))
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('homebase timeout')))
    req.on('error', reject)
    req.end()
  })
}

/**
 * Fold homebase rows into one `SubagentExternal` per session id.
 *
 * Totals are summed across days/models; the reported model is the largest by
 * token volume (matches the local reader's "dominant model" behaviour); the
 * window is min(first_at)..max(last_at).
 */
export function foldHomebaseRows(rows: readonly QueryRow[]): Map<string, SubagentExternal> {
  const bySession = new Map<string, { totals: UsageTotals; calls: number; first: number; last: number; byModel: Map<string, number> }>()
  for (const row of rows) {
    if (!row || typeof row.session_id !== 'string' || !row.session_id) continue
    const cur = bySession.get(row.session_id) ?? {
      totals: emptyTotals(),
      calls: 0,
      first: 0,
      last: 0,
      byModel: new Map<string, number>(),
    }
    cur.totals.input += num(row.input_tokens)
    cur.totals.output += num(row.output_tokens)
    cur.totals.cacheRead += num(row.cache_read)
    cur.totals.cacheWrite += num(row.cache_write)
    cur.totals.total += num(row.total_tokens)
    cur.calls += num(row.calls)
    const first = num(row.first_at)
    const last = num(row.last_at)
    if (first > 0) cur.first = cur.first === 0 ? first : Math.min(cur.first, first)
    if (last > 0) cur.last = Math.max(cur.last, last)
    if (row.model) cur.byModel.set(row.model, (cur.byModel.get(row.model) ?? 0) + num(row.total_tokens))
    bySession.set(row.session_id, cur)
  }

  const out = new Map<string, SubagentExternal>()
  for (const [sessionId, agg] of bySession) {
    let model: string | null = null
    let best = -1
    for (const [name, tokens] of agg.byModel) {
      if (tokens > best) {
        best = tokens
        model = name
      }
    }
    out.set(sessionId, {
      executor: 'opencode',
      remoteId: sessionId,
      model,
      totals: agg.totals,
      calls: agg.calls,
      startedAt: agg.first,
      endedAt: agg.last || null,
      source: 'opencode-db',
    })
  }
  return out
}

/** Fetch and fold. Throws on any failure so the caller can fall back. */
export async function fetchHomebaseUsage(config: HomebaseConfig, opts: { limit?: number } = {}): Promise<Map<string, SubagentExternal>> {
  if (config.source !== 'homebase') throw new Error('homebase source not enabled')
  if (!config.url || !config.token) throw new Error('homebase url/token missing')
  const limit = Math.min(Math.max(opts.limit ?? 2000, 1), 2000)
  const payload = (await requestJson(
    config,
    `/api/internal/token-usage/query?source=opencode&group_by=all&limit=${limit}`,
  )) as { rows?: QueryRow[] }
  return foldHomebaseRows(payload?.rows ?? [])
}

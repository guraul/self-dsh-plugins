// dsh-usage-panel · codebuddy session transcript reader.
//
// codebuddy keeps one JSONL transcript per session at
// `~/.codebuddy/projects/<cwd-slug>/<remoteId>.jsonl`. Assistant message lines
// carry the real model and token usage under `providerData`; a missing file
// means "no external record" (never a zero-filled row).
import { createReadStream } from 'node:fs'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import type { SubagentExternal, UsageTotals } from '../../shared/contract.ts'

export interface CodebuddyRead {
  hit: SubagentExternal | null
  errors: string[]
}

export interface CodebuddyOptions {
  /** Root of the transcript tree; defaults to `~/.codebuddy/projects`. */
  projectsDir?: string
}

/**
 * Project directory slug: the cwd with separators replaced by `-` and the
 * leading separator removed. `/Users/gubin/workspace/self-dsh-plugins` →
 * `Users-gubin-workspace-self-dsh-plugins`.
 */
export function cwdSlug(cwd: string): string {
  return cwd.replace(/\\/g, '/').replace(/\//g, '-').replace(/^-+/, '')
}

export function defaultCodebuddyProjectsDir(): string {
  return path.join(os.homedir(), '.codebuddy', 'projects')
}

export function codebuddyTranscriptPath(projectsDir: string, cwd: string, remoteId: string): string {
  return path.join(projectsDir, cwdSlug(cwd), remoteId + '.jsonl')
}

function messageOf(err: unknown): string {
  return String((err as Error)?.message ?? err)
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function time(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

interface Aggregate {
  model: string | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  calls: number
  credit: number
  hasCredit: boolean
  startedAt: number | null
  endedAt: number | null
}

/** Numeric coercion that rejects NaN/Infinity/negatives. */
function toNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** First coercible number wins; `undefined`/`null`/garbage fall through. */
function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const n = toNumber(value)
    if (n !== null) return n
  }
  return null
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * Parse one transcript. Only `type === 'message' && role === 'assistant'`
 * lines with a usage block count.
 *
 * ⚠️ codebuddy reports **OpenAI-style** usage: `usage.inputTokens` (=
 * `prompt_tokens`) ALREADY includes the cached prefix. The clean decomposition
 * lives in `rawUsage`:
 *   `prompt_cache_hit_tokens`  → cache read
 *   `prompt_cache_miss_tokens` → uncached input
 * Reading `inputTokens` as uncached input inflates it by the cache-hit amount
 * (~80x on cache-heavy turns) and hides the cache column entirely (issue #127).
 * Malformed lines are ignored.
 */
export async function readCodebuddySession(
  remoteId: string,
  cwd: string,
  options: CodebuddyOptions = {},
): Promise<CodebuddyRead> {
  const errors: string[] = []
  if (!remoteId) return { hit: null, errors }
  if (!cwd) {
    errors.push('codebuddy: no cwd for remote ' + remoteId + ' (cannot locate transcript)')
    return { hit: null, errors }
  }
  const projectsDir = options.projectsDir ?? defaultCodebuddyProjectsDir()
  const filePath = codebuddyTranscriptPath(projectsDir, cwd, remoteId)
  try {
    await access(filePath)
  } catch {
    // Missing transcript is an expected, honest "no external record".
    return { hit: null, errors }
  }

  const agg: Aggregate = {
    model: null,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    calls: 0,
    credit: 0,
    hasCredit: false,
    startedAt: null,
    endedAt: null,
  }

  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue
      const row = record as Record<string, unknown>
      if (row.type !== 'message' || row.role !== 'assistant') continue
      const providerData = row.providerData
      if (!providerData || typeof providerData !== 'object' || Array.isArray(providerData)) continue
      const pd = providerData as Record<string, unknown>
      const usage = pd.usage
      if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue
      const buckets = usage as Record<string, unknown>

      const rawUsage = objectOf(pd.rawUsage)
      const details = Array.isArray(buckets.inputTokensDetails) ? objectOf(buckets.inputTokensDetails[0]) : null
      const promptTotal = num(buckets.inputTokens)
      const cacheRead =
        firstNumber(rawUsage?.prompt_cache_hit_tokens, objectOf(rawUsage?.prompt_tokens_details)?.cached_tokens, details?.cached_tokens) ?? 0
      const cacheMiss = firstNumber(rawUsage?.prompt_cache_miss_tokens)
      // Never double count: hit + miss must not exceed promptTotal.
      const uncachedInput = cacheMiss !== null ? cacheMiss : Math.max(0, promptTotal - cacheRead)
      agg.input += uncachedInput
      agg.cacheRead += cacheRead
      agg.cacheWrite += firstNumber(rawUsage?.prompt_cache_write_tokens) ?? 0
      agg.output += num(buckets.outputTokens)
      if (typeof pd.model === 'string' && pd.model) agg.model = pd.model
      if (rawUsage) {
        const credit = rawUsage.credit
        const value = Number(credit)
        if (credit !== undefined && credit !== null && Number.isFinite(value)) {
          agg.credit += value
          agg.hasCredit = true
        }
      }
      const ts = time(row.timestamp)
      if (ts !== null) {
        agg.startedAt = agg.startedAt === null ? ts : Math.min(agg.startedAt, ts)
        agg.endedAt = agg.endedAt === null ? ts : Math.max(agg.endedAt, ts)
      }
      agg.calls += 1
    }
  } catch (err) {
    errors.push('codebuddy: read ' + filePath + ': ' + messageOf(err))
  } finally {
    lines.close()
    stream.destroy()
  }

  if (agg.calls === 0 || agg.startedAt === null) return { hit: null, errors }
  const totals: UsageTotals = {
    input: agg.input,
    output: agg.output,
    cacheRead: agg.cacheRead,
    cacheWrite: agg.cacheWrite,
    total: agg.input + agg.output + agg.cacheRead + agg.cacheWrite,
  }
  const hit: SubagentExternal = {
    executor: 'codebuddy',
    remoteId,
    model: agg.model,
    totals,
    calls: agg.calls,
    startedAt: agg.startedAt,
    endedAt: agg.endedAt,
    source: 'codebuddy-jsonl',
  }
  if (agg.hasCredit) hit.credit = agg.credit
  return { hit, errors }
}

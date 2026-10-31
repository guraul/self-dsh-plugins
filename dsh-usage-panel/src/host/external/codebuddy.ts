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
  calls: number
  credit: number
  hasCredit: boolean
  startedAt: number | null
  endedAt: number | null
}

/**
 * Parse one transcript. Only `type === 'message' && role === 'assistant'`
 * lines with a usage block count. Per the fork contract cacheRead/cacheWrite
 * stay 0 (codebuddy reports them separately but the panel keeps the external
 * row faithful to input/output only). Malformed lines are ignored.
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

      agg.input += num(buckets.inputTokens)
      agg.output += num(buckets.outputTokens)
      if (typeof pd.model === 'string' && pd.model) agg.model = pd.model
      const rawUsage = pd.rawUsage
      if (rawUsage && typeof rawUsage === 'object' && !Array.isArray(rawUsage)) {
        const credit = (rawUsage as Record<string, unknown>).credit
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
    cacheRead: 0,
    cacheWrite: 0,
    total: agg.input + agg.output,
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

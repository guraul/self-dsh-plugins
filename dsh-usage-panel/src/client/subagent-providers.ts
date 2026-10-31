// dsh-usage-panel · subagent executor rollup (issue #129).
//
// Sums the external executors' REAL usage across every subagent row. Pure so
// it can be unit-tested without a DOM. Rows without an external record carry
// no attributable spend and are excluded — never counted as zero.
import type { ExecutorId, SubagentItem, UsageTotals } from '../shared/contract.ts'

export interface ExecutorRollup {
  executor: ExecutorId
  totals: UsageTotals
  /** Subagent sessions attributed to this executor. */
  sessions: number
  /** External LLM calls reported by the executor. */
  calls: number
}

function zero(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

/** Add two bucket sets (issue #132 folds external spend into the KPI). */
export function mergeTotals(base: UsageTotals, extra: UsageTotals): UsageTotals {
  return {
    input: base.input + extra.input,
    output: base.output + extra.output,
    cacheRead: base.cacheRead + extra.cacheRead,
    cacheWrite: base.cacheWrite + extra.cacheWrite,
    total: base.total + extra.total,
  }
}

/** Sum every executor row into one bucket set; empty input yields zeros. */
export function sumExecutorTotals(rows: readonly ExecutorRollup[]): UsageTotals {
  return rows.reduce<UsageTotals>((acc, row) => mergeTotals(acc, row.totals), zero())
}

/**
 * Group real external usage by executor, sorted by total desc.
 * `external === null` rows are skipped entirely.
 */
export function aggregateByExecutor(items: readonly SubagentItem[]): ExecutorRollup[] {
  const map = new Map<ExecutorId, ExecutorRollup>()
  for (const item of items) {
    const ext = item.external
    if (!ext) continue
    let row = map.get(ext.executor)
    if (!row) {
      row = { executor: ext.executor, totals: zero(), sessions: 0, calls: 0 }
      map.set(ext.executor, row)
    }
    row.totals.input += ext.totals.input
    row.totals.output += ext.totals.output
    row.totals.cacheRead += ext.totals.cacheRead
    row.totals.cacheWrite += ext.totals.cacheWrite
    row.totals.total += ext.totals.total
    row.sessions += 1
    row.calls += ext.calls
  }
  return [...map.values()].sort((a, b) => b.totals.total - a.totals.total)
}

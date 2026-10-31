// dsh-usage-panel · subagent card selection (issue #125).
//
// Pure so it can be unit-tested without a DOM/React runtime: the card shows
// only the last 3 days, ranked by the external executor's real spend, capped
// at 10 rows. Rows without an external record have no comparable number, so
// they sink below every matched row instead of reading as zero-spend tasks.
import type { SubagentItem } from '../shared/contract.ts'

export const SUBAGENT_WINDOW_DAYS = 3
export const SUBAGENT_TOP_LIMIT = 10
const WINDOW_MS = SUBAGENT_WINDOW_DAYS * 24 * 60 * 60 * 1000

/** Real external spend; unmatched rows sort last. */
export function subagentSpend(item: SubagentItem): number {
  return item.external ? item.external.totals.total : -1
}

/**
 * Filter to the window ending at `now`, rank by real spend (desc), cap at 10.
 * A row with neither `startedAt` nor `lastActive` cannot be placed in the
 * window and is dropped rather than guessed.
 */
export function selectRecentTop(items: readonly SubagentItem[], now: number): SubagentItem[] {
  const cutoff = now - WINDOW_MS
  return items
    .filter((item) => {
      const at = item.startedAt ?? item.lastActive
      return at !== null && at >= cutoff
    })
    .slice()
    .sort((a, b) => subagentSpend(b) - subagentSpend(a))
    .slice(0, SUBAGENT_TOP_LIMIT)
}

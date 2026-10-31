// dsh-usage-panel · roll subagent spend up into its root session (issue #130).
//
// The session ranking lists root sessions only; a root's delegated work lives
// in child sessions (possibly nested). This walks the parent links and sums the
// children's REAL external spend so a root row reflects the whole tree.
// Children without an external record have no attributable spend; they are
// counted separately instead of being folded in as zero.
import type { SubagentItem, UsageTotals } from '../shared/contract.ts'

export interface SessionRollup {
  /** Sum of every descendant's external totals. */
  subagentTotals: UsageTotals
  /** Descendant sessions that had an external record. */
  subagentCount: number
  /** Descendant sessions with no external record (honest gap marker). */
  withoutExternal: number
}

function zero(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

/**
 * Build `rootSessionId → rollup` for the given roots.
 *
 * Descendants are resolved transitively (depth 2+ included). A session that
 * appears under several parents is only counted once per root, and cycles are
 * broken by the visited set.
 */
export function rollupByRoot(
  rootIds: readonly string[],
  items: readonly SubagentItem[],
): Map<string, SessionRollup> {
  const children = new Map<string, SubagentItem[]>()
  for (const item of items) {
    const parent = item.parentSessionId
    if (!parent) continue
    const bucket = children.get(parent)
    if (bucket) bucket.push(item)
    else children.set(parent, [item])
  }

  const out = new Map<string, SessionRollup>()
  for (const rootId of rootIds) {
    const rollup: SessionRollup = { subagentTotals: zero(), subagentCount: 0, withoutExternal: 0 }
    const visited = new Set<string>()
    const stack = [...(children.get(rootId) ?? [])]
    while (stack.length) {
      const item = stack.pop()!
      if (visited.has(item.sessionId)) continue
      visited.add(item.sessionId)
      if (item.external) {
        rollup.subagentTotals.input += item.external.totals.input
        rollup.subagentTotals.output += item.external.totals.output
        rollup.subagentTotals.cacheRead += item.external.totals.cacheRead
        rollup.subagentTotals.cacheWrite += item.external.totals.cacheWrite
        rollup.subagentTotals.total += item.external.totals.total
        rollup.subagentCount += 1
      } else {
        rollup.withoutExternal += 1
      }
      const grand = children.get(item.sessionId)
      if (grand) stack.push(...grand)
    }
    out.set(rootId, rollup)
  }
  return out
}

// issue #129: per-executor rollup of subagent spend.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateByExecutor, mergeTotals, sumExecutorTotals } from '../src/client/subagent-providers.ts'
import type { ExecutorId, SubagentItem } from '../src/shared/contract.ts'

function item(id: string, executor: ExecutorId | null, total: number, calls = 1): SubagentItem {
  return {
    sessionId: id,
    parentSessionId: 'root',
    label: id,
    depth: 1,
    startedAt: 1000,
    lastActive: 1000,
    relay: { model: null, totals: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } },
    external:
      executor === null
        ? null
        : {
            executor,
            remoteId: 'r-' + id,
            model: 'm',
            totals: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
            calls,
            startedAt: 1000,
            endedAt: 1000,
            source: executor === 'codebuddy' ? 'codebuddy-jsonl' : 'opencode-db',
          },
  }
}

test('aggregateByExecutor: sums real spend per executor, sorted desc', () => {
  const rows = aggregateByExecutor([
    item('a', 'opencode', 100),
    item('b', 'codebuddy', 300),
    item('c', 'opencode', 50),
  ])
  assert.deepEqual(rows.map((r) => r.executor), ['codebuddy', 'opencode'])
  assert.equal(rows[0]!.totals.total, 300)
  assert.equal(rows[0]!.sessions, 1)
  assert.equal(rows[1]!.totals.total, 150)
  assert.equal(rows[1]!.sessions, 2)
  assert.equal(rows[1]!.calls, 2)
})

test('aggregateByExecutor: rows without an external record are excluded, never zero', () => {
  const rows = aggregateByExecutor([item('no-ext', null, 0), item('has', 'opencode', 10)])
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.executor, 'opencode')
  assert.equal(rows[0]!.totals.total, 10)
})

test('aggregateByExecutor: empty input yields no rows', () => {
  assert.deepEqual(aggregateByExecutor([]), [])
})

// issue #132: the KPI folds external subagent spend into its all-time totals.
test('mergeTotals: adds every bucket and recomputes the total', () => {
  const merged = mergeTotals(
    { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, total: 1010 },
    { input: 5, output: 2, cacheRead: 300, cacheWrite: 1, total: 308 },
  )
  assert.deepEqual(merged, { input: 105, output: 12, cacheRead: 1200, cacheWrite: 1, total: 1318 })
})

test('sumExecutorTotals: sums rows, empty input yields zeros', () => {
  const rows = aggregateByExecutor([item('a', 'opencode', 100), item('b', 'codebuddy', 20)])
  assert.equal(sumExecutorTotals(rows).total, 120)
  assert.deepEqual(sumExecutorTotals([]), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })
})

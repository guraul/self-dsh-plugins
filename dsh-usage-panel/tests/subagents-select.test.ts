// issue #125: the subagent card shows only the last 3 days, ranked by the
// external executor's real spend, capped at 10 rows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectRecentTop, subagentSpend, SUBAGENT_TOP_LIMIT, SUBAGENT_WINDOW_DAYS } from '../src/client/subagents-select.ts'
import type { SubagentItem } from '../src/shared/contract.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

function item(id: string, startedAt: number | null, spend: number | null, lastActive: number | null = null): SubagentItem {
  return {
    sessionId: id,
    label: id,
    depth: 1,
    startedAt,
    lastActive,
    relay: { model: 'relay-model', totals: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } },
    external:
      spend === null
        ? null
        : {
            executor: 'codebuddy',
            remoteId: 'r-' + id,
            model: 'deepseek-v4.1-flash',
            totals: { input: spend, output: 0, cacheRead: 0, cacheWrite: 0, total: spend },
            calls: 1,
            startedAt,
            endedAt: startedAt,
            source: 'codebuddy-jsonl',
          },
  }
}

test('selectRecentTop: drops rows older than the 3-day window', () => {
  const rows = [item('fresh', NOW - 1 * DAY, 100), item('edge', NOW - SUBAGENT_WINDOW_DAYS * DAY, 50), item('stale', NOW - 4 * DAY, 999)]
  const out = selectRecentTop(rows, NOW)
  assert.deepEqual(out.map((r) => r.sessionId), ['fresh', 'edge'])
})

test('selectRecentTop: ranks by real spend, not by time', () => {
  const rows = [item('old-big', NOW - 2 * DAY, 900), item('new-small', NOW - 1000, 10), item('mid', NOW - 1 * DAY, 400)]
  const out = selectRecentTop(rows, NOW)
  assert.deepEqual(out.map((r) => r.sessionId), ['old-big', 'mid', 'new-small'])
})

test('selectRecentTop: rows without an external record sort last but are kept', () => {
  const rows = [item('no-ext', NOW - 1000, null), item('has-ext', NOW - 2000, 5)]
  const out = selectRecentTop(rows, NOW)
  assert.deepEqual(out.map((r) => r.sessionId), ['has-ext', 'no-ext'])
  assert.equal(subagentSpend(out[1]!), -1)
})

test('selectRecentTop: caps at 10 rows', () => {
  const rows = Array.from({ length: 25 }, (_, i) => item('s' + i, NOW - i * 1000, 25 - i))
  const out = selectRecentTop(rows, NOW)
  assert.equal(out.length, SUBAGENT_TOP_LIMIT)
  assert.equal(out[0]!.sessionId, 's0')
})

test('selectRecentTop: rows without any timestamp are dropped, not guessed', () => {
  const rows = [item('no-time', null, 500), item('timed', NOW - 1000, 1)]
  const out = selectRecentTop(rows, NOW)
  assert.deepEqual(out.map((r) => r.sessionId), ['timed'])
})

// issue #130: roll a root session's descendant subagent spend into its row.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rollupByRoot } from '../src/client/session-rollup.ts'
import type { SubagentItem } from '../src/shared/contract.ts'

function sub(id: string, parent: string | null, spend: number | null): SubagentItem {
  return {
    sessionId: id,
    parentSessionId: parent,
    label: id,
    depth: 1,
    startedAt: 1000,
    lastActive: 1000,
    relay: { model: null, totals: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } },
    external:
      spend === null
        ? null
        : {
            executor: 'opencode',
            remoteId: 'r-' + id,
            model: 'm',
            totals: { input: spend, output: 0, cacheRead: 0, cacheWrite: 0, total: spend },
            calls: 1,
            startedAt: 1000,
            endedAt: 1000,
            source: 'opencode-db',
          },
  }
}

test('rollupByRoot: sums direct children of a root', () => {
  const map = rollupByRoot(['root-a'], [sub('c1', 'root-a', 100), sub('c2', 'root-a', 50), sub('x', 'root-b', 999)])
  const r = map.get('root-a')!
  assert.equal(r.subagentTotals.total, 150)
  assert.equal(r.subagentCount, 2)
  assert.equal(r.withoutExternal, 0)
})

test('rollupByRoot: includes nested grandchildren (depth 2+)', () => {
  const map = rollupByRoot(['root'], [sub('c1', 'root', 100), sub('g1', 'c1', 40), sub('g2', 'c1', 10)])
  const r = map.get('root')!
  assert.equal(r.subagentTotals.total, 150)
  assert.equal(r.subagentCount, 3)
})

test('rollupByRoot: counts descendants without an external record separately', () => {
  const map = rollupByRoot(['root'], [sub('c1', 'root', 100), sub('c2', 'root', null)])
  const r = map.get('root')!
  assert.equal(r.subagentTotals.total, 100)
  assert.equal(r.subagentCount, 1)
  assert.equal(r.withoutExternal, 1)
})

test('rollupByRoot: a root with no subagents gets a zero rollup', () => {
  const map = rollupByRoot(['lonely'], [sub('c1', 'other', 100)])
  const r = map.get('lonely')!
  assert.equal(r.subagentTotals.total, 0)
  assert.equal(r.subagentCount, 0)
})

test('rollupByRoot: cycles do not double count', () => {
  const map = rollupByRoot(['root'], [sub('c1', 'root', 10), sub('c2', 'c1', 20), sub('c1', 'c2', 10)])
  const r = map.get('root')!
  // c1 counted once even though it reappears as c2's child.
  assert.equal(r.subagentTotals.total, 30)
  assert.equal(r.subagentCount, 2)
})

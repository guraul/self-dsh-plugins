// Locks the dsh.smoke module itself: the pure fold assertion always runs, the
// real coldSnapshot assertion runs wherever a global dsh install exists (CI
// runners have none, so it is skipped there — the smoke only executes inside
// a host, where ctx.dshDir is always present).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

// @ts-expect-error — smoke.mjs is plain JS, intentionally not in the TS program.
import { run } from '../smoke.mjs'

/** Locate the globally installed @deepseek-ai/dsh package directory. */
function findDshDir(): string | undefined {
  try {
    const bin = realpathSync(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim())
    let dir = dirname(bin)
    for (let depth = 0; depth < 6; depth += 1) {
      const manifest = join(dir, 'package.json')
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@deepseek-ai/dsh') return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    return undefined
  }
  return undefined
}

const dshDir = findDshDir()

test('smoke: usagePanel fold yields the fixture totals', async () => {
  const { checks }: { checks: { name: string; ok: boolean; detail?: string }[] } = await run()
  const fold = checks.find((item) => item.name === 'usagePanel-fold')
  assert.equal(fold?.ok, true, fold?.detail)
  // Without host facts coldSnapshot must be red with a locatable reason.
  const cold = checks.find((item) => item.name === 'coldSnapshot')
  assert.equal(cold?.ok, false)
  assert.match(cold?.detail ?? '', /ctx\.dshDir/)
})

test('smoke: host coldSnapshot returns usagePanel', { skip: dshDir === undefined }, async () => {
  const { ok, checks }: { ok: boolean; checks: { name: string; ok: boolean; detail?: string }[] } = await run({ dshDir })
  assert.equal(ok, true, JSON.stringify(checks, null, 2))
  assert.deepEqual(checks.map((item) => item.name), ['usagePanel-fold', 'coldSnapshot'])
})

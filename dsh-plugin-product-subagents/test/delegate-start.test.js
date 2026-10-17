import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickStart } from '../lib/tools/product-delegate.js'

/**
 * Regression guard for the DSH 0.2.1 rename.
 *
 * `0.2.1-alpha.5` removed the service-level `ctx.subagents.startContinuable`
 * and put `startActivation` in its place, which also requires `delivery`. The
 * plugin kept calling the removed method, so every delegation threw
 * `ctx.subagents.startContinuable is not a function` while the plugin itself
 * still loaded and registered its tools — invisible to the acceptance harness,
 * which only asserts registration. These tests fail the moment the call shape
 * drifts again.
 */

/** A minimal stand-in for the mounted subagent service. */
function fakeService(methods) {
  const calls = []
  const service = {}
  for (const name of methods) {
    service[name] = async (spec) => {
      calls.push({ name, spec })
      return { childId: `${name}-child`, result: Promise.resolve({}), dispose: async () => {} }
    }
  }
  return { service, calls }
}

test('0.2.1+ service: uses startActivation and supplies delivery', async () => {
  const { service, calls } = fakeService(['startActivation'])
  const picked = pickStart(service)
  assert.equal(picked.kind, 'activation')
  await picked.start({ provider: 'p', label: 'l', request: { prompt: [], parent: {} }, signal: undefined })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'startActivation')
  assert.equal(calls[0].spec.delivery, 'parent')
})

test('0.2.0-line service: falls back to startContinuable without delivery', async () => {
  const { service, calls } = fakeService(['startContinuable'])
  const picked = pickStart(service)
  assert.equal(picked.kind, 'continuable')
  await picked.start({ provider: 'p', label: 'l', request: { prompt: [], parent: {} }, signal: undefined })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'startContinuable')
  assert.equal('delivery' in calls[0].spec, false)
})

test('a service exposing both prefers startActivation', () => {
  const { service } = fakeService(['startActivation', 'startContinuable'])
  assert.equal(pickStart(service).kind, 'activation')
})

test('a service exposing neither fails loudly instead of silently delegating nothing', () => {
  assert.throws(() => pickStart({}), /startActivation|startContinuable/)
  assert.throws(() => pickStart(undefined), /cannot delegate/)
})

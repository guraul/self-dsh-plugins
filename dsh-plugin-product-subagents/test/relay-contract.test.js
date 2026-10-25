import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RELAY_CONTRACT_SECTION,
  RELAY_CONTRACT_TEXT,
  installRelayContract,
  productSessionTag,
  productSessionTags,
  stripProductSessionTag,
  verifyRelayAnswer,
} from '../lib/relay-contract.js'

/**
 * Issue #42: the relay could answer on its own when `product_submit` failed.
 * These cases pin the two halves of the fix — the prompt contract and the
 * structural check on the relay's final text.
 */

test('the contract forbids self-answering, mandates RELAY_FAILED and verbatim success', () => {
  assert.match(RELAY_CONTRACT_TEXT, /only action is `product_submit`/)
  assert.match(RELAY_CONTRACT_TEXT, /RELAY_FAILED: /)
  assert.match(RELAY_CONTRACT_TEXT, /<!--product-session:…-->/)
  assert.match(RELAY_CONTRACT_TEXT, /Anything else counts as a failure/)
})

test('installRelayContract registers one fixed, non-interpolated section', () => {
  const sections = []
  const ctx = { systemPrompt: { section: (section) => sections.push(section) } }
  assert.equal(installRelayContract(ctx), true)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, RELAY_CONTRACT_SECTION)
  assert.equal(sections[0].text, RELAY_CONTRACT_TEXT)
  assert.equal(sections[0].interpolate, false)
  assert.ok(Number.isFinite(sections[0].order))
})

test('installRelayContract falls back to ctx.get and reports a missing service', () => {
  const sections = []
  const viaGet = { get: (name) => (name === 'systemPrompt' ? { section: (s) => sections.push(s) } : undefined) }
  assert.equal(installRelayContract(viaGet), true)
  assert.equal(sections.length, 1)
  assert.equal(installRelayContract({}), false)
  assert.equal(installRelayContract(undefined), false)
})

test('the tag round-trips and is stripped with the blank lines it leaves', () => {
  const tag = productSessionTag('sess-42')
  assert.equal(tag, '<!--product-session:sess-42-->')
  assert.deepEqual(productSessionTags(`a\n${tag}`), ['sess-42'])
  assert.equal(stripProductSessionTag(`a\n${tag}`), 'a')
  assert.equal(stripProductSessionTag('no tag here'), 'no tag here')
})

test('a successful answer verifies and comes back without the tag', () => {
  const result = verifyRelayAnswer(`the product answer\n${productSessionTag('sess-42')}`)
  assert.equal(result.ok, true)
  assert.equal(result.text, 'the product answer')
  assert.equal(JSON.stringify(result).includes('product-session'), false)
})

test('an answer without the tag is unverifiable, and the text is not echoed back', () => {
  const result = verifyRelayAnswer('WAIT_FIX_VERIFY')
  assert.equal(result.ok, false)
  assert.equal(result.relayFailed, false)
  assert.match(result.failure, /unverifiable origin/)
  assert.equal(JSON.stringify(result).includes('WAIT_FIX_VERIFY'), false)
})

test('RELAY_FAILED passes the error through verbatim', () => {
  const result = verifyRelayAnswer('RELAY_FAILED: Error: quota exhausted')
  assert.equal(result.ok, false)
  assert.equal(result.relayFailed, true)
  assert.equal(result.failure, 'Error: quota exhausted')
})

test('RELAY_FAILED without a message, an empty tag and an empty answer all fail', () => {
  assert.match(verifyRelayAnswer('RELAY_FAILED:').failure, /without an error message/)
  assert.match(verifyRelayAnswer('answer\n<!--product-session:-->').failure, /unverifiable origin/)
  assert.match(verifyRelayAnswer('').failure, /empty answer/)
  assert.match(verifyRelayAnswer(undefined).failure, /empty answer/)
})

test('leading whitespace does not hide a RELAY_FAILED report', () => {
  assert.equal(verifyRelayAnswer('\n  RELAY_FAILED: boom').failure, 'boom')
})

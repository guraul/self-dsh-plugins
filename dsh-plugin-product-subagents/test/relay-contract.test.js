import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as relayEntry from '../lib/relay.js'
import { buildAttestation, normalizeAnswerText } from '../lib/attestation.js'
import { buildRelayPrompt } from '../lib/tools/product-delegate.js'
import {
  RELAY_CONTRACT_SECTION,
  RELAY_CONTRACT_TEXT,
  installRelayContract,
  productSessionTag,
  productSessionTags,
  stripProductSessionTag,
  verifyRelayAnswer,
  verifyRelayAnswerWithAttestation,
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

/**
 * Issue #50 (regression of #49): Cordis throws on a context *property* read for
 * a service the plugin did not `inject` — and on any service the current scope
 * cannot see. Reading `ctx.systemPrompt` first therefore aborted the whole
 * `product-relay` preset mount and every background delegation with
 * `cannot get property "systemPrompt" without inject`.
 *
 * The fake below reproduces the Cordis context proxy: every property that is
 * not on the plain target throws exactly that error.
 */
function cordisLikeContext(target = {}) {
  return new Proxy(target, {
    get(object, prop) {
      if (Reflect.has(object, prop)) return Reflect.get(object, prop)
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
    has: (object, prop) => Reflect.has(object, prop),
  })
}

test('an unreachable systemPrompt service is skipped instead of aborting the mount', () => {
  const ctx = cordisLikeContext({ tools: { register() {} } })
  // Must not throw: a throw here is what killed the preset.
  assert.equal(installRelayContract(ctx), false)
})

test('the non-throwing ctx.get is probed before the throwing property read', () => {
  const sections = []
  const ctx = {
    get: (name) => (name === 'systemPrompt' ? { section: (section) => sections.push(section) } : undefined),
    get systemPrompt() {
      throw new Error('cannot get property "systemPrompt" without inject')
    },
  }
  assert.equal(installRelayContract(ctx), true)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, RELAY_CONTRACT_SECTION)
})

test('a throwing ctx.get degrades to the property, and never escapes', () => {
  const sections = []
  const viaProperty = {
    systemPrompt: { section: (section) => sections.push(section) },
    get: () => { throw new Error('get exploded') },
  }
  assert.equal(installRelayContract(viaProperty), true)
  assert.equal(sections.length, 1)

  const bothBroken = {
    get: () => { throw new Error('get exploded') },
    get systemPrompt() { throw new Error('property exploded') },
  }
  assert.equal(installRelayContract(bothBroken), false)
})

test('the relay entry never declares systemPrompt in inject (every entry is required)', () => {
  // Cordis waits for every injected service before `apply` runs, and the preset
  // registry audits such a row as "waiting for …" — a `systemPrompt` that the
  // relay scope cannot see would leave the relay with no tools at all.
  const declared = Array.isArray(relayEntry.inject)
    ? relayEntry.inject
    : Object.keys(relayEntry.inject ?? {})
  assert.deepEqual(declared, ['tools'])
})

test('buildRelayPrompt still carries the contract as the in-prompt fallback', () => {
  const prompt = buildRelayPrompt('opencode', { command: 'opencode' }, 'TASK')
  assert.ok(prompt.includes(RELAY_CONTRACT_TEXT))
  assert.match(prompt, /BEGIN TEXT ADDRESSED TO THE REMOTE PRODUCT AGENT/)
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

// ── issue #56: a paraphrased genuine answer is claimable, a fake one is not ──

/** A long remote answer (> 200 chars), as a real submit would return it. */
const LONG_ANSWER = Array.from(
  { length: 12 },
  (_, i) => `Step ${i + 1}: the remote edited the module and re-ran the full suite.`,
).join(' ')

/** One attestation as `product_submit` records it. */
function attestationOf(text) {
  return buildAttestation(text, 'sess-56', 1_700_000_000_000)
}

test('#56: a verbatim tagged answer still verifies as mode "tag"', () => {
  const warnings = []
  const result = verifyRelayAnswerWithAttestation(
    `the product answer\n${productSessionTag('sess-42')}`,
    attestationOf('the product answer'),
    { warn: (text) => warnings.push(text) },
  )
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'tag')
  assert.equal(result.text, 'the product answer')
  assert.equal(JSON.stringify(result).includes('product-session'), false)
  assert.equal(warnings.length, 0)
})

test('#56: a paraphrased long answer is reconciled by the recorded head, with a warn', () => {
  const attest = attestationOf(LONG_ANSWER)
  // The relay summarised: prose before/after, the real opening kept, the tag
  // dropped. This is the production failure from issue #56.
  const relayText = `Here is what the remote reported:\n\n${LONG_ANSWER.slice(0, 200)}\n\nThe rest was a summary; the PR is open.`
  const warnings = []
  const result = verifyRelayAnswerWithAttestation(relayText, attest, { warn: (text) => warnings.push(text) })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'reconciled')
  assert.equal(result.text, relayText)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /reconciled/)
})

test('#56: an exact untagged copy of the answer is reconciled by the full-text hash', () => {
  const result = verifyRelayAnswerWithAttestation(LONG_ANSWER, attestationOf(LONG_ANSWER), { warn: null })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'reconciled')
  assert.equal(result.text, LONG_ANSWER)
})

test('#56: a self-answer with no relation to the record still fails', () => {
  const warnings = []
  const result = verifyRelayAnswerWithAttestation(
    'I could not reach the remote product, but I assume it finished the task.',
    attestationOf(LONG_ANSWER),
    { warn: (text) => warnings.push(text) },
  )
  assert.equal(result.ok, false)
  assert.equal(result.relayFailed, false)
  assert.match(result.failure, /unverifiable origin/)
  assert.equal(warnings.length, 0)
  assert.equal(JSON.stringify(result).includes('I could not reach'), false)
})

test('#56: no attestation and no tag is still rejected (fail-closed unchanged)', () => {
  const result = verifyRelayAnswerWithAttestation('the real product answer', undefined, { warn: null })
  assert.equal(result.ok, false)
  assert.match(result.failure, /unverifiable origin/)
  assert.equal(verifyRelayAnswerWithAttestation('the real product answer', undefined).ok, false)
})

test('#56: a RELAY_FAILED report is never reconciled, even if it quotes the answer', () => {
  const attest = attestationOf(LONG_ANSWER)
  const result = verifyRelayAnswerWithAttestation(`RELAY_FAILED: ${LONG_ANSWER.slice(0, 200)}`, attest, { warn: null })
  assert.equal(result.ok, false)
  assert.equal(result.relayFailed, true)
})

test('#56: normalization folds whitespace and trims, leaving markdown alone', () => {
  assert.equal(normalizeAnswerText('  a\n\n b\t\tc  '), 'a b c')
  assert.equal(normalizeAnswerText('line1\r\nline2'), 'line1 line2')
  assert.equal(normalizeAnswerText('  **bold** and `code`  '), '**bold** and `code`')
  assert.equal(normalizeAnswerText(undefined), '')
  assert.equal(normalizeAnswerText(null), '')
})

test('#56: an attestation of a differently formatted answer still claims it', () => {
  const attest = attestationOf('Step 1: edit the module.\nStep 2: run the suite.')
  const result = verifyRelayAnswerWithAttestation('Step 1: edit the module.   Step 2: run the suite.', attest, { warn: null })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'reconciled')
})

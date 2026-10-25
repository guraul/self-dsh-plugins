import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldProgress, foldTrace, foldTokenUsage, lastAnswerFull, RELAY_UNVERIFIED_ANSWER } from '../lib/progress.js'
import { productSessionTag } from '../lib/relay-contract.js'

function events(list) {
  return list.map((e, i) => ({ seq: i + 1, ...e }))
}

test('foldProgress: turn/step/task/answer/marker', () => {
  const now = Date.now()
  const session = { events: events([
    { type: 'turn/start', timestamp: now - 60000, payload: { turn: 1 } },
    { type: 'step/start', timestamp: now - 59000, payload: { turn: 1, step: 1 } },
    { type: 'tool/call', timestamp: now - 58000, payload: { name: 'product_submit', args: { task: 'do thing A' } } },
    { type: 'assistant/message', timestamp: now - 50000, payload: { message: { content: [{ type: 'text', text: 'PROBE_CONT\nPRODUCT_SESSION:acp:sess-123' }] } } },
    { type: 'turn/end', timestamp: now - 49000, payload: { turn: 1 } },
    { type: 'turn/start', timestamp: now - 10000, payload: { turn: 2 } },
  ]) }
  const out = foldProgress(session)
  assert.equal(out.turn, 2)
  assert.equal(out.stepCount, 1)
  assert.equal(out.lastTask, 'do thing A')
  assert.match(out.lastAnswer, /PROBE_CONT/)
  assert.equal(out.endedAt, now - 49000)
  assert.equal(out.turnOpen, true)
  assert.equal(out.product, 'acp')
  assert.equal(out.remoteSessionId, 'sess-123')
})

test('foldTrace: skips chunks, newest-last, bounded', () => {
  const now = Date.now()
  const session = { events: events([
    { type: 'assistant/chunk', timestamp: now, payload: { text: 'x' } },
    { type: 'assistant/chunk', timestamp: now, payload: { text: 'y' } },
    { type: 'tool/call', timestamp: now, payload: { name: 'product_submit', args: { task: 't' } } },
    { type: 'assistant/message', timestamp: now, payload: { message: { content: [{ type: 'text', text: 'answer' }] } } },
  ]) }
  const trace = foldTrace(session, 10)
  assert.equal(trace.length, 2)
  assert.equal(trace[0].event, 'tool/call')
  assert.match(trace[0].brief, /product_submit/)
  assert.equal(trace[1].event, 'assistant/message')
})

test('foldTokenUsage sums input/output/cache tokens', () => {
  const session = { events: events([
    { type: 'assistant/message', payload: { message: { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 } } } },
    { type: 'assistant/message', payload: { message: { usage: { input_tokens: 20, output_tokens: 7 } } } },
    { type: 'turn/start', payload: { turn: 1 } },
  ]) }
  const usage = foldTokenUsage(session)
  assert.deepEqual(usage, { inputTokens: 30, outputTokens: 12, cacheReadInputTokens: 100 })
})

test('foldProgress returns null for non-array events', () => {
  assert.equal(foldProgress(null), null)
  assert.equal(foldProgress({}), null)
  assert.deepEqual(foldTrace(undefined), [])
})

test('lastAnswerFull keeps the full text while foldProgress truncates', () => {
  const text = `${'y'.repeat(1000)}\n${productSessionTag('sess-full')}`
  const session = { events: events([
    { type: 'assistant/message', timestamp: 1, payload: { message: { content: [{ type: 'text', text }] } } },
  ]) }
  assert.equal(foldProgress(session).lastAnswer.length, 300)
  assert.equal(lastAnswerFull(session).length, 1000)
  assert.equal(lastAnswerFull({}), RELAY_UNVERIFIED_ANSWER)
  assert.equal(lastAnswerFull(undefined), RELAY_UNVERIFIED_ANSWER)
})

test('foldProgress reads the real event envelope (data, not payload)', () => {
  const now = Date.now()
  const session = { events: events([
    { type: 'turn/start', time: now - 60000, data: { turn: 1 } },
    { type: 'step/start', time: now - 59000, data: { turn: 1, step: 1 } },
    {
      type: 'tool/call',
      time: now - 58000,
      data: { turn: 1, step: 1, callId: 'call-1', name: 'product_submit', arguments: '{"task":"do real thing"}' },
    },
    {
      type: 'tool/result',
      time: now - 50000,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'result-1',
          role: 'tool',
          content: [{ type: 'text', text: `ok\nPRODUCT_SESSION:acp:sess-999\n${productSessionTag('sess-999')}` }],
        },
      },
    },
    { type: 'turn/end', time: now - 49000, data: { turn: 1 } },
  ]) }
  const out = foldProgress(session)
  assert.equal(out.stepCount, 1)
  assert.equal(out.lastTask, 'do real thing')
  assert.match(out.lastAnswer, /^ok/)
  assert.equal(out.lastAnswer.includes('result-1'), false)
  assert.equal(out.product, 'acp')
  assert.equal(out.remoteSessionId, 'sess-999')
  assert.equal(out.lastActivityAt, now - 49000)
  assert.equal(out.turnOpen, false)
  assert.equal(lastAnswerFull(session), 'ok\nPRODUCT_SESSION:acp:sess-999')
})

// ── issue #42: lastAnswerFull fails closed, not just the 300-char display ────

/** One assistant answer in the real `{ type, data }` envelope. */
function answerSession(text) {
  return { events: events([
    { type: 'assistant/message', time: 1, data: { message: { content: [{ type: 'text', text }] } } },
  ]) }
}

test('lastAnswerFull: an answer with the machine tag comes back stripped', () => {
  const out = lastAnswerFull(answerSession(`BG_RELAY_SMOKE_OK\n${productSessionTag('sess-bg')}`))
  assert.equal(out, 'BG_RELAY_SMOKE_OK')
  assert.equal(out.includes('product-session'), false)
})

test('lastAnswerFull: the human-readable PRODUCT_SESSION line alone is not a receipt', () => {
  // `verifyRelayAnswer()` requires the HTML tag that only product_submit mints;
  // the `PRODUCT_SESSION:<product>:<id>` line is a recovery marker, so on its
  // own it must not turn an unverifiable answer into a success.
  const out = lastAnswerFull(answerSession('BG_RELAY_SMOKE_OK\nPRODUCT_SESSION:codebuddy:sess-bg'))
  assert.equal(out, RELAY_UNVERIFIED_ANSWER)
})

test('lastAnswerFull: an untagged answer is rejected and never echoed back', () => {
  const out = lastAnswerFull(answerSession('FABRICATED_ANSWER_WITHOUT_TAG'))
  assert.ok(out.startsWith('RELAY_FAILED:'))
  assert.match(out, /product-session/)
  assert.equal(out.includes('FABRICATED_ANSWER_WITHOUT_TAG'), false)
})

test('lastAnswerFull: an empty or missing log fails closed without throwing', () => {
  for (const input of [undefined, null, {}, { events: [] }, { events: 'nope' }]) {
    const out = lastAnswerFull(input)
    assert.equal(out, RELAY_UNVERIFIED_ANSWER)
  }
  assert.equal(lastAnswerFull(answerSession('')), RELAY_UNVERIFIED_ANSWER)
})

test('lastAnswerFull: a relay RELAY_FAILED report keeps its error instead of the generic text', () => {
  const out = lastAnswerFull(answerSession('RELAY_FAILED: Error: quota exhausted'))
  assert.equal(out, 'RELAY_FAILED: Error: quota exhausted')
})

test('foldTokenUsage reads data.message.usage', () => {
  const session = { events: events([
    { type: 'assistant/message', time: 1, data: { turn: 1, step: 1, message: { content: [], usage: { input_tokens: 4, output_tokens: 2 } } } },
  ]) }
  assert.deepEqual(foldTokenUsage(session), { inputTokens: 4, outputTokens: 2, cacheReadInputTokens: 0 })
})

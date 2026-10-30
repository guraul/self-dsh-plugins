/**
 * Unit tests for the approval relay's pure rules (Node 24 type stripping).
 * Run with `pnpm test`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ApprovalQueue,
  buildApprovalCard,
  formatApprovalText,
  parseApprovalReply,
  parseButtonKey,
  redactArguments,
  type ApprovalOutcome,
  type PendingApproval,
} from '../src/approval.ts'

/** Build one pending entry with a settle spy. */
function entry(id: string, overrides: Partial<PendingApproval> = {}): {
  value: PendingApproval
  decisions: string[]
} {
  const decisions: string[] = []
  const value: PendingApproval = {
    id,
    chatTarget: 'user-1',
    kind: 'single',
    initiator: 'user-1',
    toolName: 'bash',
    summary: 'gh issue create',
    settle: (decision) => { decisions.push(decision) },
    ...overrides,
  }
  return { value, decisions }
}

describe('redactArguments', () => {
  it('keeps the command and drops secret-looking values', () => {
    const raw = JSON.stringify({ command: 'curl --token abc123 https://x.test', description: 'x' })
    const out = redactArguments(raw)
    assert.ok(out.includes('curl'))
    assert.ok(!out.includes('abc123'))
    assert.ok(out.includes('***'))
  })

  it('blanks secret-named JSON fields', () => {
    const out = redactArguments(JSON.stringify({ api_key: 'sk-live-123', query: 'hello' }))
    assert.equal(out, 'hello')
  })

  it('redacts provider token shapes and long hex', () => {
    const raw = JSON.stringify({ command: 'git push ghp_abcdefghijklmnop 0123456789abcdef0123456789abcdef' })
    const out = redactArguments(raw)
    assert.ok(!out.includes('ghp_abcdefghijklmnop'))
    assert.ok(!out.includes('0123456789abcdef'))
  })

  it('truncates long summaries with an ellipsis', () => {
    const out = redactArguments(JSON.stringify({ command: 'x'.repeat(400) }), 40)
    assert.equal(out.length, 40)
    assert.ok(out.endsWith('…'))
  })

  it('falls back to the raw string when arguments are not JSON', () => {
    assert.equal(redactArguments('plain text'), 'plain text')
    assert.equal(redactArguments(undefined), '（无参数）')
  })
})

describe('parseApprovalReply', () => {
  it('accepts an explicit id', () => {
    assert.deepEqual(parseApprovalReply('同意 3'), { id: '3', decision: 'allowed-once' })
    assert.deepEqual(parseApprovalReply('拒绝3'), { id: '3', decision: 'rejected' })
  })

  it('accepts a bare word only when one prompt is pending', () => {
    assert.deepEqual(parseApprovalReply('同意', '7'), { id: '7', decision: 'allowed-once' })
    assert.equal(parseApprovalReply('同意'), undefined)
  })

  it('ignores unrelated text', () => {
    assert.equal(parseApprovalReply('帮我看看这个文件'), undefined)
    assert.equal(parseApprovalReply(''), undefined)
  })
})

describe('parseButtonKey', () => {
  it('maps both button prefixes', () => {
    assert.deepEqual(parseButtonKey('approve:12'), { id: '12', decision: 'allowed-once' })
    assert.deepEqual(parseButtonKey('reject:12'), { id: '12', decision: 'rejected' })
    assert.equal(parseButtonKey('approve:'), undefined)
    assert.equal(parseButtonKey('other:12'), undefined)
  })
})

describe('card and text rendering', () => {
  it('renders both buttons with the request id', () => {
    const { value } = entry('5')
    const card = buildApprovalCard(value, 5)
    assert.equal(card.card_type, 'button_interaction')
    assert.equal(card.task_id, '5')
    assert.deepEqual(card.button_list.map((button) => button.key), ['approve:5', 'reject:5'])
    assert.ok(card.sub_title_text.includes('5 分钟'))
  })

  it('mentions the reply syntax in the text fallback', () => {
    const { value } = entry('9')
    const text = formatApprovalText(value, { index: 1, total: 2 }, 5)
    assert.ok(text.includes('同意 9'))
    assert.ok(text.includes('1/2'))
  })
})

describe('ApprovalQueue', () => {
  it('sends one prompt at a time and advances after settling', async () => {
    const sent: string[] = []
    const outcomes: ApprovalOutcome[] = []
    const queue = new ApprovalQueue({
      send: (item) => { sent.push(item.id); return Promise.resolve() },
      done: (_item, outcome) => { outcomes.push(outcome) },
    })
    const first = entry('1')
    const second = entry('2')
    queue.add(first.value)
    queue.add(second.value)
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(sent, ['1'])

    assert.equal(queue.settle('1', 'allowed-once'), true)
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(sent, ['1', '2'])
    assert.deepEqual(first.decisions, ['allowed-once'])
    assert.deepEqual(outcomes, ['allowed-once'])
  })

  it('settles a queued prompt without sending it', async () => {
    const sent: string[] = []
    const queue = new ApprovalQueue({
      send: (item) => { sent.push(item.id); return Promise.resolve() },
      done: () => {},
    })
    const first = entry('1')
    const second = entry('2')
    queue.add(first.value)
    queue.add(second.value)
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(queue.settle('2', 'rejected'), true)
    assert.deepEqual(second.decisions, ['rejected'])
    assert.equal(queue.size, 1)
    assert.deepEqual(sent, ['1'])
  })

  it('fails closed when the prompt cannot be sent', async () => {
    const outcomes: ApprovalOutcome[] = []
    const queue = new ApprovalQueue({
      send: () => Promise.reject(new Error('socket down')),
      done: (_item, outcome) => { outcomes.push(outcome) },
    })
    const only = entry('1')
    queue.add(only.value)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(outcomes, ['unavailable'])
    assert.deepEqual(only.decisions, ['rejected'])
  })

  it('drops everything on clear', () => {
    const outcomes: ApprovalOutcome[] = []
    const queue = new ApprovalQueue({
      send: () => Promise.resolve(),
      done: (_item, outcome) => { outcomes.push(outcome) },
    })
    queue.add(entry('1').value)
    queue.add(entry('2').value)
    queue.clear()
    assert.equal(queue.size, 0)
    assert.deepEqual(outcomes, ['unavailable', 'unavailable'])
  })
})

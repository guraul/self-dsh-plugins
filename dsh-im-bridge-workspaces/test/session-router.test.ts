/**
 * Unit tests for the pure `/s` session command router (Node 24 type stripping).
 * Run with `pnpm test`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parseSessionCommand,
  sessionKeyForPinnedSession,
  shortSessionId,
} from '../src/session-router.ts'

describe('parseSessionCommand', () => {
  it('treats bare command heads and `list` as a list request', () => {
    for (const text of ['/s', '/session', '/会话', '/S', '/SESSION', '/s list', '/s LIST']) {
      assert.deepEqual(parseSessionCommand(text), { kind: 'list' }, text)
    }
  })

  it('parses help aliases', () => {
    for (const text of ['/s help', '/s HELP', '/s ?', '/s 帮助', '/会话 帮助']) {
      assert.deepEqual(parseSessionCommand(text), { kind: 'help' }, text)
    }
  })

  it('parses reset aliases', () => {
    for (const text of ['/s reset', '/s default', '/s DEFAULT', '/session reset']) {
      assert.deepEqual(parseSessionCommand(text), { kind: 'reset' }, text)
    }
  })

  it('binds a 1-based index from the last `/s` listing', () => {
    assert.deepEqual(parseSessionCommand('/s 1'), { kind: 'bindIndex', index: 1 })
    assert.deepEqual(parseSessionCommand('/s 12'), { kind: 'bindIndex', index: 12 })
    assert.deepEqual(parseSessionCommand('/s 007'), { kind: 'bindIndex', index: 7 })
    assert.deepEqual(parseSessionCommand('/session 3'), { kind: 'bindIndex', index: 3 })
  })

  it('treats an unusable digit-led argument as plain chat', () => {
    for (const text of ['/s 0', '/s 00', '/s 1a', '/s 1234']) {
      assert.equal(parseSessionCommand(text), undefined, text)
    }
  })

  it('binds a well-formed session id', () => {
    assert.deepEqual(parseSessionCommand('/s session-abc123'), {
      kind: 'bind',
      sessionId: 'session-abc123',
    })
    assert.deepEqual(parseSessionCommand('/session a.b_c:d-e'), {
      kind: 'bind',
      sessionId: 'a.b_c:d-e',
    })
    assert.deepEqual(parseSessionCommand('/会话 ses_9'), { kind: 'bind', sessionId: 'ses_9' })
  })

  it('rejects session ids with illegal characters', () => {
    for (const text of ['/s 有空格 的 id', '/s -leading', '/s has/slash', '/s has#hash', '/s a b']) {
      assert.equal(parseSessionCommand(text), undefined, text)
    }
  })

  it('does not treat glued heads as commands', () => {
    for (const text of ['/sx', '/sessionx', '/s2', '/sessions']) {
      assert.equal(parseSessionCommand(text), undefined, text)
    }
  })

  it('leaves ordinary chat text alone', () => {
    for (const text of ['你好', 's', '/ws list', '/ss', '帮我看看 /s 怎么用', '/ls', '/s-x']) {
      assert.equal(parseSessionCommand(text), undefined, text)
    }
  })
})

describe('sessionKeyForPinnedSession', () => {
  it('suffixes the window key with #sid=', () => {
    assert.equal(
      sessionKeyForPinnedSession('single:GuBin', 'session-abc12345'),
      'single:GuBin#sid=session-abc12345',
    )
    assert.equal(sessionKeyForPinnedSession('group:chatid1', 'x'), 'group:chatid1#sid=x')
  })

  it('gives different windows and sessions different keys', () => {
    const a = sessionKeyForPinnedSession('single:GuBin', 'session-a')
    const b = sessionKeyForPinnedSession('single:GuBin', 'session-b')
    const c = sessionKeyForPinnedSession('single:Other', 'session-a')
    assert.notEqual(a, b)
    assert.notEqual(a, c)
    assert.notEqual(a, 'single:GuBin')
  })
})

describe('shortSessionId', () => {
  it('drops the session- prefix and keeps 8 characters', () => {
    assert.equal(shortSessionId('session-abcdef123456'), 'abcdef12')
    assert.equal(shortSessionId('session-abc'), 'abc')
  })

  it('keeps ids without the prefix and short ids as-is', () => {
    assert.equal(shortSessionId('wecom-321a442c'), 'wecom-32')
    assert.equal(shortSessionId('short'), 'short')
    assert.equal(shortSessionId('12345678'), '12345678')
  })
})

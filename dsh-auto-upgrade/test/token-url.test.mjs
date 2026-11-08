import test from 'node:test'
import assert from 'node:assert/strict'
import { latestTokenUrl } from '../lib/host/token-url.js'

/**
 * The launch token is process-scoped and only ever printed to stdout, so
 * `.dsh-web/url.txt` is refreshed from that log. These cases pin the parsing
 * rules the helper relies on (test/token-url.test.mjs → lib/host/token-url.js).
 */

test('returns the last token URL in the log', () => {
  const text = [
    'dsh web ready: http://127.0.0.1:3080/?token=FIRST_TOKEN_123456',
    'some noise',
    'dsh web ready: http://127.0.0.1:3080/?token=SECOND_TOKEN_654321',
    '',
  ].join('\n')
  assert.equal(latestTokenUrl(text), 'http://127.0.0.1:3080/?token=SECOND_TOKEN_654321')
})

test('ignores lines without a token', () => {
  assert.equal(latestTokenUrl('no url here\njust text\n'), undefined)
  assert.equal(latestTokenUrl(''), undefined)
  assert.equal(latestTokenUrl(undefined), undefined)
})

test('can restrict the port of the running service', () => {
  const text = [
    'http://127.0.0.1:3080/?token=OLD_PORT_TOKEN_1',
    'http://127.0.0.1:3099/?token=OTHER_PORT_TOKEN_2',
  ].join('\n')
  assert.equal(latestTokenUrl(text, 3080), 'http://127.0.0.1:3080/?token=OLD_PORT_TOKEN_1')
  assert.equal(latestTokenUrl(text, 3099), 'http://127.0.0.1:3099/?token=OTHER_PORT_TOKEN_2')
  assert.equal(latestTokenUrl(text, 4000), undefined)
})

test('keeps the whole URL including any path prefix', () => {
  const url = 'http://127.0.0.1:3080/some/path?token=ABCDEF123456'
  assert.equal(latestTokenUrl(`ready at ${url}\n`), url)
})

test('requires a plausible token length so stray query strings do not match', () => {
  assert.equal(latestTokenUrl('http://127.0.0.1:3080/?token=short'), undefined)
})

test('#377 宽限期：当前令牌永远可用；上一个令牌只在宽限期内可用', async () => {
  const { tokenAccepted } = await import('../lib/host/token-url.js')
  const base = { current: 'NEW', previous: 'OLD', graceMs: 600_000 }
  assert.equal(tokenAccepted({ ...base, presented: 'NEW', ageMs: 999_999 }), true, '当前令牌不看时间')
  assert.equal(tokenAccepted({ ...base, presented: 'OLD', ageMs: 1_000 }), true, '刚重启时旧令牌仍可用（旧标签页）')
  assert.equal(tokenAccepted({ ...base, presented: 'OLD', ageMs: 600_001 }), false, '过了宽限期就不认了')
  assert.equal(tokenAccepted({ ...base, presented: 'GUESS', ageMs: 0 }), false)
  assert.equal(tokenAccepted({ ...base, presented: undefined, ageMs: 0 }), false)
  assert.equal(tokenAccepted({ current: undefined, previous: 'OLD', presented: 'OLD', ageMs: 0 }), false, '没有当前令牌时一律拒绝')
  assert.equal(tokenAccepted({ current: 'NEW', previous: undefined, presented: 'OLD', ageMs: 0 }), false, '没有上一个令牌时不能放行')
})

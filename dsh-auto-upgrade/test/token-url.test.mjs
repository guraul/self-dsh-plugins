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

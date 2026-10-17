#!/usr/bin/env node
/**
 * Refresh `.dsh-web/url.txt` from the running host's stdout log.
 *
 * Called by the detached helper after it relaunched the service: the new host
 * prints a fresh token URL, and the old url.txt is worthless. Exit codes:
 *
 *   0  url.txt already current, or rewritten
 *   1  no token URL in the log yet (the helper retries)
 *   2  bad usage
 *
 * The parsing itself is `latestTokenUrl()` (lib/host/token-url.js), covered by
 * `test/token-url.test.mjs`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { latestTokenUrl } from './token-url.js'

const [outLog, urlFile] = process.argv.slice(2)
if (outLog === undefined || urlFile === undefined) {
  process.stderr.write('usage: refresh-url.mjs <outLog> <urlFile>\n')
  process.exit(2)
}

let text
try {
  text = readFileSync(outLog, 'utf8')
} catch {
  process.exit(1)
}

const found = latestTokenUrl(text)
if (found === undefined) process.exit(1)

let current
try {
  current = readFileSync(urlFile, 'utf8').trim()
} catch {
  current = undefined
}
if (current === found) process.exit(0)

try {
  writeFileSync(urlFile, `${found}\n`, 'utf8')
} catch {
  process.exit(1)
}
process.exit(0)

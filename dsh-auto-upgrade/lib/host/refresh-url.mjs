#!/usr/bin/env node
/**
 * Refresh `.dsh-web/url.txt` from the running host's stdout log.
 *
 * Called by the detached helper after it relaunched the service: the new host
 * prints a fresh token URL, and the old url.txt is worthless. Writing the
 * "last URL in the log" blindly raced the relaunch (issue #293): right after
 * `kickstart` the new host has not printed yet, so the last match is still the
 * PREVIOUS start's URL — writing it leaves url.txt pointing at a 401 forever
 * (the helper saw exit 0 and stopped retrying). Two criteria must both hold
 * before url.txt is written:
 *
 *   1. only a URL that is NEW since the restart: the helper captures the
 *      pre-relaunch last URL via `--print-latest` and passes it back as
 *      `--previous <baseline>`; same as baseline → keep waiting;
 *   2. the candidate must really authenticate: one `fetch(url, {redirect:'manual'})`
 *      whose status is in {200, 302, 303}; the launch token is process-scoped,
 *      so a stale token gets 401 from the new process.
 *
 * Usage:
 *
 *   refresh-url.mjs <outLog> <urlFile> [--previous <baseline>]
 *   refresh-url.mjs --print-latest <outLog>
 *
 * Exit codes (normal mode):
 *
 *   0  url.txt rewritten (or already current)
 *   1  no token URL yet / same as baseline / candidate failed to authenticate
 *      (the helper retries)
 *   2  bad usage
 *
 * `--print-latest` prints the log's last token URL (helper's baseline capture)
 * and exits 0, or prints nothing and exits 1 when the log has no URL yet.
 *
 * The parsing itself is `latestTokenUrl()` (lib/host/token-url.js), covered by
 * `test/token-url.test.mjs`; the CLI behaviour is covered by
 * `test/refresh-url.test.mjs`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { latestTokenUrl } from './token-url.js'

/** Statuses that prove the token URL is live (issue #293 criterion 2). */
const AUTH_OK = new Set([200, 302, 303])

/**
 * Does this URL really authenticate against the running host?
 * @param {string} url candidate token URL.
 * @returns {Promise<boolean>} true when the status proves a live token.
 */
async function authenticates(url) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) })
    return AUTH_OK.has(response.status)
  } catch {
    return false
  }
}

const argv = process.argv.slice(2)

// Baseline mode: print the log's last token URL for the helper to remember
// before it relaunches the service. Never writes url.txt.
if (argv[0] === '--print-latest') {
  if (argv.length !== 2) {
    process.stderr.write('usage: refresh-url.mjs --print-latest <outLog>\n')
    process.exit(2)
  }
  let text
  try {
    text = readFileSync(argv[1], 'utf8')
  } catch {
    process.exit(1)
  }
  const found = latestTokenUrl(text)
  if (found === undefined) process.exit(1)
  process.stdout.write(`${found}\n`)
  process.exit(0)
}

let previous
let malformed = false
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--previous') {
    if (i + 1 >= argv.length) {
      malformed = true
      break
    }
    previous = argv[i + 1]
    i += 1
  } else if (arg.startsWith('--')) {
    malformed = true
    break
  } else {
    positional.push(arg)
  }
}
const [outLog, urlFile] = positional
if (malformed || outLog === undefined || urlFile === undefined || positional.length !== 2) {
  process.stderr.write('usage: refresh-url.mjs <outLog> <urlFile> [--previous <baseline>]\n')
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

// Criterion 1 (issue #293): only a URL printed AFTER the restart counts.
// Same as the pre-relaunch baseline → the new host has not printed yet.
if (previous !== undefined && found === previous) process.exit(1)

// Criterion 2 (issue #293): the candidate must really authenticate; a stale
// token gets 401 from the new process and must not be written either.
if (!(await authenticates(found))) process.exit(1)

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

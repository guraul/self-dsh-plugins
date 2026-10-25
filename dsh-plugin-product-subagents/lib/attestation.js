import { createHash } from 'node:crypto'

/**
 * Structured attestation for a successful `product_submit` (issue #56).
 *
 * The machine tag (`<!--product-session:…-->`) is a *structural* receipt, but a
 * relay that paraphrases a long remote answer drops it — and the answer was
 * genuine. The fix is not to trust untagged text again: `product_submit` now
 * records a comparable digest of every successful result next to the child's
 * durable registry entry, and the caller can only claim untagged text when it
 * matches that record.
 *
 * The comparison is deliberately narrow: whitespace is folded (indentation and
 * line wrapping must not matter) but markdown is *not* stripped — a paraphrase
 * that keeps the first 200 characters is accepted, a rewritten answer is not.
 */

/** Characters of the normalized answer kept as the claimable head. */
export const ATTEST_HEAD_CHARS = 200

/**
 * Fold whitespace so formatting alone cannot break a match: every run of
 * whitespace collapses to one space, then the ends are trimmed.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeAnswerText(text) {
  if (typeof text !== 'string') return ''
  return text.replace(/\s+/g, ' ').trim()
}

/** SHA-256 of the normalized text, hex. */
export function hashAnswerText(text) {
  return createHash('sha256').update(normalizeAnswerText(text), 'utf8').digest('hex')
}

/**
 * Build the digest persisted with one child's registry entry.
 *
 * @param {unknown} text the successful `product_submit` answer (without the
 *   marker / tag suffix, so `head` always starts with real answer text).
 * @param {string|undefined} remoteId the remote session id, or the child id.
 * @param {number} [at] epoch millis; injectable for tests.
 * @returns {{ remoteId?: string, at: number, head: string, len: number, hash: string }}
 */
export function buildAttestation(text, remoteId, at = Date.now()) {
  const normalized = normalizeAnswerText(text)
  return {
    remoteId: remoteId || undefined,
    at,
    head: normalized.slice(0, ATTEST_HEAD_CHARS),
    len: normalized.length,
    hash: hashAnswerText(normalized),
  }
}

/**
 * Whether `text` can be claimed by a recorded attestation: either the
 * normalized text equals the attested full text (same hash), or it contains the
 * attested 200-character head (a paraphrase that still starts from the real
 * answer).
 *
 * Malformed or empty records never claim anything.
 *
 * @param {unknown} text
 * @param {unknown} attest
 * @returns {boolean}
 */
export function attestationClaims(text, attest) {
  if (!attest || typeof attest !== 'object') return false
  const normalized = normalizeAnswerText(text)
  if (!normalized) return false
  if (typeof attest.hash === 'string' && attest.hash !== '' && hashAnswerText(normalized) === attest.hash) {
    return true
  }
  if (typeof attest.head === 'string' && attest.head !== '' && normalized.includes(attest.head)) {
    return true
  }
  return false
}

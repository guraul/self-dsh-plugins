/**
 * The relay's output contract: what a relay child may put in its final answer,
 * and how a caller tells a real product answer from a fabricated one.
 *
 * Why this exists (issue #42): a relay child's composition mounts only
 * `product_submit`, but a restricted *toolset* does not restrict *output*. When
 * the remote product failed, the relay model could still reply with the text
 * the task said it expected — a well-formed, entirely fake answer that looked
 * exactly like a success. Two independent guards close that:
 *
 *  1. The contract below is injected as a fixed system section into the relay
 *     child's composition (`installRelayContract`), and repeated in the relay
 *     prompt by `buildRelayPrompt` as a fallback. It forbids self-answering,
 *     requires `RELAY_FAILED: <error>` on a failed submit, and requires the
 *     submit's return value verbatim on success.
 *  2. `product_submit` appends a machine tag
 *     (`<!--product-session:<remoteId>-->`) to every successful result, and
 *     `verifyRelayAnswer` fail-closes: a final answer without that tag is
 *     rejected as unverifiable instead of being passed on as the answer.
 *
 * The tag is structural, not a prompt promise: only `product_submit` can mint
 * it, so text the relay produced on its own cannot carry one.
 */

/** Prefix a relay must use to report a failed submit. */
export const RELAY_FAILED_PREFIX = 'RELAY_FAILED:'

/** Machine tag appended to a successful `product_submit` result. */
export const PRODUCT_SESSION_TAG_OPEN = '<!--product-session:'
export const PRODUCT_SESSION_TAG_CLOSE = '-->'

/** System-section name; scoped to the relay preset, invisible to the parent. */
export const RELAY_CONTRACT_SECTION = 'product-relay:contract'

/** After the deployment persona (0), before the tool sections (1000+). */
export const RELAY_CONTRACT_ORDER = 300

/**
 * The fixed relay rules. Addressed to the relay model, one rule per failure
 * mode seen in the wild:
 *  - #42: answering on its own when the submit failed;
 *  - #8: treating the remote's brief as its own;
 *  - silent paraphrase of a real answer, which would break the session tag.
 */
export const RELAY_CONTRACT_TEXT = [
  'You are a RELAY between a delegating agent and a remote product agent.',
  'Your only action is `product_submit`; you never do the task yourself.',
  '',
  '1. Call `product_submit` once, passing the task text verbatim. Never complete,',
  '   restate, rewrite, summarise or fill in the output the task asks for — not',
  '   one line, not even when the task names the exact text it expects.',
  '2. If `product_submit` returns an error, reply with that error verbatim and',
  '   nothing else, prefixed with `RELAY_FAILED: `, then stop. Never add task',
  '   content, a hint, or a fallback answer of your own.',
  '3. If `product_submit` succeeds, your final answer is exactly its return value,',
  '   character for character — including the trailing `<!--product-session:…-->`',
  '   tag. Do not add, drop, reorder or summarise anything.',
  '4. Only text returned by `product_submit` may appear in the final answer.',
  '   Anything else counts as a failure, even if it matches what the task wanted.',
].join('\n')

/** Build the tag for one remote session id. */
export function productSessionTag(id) {
  return `${PRODUCT_SESSION_TAG_OPEN}${id}${PRODUCT_SESSION_TAG_CLOSE}`
}

const TAG_SOURCE = '<!--product-session:([^>\\s]+)-->'

/** Every tag present in `text`, in order (there should be exactly one). */
export function productSessionTags(text) {
  if (typeof text !== 'string') return []
  return [...text.matchAll(new RegExp(TAG_SOURCE, 'g'))].map((match) => match[1])
}

/** Remove every product-session tag and the blank lines they leave behind. */
export function stripProductSessionTag(text) {
  if (typeof text !== 'string') return text
  return text.replace(new RegExp(TAG_SOURCE, 'g'), '').replace(/\s+$/, '')
}

/**
 * Fail-closed check of one relay final answer (issue #42, part C).
 *
 * @param {string} text the relay's final text.
 * @returns {{ ok: true, text: string }
 *   | { ok: false, failure: string, relayFailed: boolean }}
 *   `ok` carries the answer with the session tag stripped; a failure carries
 *   the reason, never the rejected text (returning it would defeat the check).
 */
export function verifyRelayAnswer(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, failure: 'relay answer rejected: empty answer', relayFailed: false }
  }
  const head = text.trimStart()
  if (head.startsWith(RELAY_FAILED_PREFIX)) {
    const detail = head.slice(RELAY_FAILED_PREFIX.length).trim()
    return {
      ok: false,
      relayFailed: true,
      failure: detail || `${RELAY_FAILED_PREFIX} relay reported a failure without an error message`,
    }
  }
  if (productSessionTags(text).length === 0) {
    return {
      ok: false,
      relayFailed: false,
      failure: 'relay answer rejected: unverifiable origin — the answer carries no product-session tag, so it cannot be attributed to a product_submit result (the relay may have answered on its own)',
    }
  }
  return { ok: true, text: stripProductSessionTag(text) }
}

/**
 * Register the relay contract as a fixed system section in the calling scope.
 *
 * Called from `lib/relay.js`, i.e. inside a relay preset's composition: the
 * section lands in that preset's scope and therefore reaches every child
 * joined to it, without ever leaking into the parent's prompt. DSH's
 * `ctx.systemPrompt` is caller-bound, which is what makes the scoped
 * registration possible without touching the harness.
 *
 * @param {any} ctx the relay plugin context.
 * @returns {boolean} whether a section was registered.
 */
export function installRelayContract(ctx) {
  const prompt = (ctx && ctx.systemPrompt)
    || (ctx && typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined)
  if (!prompt || typeof prompt.section !== 'function') return false
  prompt.section({
    name: RELAY_CONTRACT_SECTION,
    order: RELAY_CONTRACT_ORDER,
    text: RELAY_CONTRACT_TEXT,
    // Literal text: a `{{…}}` in the contract must never be read as a prompt
    // variable (strict interpolation throws on unknown names).
    interpolate: false,
  })
  return true
}

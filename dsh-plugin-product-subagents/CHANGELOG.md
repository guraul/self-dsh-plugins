# Changelog

All notable changes to this project are documented in this file.

## [0.4.11] — 2026-10-25

A background delegation could finish its real work and still be reported as
failed: the relay paraphrased the remote's long answer, the
`<!--product-session:…-->` tag was lost, and the #42 fail-closed check rejected
the whole turn as "unverifiable origin" (issue #56). Rejecting a genuine answer
is the opposite failure of the one #42 guards against, so the receipt is now
backed by a record of the submit itself — without giving up the default.

### Fixed
- **`product_submit` records a structured attestation of every successful
  answer** (issue #56): `{ remoteId, at, head, len, hash }` is written onto the
  child's existing registry entry (no new storage file). `head` is the first
  200 characters and `hash` the SHA-256 of the *normalized* body; normalization
  collapses every whitespace run to one space and trims, and deliberately does
  **not** strip markdown. Helpers live in `lib/attestation.js` (`normalizeAnswerText`,
  `buildAttestation`, `attestationClaims`).
- **`verifyRelayAnswerWithAttestation(text, attest)`** adds one narrow
  acceptance to the #42 check: no tag, but the normalized answer contains the
  recorded `head` (or its hash equals the recorded `hash`) → `ok`,
  `mode: "reconciled"`, body returned as received, plus a warn. A tag still
  wins (`mode: "tag"`). `RELAY_FAILED` reports are never reconciled, and
  `verifyRelayAnswer(text)` keeps its exact signature and behaviour.
- **`product_wait` uses the new check** and reports how the answer was
  verified: `attested: "tag" | "reconciled"`. `lastAnswerFull()` / the new
  `lastAnswerResult()` in `lib/progress.js` take the same optional attestation,
  so the log fallback reconciles too — with no record it degrades to the old
  fail-closed result.
- **The log fallback no longer re-checks already-stripped text.** The fallback
  had returned the verified body (tag stripped) and `product_wait` then ran the
  tag check on it again, so every answer read from the log failed as
  "unverifiable origin". It now consumes the verifier's result directly, which
  is what makes a successful log answer pass at all.

### Tests
- `test/relay-contract.test.js`: +8 cases (verbatim tag; paraphrase claimed by
  `head`; exact untagged copy claimed by `hash`; self-answer rejected; no
  attestation + no tag rejected; `RELAY_FAILED` never reconciled; whitespace
  normalization; differently formatted answer still claimed).
- `test/product-wait.test.js`: +4 cases (reconciled settlement with
  `attested: "reconciled"`; a self-answer with a record for another answer still
  fails; the log fallback reconciles; a tagged log answer verifies as
  `attested: "tag"`). Suite 105 → 117.

## [0.4.10] — 2026-10-25

Stopping a product child used to stop only the local half. `product_submit`
runs inside the relay child's turn, so `interrupt_agent` aborted `exec.signal`
— but the ACP bridge never read that signal, and `prompt()` stayed open until
the agent finished on its own. Killing the client was no help either: a v2
agent runs the turn in a resident backend (`opencode serve --service`), so the
session kept grepping and spawning git minutes after `list_agents` showed the
child as inactive (issue #12).

### Fixed
- **ACP turns now honour caller cancellation.** The bridge translates an
  aborted `signal` into the protocol's `session/cancel` notification, the only
  channel that reaches a running turn (the agent then answers the original
  `session/prompt` with `stopReason: cancelled`). A failed notification only
  warns — it never breaks the turn.
- **`dispose()` cancels before closing.** `closeSession` + SIGTERM release the
  client side only, so a turn still live in a resident backend is cancelled
  first.
- **A cancelled turn is never replayed.** The dead-transport retry no longer
  reconnects and re-sends the task after the caller aborted; that would have
  started a fresh remote session for work the caller had just stopped.

claude-code and codex needed no change: their bridges already pass `signal` to
`runCommand()`, which kills the product process on abort.

### Tests
- `test/acp-cancel.test.js`: +6 cases (abort sends `session/cancel`; an
  already-aborted signal cancels immediately; a rejected and a synchronously
  throwing `cancel` only warn; a completed turn is not cancelled
  retroactively; `dispose` cancels before `closeSession`). Suite 99 → 105.

## [0.4.9] — 2026-10-25

The log fallback `product_wait` uses was the last path that could hand back an
**unverified** relay answer: `lastAnswerFull()` returned the raw text, and the
#42 check only ran afterwards inside `product_wait`. The fold itself is now
fail-closed, so no caller can obtain the text without the tag check.

### Fixed
- **`lastAnswerFull()` did not verify or strip the product-session tag** (issue
  #52, a #42 coverage gap). The whole answer now goes through
  `verifyRelayAnswer()`: a tagged answer comes back with the tag stripped; an
  untagged one comes back as `RELAY_FAILED: 输出缺少 product-session 标记，来源不可验证`
  and **never** as the rejected text; an empty log / empty answer / undefined
  fails the same way instead of throwing. A relay's own `RELAY_FAILED: <error>`
  keeps its message, because that error is the failure the caller needs.
- **`product_wait` only uses that fallback when the log has events.** An
  already-settled child with no readable log keeps `status: "ready"` and has no
  answer, instead of being reported as a verification failure.

### Not covered
- The activation settlement notice DSH delivers to the parent
  (`delivery: 'parent'`) is still harness-owned text
  (`dsh-subagent` `createSettlementMessage()`), so a background delegation's
  closing message can still show the markers. Fixing that needs a DSH-side hook
  or a relay-contract change; it is recorded, not addressed here.

### Tests
- `test/progress.test.js`: +5 cases (tagged answer stripped; the bare
  `PRODUCT_SESSION:` recovery marker is not a receipt; untagged answer is
  rejected and not echoed; empty/undefined fails closed without throwing; a
  relay `RELAY_FAILED` keeps its error). Two old fixtures that used untagged
  text were updated to the `verifyRelayAnswer` semantics. Suite 94 → 99.

## [0.4.8] — 2026-10-25

`0.4.7` broke the `product-relay` preset itself: `installRelayContract()` read
`ctx.systemPrompt` before falling back to `ctx.get()`, and Cordis throws on that
property read for a service the plugin did not `inject`. Every background
delegation failed at mount with `cannot get property "systemPrompt" without
inject`; foreground delegation was unaffected.

### Fixed
- **Relay preset failed to mount when `systemPrompt` was not injected** (issue
  #50, a regression of #49). The service is now probed with the non-throwing
  `ctx.get('systemPrompt')` first; the property read remains only as a guarded
  fallback for plain (non-Cordis) contexts, and the whole registration is
  wrapped so a missing service is a no-op instead of a mount failure. The relay
  child still gets the contract through `buildRelayPrompt()`.
- **`systemPrompt` stays out of `inject`** (and is now pinned by a test). Cordis
  has no `{ required, optional }` form — the object shape is
  `serviceName → intercept config` — and every entry of `inject` is required, so
  a service the relay scope cannot see would keep the row pending with no tools
  at all instead of merely skipping the section.

### Tests
- `test/relay-contract.test.js`: a Cordis-like context proxy (unknown property
  reads throw) must be skipped, not fatal; `ctx.get` must be probed before the
  throwing property read; a throwing `ctx.get` and a throwing property must both
  degrade to no-op; `lib/relay.js` `inject` must be exactly `['tools']`;
  `buildRelayPrompt()` must still carry the contract. Suite 89 → 94.

## [0.4.7] — 2026-10-25

A relay child could hand its caller a **fabricated** answer: when the remote
product failed, the relay model sometimes replied with the text the task said it
expected. The toolset was restricted; the *output* was not. The relay contract
is now injected into the relay composition, `product_submit` stamps every
successful result, and `product_wait` fail-closes on a final answer that carries
no stamp.

### Fixed
- **Relay answered on its own when `product_submit` failed** (issue #42). Two
  independent causes, two guards:
  1. **Prompt** — new `lib/relay-contract.js` holds the fixed contract
     (only action is `product_submit`; a submit error must be reported verbatim
     as `RELAY_FAILED: <error>` and end the turn; a successful return value must
     be echoed verbatim; nothing else may appear in the final answer). `lib/relay.js`
     injects it as the system section `product-relay:contract` through the
     caller-bound `ctx.systemPrompt.section(...)` — it lands in the relay
     preset's scope, so every relay child inherits it and the parent never sees
     it. `buildRelayPrompt` repeats the same rules in the relay prompt, which
     covers a profile without a `systemPrompt` service.
  2. **Structure** — `product_submit` now appends a machine tag
     `<!--product-session:<remoteId>-->` to every successful result (the child
     session id when the bridge has not exposed a remote id yet). Only that tool
     can mint the tag, so text the relay produced on its own cannot carry one.
     No extra network call: the id is the one the binding already holds.
- **`product_wait` is fail-closed on the relay's final text** (`verifyRelayAnswer`):
  - starts with `RELAY_FAILED:` → `status: "failed"`, `failure` = the reported
    error text verbatim, no `answer`;
  - no product-session tag → `status: "failed"` with an "unverifiable origin"
    `failure`, **no `answer`** (the rejected text is never returned, otherwise
    the check would be pointless);
  - tag present → the body with the tag stripped. The success path is otherwise
    unchanged.
  Non-terminal statuses (`timeout` / `aborted` / `unknown`) keep their own
  meaning, but an unverifiable answer read from the log is withheld instead of
  returned.
- **The rejected answer is withheld from `product_wait`'s internal `trace`**
  too: the trace is part of the same model-visible result, so its
  `assistant/message` briefs are blanked when the answer was rejected. Turn /
  step / tool entries are kept — they are the diagnostic value.
- **`foldProgress().lastAnswer`** strips the tag before the 300-character cap,
  so the marker never shows up in `subagent_progress` output either.

### Tests
- New `test/relay-contract.test.js` (9 cases): the contract text, the scoped
  section registration (plus the `ctx.get` fallback and a missing service), tag
  round-trip/strip, and `verifyRelayAnswer` for success, missing tag,
  `RELAY_FAILED`, malformed/empty input and leading whitespace.
- `test/product-wait.test.js` (14 cases, +6): the issue #42 acceptance set —
  remote failure + task's expected text → failed and the text is absent from the
  whole result; the same with a session log, proving the trace is redacted;
  `RELAY_FAILED` passthrough; tagged success with the tag stripped;
  success-looking answer without a tag → failed; unverifiable answer on timeout
  withheld. The two existing success fixtures now carry the tag.
- 89 tests pass, 0 fail (baseline before this change: 74).

## [0.4.6] — 2026-10-23

`subagent_progress` could never report anything: `foldProgress()` read a
`session.events` property that the real harness `Session` does not have, and the
events it was supposed to fold carry their body in `data`, not `payload`. Both
layers are fixed; the session log is now read through the `sessionQuery`
service, which also covers settled children.

### Fixed
- **`subagent_progress` returned `stepCount: 0`, `trace: []` and no
  `lastAnswer` for every child** (issue #41), including one whose log held 25
  events. Two independent causes:
  1. **Source** — `lib/progress.js` gated on `Array.isArray(session.events)`.
     The real `Session` exposes `snapshotEvents()` / `log` only, so the fold
     returned `null` on its first line. On top of that, `sessions.get(id)` serves
     only **live** sessions, so a settled child was absent from the store.
  2. **Field name** — real events are `{ type, seq, time, data }`; the folds read
     `event.payload`, so even a correct log produced no `lastTask` / `lastAnswer`
     / marker.
- **New `lib/session-events.js`** — `loadEvents(ctx, sessionId)` maps a session
  id to a normalized event array (`payload` mirrors `data`, `timestamp` mirrors
  `time`, original fields kept). It prefers `sessionQuery.readSession()` (full
  log, live-preferred, cold reads via persistence), falls back to
  `sessionQuery.listEvents()` (metadata-only records) and then to the live
  `Session.snapshotEvents()`. Any failure degrades to `[]`; a 5 s timeout guards
  the read; the warning is emitted once; nothing is cached (a running log grows).
- **`foldProgress` / `lastAnswerFull` / `foldTrace` / `foldTokenUsage`** now read
  `payload → data → body`, so both fixture-shaped and real events fold
  correctly. `tool/call` recognises `data.arguments` (JSON string) and
  `tool/result` reads `data.message` content instead of scanning arbitrary
  strings (which used to return the message id).
- **`subagent_progress`** builds `{ events }` from `loadEvents()` before folding;
  `status` / `inFlight` still come from the live store and the binding.
- **`product_wait`** does the same for its answers and trace, and falls back to
  the untruncated `lastAnswerFull()`. Its wake-up signal is unchanged: the
  activation settlement promise (0.4.5, issue #40).
- **`bindings.recoverRemoteSessionId()`** accepts `data` and, for a live
  `Session`, `snapshotEvents()`; settled sessions are still recovered through the
  durable registry.

### Tests
- New `test/session-events.test.js`: real envelope with `data`, `readSession`
  preference, live `snapshotEvents()` fallback, throwing service, timeout.
- `test/progress.test.js`: real-envelope case asserting `lastTask` / `lastAnswer`
  / marker, and `data.message.usage` for token folding.
- `test/product-wait.test.js`: unchanged (the 8 timing cases still pass).
- 74 tests pass, 0 fail.

## [0.4.5] — 2026-10-23

`product_wait` now waits on the child activation's own settlement promise,
replacing 0.4.4's event-and-session-log scheme whose fallback was unreachable in
production.

### Fixed
- **0.4.4's two wake-up signals both never fired for a real child** (issue #40).
  Measured on DSH 0.2.1-rc.2 with a child that answered in 24 s: `product_wait`
  still returned `{"status":"timeout"}` after the full window.
  - `ctx.on('subagent/end')` is a parent-scoped, one-shot emit; a listener on the
    plugin's own context never observed it.
  - The session-log fallback could not work at all: `sessions.get(id)` serves
    only **live** sessions (a settled child has been removed from the store),
    and the real `Session` object exposes no `events` property, so
    `foldProgress(session)` returned `null` on its first line — always.
- **Primary signal**: `startActivation()` resolves to `{ childId, result, … }`
  and `result` settles exactly when the activation ends
  (`dsh-subagent/lib/index.js:2075`). `product_delegate` now stores that promise
  on the binding (`record.settle`) and `product_wait` races it against the
  timeout and the abort signal — no events, no session reads.
- **A rejected activation reports failure** (`status: 'failed'`,
  `detectedBy: 'activation'`, `failure: <message>`) instead of surfacing an
  empty answer.
- The `subagent/end` listener is kept **only** as a fallback when no settlement
  handle exists (e.g. a child started by an earlier process).

### Changed
- `detectedBy` values: `activation` (normal), `already-settled`, `event`
  (fallback), `timeout`, `aborted`, `unknown`. `session-log` is gone.
- Default timeout back to **300 s**. With a settlement promise the call returns
  as soon as the child ends, so the timeout is only a safety net; 0.4.4's 120 s
  risked cutting off legitimate long product runs.
- Timeout results report `progress.waitingOn` (`activation` / `event`).

### Notes
- `foldProgress()` still reads `session.events`, which the runtime does not
  provide — `subagent_progress` therefore remains empty. Tracked separately as
  issue #41; this release deliberately does **not** depend on it.

## [0.4.4] — 2026-10-23

`product_wait` no longer misses a child that already finished and then blocks
until the timeout.

### Fixed
- **A child that settled during the wait's own setup woke nobody** (issue #38).
  `product_wait` used to snapshot `subagents.listChildren()` first and only then
  subscribe to `subagent/end`. A settle landing in that window — including the
  time `listChildren()` itself takes — was dropped, because the event is a
  one-shot parent-scoped broadcast with no replay; the call then returned
  `{"status":"timeout"}` after the full 300 s even though the child had answered
  in 39 s. The subscription is now established **before** the snapshot.
- **No second signal**: the child's own durable session log is now folded
  (`sessions.get(childId)` → `foldProgress`, first read immediately, then every
  2 s) and a closed last turn plus a folded answer (`endedAt`, `turnOpen ===
  false`, `lastAnswer`) also completes the wait. Whichever signal lands first
  wins.
- **A resumed child could be reported complete with the previous turn's
  answer.** The tail of a child continued via `send_message` holds the earlier
  `turn/end` while the new turn is still streaming, so `endedAt` alone reported
  `completed` with the *old* answer — a silent wrong answer, worse than the
  timeout. `foldProgress` now tracks `turnOpen` (set by `turn/start`, cleared by
  `turn/end`) and the log signal additionally requires it to be `false`.
- **The log path no longer truncates the answer.** `foldProgress.lastAnswer` is
  a 300-character display cap; `product_wait` now returns the full text via the
  new `lastAnswerFull()`. A folded answer is only used as `answer` when its turn
  is closed (or the child is already settled), never while a turn is in
  flight.

### Changed
- **`detectedBy` is now returned**: `"event"`, `"session-log"`,
  `"already-settled"` or `"timeout"` says which signal woke the call
  (`aborted` carries none).
- **A timeout no longer lies**: if the log already shows a finished child at the
  timeout boundary the result is `status: "completed"` with
  `detectedBy: "session-log"`; only a genuinely silent child reports `timeout`,
  and that result now carries `progress` (`lastActivityAt`, `receivedChars`,
  `lastTask`).
- **Default timeout 300 s → 120 s** (the cap stays 600 s; `timeout_ms` still
  overrides).
- `foldProgress` exposes `endedAt` (timestamp of the last `turn/end`) and
  `turnOpen` (whether a later `turn/start` re-opened the turn).

### Tests
- New `test/product-wait.test.js`: eight timing cases against a fake ctx and
  fake sessions (event before subscribe, event after subscribe, log-only
  completion, nothing at all, already-inactive child, pre-aborted signal, a
  resumed child whose new turn is still open, and a 1000-character answer) —
  offline, no credentials.

## [0.4.3] — 2026-10-17

Restores the read-only relay on DSH 0.2.1 — 0.4.2 silently handed delegated
children the parent's whole toolset.

### Fixed
- **A delegated background child could run the task itself instead of calling
  `product_submit`** (issue #8). 0.4.2 adapted to `startActivation` by sending
  only `prompt` + `parent`, on the assumption that 0.2.1 made external children
  one-shot. That assumption was wrong: this provider implements
  `prepareContinuable`, and *method presence selects local activation
  execution*, so DSH created a real local child Agent. With no composition
  restriction it inherited the parent's full toolset (bash / read / write /
  edit), and because a local child inherits the parent's model route, it did the
  work on the DSH model — the remote product CLI and the requested `model` were
  never used. Observed in a child session log as `{bash: 33, read: 5, edit: 8,
  write: 1}` with zero `product_submit` calls.
- **Root cause of the restriction loss**: 0.2.1 removed `persona` and
  `toolFilter` from `SubagentStartRequest`, and a local child's composition is
  built from `agentPreset` alone
  (`dsh-subagent/lib/index.js: composition: { agentPreset: request.agentPreset }`).
  `applyChildOverrides` still honours `composition.toolFilter`, but only a
  historical descriptor (cold resume) can populate it — a fresh start cannot.
- **Fix**: the plugin now registers a **`product-relay` agent preset** at load
  (`ctx.agentPresets.register`). Its composition mounts one entry
  (`lib/relay.js`) that registers exactly one tool, `product_submit`. The
  delegation path passes `agentPreset: 'product-relay'`, so the child cannot
  touch files or commands and the work necessarily goes to the remote product.
  This is stricter than the old `toolFilter`, which inherited the parent
  composition and then pruned it.
- If the profile exposes no `agentPresets` service, background delegation now
  **fails loudly** with an actionable message instead of starting an
  unrestricted child. (`background: false` is unaffected: it never creates a
  local child.)

### Changed
- The local relay's prompt no longer presents `role.instructions` as its own
  brief. Those instructions are addressed to the REMOTE product ("You have full
  file, command and permission access — do not ask for permission"), so
  `buildRelayPrompt()` now delimits them as "addressed to the remote product
  agent" and tells the relay to forward the text verbatim through
  `product_submit`. Previously the local child read the grant as its own.
- `maxDepth` is passed explicitly (`config.maxDelegationDepth`, default `2`) so
  a product chain cannot nest without bound. The provider now advertises the
  `agentPreset` and `depthLimit` capabilities (DSH rejects both request fields
  otherwise); the stale `persona` / `toolFilter` capability keys — no longer in
  `SubagentCapabilities` — are gone.

### Added
- `test/delegate-request.test.js`: asserts the **request content** of a
  background delegation (`agentPreset`, `maxDepth`, delimited relay prompt) and
  the loud refusal when no preset is available. The 0.4.2 test only asserted
  *which* service method was called, which is why this regression shipped green.
- `scripts/verify-plugin.mjs` now checks that the relay preset is registered
  and that the provider advertises the capabilities the activation path uses.
- `lib/bridge-set.js`: one bridge/provider construction shared by the parent
  plugin and the relay entry, so both resolve the same providers.

### Compatibility
- Recorded `0.2.1-rc.2` as `compatible` (install · compose · start · uninstall,
  with `@deepseek-ai/dsh-agent-preset-registry` installed alongside so the
  relay-preset assertion is meaningful). The declared range already covered it
  (`^0.2.1-alpha.5`).
- **Background delegation needs the `agentPresets` service.** Profiles that
  mount `@deepseek-ai/dsh-agent-preset-registry` (the `web` profile does) get
  the restricted relay; profiles without it keep synchronous
  `background: false` delegation and refuse background delegation by design.

## [0.4.2] — 2026-10-17

Delegation on the DSH `0.2.1` line, which renamed the service-level start call.

### Fixed
- **Every delegation threw `ctx.subagents.startContinuable is not a function` on
  DSH `0.2.1-alpha.5`.** The plugin still loaded, registered all six tools and
  answered `product_agents` / `product_roles` — only starting a child failed, so
  the symptom looked like a broken product CLI rather than a renamed API.
  `0.2.1` replaced `startContinuable` with `startActivation`, which additionally
  requires `delivery`. `lib/tools/product-delegate.js` now selects the call the
  mounted service actually exposes (`pickStart`) instead of assuming one:
  - `startActivation` (DSH >= 0.2.1) → `delivery: 'parent'`, so a background
    child's completion still reaches the delegating model;
  - `startContinuable` (DSH 0.2.0 line) → unchanged, `persona` / `toolFilter`
    included;
  - neither → a loud error naming both methods, rather than delegating nothing.
- The start request no longer carries `persona` / `toolFilter` on the `0.2.1`
  path: `0.2.1` removed both fields, and the external one-shot execution has no
  relay model to receive a persona. The role's `instructions` are still
  prepended to the task text, which is what the product CLI reads.

### Added
- `test/delegate-start.test.js` — a credential-free regression guard for the
  rename. This is the class of breakage the disposable-profile acceptance run
  cannot see: its `start` step asserts registration and tool execution, never a
  live delegation, which is why the `0.2.1-rc.1` verdict recorded in 0.4.1 did
  not catch it.

### Compatibility
- `peerDependencies` / `dsh.compatibility.dsh` now end with
  `|| ^0.2.1-alpha.5` (which also covers the rest of the `0.2.1` line, including
  `0.2.1-rc.1`) instead of `|| ^0.2.1-rc.1`. A prerelease comparator only
  matches its own `major.minor.patch` tuple, so the `rc.1` anchor never covered
  `alpha.5`.
- Recorded `0.2.1-alpha.5` as `compatible` in `dsh.compatibility.dshReleases`.

### ⚠️ Behaviour change on DSH 0.2.1+
- DSH `0.2.1` makes **external** subagents one-shot: "Local spawn and fork
  children retain durable sessions for later messages; ACP, DSH SDK, Codex, and
  Claude Code execute once." Everything this plugin registers is external, so on
  `0.2.1+` a delegated child runs exactly once: no durable remote session, no
  continuation, and `product_submit` has no child to serve. Those behaviours
  remain intact on the `0.2.0` line. `product_wait` still attaches to the child
  id; where the runtime no longer exposes a child Session, its trace fields are
  simply absent (`stripUndefined`), not fabricated.

## [0.4.1] — 2026-10-17

Compatibility release for the DSH `0.2.x` line.

### Added
- `dsh.compatibility.dshReleases` verdicts for `0.2.0-rc.2` and `0.2.1-rc.1`,
  each backed by a disposable-profile acceptance run (install · compose ·
  start · uninstall). The `0.2.0-rc.2` verdict was additionally earned with the
  official `@deepseek-ai/dsh-subagent-claude-code@0.2.0-rc.2` and
  `-codex@0.2.0-rc.2` plugins co-installed in the same profile, registering
  `claude-code`, `codex` and `product-subagents:acp` side by side — the
  plugin-owned-id guarantee of 0.4.0 holds on the 0.2.x line too.

### Changed
- The DSH range in `peerDependencies` and `dsh.compatibility.dsh` now ends with
  `|| ^0.2.0-rc.2 || ^0.2.1-rc.1`. Both alternatives are needed and neither is
  redundant: a prerelease only satisfies a comparator that shares its exact
  `major.minor.patch` tuple, so the `0.2.1` line cannot be covered by the
  `0.2.0-rc.2` anchor.

### Notes
- No code change. 0.4.0 already ran correctly on `0.2.x`; only the declaration
  was missing, so DSH's profile boot check skipped the bundle unless an exact
  version exemption was written into the profile's `compatibility.json`. With
  the range and the matrix updated, that exemption can be revoked.
- Repo note (self-dsh-plugins, 2026-10-17): this fork now lives under the
  repo-wide single-`AGENTS.md` policy, so the plugin's agent guidance moved to
  `docs/plugins/dsh-plugin-product-subagents.md` and the plugin-local
  `AGENTS.md` and `CLAUDE.md` were removed. The 0.4.0 entry below is kept as
  the historical record of why `CLAUDE.md` existed at all.

## [0.4.0] — 2026-09-10

Compatibility release for the current DeepSeek Harness line, and the DSH STORE
fixed-Commit contract (AI-Scarlett/DSH-Store#683).

### Added
- `config.providerNamespace` — the namespace for the ids registered on
  `ctx.subagents` (default `product-subagents`; `''` registers the bare keys).
- `dsh.compatibility` in `package.json`: the declared Node.js range, the DSH
  SemVer range, and `dshReleases` — a per-release `compatible` /
  `incompatible` / `unknown` verdict for every published `@deepseek-ai/dsh`
  release. DSH STORE reads this matrix from the pinned commit; a range alone is
  not installable evidence.
- `scripts/verify-dsh-profile.mjs` + `scripts/verify-plugin.mjs`: a
  disposable-profile acceptance run behind every `compatible` verdict. For one
  DSH release it creates a throwaway `$DSH_HOME`, installs the packed tarball
  with the real `dsh plugin add`, checks the composed profile tree, **boots**
  the profile with the verifier overlaid as a `--patch` layer (asserting the six
  tools are registered, the providers reached the real `SubagentRuntime`, and
  that `product_roles` / `product_agents` execute, schema-validate and carry no
  `undefined`), then uninstalls and asserts the bundle layer is gone. No API key
  needed; not part of `npm test`, which stays credential-free and CLI-free.
- `docs/COMPATIBILITY.md`: what each verdict means, how to reproduce one, what
  it does not prove, and how to keep the matrix current.

### Fixed
- **A profile that also loaded an official `@deepseek-ai/dsh-subagent-*` plugin
  could not boot at all.** This plugin registered its providers under the bare
  ids `claude-code`, `codex` and `acp` — the same ids
  `@deepseek-ai/dsh-subagent-claude-code` / `-codex` / `-acp` register under.
  `registerProvider` rejects a duplicate id, and that rejection fails the
  loader entry, so the whole profile's plugin tree went down with
  `a subagent provider named "claude-code" is already registered` — the harness,
  not just this plugin. Registrations are now namespaced into ids this plugin
  owns (`product-subagents:claude-code`), which is additive and never shadows or
  impersonates an official id; verified booting alongside the official
  claude-code and codex subagent plugins in one profile.

  Nothing in this plugin's own surface moved: roles, `config.providers` keys,
  the `product_delegate` `provider` argument and the durable session registry
  all still use the bare key. Only the provider names seen in the harness-wide
  `subagent` tool changed. `config.providerNamespace: ''` restores the old bare
  ids for a profile with no official product subagent plugin loaded.
- **Peer ranges excluded every DSH release after `0.1.0-rc.8`.**
  `^0.1.0-rc.6` is a prerelease-anchored caret: under SemVer a prerelease only
  satisfies a comparator sharing its exact `major.minor.patch` tuple, so
  `0.1.2-rc.1`, `0.1.3-alpha.2` and `0.1.5-alpha.*` all failed the range and
  installed with an unmet-peer warning. `@deepseek-ai/dsh-subagent` and
  `@deepseek-ai/dsh-tools` now enumerate every supported release line, and
  `@deepseek-ai/cordis` accepts `^4.0.1-rc.4` and up (dsh-tools requires
  `^4.0.2` since `0.1.2-rc.1`). The declared range now covers every installable
  DSH release from `0.0.1-rc.5` through `0.1.5-rc.1`, each verified
  individually — see [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).
- `listChildren()` diagnostic rows are no longer reported as children.
  The listing is a union: a `child` row carries `activity` / `mode` / `label`,
  while a `diagnostic` row carries only an id and a reason (its descriptor was
  unreadable or transiently unavailable). `product_agents` listed those rows as
  children with missing fields, and `subagent_progress` / `product_wait` could
  match one and report a fabricated status. All three now go through
  `lib/children.js` and see identity-bearing rows only.
- `CLAUDE.md` is a regular file instead of a symlink to `AGENTS.md`. The DSH
  STORE fixed-Commit contract requires ordinary files in the pinned source tree;
  the symlink deferred the 0.3.2 update with `package contains symbolic links`.
  Guidance still lives only in `AGENTS.md`.

### Changed
- The subagent provider now states every `SubagentCapabilities` key explicitly
  (`agentOptions`, `outputSchema` and `depthLimit` alongside `persona` and
  `toolFilter`) instead of leaving them to fall through as `undefined`, so a
  capability added upstream is a deliberate decision here. `agentOptions` is
  `false` on purpose: `model` / `reasoning_effort` are forwarded to the remote
  product CLI, never to a host Agent.

## [0.3.2] — 2026-09-09

### Fixed
- `subagent_progress` and `product_wait` no longer fail with
  `value is not lossless JSON` when polling an active `claude` product child.
  Both tools built their result from optional fold fields (`mode`, `label`,
  `turn`, `lastTask`, `trace`, `inFlight`, `stopReason`, ...) that are
  legitimately `undefined` whenever a child has no local session snapshot — the
  normal case for a `claude` child, whose events live in the remote CLI. The
  harness validates every tool result as strict lossless JSON, so a single
  `undefined` value threw on every poll, breaking watchable delegation. Results
  are now passed through a shared `stripUndefined` helper (`lib/lossless.js`)
  that recursively drops `undefined` keys/elements before returning.
- `product_agents` failed the same way: a listed child with no product binding
  (a plain subagent, or one whose binding was idle-disposed) left `product`,
  `mode` and `label` `undefined` in the children array, and an undetected
  provider left `auth`/`note` `undefined` in the availability view. Its result
  now goes through the same `stripUndefined` helper.

Thanks to @kaiomp for the report and the fix (#4, #5).

## [0.3.1] — 2026-08-17

### Added
- Declare `dsh.bundle` in `package.json` and ship a `cordis.patch.yml` bundle
  patch. `dsh plugin --profile <name> add dsh-plugin-product-subagents` now
  automatically wires the plugin as a profile layer — no manual
  `cordis.patch.yml` editing required, and the "declares no dsh.bundle"
  warning is gone.

### Changed
- README (EN + zh): the recommended install method is now
  `dsh plugin --profile web add dsh-plugin-product-subagents`. The manual
  fallback switched from `npm i` to `pnpm add` with an explanation of why npm
  breaks the harness singleton (it auto-installs peer dependencies, shadowing
  the host's `@deepseek-ai/dsh-tools` symlink — the same root cause as #3).

### Notes
- Issue #3's code fix shipped in 0.3.0 (dsh-tools moved to `peerDependencies`),
  but `dsh plugin add` still resolved to 0.2.0 on machines running pnpm 11:
  pnpm 11 enables `minimumReleaseAge` by default, and 0.3.0 was too new to
  pass the age gate, so pnpm fell back to 0.2.0 (which has dsh-tools in
  `dependencies` and reproduces the crash). Once 0.3.0+ ages past the
  threshold the problem disappears; until then, pin explicitly with
  `dsh plugin --profile web add dsh-plugin-product-subagents@0.3.0`.

## [0.3.0] — 2026-08-17

### Fixed
- Windows: `winArgs()` wraps the whole `cmd /S /C` invocation in one outer
  pair of quotes, so `/S` strips exactly that pair instead of the command's
  own quotes. `product_delegate` (claude-code / codex) no longer fails with
  `'claude" -p ...' is not recognized` (fixes #1).
- Move `@deepseek-ai/dsh-tools` from `dependencies` to `peerDependencies`: the
  harness core package must share a singleton with the host, and a second
  pnpm-installed copy in the profile shadowed the symlink and crashed every
  tool call with `Cannot read properties of undefined (reading 'prepare')`
  (fixes #3).

## [0.2.0] — 2026-08-13

Open-source release restructuring.

### Added
- Standalone npm package (`dsh-plugin-product-subagents`), MIT licensed.
- Unit test suite (`node --test`) with a fake bridge; no product CLIs needed.
- GitHub Actions CI matrix (macOS / Ubuntu / Windows).
- Config validation (`zod`) for `providers`, roles, and plugin config.
- Bilingual README (EN + zh), CONTRIBUTING, SECURITY, ARCHITECTURE docs.
- Split `lib/index.js` into `lib/tools/*` (one module per tool).

## [0.1.0]

### Added
- Config-driven provider registry: built-in `claude-code`, `codex`, `acp` plus
  custom ACP agents via `config.providers` (e.g. `agent acp`, `cbc --acp`,
  `gemini --acp`).
- Declarative role library (`roles/*.json`): `general` (default, full
  permissions, may delegate), `code-review` (readonly), `explore` (readonly,
  never delegates), `debug` (default). Delegation defaults ON; `false` bans it.
- Role-based product permissions (`readonly` / `default` / `full`) mapped to
  each product's own CLI flags; the relay model is always a read-only pipe.
- Delegation permission ceiling: a child cannot spawn a descendant with more
  permission than it has.
- Continuable children with durable session recovery (registry file +
  session-log markers), idle disposal of remote sessions, configurable
  per-product timeouts, and a concurrency cap.
- Tools: `product_delegate`, `product_roles`, `product_submit`,
  `subagent_progress`, `product_wait`, `product_agents`.
- Cross-platform process launching (Windows `.cmd` shims via `cmd.exe`),
  Windows-safe path escaping, `fileURLToPath` for module paths.

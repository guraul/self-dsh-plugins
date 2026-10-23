# Changelog

All notable changes to this project are documented in this file.

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
  2 s) and a closed turn plus a folded answer (`endedAt` + `lastAnswer`) also
  completes the wait. Whichever signal lands first wins.

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
- `foldProgress` exposes `endedAt` (timestamp of the last `turn/end`).

### Tests
- New `test/product-wait.test.js`: six timing cases against a fake ctx and fake
  sessions (event before subscribe, event after subscribe, log-only completion,
  nothing at all, already-inactive child, pre-aborted signal) — offline, no
  credentials.

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

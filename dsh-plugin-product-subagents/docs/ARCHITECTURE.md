# Architecture

This plugin is a DeepSeek Harness (Cordis) plugin that turns external
agent CLIs (Claude Code, Codex, any ACP agent) into **continuable product
subagents** with a role-based permission model.

## Big picture

```
                ┌────────────────────────────────────────────────┐
                │            dsh-plugin-product-subagents         │
                │                                                │
  root session  │  product_delegate ──► harness continuation ──► │
  (the model)   │                        manager (in-process     │
      │         │                        child = relay model)    │
      │ report  │        ┌──────────────┐  product_submit        │
      │◄────────┤        │ relay model  │───────────────────────►│  bridge
      │         │        │ (deepseek,   │   task text + settings │  (claude/
      │         │        │  read-only   │                        │   codex/
      │         │        │  pipe)       │◄───────────────────────┤   acp)
      │         │        └──────────────┘   answer + markers      │
      └─────────┴────────────────────────────────────────────────┘
                     child session ◄─binding──► remote session
```

- **The relay model is always a read-only pipe.** Its toolFilter only ever
  contains `product_submit` (plus `product_delegate` when the role allows
  delegation). It never receives write-capable tools. All real work happens
  in the remote product.
- **The relay may not answer on its own.** A restricted toolset does not
  restrict output, so the relay composition also carries a fixed contract and
  `product_submit` stamps every result; `product_wait` rejects an unstamped
  answer (see "Relay output contract" below).
- **Permissions are for the remote product.** `permissionMode` per role maps
  to the product's own CLI flags (`readonly` / `default` / `full`).
- **Permissions inherit down the delegation tree.** A child cannot spawn a
  descendant with more permission than it has.

## Bridge interface

Every product is one bridge module in `lib/bridges/` implementing:

```ts
interface Bridge {
  create(cwd): Promise<Remote>                       // start a fresh remote session
  submit(remote, task, signal, cwd, settings): Promise<{ text, stopReason }>
  reconnect(sessionId, cwd): Promise<Remote>         // resume a persisted session
  dispose(remote): Promise<void>                     // release the remote session
}
```

`settings` carries `{ model?, reasoningEffort?, permissionMode? }`. The
permission flags are translated per product inside the bridge.

**Adding a product** = add a bridge + register it in `lib/providers.js`
(built-in) or declare it via `config.providers` (any ACP CLI, no code).

### Provider ids are namespaced

A provider key (`claude-code`, `codex`, `acp`, or any `config.providers` key)
is the plugin's own vocabulary: roles pin it, `product_delegate` takes it, and
the durable binding/registry records it, so a recovered child always finds the
bridge it started on.

It is NOT what gets registered on `ctx.subagents`. Those keys are also the ids
the official `@deepseek-ai/dsh-subagent-claude-code` / `-codex` / `-acp`
plugins register under, and `registerProvider` rejects a duplicate name —
a rejection that fails the whole loader entry and takes the profile's plugin
tree down at boot. So every registration goes out namespaced
(`product-subagents:claude-code`, see `runtimeProviderName` in
`lib/providers.js`), which is additive: it never shadows or impersonates an
official id, and both plugins can be loaded in one profile.

`config.providerNamespace` overrides the namespace; `''` registers the bare
keys, which is only safe on a profile with no official product subagent
plugins.

## Session continuity

A child's remote session id is captured at the earliest possible moment and
durably recorded:

1. **in-memory binding** (child session id → remote handle) — fast path
2. **durable registry file** (`registryPath`, default
   `~/.dsh/product-subagents-registry.json`) — survives idle disposal and
   restarts; written as soon as the remote id is known
3. **session-log marker** (`PRODUCT_SESSION:<product>:<id>` in product_submit
   results) — last-resort fallback

Idle disposal releases a settled child's remote session after
`idleTimeoutMs`; reuse cancels the pending release.

## Relay output contract (fail-closed)

Restricting the relay's toolset does not restrict its *output*: with only
`product_submit` mounted, the relay could still answer the task itself — and
when the remote failed it did, replying with the text the task said it expected
(issue #42). A well-formed fake is indistinguishable from a real answer unless
the transport says which is which, so the contract is enforced twice.

**1. Prompt (`lib/relay-contract.js`)**

`RELAY_CONTRACT_TEXT` is one fixed block: the only action is `product_submit`;
a submit error must be reported verbatim as `RELAY_FAILED: <error>` and end the
turn; a successful return value must be echoed character for character,
including its trailing tag; nothing else may appear in the final answer.

- `lib/relay.js` registers it as the system section `product-relay:contract`
  through the caller-bound `ctx.systemPrompt.section(...)`. Registration happens
  in the `product-relay` preset's scope (the preset tree is mounted under
  `createScope()` in `dsh-agent-preset-registry`), and a child joins that scope
  as its parent — so every relay child inherits the section and the root agent
  never sees it. No harness change, no global section.
- `buildRelayPrompt()` (lib/tools/product-delegate.js) repeats the same text in
  the relay prompt. That is the fallback for a profile without a `systemPrompt`
  service, and it keeps the contract in the same message as the task.

**2. Machine tag (`product_submit` → `verifyRelayAnswer`)**

`product_submit` appends `<!--product-session:<remoteId>-->` to every successful
result, next to the `PRODUCT_SESSION:<product>:<id>` recovery marker. The id is
the one the binding already holds (`remote.sessionId || remote.threadId`, else
the child session id) — no extra request. Only this tool can mint the tag.

`product_wait` runs `verifyRelayAnswer()` on the child's final text:

| Final text | Result |
|---|---|
| starts with `RELAY_FAILED:` | `status: "failed"`, `failure` = the reported error, no `answer` |
| no tag | `status: "failed"` (`unverifiable origin`), no `answer` — the rejected text is never returned |
| tag present | body with the tag stripped, `status` unchanged |

Non-terminal statuses (`timeout` / `aborted` / `unknown`) keep their meaning; an
unverifiable answer read from the log is withheld rather than returned.
`foldProgress().lastAnswer` strips the tag as well, so it never shows up in
`subagent_progress`, which also sees the relay's text.

Deliberately out of scope: the activation settlement notice DSH itself delivers
to the parent (`delivery: 'parent'`) is harness-owned text and cannot be
rewritten here. Verification covers every answer this plugin returns.

## Role system

`roles/*.json` (or `config.rolesDir`):

```json
{
  "id": "code-review",
  "description": "…",
  "provider": "claude-code",
  "permissionMode": "readonly",
  "allowDelegation": true,
  "instructions": "… (sent to the remote product)"
}
```

- `allowDelegation` defaults **ON**; `false` bans it (e.g. `explore`).
- `permissionMode` ordering: `readonly < default < full`.
- Unknown role ids fall back to `general`.

## Tools

| Tool | Purpose |
|---|---|
| `product_delegate` | role-aware delegation (one-shot sync / continuable async) |
| `product_roles` | list the role library |
| `product_submit` | per-child bridge (children only) |
| `subagent_progress` | status + internal trace + token usage of one child |
| `product_wait` | attach to a child and block until it settles |
| `product_agents` | provider availability + live children |

## Lifecycle

- Providers are registered only for CLIs detected on PATH.
- `subagent/end` → decrement the concurrency counter and schedule idle
  disposal; `product_submit` reuse cancels it.
- Plugin teardown disposes every live remote session.

## Cross-platform

CLI launches go through `lib/run.js` `spawnProduct`/`spawnSyncProduct`, which
on Windows run `.cmd` shims through `cmd.exe /d /s /c` with verbatim args and
quote any arg containing spaces or cmd metacharacters. Paths use `join()` and
`fileURLToPath`. The CI matrix (macOS / Ubuntu / Windows × Node 18/20/22)
runs the test suite on all platforms.

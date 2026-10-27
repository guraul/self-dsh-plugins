import { defineTool } from '@deepseek-ai/dsh-tools'
import { checkDelegationPermission, PERM_RANK } from '../permission-gate.js'
import { providerPersona } from '../providers.js'
import { RELAY_CONTRACT_TEXT } from '../relay-contract.js'
import { parentCwd } from '../run.js'

/** Permission ordering for the delegation ceiling (single source: lib/permission-gate.js). */
export { PERM_RANK }

/**
 * Build the prompt of the LOCAL relay child (DSH 0.2.1+).
 *
 * The child is a local DSH agent that mounts only `product_submit`
 * (lib/relay-preset.js). Its job is to hand the remote product the text
 * verbatim — nothing else. `role.instructions` are addressed to the REMOTE
 * product agent (e.g. "You have full file, command and permission access —
 * do not ask for permission"), so they are delimited as such: a local child
 * that reads them as its own brief concludes it may act locally, which is
 * exactly the failure mode of issue #8.
 *
 * @param {string} provider plugin provider key (`claude-code` / `codex` / `acp`).
 * @param {object} providerDef the provider definition (command/type).
 * @param {string} remoteText role instructions + task, addressed to the remote.
 * @returns {string} the relay child's prompt.
 */
export function buildRelayPrompt(provider, providerDef, remoteText) {
  return [
    providerPersona(provider, providerDef),
    '',
    'You are a relay. Your ONLY tool is `product_submit`. Call it exactly once, passing the text between the markers below VERBATIM, then return its answer unchanged. Do not run commands, do not read or write files: the remote product agent owns the workspace and the permissions.',
    '',
    // Same rules as the preset's system section (lib/relay-contract.js). The
    // system section is the primary injection; this copy is the fallback, and
    // it is also what makes the contract survive an unavailable systemPrompt
    // service. Issue #42: without it the relay answered on its own when the
    // remote product failed, producing a fake but well-formed answer.
    RELAY_CONTRACT_TEXT,
    '',
    '---- BEGIN TEXT ADDRESSED TO THE REMOTE PRODUCT AGENT (not to you) ----',
    remoteText,
    '---- END TEXT ADDRESSED TO THE REMOTE PRODUCT AGENT ----',
  ].join('\n')
}

/**
 * Pick the child-start call supported by the mounted `@deepseek-ai/dsh-subagent`
 * service and normalise it to one signature.
 *
 * - DSH `0.2.1` renamed the service-level `startContinuable` to
 *   `startActivation`, which additionally requires `delivery`.
 * - The `0.2.0` line only has `startContinuable`.
 *
 * Feature detection beats a version comparison here: a patched runtime keeps
 * working, and a future rename fails loudly at delegation time (see the throw)
 * instead of silently doing nothing. This function is exported because the
 * rename is exactly the regression a unit test must catch — see
 * `test/delegate-start.test.js`.
 *
 * @param {any} service the `ctx.subagents` service.
 * @returns {{ kind: 'activation' | 'continuable', start: (spec: any) => Promise<any> }}
 */
export function pickStart(service) {
  if (service && typeof service.startActivation === 'function') {
    return {
      kind: 'activation',
      start: (spec) => service.startActivation({ ...spec, delivery: 'parent' }),
    }
  }
  if (service && typeof service.startContinuable === 'function') {
    return { kind: 'continuable', start: (spec) => service.startContinuable(spec) }
  }
  throw new Error(
    'product_delegate: the mounted @deepseek-ai/dsh-subagent service exposes neither startActivation (DSH >= 0.2.1) nor startContinuable (DSH 0.2.0 line); this plugin cannot delegate on this DSH release',
  )
}

/**
 * The delegation tool: role-aware sync one-shot or async continuable. The
 * role decides the REMOTE product's permissions, whether the child may
 * delegate, and its extra instructions; the relay model stays a read-only
 * pipe in every case. Delegation enforces a permission ceiling: a product
 * child may never spawn a descendant with more permission than it has.
 */
export function registerProductDelegate(ctx, deps) {
  const {
    bindings, bridges, availability, providers, roles,
    state, maxConcurrent, availableProviders, runtimeName,
    relayPreset, maxDelegationDepth,
  } = deps
  const roleIds = roles.list().map((r) => r.id)

  ctx.tools.register(defineTool({
    name: 'product_delegate',
    description: 'Delegate task work to a configured product CLI (Claude Code / Codex / any ACP agent) under a declared role. background=true (default) starts a durable continuable child — control it with send_message / list_agents / interrupt_agent / subagent_progress, and it can be resumed with more context after settling. background=false runs one-shot synchronously and returns the final answer now. The chosen product and its remote session are pinned for the child\'s lifetime. The role decides the REMOTE product\'s permissions (readonly/default/full), whether the child may spawn its own subagents, and its extra instructions; the relay model stays a read-only pipe in every case.',
    parameters: {
      role: {
        type: 'string',
        enum: roleIds.length ? roleIds : ['general'],
        description: 'Role from the declarative role library (product_roles lists them). Defaults to "general" (full product permissions, may delegate).',
      },
      provider: {
        type: 'string',
        enum: availableProviders.length ? availableProviders : ['codex', 'claude-code', 'acp'],
        description: 'Product CLI to use. Defaults to the role\'s provider; required when the role does not pin one (only detected agents are registered).',
      },
      task: { type: 'string', required: true, description: 'The task text for the product agent.' },
      model: { type: 'string', description: 'Product model override. Omit to inherit the product\'s own default model configuration (claude-code: --model, codex: -c model=). ACP uses the agent\'s own configuration.' },
      reasoning_effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Product reasoning effort. Omit to inherit the product\'s own default (claude-code: --effort, codex: -c model_reasoning_effort=). ACP uses the agent\'s own configuration.' },
      background: { type: 'boolean', default: true, description: 'false = run one-shot synchronously and return the final answer now.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          childId: { type: 'string', description: 'continuable child session id (background mode).' },
          output: { type: 'string', description: 'final answer (one-shot mode).' },
          stopReason: { type: 'string', description: 'one-shot stop reason.' },
          role: { type: 'string', description: 'resolved role id.' },
          permissionMode: { type: 'string', description: 'resolved product permission mode.' },
        },
      },
      render: (_args, value) => {
        if (value.childId) return [{ type: 'text', text: `started product subagent ${value.childId} (role ${value.role})` }]
        return [{ type: 'text', text: value.output }]
      },
    },
    async execute(args, exec) {
      const parent = exec.agent
      const role = roles.get(args.role || 'general')
      if (!role) throw new Error(`product_delegate: unknown role "${args.role}" and no general fallback`)
      const provider = args.provider || role.provider
      if (!provider) throw new Error(`product_delegate: no provider — pass provider or set it on role "${role.id}"`)
      const detected = availability[provider]
      if (!detected || !detected.registered) {
        throw new Error(`product agent "${provider}" is not available${detected ? `: ${detected.reason}` : ''}`)
      }
      const bridge = bridges[provider]
      // Delegation permission ceiling: permissions inherit DOWN the
      // delegation tree. A product child (a continuable subagent with a live
      // binding) may never grant a descendant MORE permission than it has
      // itself — otherwise a read-only child could escape its restriction by
      // spawning a full-permission grandchild. `readonly < default < full`.
      const callerRecord = parent ? bindings.get(parent.session.id) : undefined
      // 天花板只在调用方**已声明**权限时生效（见 lib/permission-gate.js：#58）
      const gate = checkDelegationPermission(callerRecord, role.permissionMode)
      if (!gate.ok) {
        throw new Error(
          `product_delegate: permission escalation blocked — this subagent's permissionMode is "${gate.callerMode}" and cannot spawn a "${gate.requestedMode}" descendant. The delegating parent must grant the needed permission in the first place.`,
        )
      }
      const settings = { permissionMode: role.permissionMode }
      if (args.model) settings.model = args.model
      if (args.reasoning_effort) settings.reasoningEffort = args.reasoning_effort
      // role instructions are sent to the REMOTE product; the relay pipe
      // persona is fixed and never includes write-capable tools.
      const task = role.instructions ? `${role.instructions}\n\n${args.task}` : args.task
      if (args.background === false) {
        const cwd = parentCwd(parent)
        const remote = await bridge.create(cwd)
        try {
          const out = await bridge.submit(remote, task, exec.signal, cwd, settings)
          await bridge.dispose(remote).catch(() => {})
          return { output: out.text, stopReason: out.stopReason, role: role.id, permissionMode: role.permissionMode }
        } catch (error) {
          await bridge.dispose(remote).catch(() => {})
          throw error
        }
      }
      if (state.activeChildren >= maxConcurrent) {
        throw new Error(`product_delegate: concurrency limit reached (${maxConcurrent} active children). Wait for a subagent to settle (subagent_progress / product_wait) or raise maxConcurrentChildren.`)
      }
      // The relay is ALWAYS a read-only pipe: product_submit only, plus
      // product_delegate exactly when the role allows delegation. No
      // write-capable tool is ever exposed to the relay model.
      const allow = role.allowDelegation ? ['product_submit', 'product_delegate'] : ['product_submit']
      const label = `${role.id}: ${args.task.slice(0, 50)}`
      // Feature-detect the service call instead of branching on a DSH version
      // string (see pickStart below): 0.2.0-rc.x keeps the continuable relay
      // child, 0.2.1+ delegates through one activation.
      const picked = pickStart(ctx.subagents)
      let start
      if (picked.kind === 'activation') {
        // DSH 0.2.1 removed `persona` / `toolFilter` from the start request and
        // builds a local child's composition from `agentPreset` alone. Without a
        // preset the child inherits the parent's whole toolset and can silently
        // run the task locally instead of handing it to the product CLI
        // (issue #8). Refuse loudly rather than degrade silently.
        const presetId = typeof relayPreset === 'function' ? await relayPreset() : undefined
        if (presetId === undefined) {
          throw new Error(
            'product_delegate: refusing to start an unrestricted local subagent — on DSH >= 0.2.1 a delegated child is restricted only through an agent preset, and this profile exposes no agentPresets service (or the product-relay preset failed to register). Mount @deepseek-ai/dsh-agent-preset-registry, or delegate with background:false, which runs the product CLI directly and creates no local child.',
          )
        }
        start = await picked.start({
          // the id this plugin registered on ctx.subagents; `provider` stays the
          // plugin's own key everywhere the caller and the roles can see it
          provider: runtimeName(provider),
          label,
          request: {
            prompt: [{ type: 'text', text: buildRelayPrompt(provider, providers[provider], task) }],
            parent,
            agentPreset: presetId,
            // The provider advertises `depthLimit`, so DSH enforces this cap.
            maxDepth: maxDelegationDepth,
          },
          signal: exec.signal,
        })
      } else {
        start = await picked.start({
          provider: runtimeName(provider),
          label,
          request: {
            prompt: [{ type: 'text', text: task }],
            parent,
            persona: providerPersona(provider, providers[provider]) + (role.allowDelegation
              ? ' You MAY delegate subtasks to your own subagents via product_delegate (choose an appropriate role) and integrate the answers.'
              : ''),
            toolFilter: { allow },
          },
          signal: exec.signal,
        })
      }
      state.activeChildren += 1
      const record = bindings.get(start.childId)
      if (record) {
        record.settings = settings
        // `startActivation()` resolves to `{ childId, result, dispose }` and
        // `result` settles exactly when this activation ends. `product_wait`
        // awaits it — events and session logs are not reachable from here on
        // this DSH line (issue #40). The extra catch only suppresses an
        // unhandled rejection when nobody waits; `product_wait` still observes
        // the real rejection on the original promise.
        const settle = start && start.result
        if (settle !== undefined && typeof settle.then === 'function') {
          settle.catch(() => {})
          record.settle = settle
        }
      }
      return { childId: start.childId, role: role.id, permissionMode: role.permissionMode }
    },
  }))
}

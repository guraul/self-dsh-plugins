import { defineTool } from '@deepseek-ai/dsh-tools'
import { productSessionTag } from '../relay-contract.js'

/**
 * The per-child bridge tool: continuable children submit task work to their
 * bound remote product session. Only children with a binding (created by
 * product_delegate) can call it; recovery reconnects a lost session from the
 * durable registry or the child's own log.
 *
 * The tool is built from `deps` instead of closing over the parent plugin
 * instance, because on DSH 0.2.1+ the same tool is registered twice:
 *
 *  - in the parent context, as one of the six model-facing tools, and
 *  - inside a relay child's limited composition (lib/relay.js), where it is
 *    the child's ONLY tool. That child mounts an agent preset containing just
 *    the relay entry, so it cannot touch local files or commands and must
 *    forward the work to the remote product.
 *
 * `bindings` is a module-level singleton (lib/bindings.js), so both
 * registrations observe the same child→remote map.
 */
export function createProductSubmitTool(deps) {
  const { bindings, MARKER, recoverRemoteSessionId, bridges, registry, persistRemote, cancelDispose } = deps
  return defineTool({
    name: 'product_submit',
    description: 'Submit one task to the persistent remote product session bound to this agent (Codex / Claude Code / ACP CLI) and return the product agent\'s answer. The remote session remembers the full conversation, so later submissions continue it. Use this for all task work while you are a product subagent.',
    parameters: {
      task: { type: 'string', required: true, description: 'The task text to send to the remote product agent.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const agent = exec && exec.agent
      if (!agent || !agent.session) throw new Error('product_submit requires a calling agent session')
      const childSessionId = agent.session.id
      // This child is being used again — cancel any pending idle disposal so a
      // fast continuation never pays a reconnect.
      if (typeof cancelDispose === 'function') cancelDispose(childSessionId)
      let record = bindings.get(childSessionId)
      if (!record) {
        // The binding is gone (idle disposal or restart). Recovery order:
        // 1) the durable registry (reliable — written when the remote id was
        //    first known), 2) the child's own session log (marker fallback).
        const cwd = (agent.session.header && agent.session.header.cwd) || process.cwd()
        const persisted = registry.get(childSessionId)
        const recovered = persisted && bridges[persisted.product]
          ? { product: persisted.product, sessionId: persisted.remoteId }
          : recoverRemoteSessionId(agent.session)
        const bridge = recovered ? bridges[recovered.product] : undefined
        if (!bridge) throw new Error('product_submit: no remote product session is bound to this agent (recovery failed)')
        const remote = await bridge.reconnect(recovered.sessionId, cwd)
        record = { product: recovered.product, bridge, remote, settings: undefined }
        bindings.set(childSessionId, record)
      }
      const cwd = (agent.session.header && agent.session.header.cwd) || process.cwd()
      try {
        const out = await record.bridge.submit(record.remote, args.task, exec.signal, cwd, record.settings)
        const remoteId = record.remote.sessionId || record.remote.threadId
        const marker = remoteId ? `${MARKER}${record.product}:${remoteId}` : ''
        // Two markers with different jobs:
        //  - `PRODUCT_SESSION:<product>:<id>` names the product too, and is what
        //    `recoverRemoteSessionId` scans the child's log for.
        //  - the HTML tag is the machine receipt `verifyRelayAnswer` requires in
        //    the relay's final answer: it can only come from this return value,
        //    so an answer the relay wrote on its own never carries one (#42).
        //    It falls back to the child session id — the binding key, unique per
        //    child — when the bridge has not exposed a remote id yet.
        const tag = productSessionTag(remoteId || childSessionId)
        const text = [`${out.text}`, marker, tag].filter(Boolean).join('\n')
        return { text }
      } finally {
        // Persist the remote id whenever it becomes known (after a successful
        // submit, or after the claude bridge recovered it from disk on a
        // failed/interrupted submit).
        if (typeof persistRemote === 'function') persistRemote(childSessionId, record, cwd)
      }
    },
  })
}

/** Register `product_submit` in the current context (the parent plugin). */
export function registerProductSubmit(ctx, deps) {
  ctx.tools.register(createProductSubmitTool(deps))
}

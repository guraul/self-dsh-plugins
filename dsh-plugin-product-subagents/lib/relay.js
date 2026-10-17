import { bindings, MARKER, recoverRemoteSessionId } from './bindings.js'
import { buildBridgeSet } from './bridge-set.js'
import { validateConfig } from './config.js'
import { createRegistry } from './registry.js'
import { createProductSubmitTool } from './tools/product-submit.js'

/**
 * Relay child entry — the ONLY plugin mounted by the `product-relay` agent
 * preset (see lib/relay-preset.js).
 *
 * DSH 0.2.1 removed `persona` and `toolFilter` from `SubagentStartRequest` and
 * builds a local child's composition from `agentPreset` alone
 * (`dsh-subagent/lib/index.js`: `composition: { agentPreset: request.agentPreset }`).
 * A plugin that used to restrict a continuable child with
 * `toolFilter: { allow: ['product_submit'] }` therefore has exactly one
 * sanctioned replacement: mount a preset whose composition contains only the
 * relay tooling. This module is that tooling.
 *
 * The child gets `product_submit` and nothing else: no bash, no read/write/
 * edit, no glob/grep. It cannot run the task itself, so the work necessarily
 * goes to the remote product CLI through the bridge — which is the whole
 * point of the read-only-relay design.
 *
 * `bindings` is a module-level singleton (`lib/bindings.js`), so this entry —
 * loaded as a separate plugin instance inside the child context — sees the
 * binding the parent's provider created in `prepareContinuable`.
 */

export const name = 'product-relay'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const cfg = validateConfig(config)
  const { bridges } = buildBridgeSet(cfg)
  const registry = createRegistry(cfg.registryPath)

  const persistRemote = (childId, record, cwd) => {
    const remoteId = record && record.remote && (record.remote.sessionId || record.remote.threadId)
    if (!remoteId) return
    registry.set(childId, { product: record.product, remoteId, cwd })
  }

  ctx.tools.register(createProductSubmitTool({
    bindings,
    MARKER,
    recoverRemoteSessionId,
    bridges,
    registry,
    persistRemote,
    // The relay has no idle-disposal timers of its own; the parent owns them.
    cancelDispose: () => {},
  }))
}

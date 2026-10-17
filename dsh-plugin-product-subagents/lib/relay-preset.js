/**
 * Register the `product-relay` agent preset that gives a delegated child a
 * relay-only composition.
 *
 * Why this exists: DSH 0.2.1 removed `persona` / `toolFilter` from
 * `SubagentStartRequest` and forwards only `agentPreset` into a local child's
 * composition. Without a preset the child inherits the parent's full toolset
 * (bash / read / write / edit / …) and can silently do the work locally
 * instead of handing it to the remote product CLI. Mounting this preset makes
 * the child's composition contain exactly one tool: `product_submit`.
 *
 * The preset is registered programmatically (`ctx.agentPresets.register`) so a
 * profile needs nothing but this plugin. Registration is async; `ready`
 * resolves to the preset id (or `undefined` when the profile exposes no
 * `agentPresets` service), and the delegation path refuses to start an
 * unrestricted child instead of degrading silently.
 */

/** Stable id used by the delegation path. */
export const RELAY_PRESET_ID = 'product-relay'

/** Module specifier the loader imports inside the child context. */
export const RELAY_ENTRY = 'dsh-plugin-product-subagents/lib/relay.js'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} cfg validated plugin config (only plain JSON is forwarded).
 * @returns {{ ready: Promise<string | undefined> }}
 */
export function registerRelayPreset(ctx, cfg) {
  const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
  if (!presets || typeof presets.register !== 'function') {
    // 0.2.0 line, or a profile without @deepseek-ai/dsh-agent-preset-registry.
    // The delegation path checks `ready` and refuses background delegation.
    return { ready: Promise.resolve(undefined) }
  }

  const state = { dispose: undefined, disposed: false }
  const ready = Promise.resolve(presets.register({
    id: RELAY_PRESET_ID,
    name: 'Product relay',
    description: 'Relay-only composition for delegated product subagents: mounts product_submit and nothing else, so the child cannot run the task locally.',
    order: 90,
    plugins: [{
      id: 'product-relay-tools',
      name: RELAY_ENTRY,
      config: {
        providers: cfg.providers,
        registryPath: cfg.registryPath,
      },
    }],
  })).then((dispose) => {
    if (state.disposed) {
      if (typeof dispose === 'function') void dispose()
      return undefined
    }
    state.dispose = dispose
    return RELAY_PRESET_ID
  })

  ctx.effect(() => () => {
    state.disposed = true
    if (typeof state.dispose === 'function') void state.dispose()
  })

  return { ready }
}

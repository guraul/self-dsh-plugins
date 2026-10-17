import { detectAvailability } from './availability.js'
import { buildProviders, createBridgeFor } from './providers.js'

/**
 * Build the detected provider set and one bridge per detected product.
 *
 * Extracted so the parent plugin (lib/index.js) and the relay child entry
 * (lib/relay.js) construct exactly the same bridges, and so the relay's
 * recovery path can reconnect to a remote session the parent created.
 *
 * @param {object} config validated plugin config.
 * @returns {{ providers: object, availability: object, bridges: object }}
 */
export function buildBridgeSet(config = {}) {
  const providers = buildProviders(config)
  const availability = detectAvailability(providers)
  const bridges = Object.fromEntries(
    Object.entries(providers)
      .filter(([name]) => availability[name].registered)
      .map(([name, def]) => [name, createBridgeFor(def)]),
  )
  return { providers, availability, bridges }
}

// dsh-usage-panel · Client entry (web plugin `./client` export).
// Registered into the DSH browser module loader via scripts/wrap-client.mjs;
// exports.apply + exports.inject are the loader contract. The settings page
// label is a thunk so the settings list re-reads the active language; locale
// switches re-render through the i18n subscription wired to 'locale/change'.
import { createElement } from 'react'
import type { ClientCtx } from './ctx.ts'
import { createI18n } from './locales.ts'
import { CSS, STYLE_ID } from './styles.ts'
import { StatsSection } from './StatsSection.tsx'
import { Boundary } from './boundary.tsx'

export const inject = ['slots', 'connection', 'locale']

export function apply(ctx: ClientCtx): void {
  // Own stylesheet, removed with this fiber (HMR-safe: skip if present).
  let tag: HTMLStyleElement | null = null
  if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') === null) {
    tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-usage-panel'
    tag.dataset.pluginCss = STYLE_ID
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  const i18n = createI18n(ctx.locale)
  // Backup wiring: the runtime's own subscribe (inside createI18n) already
  // covers switches; ctx.on is cordis-standard for the 'locale/change' event.
  const disposeLocaleEvent = ctx.on ? ctx.on('locale/change', () => i18n.update()) : null

  const slots = ctx.slots
  slots.inject('settings.section', () =>
    slots.register(
      {
        name: 'settings.section',
        id: 'usage-stats',
        order: 25,
        label: () => i18n.t('nav.label'),
      },
      () => createElement(Boundary, { i18n }, createElement(StatsSection, { rpc: ctx.connection.rpc, i18n })),
    ),
  )

  ctx.effect(() => () => {
    if (tag !== null && tag.isConnected) tag.remove()
    if (disposeLocaleEvent) disposeLocaleEvent()
    i18n.dispose()
  })
}

// dsh-usage-panel · subagent executor rollup card (issue #129).
// One row per external executor (opencode / codebuddy / acp / unknown), showing
// the summed REAL token spend of every subagent it ran. Rows without an
// external record contribute nothing and are excluded upstream.
import type { SubagentItem } from '../../shared/contract.ts'
import { fmtTokens } from '../../shared/format.ts'
import type { I18n } from '../locales.ts'
import { aggregateByExecutor } from '../subagent-providers.ts'
import * as React from 'react'

interface SubagentProvidersCardProps {
  items: SubagentItem[]
  i18n: I18n
}

export function SubagentProvidersCard({ items, i18n }: SubagentProvidersCardProps): JSX.Element | null {
  const t = i18n.t
  const locale = i18n.locale
  const rows = aggregateByExecutor(items)
  if (!rows.length) return null
  const top = Math.max(1, rows[0]!.totals.total)
  const grand = rows.reduce((sum, row) => sum + row.totals.total, 0)
  return (
    <div className="dsw-ust-card">
      <div className="dsw-ust-card-head">
        <div className="dsw-ust-card-title">
          <h3>{t('subagentProviders.title')}</h3>
          <span className="dsw-ust-card-sub">{t('subagentProviders.sub')}</span>
        </div>
      </div>
      {rows.map((row) => {
        const share = grand > 0 ? Math.round((row.totals.total / grand) * 100) : 0
        const detail =
          t('subagentProviders.detail', {
            sessions: row.sessions,
            calls: row.calls,
            input: fmtTokens(row.totals.input, locale),
            output: fmtTokens(row.totals.output, locale),
            cacheRead: fmtTokens(row.totals.cacheRead, locale),
          })
        return (
          <div key={row.executor} className="dsw-ust-prow" title={detail}>
            <span className="dsw-ust-pname">{row.executor}</span>
            <div className="dsw-ust-pbar">
              <i style={{ width: Math.max(2, Math.round((row.totals.total / top) * 100)) + '%', background: '#4f8cff' }} />
            </div>
            <span className="dsw-ust-ptokens">
              {fmtTokens(row.totals.total, locale)} · {share}%
            </span>
          </div>
        )
      })}
    </div>
  )
}

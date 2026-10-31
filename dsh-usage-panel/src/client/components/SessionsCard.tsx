// dsh-usage-panel · session drill-down card (P0-④).
// Top sessions by all-time usage, with titles folded from session/title
// (zero extra log reads in scan mode; per-session readTitle in projection
// mode, only for the ranked top-10).
import type { SessionSummary } from '../../shared/contract.ts'
import { fmtTokens } from '../../shared/format.ts'
import type { I18n } from '../locales.ts'
import type { SessionRollup } from '../session-rollup.ts'
import * as React from 'react'

interface SessionsCardProps {
  sessions: SessionSummary[]
  i18n: I18n
  /** Root session id → summed descendant subagent spend (issue #130). */
  rollups?: Map<string, SessionRollup>
}

export function SessionsCard({ sessions, i18n, rollups }: SessionsCardProps): JSX.Element {
  const t = i18n.t
  const locale = i18n.locale
  if (!sessions.length) return <div />
  return (
    <div className="dsw-ust-card">
      <div className="dsw-ust-card-head">
        <div className="dsw-ust-card-title">
          <h3>{t('sessions.title')}</h3>
          <span className="dsw-ust-card-sub">{t('sessions.sub')}</span>
        </div>
      </div>
      {sessions.map((s, i) => {
        const d = new Date(s.lastActive)
        const date =
          d.getUTCFullYear() +
          '-' +
          String(d.getUTCMonth() + 1).padStart(2, '0') +
          '-' +
          String(d.getUTCDate()).padStart(2, '0')
        return (
          <div key={s.id} className="dsw-ust-srow">
            <span className="dsw-ust-srank">{i + 1}</span>
            <span className="dsw-ust-sname" title={s.id}>
              {s.title || t('sessions.untitled')}
            </span>
            <span className={'dsw-ust-stag' + (s.depth > 0 ? ' sub' : '')}>{s.depth > 0 ? t('sessions.subagent') : t('sessions.main')}</span>
            <span className="dsw-ust-smeta">{date}</span>
            <span className="dsw-ust-stokens">
              {(() => {
                const rollup = rollups ? rollups.get(s.id) : undefined
                const own = s.totals.total
                if (!rollup || rollup.subagentCount === 0) return fmtTokens(own, locale)
                return (
                  <>
                    {fmtTokens(own + rollup.subagentTotals.total, locale)}
                    <span className="dsw-ust-ssub" title={t('sessions.withSubagents', { n: rollup.subagentCount })}>
                      {' +'} {fmtTokens(rollup.subagentTotals.total, locale)}
                    </span>
                  </>
                )
              })()}
            </span>
          </div>
        )
      })}
    </div>
  )
}

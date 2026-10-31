// dsh-usage-panel · subagent drill-down card (issue #104).
// One row per delegated DSH subagent session, joined by the host with the
// external executor's real usage. Cells stay "—" whenever no external record
// was matched: a fabricated 0 would read as "ran and used nothing".
import type { SubagentsPayload } from '../../shared/contract.ts'
import { fmtTokens, formatDuration, formatLocalDateTime } from '../../shared/format.ts'
import type { I18n } from '../locales.ts'
import { selectRecentTop } from '../subagents-select.ts'
import * as React from 'react'

const MAX_ERRORS = 2

interface SubagentsCardProps {
  payload: SubagentsPayload | null
  error: string | null
  loading: boolean
  i18n: I18n
  onRetry: () => void
}

export function SubagentsCard({ payload, error, loading, i18n, onRetry }: SubagentsCardProps): JSX.Element {
  const t = i18n.t
  const locale = i18n.locale
  const shown = payload ? selectRecentTop(payload.items, payload.updatedAt) : []
  const coverage = payload ? payload.coverage : null

  let body: JSX.Element
  if (!payload) {
    body = error ? (
      <div className="dsw-ust-sub-state">
        <div>{t('subagents.error', { msg: error })}</div>
        <button className="dsw-ust-sub-morebtn" onClick={onRetry}>
          {t('refresh.button')}
        </button>
      </div>
    ) : (
      <div className="dsw-ust-sub-state">{t('subagents.loading')}</div>
    )
  } else if (!shown.length) {
    body = <div className="dsw-ust-sub-state">{t('subagents.empty')}</div>
  } else {
    body = (
      <>
        <div className="dsw-ust-sub-wrap">
          <table className="dsw-ust-sub-table">
            <thead>
              <tr>
                <th>{t('subagents.col.task')}</th>
                <th>{t('subagents.col.executor')}</th>
                <th>{t('subagents.col.model')}</th>
                <th className="num">{t('subagents.col.input')}</th>
                <th className="num">{t('subagents.col.output')}</th>
                <th className="num">{t('subagents.col.cacheRead')}</th>
                <th className="num">{t('subagents.col.duration')}</th>
                <th>{t('subagents.col.started')}</th>
                <th>{t('subagents.col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((item) => {
                const ext = item.external
                const executor = ext ? ext.executor : 'unknown'
                const model = (ext && ext.model) || item.relay.model
                return (
                  <tr key={item.sessionId}>
                    <td className="dsw-ust-sub-task">
                      <span className="dsw-ust-sub-label" title={item.sessionId}>
                        {item.label || item.sessionId.slice(0, 8)}
                      </span>
                      {ext ? <span className="dsw-ust-sub-calls">{t('subagents.calls', { n: ext.calls })}</span> : null}
                    </td>
                    <td>
                      <span className={'dsw-ust-sub-badge is-' + executor}>{executor}</span>
                    </td>
                    <td className="dsw-ust-sub-model" title={model || undefined}>
                      {model || '—'}
                    </td>
                    <td className="num">{ext ? fmtTokens(ext.totals.input, locale) : '—'}</td>
                    <td className="num">{ext ? fmtTokens(ext.totals.output, locale) : '—'}</td>
                    <td className="num">{ext ? fmtTokens(ext.totals.cacheRead, locale) : '—'}</td>
                    <td className="num">{formatDuration(ext ? ext.startedAt : null, ext ? ext.endedAt : null)}</td>
                    <td className="dsw-ust-sub-time">{formatLocalDateTime(item.startedAt)}</td>
                    <td>
                      {ext ? (
                        <span className="dsw-ust-sub-src">{ext.source}</span>
                      ) : (
                        <span className="dsw-ust-sub-muted">{t('subagents.noExternal')}</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </>
    )
  }

  return (
    <div className="dsw-ust-card">
      <div className="dsw-ust-card-head">
        <div className="dsw-ust-card-title">
          <h3>{t('subagents.title')}</h3>
          <span className="dsw-ust-card-sub">{t('subagents.sub')}</span>
        </div>
        {loading && payload ? <span className="dsw-ust-sub-load">{t('subagents.loading')}</span> : null}
      </div>
      {coverage ? (
        <div className="dsw-ust-sub-coverage">
          {t('subagents.window')} · {t('subagents.coverage', {
            total: coverage.total,
            matched: coverage.matched,
            noExternal: coverage.noExternal,
          })}
        </div>
      ) : null}
      {coverage && coverage.errors.length ? (
        <ul className="dsw-ust-sub-errors">
          {coverage.errors.slice(0, MAX_ERRORS).map((msg, i) => (
            <li key={i} title={msg}>
              {msg}
            </li>
          ))}
        </ul>
      ) : null}
      {error && payload ? <div className="dsw-ust-sub-warn">{t('subagents.error', { msg: error })}</div> : null}
      {body}
    </div>
  )
}

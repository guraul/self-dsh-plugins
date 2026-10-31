// dsh-usage-panel · export menu (P1-⑧).
// JSON / daily CSV / model CSV; CSV cells are formula-injection-guarded,
// RFC 4180 escaped, and files carry a UTF-8 BOM.
import { useState } from 'react'
import type { Overview } from '../../shared/contract.ts'
import { buildDailyCsv, buildJson, buildModelCsv, download } from '../export.ts'
import type { I18n } from '../locales.ts'
import { useClickAway } from '../hooks.ts'
import * as React from 'react'

interface ExportMenuProps {
  overview: Overview
  i18n: I18n
}

export function ExportMenu({ overview, i18n }: ExportMenuProps): JSX.Element {
  const t = i18n.t
  const [open, setOpen] = useState(false)
  const menuRef = useClickAway(() => setOpen(false))

  const run = (kind: 'json' | 'daily' | 'models'): void => {
    if (kind === 'json') download(t('export.file.json'), buildJson(overview), 'application/json')
    else if (kind === 'daily') download(t('export.file.daily'), buildDailyCsv(overview.days), 'text/csv')
    else download(t('export.file.models'), buildModelCsv(overview.byModel), 'text/csv')
    setOpen(false)
  }

  return (
    <div className="dsw-ust-export" ref={menuRef}>
      <button className="dsw-ust-refresh" onClick={() => setOpen((v) => !v)}>
        {t('export.button')}
      </button>
      {open ? (
        <div className="dsw-ust-export-menu">
          <button onClick={() => run('json')}>{t('export.json')}</button>
          <button onClick={() => run('daily')}>{t('export.daily')}</button>
          <button onClick={() => run('models')}>{t('export.models')}</button>
        </div>
      ) : null}
    </div>
  )
}

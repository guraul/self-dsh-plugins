// Locks the homebase data-source switch (self-dsh-plugins#208):
// config defaults, the "misconfigured stays local" rule, and the fold that
// turns per-(day, model) rows back into one record per remote session.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldHomebaseRows, homebaseConfigFromEnv } from '../src/host/external/homebase.ts'

test('config: defaults to local with no env at all', () => {
  const cfg = homebaseConfigFromEnv({})
  assert.equal(cfg.source, 'local')
  assert.equal(cfg.timeoutMs, 8000)
})

test('config: homebase is only selected when explicitly asked AND fully configured', () => {
  const full = homebaseConfigFromEnv({
    DSH_USAGE_PANEL_DATA_SOURCE: 'homebase',
    DSH_USAGE_PANEL_HOMEBASE_URL: 'https://106.13.181.13',
    DSH_USAGE_PANEL_HOMEBASE_TOKEN: 'x'.repeat(64),
  })
  assert.equal(full.source, 'homebase')
  assert.equal(full.url, 'https://106.13.181.13')

  // Missing token → stays local (a typo must not blank the panel).
  const noToken = homebaseConfigFromEnv({
    DSH_USAGE_PANEL_DATA_SOURCE: 'homebase',
    DSH_USAGE_PANEL_HOMEBASE_URL: 'https://106.13.181.13',
  })
  assert.equal(noToken.source, 'local')

  const typo = homebaseConfigFromEnv({ DSH_USAGE_PANEL_DATA_SOURCE: 'homebse' })
  assert.equal(typo.source, 'local')
})

test('fold: sums across days and models, keeps the dominant model, window is min..max', () => {
  const hits = foldHomebaseRows([
    {
      usage_date: '2026-10-30',
      source: 'opencode',
      provider: 'opencode',
      model: 'deepseek-v4.1-flash-free',
      session_id: 'ses_a',
      calls: 3,
      input_tokens: 100,
      output_tokens: 10,
      cache_read: 900,
      cache_write: 0,
      total_tokens: 1010,
      first_at: 1000,
      last_at: 2000,
    },
    {
      usage_date: '2026-10-31',
      source: 'opencode',
      provider: 'opencode',
      model: 'longcat-2.5-preview-free',
      session_id: 'ses_a',
      calls: 1,
      input_tokens: 5000,
      output_tokens: 20,
      cache_read: 0,
      cache_write: 0,
      total_tokens: 5020,
      first_at: 900,
      last_at: 5000,
    },
  ])

  const hit = hits.get('ses_a')
  assert.ok(hit)
  assert.equal(hit!.calls, 4)
  assert.equal(hit!.totals.input, 5100)
  assert.equal(hit!.totals.total, 6030)
  assert.equal(hit!.startedAt, 900)
  assert.equal(hit!.endedAt, 5000)
  // 5020 > 1010 → longcat wins
  assert.equal(hit!.model, 'longcat-2.5-preview-free')
  assert.equal(hit!.executor, 'opencode')
})

test('fold: rows without a session id are skipped, not crashed on', () => {
  const hits = foldHomebaseRows([
    { usage_date: '2026-10-30', source: 'opencode', provider: 'p', model: 'm', session_id: '', total_tokens: 1 },
    { usage_date: '2026-10-30', source: 'opencode', provider: 'p', model: 'm', session_id: 'ses_b', total_tokens: 5 },
  ])
  assert.equal(hits.size, 1)
  assert.equal(hits.get('ses_b')?.totals.total, 5)
})

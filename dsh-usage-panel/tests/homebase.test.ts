// Locks the homebase data-source switch (self-dsh-plugins#208):
// config defaults, the "misconfigured stays local" rule, and the fold that
// turns per-(day, model) rows back into one record per remote session.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildOverviewFromRows, foldHomebaseRows, homebaseConfigFromEnv, loadCaContents, parseTokenSyncEnv, readTokenSyncEnv } from '../src/host/external/homebase.ts'

// Point at a file that does not exist so the real ~/.dsh/token-sync.env never
// leaks into assertions.
const NO_FILE = '/nonexistent/token-sync.env'

test('config: defaults to local with no env at all', () => {
  const cfg = homebaseConfigFromEnv({}, NO_FILE)
  assert.equal(cfg.source, 'local')
  assert.equal(cfg.timeoutMs, 8000)
})

test('config: homebase is only selected when explicitly asked AND fully configured', () => {
  const full = homebaseConfigFromEnv(
    {
      DSH_USAGE_PANEL_DATA_SOURCE: 'homebase',
      DSH_USAGE_PANEL_HOMEBASE_URL: 'https://106.13.181.13',
      DSH_USAGE_PANEL_HOMEBASE_TOKEN: 'x'.repeat(64),
    },
    NO_FILE,
  )
  assert.equal(full.source, 'homebase')
  assert.equal(full.url, 'https://106.13.181.13')

  // Missing token → stays local (a typo must not blank the panel).
  const noToken = homebaseConfigFromEnv(
    {
      DSH_USAGE_PANEL_DATA_SOURCE: 'homebase',
      DSH_USAGE_PANEL_HOMEBASE_URL: 'https://106.13.181.13',
    },
    NO_FILE,
  )
  assert.equal(noToken.source, 'local')

  const typo = homebaseConfigFromEnv({ DSH_USAGE_PANEL_DATA_SOURCE: 'homebse' }, NO_FILE)
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

test('token-sync.env fallback: only DATA_SOURCE is needed when the file carries the rest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-env-'))
  const file = path.join(dir, 'token-sync.env')
  fs.writeFileSync(
    file,
    '# collector config\nHOMEBASE_URL=https://106.13.181.13\nHOMEBASE_INTERNAL_TOKEN=' + 'y'.repeat(64) + '\nHOMEBASE_CA="~/certs/ca.pem"\n',
  )
  const cfg = homebaseConfigFromEnv({ DSH_USAGE_PANEL_DATA_SOURCE: 'homebase' }, file)
  assert.equal(cfg.source, 'homebase')
  assert.equal(cfg.url, 'https://106.13.181.13')
  assert.equal(cfg.token.length, 64)
  // ~ must expand so the CA path is usable.
  assert.equal(cfg.ca, path.join(os.homedir(), 'certs/ca.pem'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('token-sync.env fallback: missing file falls back to local, env wins when both exist', () => {
  assert.equal(homebaseConfigFromEnv({ DSH_USAGE_PANEL_DATA_SOURCE: 'homebase' }, NO_FILE).source, 'local')
  assert.deepEqual(readTokenSyncEnv(NO_FILE), {})
  assert.deepEqual(parseTokenSyncEnv(''), {})

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-env2-'))
  const file = path.join(dir, 'token-sync.env')
  fs.writeFileSync(file, 'HOMEBASE_URL=https://from-file\nHOMEBASE_INTERNAL_TOKEN=' + 'z'.repeat(64) + '\n')
  const cfg = homebaseConfigFromEnv(
    { DSH_USAGE_PANEL_DATA_SOURCE: 'homebase', DSH_USAGE_PANEL_HOMEBASE_URL: 'https://from-env' },
    file,
  )
  assert.equal(cfg.url, 'https://from-env') // env wins
  assert.equal(cfg.token.length, 64) // token from file
  fs.rmSync(dir, { recursive: true, force: true })
})

test('loadCaContents: 返回 PEM 内容而不是路径；读不到返回 undefined', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-ca-'))
  const file = path.join(dir, 'ca.pem')
  const pem = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n'
  fs.writeFileSync(file, pem)

  // 关键：https.request 的 ca 需要内容；传路径等于没配（这就是生产 bug）。
  assert.equal(loadCaContents(file), pem)
  assert.notEqual(loadCaContents(file), file)

  assert.equal(loadCaContents(path.join(dir, 'missing.pem')), undefined)
  assert.equal(loadCaContents(null), undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('fold: executor 与 source 随行的 source 走（codebuddy / opencode 同一张表）', () => {
  const hits = foldHomebaseRows([
    {
      usage_date: '2026-10-31',
      source: 'opencode',
      provider: 'opencode',
      model: 'deepseek-v4.1-flash-free',
      session_id: 'ses_1',
      total_tokens: 100,
      first_at: 1,
      last_at: 2,
    },
    {
      usage_date: '2026-10-31',
      source: 'codebuddy',
      provider: 'codebuddy',
      model: 'deepseek-v4.1-flash',
      session_id: '01a191db-a69f-7fcf-bfbf-d7d857cdb361',
      total_tokens: 900,
      first_at: 3,
      last_at: 4,
    },
  ]);
  assert.equal(hits.get('ses_1')?.executor, 'opencode');
  assert.equal(hits.get('ses_1')?.source, 'opencode-db');
  assert.equal(hits.get('01a191db-a69f-7fcf-bfbf-d7d857cdb361')?.executor, 'codebuddy');
  assert.equal(hits.get('01a191db-a69f-7fcf-bfbf-d7d857cdb361')?.source, 'codebuddy-jsonl');
});

test('overview: rows 装配成 days / totals / byModel / topSessions / providers', () => {
  const now = Date.parse('2026-11-02T12:00:00Z')
  const day = '2026-10-31'
  const rows = [
    { usage_date: day, source: 'dsh', provider: 'opencode-go', model: 'deepseek-v4.1-flash', session_id: 's1', title: '会话一', input_tokens: 100, output_tokens: 10, cache_read: 900, cache_write: 0, total_tokens: 1010, first_at: 1, last_at: 2 },
    { usage_date: day, source: 'dsh', provider: 'opencode-go', model: 'deepseek-v4.1-flash', session_id: 's2', title: '会话二', input_tokens: 50, output_tokens: 5, cache_read: 0, cache_write: 0, total_tokens: 55, first_at: 3, last_at: 4 },
    { usage_date: day, source: 'dsh', provider: 'deepseek-official', model: 'mimo-v2.6-flash', session_id: 's1', title: '会话一', input_tokens: 20, output_tokens: 2, cache_read: 0, cache_write: 0, total_tokens: 22, first_at: 1, last_at: 5 },
  ] as any

  const ov = buildOverviewFromRows(rows, now)
  assert.equal(ov.coverage.mode, 'homebase')
  // 近 30 天（now 前 30 天窗口包含 10-31）
  assert.equal(ov.totals.input, 170)
  assert.equal(ov.totals.cacheRead, 900)
  assert.equal(ov.totals.total, 1010 + 55 + 22)
  assert.equal(ov.sessionCount, 2)
  // allTime 与近 30 天在此用例里相同
  assert.equal(ov.allTime.totals.total, 1010 + 55 + 22)
  // 模型按总量降序
  assert.equal(ov.byModel[0].model, 'deepseek-v4.1-flash')
  // 会话排行：s1 合计 1032 > s2 55，标题取自 rows
  assert.equal(ov.topSessions[0].id, 's1')
  assert.equal(ov.topSessions[0].title, '会话一')
  assert.equal(ov.topSessions[1].id, 's2')
  // Provider 分布
  assert.equal(ov.providers[0].id, 'opencode-go')
  assert.equal(ov.providers[0].totals.total, 1010 + 55)
  // 热力图窗口有该日
  assert.ok(ov.days.some((d) => d.date === day && d.total > 0))
})

test('overview: 空数据返回 0 而不是崩溃', () => {
  const ov = buildOverviewFromRows([], Date.parse('2026-11-02T12:00:00Z'))
  assert.equal(ov.totals.total, 0)
  assert.equal(ov.sessionCount, 0)
  assert.deepEqual(ov.topSessions, [])
  assert.deepEqual(ov.providers, [])
})

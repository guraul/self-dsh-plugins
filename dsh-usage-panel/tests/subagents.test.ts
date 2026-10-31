// Locks the host-side subagent data layer: registry fault tolerance, opencode
// model JSON parsing / legacy-table fallback, and codebuddy JSONL aggregation.
// All fixtures are synthetic temp files — no real user data is read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { loadRegistry, normalizeSessionId } from '../src/host/external/registry.ts'
import { parseOpencodeModel, readOpencodeSessions } from '../src/host/external/opencode.ts'
import { codebuddyTranscriptPath, cwdSlug, readCodebuddySession } from '../src/host/external/codebuddy.ts'
import { clearSubagentCache, collectSubagents } from '../src/host/external/collect.ts'

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'usage-panel-subagents-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('registry: missing and corrupt files yield an empty map plus a diagnostic, never throw', async (t) => {
  const dir = tempDir(t)

  const missing = await loadRegistry(path.join(dir, 'does-not-exist.json'))
  assert.equal(missing.entries.size, 0)
  assert.equal(missing.errors.length, 1)
  assert.match(missing.errors[0]!, /cannot read/)

  const corruptPath = path.join(dir, 'corrupt.json')
  writeFileSync(corruptPath, '{ not json')
  const corrupt = await loadRegistry(corruptPath)
  assert.equal(corrupt.entries.size, 0)
  assert.equal(corrupt.errors.length, 1)
  assert.match(corrupt.errors[0]!, /invalid JSON/)

  const arrayPath = path.join(dir, 'array.json')
  writeFileSync(arrayPath, '[]')
  const array = await loadRegistry(arrayPath)
  assert.equal(array.entries.size, 0)
  assert.equal(array.errors.length, 1)

  const validPath = path.join(dir, 'valid.json')
  writeFileSync(
    validPath,
    JSON.stringify({
      'session-abc-123': { product: 'opencode', remoteId: 'ses_1', cwd: '/tmp/x', updatedAt: 42 },
      'def-456': { product: 'codebuddy', remoteId: '01a1', cwd: '/tmp/y', updatedAt: 43 },
      bad: { product: 'opencode' },
    }),
  )
  const valid = await loadRegistry(validPath)
  assert.equal(valid.errors.length, 0)
  assert.equal(valid.entries.size, 2)
  assert.deepEqual(valid.entries.get('abc-123'), {
    product: 'opencode',
    remoteId: 'ses_1',
    cwd: '/tmp/x',
    updatedAt: 42,
  })
  assert.equal(normalizeSessionId('session-def-456'), 'def-456')
})

test('opencode: parses model JSON, falls back to the legacy session table, and counts assistant calls', async (t) => {
  const dir = tempDir(t)
  const dbPath = path.join(dir, 'opencode.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE session_v2 (
      id text PRIMARY KEY,
      model text,
      tokens_input integer DEFAULT 0 NOT NULL,
      tokens_output integer DEFAULT 0 NOT NULL,
      tokens_cache_read integer DEFAULT 0 NOT NULL,
      tokens_cache_write integer DEFAULT 0 NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL
    );
    CREATE TABLE session_message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      type text NOT NULL
    );
    CREATE TABLE session (
      id text PRIMARY KEY,
      model text,
      tokens_input integer DEFAULT 0 NOT NULL,
      tokens_output integer DEFAULT 0 NOT NULL,
      tokens_cache_read integer DEFAULT 0 NOT NULL,
      tokens_cache_write integer DEFAULT 0 NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL
    );
  `)
  db.prepare(
    `INSERT INTO session_v2 (id, model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'ses_json',
    JSON.stringify({ id: 'deepseek-v4.1-flash-free', providerID: 'opencode' }),
    1000,
    200,
    30,
    4,
    1700000000000,
    1700000009000,
  )
  db.prepare('INSERT INTO session_message (id, session_id, type) VALUES (?, ?, ?)').run('m1', 'ses_json', 'assistant')
  db.prepare('INSERT INTO session_message (id, session_id, type) VALUES (?, ?, ?)').run('m2', 'ses_json', 'user')
  db.prepare('INSERT INTO session_message (id, session_id, type) VALUES (?, ?, ?)').run('m3', 'ses_json', 'assistant')
  db.prepare(
    `INSERT INTO session (id, model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('ses_old', 'legacy-model', 10, 5, 1, 0, 1600000000000, 1600000001000)
  db.close()

  assert.equal(parseOpencodeModel('{"id":"m-json","providerID":"opencode"}'), 'm-json')
  assert.equal(parseOpencodeModel('plain-model'), 'plain-model')
  assert.equal(parseOpencodeModel('{"providerID":"opencode"}'), null)
  assert.equal(parseOpencodeModel(null), null)

  const read = await readOpencodeSessions(['ses_json', 'ses_old', 'ses_absent'], { dbPaths: [dbPath] })
  assert.deepEqual(read.errors, [])
  assert.equal(read.hits.size, 2)

  const modern = read.hits.get('ses_json')!
  assert.equal(modern.executor, 'opencode')
  assert.equal(modern.model, 'deepseek-v4.1-flash-free')
  assert.deepEqual(modern.totals, { input: 1000, output: 200, cacheRead: 30, cacheWrite: 4, total: 1234 })
  assert.equal(modern.calls, 2)
  assert.equal(modern.startedAt, 1700000000000)
  assert.equal(modern.endedAt, 1700000009000)
  assert.equal(modern.source, 'opencode-db')

  const legacy = read.hits.get('ses_old')!
  assert.equal(legacy.model, 'legacy-model')
  assert.deepEqual(legacy.totals, { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, total: 16 })
})

test('opencode: an unreadable database is skipped with an error instead of throwing', async (t) => {
  const dir = tempDir(t)
  const badPath = path.join(dir, 'not-a-db.sqlite')
  writeFileSync(badPath, 'definitely not sqlite')
  const read = await readOpencodeSessions(['ses_x'], { dbPaths: [badPath] })
  assert.equal(read.hits.size, 0)
  assert.ok(read.errors.length >= 1)
  assert.match(read.errors[0]!, /not a database|cannot open/)
})

test('codebuddy: aggregates only assistant message usage from the cwd-slugged JSONL', async (t) => {
  const dir = tempDir(t)
  const cwd = '/Users/gubin/workspace/self-dsh-plugins'
  const remoteId = '01a1-test-remote'
  const filePath = codebuddyTranscriptPath(dir, cwd, remoteId)
  assert.equal(
    filePath,
    path.join(dir, 'Users-gubin-workspace-self-dsh-plugins', remoteId + '.jsonl'),
  )
  assert.equal(cwdSlug(cwd), 'Users-gubin-workspace-self-dsh-plugins')
  mkdirSync(path.dirname(filePath), { recursive: true })

  const lines = [
    JSON.stringify({ type: 'message', role: 'user', timestamp: 900, content: 'hi' }),
    '{ this line is broken',
    JSON.stringify({
      type: 'message',
      role: 'assistant',
      timestamp: 1000,
      providerData: {
        model: 'deepseek-v4.1-flash',
        usage: { inputTokens: 100, outputTokens: 20 },
        rawUsage: { credit: 0.5 },
      },
    }),
    JSON.stringify({ type: 'message', role: 'assistant', timestamp: 1200, providerData: { model: 'ignored' } }),
    JSON.stringify({
      type: 'message',
      role: 'assistant',
      timestamp: 2000,
      providerData: {
        model: 'deepseek-v4.1',
        usage: { inputTokens: 50, outputTokens: 5 },
        rawUsage: { credit: 0.25 },
      },
    }),
  ]
  writeFileSync(filePath, lines.join('\n') + '\n')

  const read = await readCodebuddySession(remoteId, cwd, { projectsDir: dir })
  assert.deepEqual(read.errors, [])
  assert.ok(read.hit)
  assert.equal(read.hit!.executor, 'codebuddy')
  assert.equal(read.hit!.model, 'deepseek-v4.1')
  assert.deepEqual(read.hit!.totals, { input: 150, output: 25, cacheRead: 0, cacheWrite: 0, total: 175 })
  assert.equal(read.hit!.calls, 2)
  assert.equal(read.hit!.credit, 0.75)
  assert.equal(read.hit!.startedAt, 1000)
  assert.equal(read.hit!.endedAt, 2000)
  assert.equal(read.hit!.source, 'codebuddy-jsonl')

  const missing = await readCodebuddySession('nope', cwd, { projectsDir: dir })
  assert.equal(missing.hit, null)
  assert.deepEqual(missing.errors, [])
})

test('collect: joins labels + relay, leaves unmatched rows external:null and sorts newest first', async (t) => {
  const dir = tempDir(t)
  const projCacheDir = path.join(dir, 'projcache')
  const codebuddyDir = path.join(dir, 'codebuddy')
  mkdirSync(projCacheDir, { recursive: true })
  mkdirSync(codebuddyDir, { recursive: true })
  const registryPath = path.join(dir, 'registry.json')
  clearSubagentCache()

  const cwd = '/tmp/project'
  const remoteId = '01a1-collect'
  writeFileSync(
    registryPath,
    JSON.stringify({ 'sess-new': { product: 'codebuddy', remoteId, cwd, updatedAt: 1 } }),
  )
  const transcript = codebuddyTranscriptPath(codebuddyDir, cwd, remoteId)
  mkdirSync(path.dirname(transcript), { recursive: true })
  writeFileSync(
    transcript,
    JSON.stringify({
      type: 'message',
      role: 'assistant',
      timestamp: 5000,
      providerData: { model: 'cb-model', usage: { inputTokens: 7, outputTokens: 3 } },
    }) + '\n',
  )
  writeFileSync(
    path.join(projCacheDir, 'sess-new.json'),
    JSON.stringify({
      record: {
        rows: {
          subagent: { val: { label: 'codebuddy: do work' } },
          usagePanel: {
            val: {
              currentModel: 'relay-model',
              current: {
                totals: { input: 11, output: 13, cacheRead: 17, cacheWrite: 0 },
                firstTime: 4000,
                lastTime: 4500,
              },
            },
          },
        },
      },
    }),
  )
  writeFileSync(
    path.join(projCacheDir, 'sess-orphan.json'),
    JSON.stringify({ record: { rows: { subagent: { val: { label: 'orphan: no registry' } } } } }),
  )

  const headers = [
    { id: 'sess-new', createdAt: 4000, delegationDepth: 1 },
    { id: 'sess-orphan', createdAt: 6000, delegationDepth: 2 },
    { id: 'sess-main', createdAt: 3000, delegationDepth: 0 },
  ]
  const sq = {
    listSessions: async () => headers.map((header) => ({ header, live: false, persisted: true })),
    readTitle: async () => ({ title: 't'.repeat(100) }),
  } as unknown as Parameters<typeof collectSubagents>[0]['sq']

  const payload = await collectSubagents({
    sq,
    registryPath,
    projCacheDir,
    codebuddyProjectsDir: codebuddyDir,
    opencodeDbPaths: [],
    now: 10_000,
  })

  assert.equal(payload.items.length, 2) // main session excluded
  assert.equal(payload.coverage.total, 2)
  assert.equal(payload.coverage.matched, 1)
  assert.equal(payload.coverage.noExternal, 1)
  assert.equal(payload.coverage.registryEntries, 1)
  assert.deepEqual(payload.coverage.errors, [])

  const matched = payload.items.find((item) => item.sessionId === 'sess-new')!
  assert.equal(matched.label, 'codebuddy: do work')
  assert.equal(matched.depth, 1)
  assert.equal(matched.relay.model, 'relay-model')
  assert.deepEqual(matched.relay.totals, { input: 11, output: 13, cacheRead: 17, cacheWrite: 0, total: 41 })
  assert.ok(matched.external)
  assert.equal(matched.external!.model, 'cb-model')
  assert.equal(matched.external!.executor, 'codebuddy')
  assert.equal(matched.startedAt, 4000)
  assert.equal(matched.lastActive, 5000)

  const orphan = payload.items.find((item) => item.sessionId === 'sess-orphan')!
  assert.equal(orphan.external, null) // no fabricated zeros
  assert.equal(orphan.label, 'orphan: no registry')
  assert.equal(orphan.startedAt, 6000)
  assert.equal(payload.items[0]!.sessionId, 'sess-orphan') // newest first
})

/**
 * 记录层：审核记录落盘、traceId、熔断、跳过审计。
 *
 * 记录只存 diff 的哈希与长度，不存全文——审核记录用于事后追溯，
 * 不是 diff 的第二份副本。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'

export const DEFAULT_TTL_MS = 30 * 60 * 1000
export const MAX_CONSECUTIVE_FAILURES = 3

export function reviewsDir(root) {
  return join(root, '.dsh-web', 'reviews')
}

/**
 * 审核记录属于仓库级运行态，必须落在**主工作区**：工作树会在合并收尾时被
 * `git worktree remove --force` 删掉，把证据放进去等于没留痕。
 * 取不到主工作区时退回传入目录（例如不在 git 仓库里跑单测）。
 */
export function mainWorktreeRoot(cwd = process.cwd()) {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8' })
  if (result.status === 0) {
    const first = String(result.stdout ?? '')
      .split('\n')
      .find((line) => line.startsWith('worktree '))
    if (first) return first.slice('worktree '.length)
  }
  return cwd
}

function stamp(date) {
  const iso = date.toISOString()
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
}

export function traceId(date = new Date(), bytes = randomBytes(4)) {
  return `${stamp(date)}-${bytes.toString('hex')}`
}

export function localDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function recordFile(dir, pr, headSha) {
  return join(dir, `${pr}-${headSha}.json`)
}

export function writeRecord(dir, record) {
  mkdirSync(dir, { recursive: true })
  const target = recordFile(dir, record.pr, record.head_sha)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  renameSync(tmp, target)
  return target
}

export function readRecord(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function isExpired(record, now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  const created = Date.parse(record?.createdAt ?? '')
  if (Number.isNaN(created)) return true
  return now - created > ttlMs
}

export function circuitFile(dir) {
  return join(dir, 'circuit.json')
}

/** 跨天自动清零；成功一次不清零（间歇性故障不该让熔断失效）。 */
export function readCircuit(dir, now = new Date()) {
  const empty = { date: localDate(now), consecutiveFailures: 0, tripped: false }
  const file = circuitFile(dir)
  if (!existsSync(file)) return empty
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    if (stored.date !== localDate(now)) return empty
    return {
      date: stored.date,
      consecutiveFailures: Number(stored.consecutiveFailures) || 0,
      tripped: Boolean(stored.tripped),
    }
  } catch {
    return empty
  }
}

export function bumpCircuit(dir, now = new Date()) {
  const current = readCircuit(dir, now)
  const consecutiveFailures = current.consecutiveFailures + 1
  const state = {
    date: current.date,
    consecutiveFailures,
    tripped: consecutiveFailures >= MAX_CONSECUTIVE_FAILURES,
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(circuitFile(dir), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  return state
}

export function writeSkipAudit(dir, { pr, headSha, reason, now = new Date() }) {
  const skipDir = join(dir, 'skips')
  mkdirSync(skipDir, { recursive: true })
  const file = join(skipDir, `${stamp(now)}-${pr}.json`)
  writeFileSync(
    file,
    `${JSON.stringify({ pr, head_sha: headSha ?? null, reason, at: now.toISOString() }, null, 2)}\n`,
    'utf8',
  )
  return file
}

/** 按 traceId 反查：扫目录，不建索引（索引会引入「索引与记录不一致」的新故障面）。 */
export function findByTrace(dir, trace) {
  if (!existsSync(dir)) return []
  const hits = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json') || entry === 'circuit.json') continue
    try {
      const record = JSON.parse(readFileSync(join(dir, entry), 'utf8'))
      if (record?.traceId === trace) hits.push(record)
    } catch {
      // 坏记录跳过：反查是只读辅助功能，不该因为一条坏文件整体失败
    }
  }
  return hits
}

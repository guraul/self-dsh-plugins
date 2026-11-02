/**
 * 分片审核：按文件切 diff、逐片出记录、确定性合成一条可用于闸门的记录。
 *
 * 三条硬约束：
 *   - 分片必须**完备**：每个文件恰好落在一片，不重不漏（按 diff 的
 *     `diff --git` 段落切，段落就是文件的真源）；
 *   - 合成必须**确定性**且 fail-closed：缺片不猜、不跳，直接报错；
 *     判定只能收紧不能放宽（REJECT > ESCALATE > APPROVE）；
 *   - 分片记录**不能**占用闸门读取的规范文件名，否则一片的 APPROVE
 *     就能骗过闸门。
 */
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContractError } from './contract.js'
import { recordFile } from './record.js'

/** 判定收紧顺序：取第一个命中的。 */
const VERDICT_SEVERITY = Object.freeze(['REJECT', 'ESCALATE', 'APPROVE'])

/** `1/3` → { index: 1, total: 3 }；任何含糊写法都报错，不猜。 */
export function parseShardSpec(value) {
  const shown = value === true ? '(缺值)' : String(value ?? '')
  if (typeof value !== 'string') {
    throw new ContractError('E_BUDGET', `--shard 需要形如 2/3 的值，收到 ${shown}`)
  }
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(value.trim())
  if (!match) {
    throw new ContractError('E_BUDGET', `--shard 需要形如 2/3 的值，收到 ${shown}`)
  }
  const index = Number(match[1])
  const total = Number(match[2])
  if (total < 1) throw new ContractError('E_BUDGET', `--shard 的总片数必须 ≥ 1，收到 ${shown}`)
  if (index < 1 || index > total) {
    throw new ContractError('E_BUDGET', `--shard 的片号必须在 1..${total} 之间，收到 ${shown}`)
  }
  return { index, total }
}

/** 从 `+++ b/路径` / `--- a/路径` / `diff --git a/x b/x` 里取仓库相对路径。 */
function pathFromSection(lines) {
  for (const line of lines) {
    if (line.startsWith('+++ ') && !line.startsWith('+++ /dev/null')) {
      return line.slice(4).replace(/^b\//, '').trim()
    }
    if (line.startsWith('--- ') && !line.startsWith('--- /dev/null')) {
      return line.slice(4).replace(/^a\//, '').trim()
    }
  }
  const header = lines.find((line) => line.startsWith('diff --git '))
  if (!header) return ''
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(header)
  return match ? match[2].trim() : ''
}

/**
 * 按 `diff --git` 把整段 diff 切成「一个文件一段」。
 *
 * 段与段之间原本靠换行分隔，join('\n') 能逐字节还原整段 diff；
 * 没有 `diff --git` 头（测试桩、手写 diff）时整段算一个文件。
 *
 * @param {string} diff
 * @returns {{ path: string, text: string }[]}
 */
export function splitDiffByFile(diff) {
  const text = String(diff ?? '')
  if (text.length === 0) return []

  const lines = text.split('\n')
  const chunks = []
  let current = null
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      current = [line]
      chunks.push(current)
    } else if (current) {
      current.push(line)
    }
  }
  if (chunks.length === 0) {
    const path = pathFromSection(lines)
    return path ? [{ path, text }] : []
  }
  return chunks.map((chunk) => ({ path: pathFromSection(chunk), text: chunk.join('\n') }))
}

/** 权重用段落的原始行数：与 reviewer 实际要读的量一致。 */
function sectionWeight(section) {
  return section.text.split('\n').length
}

/**
 * 把文件段落均衡地分到 n 片：按行数从大到小，逐个放进当前最轻的一片
 * （LPT 近似），平票取片号小的。结果只依赖输入，可复现。
 *
 * @param {{ path: string, text: string }[]} sections
 * @param {number} total
 * @returns {{ path: string, text: string }[][]}
 */
export function balanceSections(sections, total) {
  const buckets = Array.from({ length: total }, () => [])
  const loads = new Array(total).fill(0)
  const items = sections.map((section, index) => ({ index, weight: sectionWeight(section) }))
  items.sort((a, b) => b.weight - a.weight || a.index - b.index)

  for (const item of items) {
    let target = 0
    for (let candidate = 1; candidate < total; candidate += 1) {
      if (loads[candidate] < loads[target]) target = candidate
    }
    buckets[target].push(item.index)
    loads[target] += item.weight
  }
  return buckets.map((indices) => indices.sort((a, b) => a - b).map((index) => sections[index]))
}

/**
 * 取第 index 片。
 *
 * @param {{ path: string, text: string }[]} sections
 * @param {{ index: number, total: number }} spec
 * @returns {{ text: string, files: string[] }}
 */
export function pickShard(sections, { index, total }) {
  if (sections.length === 0) {
    throw new ContractError('E_BUDGET', '这次变更没有可切的 diff 段落，无法分片')
  }
  if (total > sections.length) {
    throw new ContractError(
      'E_BUDGET',
      `分片数 ${total} 超过变更文件数 ${sections.length}；请减少 --shard 的总片数`,
    )
  }
  const chunk = balanceSections(sections, total)[index - 1]
  return {
    text: chunk.map((section) => section.text).join('\n'),
    files: chunk.map((section) => section.path).filter(Boolean),
  }
}

/** 分片记录的文件名：与闸门读的 `<pr>-<sha>.json` 刻意区分开。 */
export function shardRecordName(pr, headSha, { index, total }) {
  return `${pr}-${headSha}.shard-${index}-of-${total}.json`
}

const SHARD_NAME = /^(\d+)-([0-9a-f]{40})\.shard-(\d+)-of-(\d+)\.json$/

/** 解析分片记录文件名；不是分片记录返回 null。 */
export function parseShardRecordName(name) {
  const match = SHARD_NAME.exec(String(name ?? ''))
  if (!match) return null
  return {
    pr: Number(match[1]),
    headSha: match[2],
    index: Number(match[3]),
    total: Number(match[4]),
  }
}

/**
 * 读该 PR 该 sha 的全部分片记录。
 * 目录不存在、没有分片、同名分片重复或总片数互相矛盾都直接报错。
 *
 * @returns {{ total: number, entries: { index: number, total: number, file: string, record: object }[],
 *             missing: number[] }}
 */
export function collectShardRecords(dir, pr, headSha) {
  if (!existsSync(dir)) {
    throw new ContractError('E_UNAVAILABLE', `找不到审核记录目录: ${dir}`)
  }
  const target = Number(pr)
  const found = new Map()
  let total = null

  for (const name of readdirSync(dir).sort()) {
    const parsed = parseShardRecordName(name)
    if (!parsed || parsed.pr !== target || parsed.headSha !== headSha) continue
    if (total === null) total = parsed.total
    else if (total !== parsed.total) {
      throw new ContractError(
        'E_RECORD',
        `分片记录的总片数不一致：${total} 与 ${parsed.total}（${name}），无法确定该有几片`,
      )
    }
    if (found.has(parsed.index)) {
      throw new ContractError('E_RECORD', `第 ${parsed.index} 片存在多条记录（${name}），无法确定信哪条`)
    }

    const file = join(dir, name)
    let record
    try {
      record = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      throw new ContractError('E_RECORD', `分片记录无法解析: ${file}: ${error.message}`)
    }
    const declared = record?.shard
    if (declared && (declared.index !== parsed.index || declared.total !== parsed.total)) {
      throw new ContractError(
        'E_RECORD',
        `分片记录的文件名与内容不符: ${name}（内容为 ${declared.index}/${declared.total}）`,
      )
    }
    found.set(parsed.index, { index: parsed.index, total: parsed.total, file, record })
  }

  if (total === null) {
    throw new ContractError('E_RECORD', `PR #${target} @ ${headSha} 没有任何分片记录`)
  }
  const missing = []
  for (let index = 1; index <= total; index += 1) {
    if (!found.has(index)) missing.push(index)
  }
  return { total, entries: [...found.values()].sort((a, b) => a.index - b.index), missing }
}

function prefix(text, index, total) {
  return `[${index}/${total}] ${text}`
}

function unique(values) {
  return [...new Set(values)]
}

/**
 * 合成分片记录。缺片、轮次不一致、判定不认识一律抛错——宁可交回人工，
 * 也不产出一条「看起来审过全部」的记录。
 *
 * @param {{ total: number, entries: object[], missing?: number[] }} collected
 * @returns {object} 不含 shard 字段的合成记录
 */
export function aggregateShardRecords({ total, entries, missing }) {
  const absent = missing ?? []
  if (absent.length > 0 || entries.length !== total) {
    const list = absent.length > 0 ? absent : Array.from({ length: total }, (_, i) => i + 1).filter(
      (index) => !entries.some((entry) => entry.index === index),
    )
    throw new ContractError(
      'E_RECORD',
      `分片记录缺第 ${list.join('、')} 片（共 ${total} 片），拒绝合成`,
    )
  }

  const ordered = [...entries].sort((a, b) => a.index - b.index)
  const round = ordered[0].record.round
  for (const entry of ordered) {
    if (entry.record.round !== round) {
      throw new ContractError(
        'E_RECORD',
        `分片记录的轮次不一致：第 ${entry.index} 片是第 ${entry.record.round} 轮，其余是第 ${round} 轮`,
      )
    }
  }

  const verdicts = ordered.map((entry) => entry.record.verdict)
  for (const verdict of verdicts) {
    if (!VERDICT_SEVERITY.includes(verdict)) {
      throw new ContractError('E_RECORD', `分片记录里有不认识的判定: ${String(verdict)}`)
    }
  }
  const verdict = VERDICT_SEVERITY.find((candidate) => verdicts.includes(candidate))

  const findings = []
  const evidence = []
  for (const entry of ordered) {
    for (const finding of entry.record.findings ?? []) {
      findings.push({ ...finding, message: prefix(finding.message, entry.index, total) })
    }
    for (const item of entry.record.evidence ?? []) {
      evidence.push(prefix(item, entry.index, total))
    }
  }

  const policies = ordered.map((entry) => entry.record.policy).filter(Boolean)
  const policy =
    policies.length === 0
      ? null
      : {
          hit: policies.some((item) => Boolean(item.hit)),
          reasons: unique(policies.flatMap((item) => item.reasons ?? [])),
        }

  const record = { ...ordered[0].record }
  // 分片字段是「这是 N 份里的第 i 份」的标记；合成记录代表整份变更，
  // 带上它会让下游误以为还有别的片没合成。
  delete record.shard
  // 多条响应对应多个 nonce，合成记录冒充其中一个会误导追溯
  delete record.nonce
  delete record.errorCode

  record.verdict = verdict
  record.round = round
  record.findings = findings
  record.evidence = evidence
  record.createdAt = new Date().toISOString()
  if (policy) record.policy = policy
  else delete record.policy

  if (verdict !== 'APPROVE') {
    const errorCode = ordered
      .filter((entry) => entry.record.verdict !== 'APPROVE' && entry.record.errorCode)
      .map((entry) => entry.record.errorCode)[0]
    if (errorCode) record.errorCode = errorCode
  }

  return record
}

/** 合成记录写规范文件名（闸门只认这条）；先落临时文件再 rename。 */
export function writeAggregateRecord(dir, record) {
  const target = recordFile(dir, record.pr, record.head_sha)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  renameSync(tmp, target)
  return target
}

/**
 * 把共享包写出的记录改写成「分片记录」：加 shard 字段、换文件名，
 * 并删掉规范文件名。少了最后一步，一片的 APPROVE 就能当整份变更过闸门。
 *
 * 任何一步失败都要保证规范文件名不残留——没有记录，闸门就拒绝。
 */
export function finalizeShardRecord(dir, record, { index, total }) {
  const canonical = recordFile(dir, record.pr, record.head_sha)
  const target = join(dir, shardRecordName(record.pr, record.head_sha, { index, total }))
  const tmp = `${target}.${process.pid}.tmp`
  const sharded = { ...record, shard: { index, total } }
  try {
    writeFileSync(tmp, `${JSON.stringify(sharded, null, 2)}\n`, 'utf8')
    renameSync(tmp, target)
    rmSync(canonical, { force: true })
  } catch (error) {
    rmSync(tmp, { force: true })
    rmSync(canonical, { force: true })
    throw new ContractError('E_UNAVAILABLE', `分片记录落盘失败: ${error.message}`)
  }
  return { file: target, record: sharded }
}

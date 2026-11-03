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
import { basename, join } from 'node:path'
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

const C_ESCAPES = Object.freeze({
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  '"': '"',
})

/**
 * 还原 git 的 C 风格引号路径（`core.quotePath`）。含空格不必引号，
 * 含制表符 / 引号 / 反斜杠 / 非 ASCII 时 git 会写成 `"b/…\t…\344\270\255"`。
 * 八进制转义是**字节**，逐个拼回再按 UTF-8 解码，否则多字节文件名会碎。
 *
 * @param {string} value
 * @returns {string} 非引号路径原样返回
 */
export function unquoteGitPath(value) {
  const text = String(value ?? '')
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text
  const body = text.slice(1, -1)
  const bytes = []
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'))
      continue
    }
    const next = body[i + 1]
    if (next === undefined) break
    if (/[0-7]/.test(next)) {
      let digits = next
      i += 1
      while (digits.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) {
        digits += body[i + 1]
        i += 1
      }
      bytes.push(parseInt(digits, 8) & 0xff)
      continue
    }
    i += 1
    bytes.push(...Buffer.from(C_ESCAPES[next] ?? next, 'utf8'))
  }
  return Buffer.from(bytes).toString('utf8')
}

/** 找未转义的结束引号；找不到返回 -1。 */
function closingQuote(text, from) {
  for (let i = from + 1; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1
      continue
    }
    if (text[i] === '"') return i
  }
  return -1
}

/** `+++ b/路径` / `--- a/路径`：整行都是路径（引号路径后面可能跟制表符时间戳）。 */
function markerPath(line, marker, prefix) {
  let raw = line.slice(marker.length).replace(/\r$/, '')
  if (raw.startsWith('"')) {
    const end = closingQuote(raw, 0)
    if (end === -1) return ''
    raw = raw.slice(0, end + 1)
  } else {
    const tab = raw.indexOf('\t')
    if (tab !== -1) raw = raw.slice(0, tab)
  }
  const path = unquoteGitPath(raw)
  if (path === '/dev/null') return ''
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/** 引号或裸路径都接受；路径必须完整覆盖 text 且带预期前缀。 */
function headerToken(text, prefix) {
  if (text.length === 0) return null
  if (text.startsWith('"')) {
    if (closingQuote(text, 0) !== text.length - 1) return null
    const path = unquoteGitPath(text)
    return path.startsWith(prefix) ? path.slice(prefix.length) : null
  }
  return text.startsWith(prefix) ? text.slice(prefix.length) : null
}

/**
 * 从 `diff --git a/x b/x` 取 b 侧路径。含空格的路径 git **不加引号**，
 * 所以不能按空白切：逐个空格试切，要求两侧各自带 a/、b/ 前缀；
 * 两侧同名的那一刀优先（重命名时退化为第一刀）。
 */
function headerPath(header) {
  const rest = header.slice('diff --git '.length).replace(/\r$/, '')
  let fallback = null
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] !== ' ') continue
    const left = headerToken(rest.slice(0, i), 'a/')
    const right = headerToken(rest.slice(i + 1), 'b/')
    if (left === null || right === null) continue
    if (left === right) return right
    if (fallback === null) fallback = right
  }
  return fallback ?? ''
}

/**
 * 从段落里取仓库相对路径：优先 `+++`（变更后的路径，重命名时才对得上
 * `files`），再 `---`，最后退回 `diff --git` 头。
 */
function pathFromSection(lines) {
  const marker = (prefix) => {
    for (const line of lines) {
      if (!line.startsWith(`${prefix} `)) continue
      const path = markerPath(line, `${prefix} `, prefix === '+++' ? 'b/' : 'a/')
      if (path) return path
    }
    return ''
  }
  const after = marker('+++')
  if (after) return after
  const before = marker('---')
  if (before) return before
  const header = lines.find((line) => line.startsWith('diff --git '))
  return header ? headerPath(header) : ''
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
    // 文件名本身就写着片号与总片数：越界不是「缺片」，是记录坏了，直接点名。
    if (parsed.index < 1 || parsed.index > parsed.total) {
      throw new ContractError('E_RECORD', `分片记录文件名越界：第 ${parsed.index} 片（共 ${parsed.total} 片）: ${name}`)
    }
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
  const outOfRange = entries.filter(
    (entry) => !Number.isInteger(entry.index) || entry.index < 1 || entry.index > total,
  )
  if (outOfRange.length > 0) {
    throw new ContractError(
      'E_RECORD',
      `分片记录里有越界片号：第 ${outOfRange.map((entry) => entry.index).join('、')} 片（共 ${total} 片），拒绝合成`,
    )
  }
  if (absent.length > 0 || entries.length !== total) {
    const list = absent.length > 0 ? absent : Array.from({ length: total }, (_, i) => i + 1).filter(
      (index) => !entries.some((entry) => entry.index === index),
    )
    if (list.length === 0) {
      throw new ContractError(
        'E_RECORD',
        `分片记录数量与总片数不符（${entries.length} 条 / 共 ${total} 片），且有重复片号，拒绝合成`,
      )
    }
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

  // 各片必须来自同一次 diff。哈希用的是整份 diff（不是切片后的）：切片哈希
  // 天然片片不同，只有「整份」这个共同基准才能证明没人在中途换了 base。
  const hashes = ordered.map((entry) => entry.record?.shard?.diffSha256)
  const withoutHash = ordered.filter((_, i) => typeof hashes[i] !== 'string' || hashes[i].length === 0)
  if (withoutHash.length > 0) {
    throw new ContractError(
      'E_RECORD',
      `分片记录缺少 diff 哈希（第 ${withoutHash.map((entry) => entry.index).join('、')} 片），无法确认各片来自同一次 diff，拒绝合成`,
    )
  }
  const bases = unique(hashes)
  if (bases.length > 1) {
    const shown = bases.map((hash) => `${hash.slice(0, 15)}…`).join(' / ')
    throw new ContractError('E_RECORD', `分片记录来自不同的 diff（${shown}），拒绝合成`)
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
/**
 * 给分片记录补上 `shard` 字段。
 *
 * 记录**已经由共享包直接写到分片文件名**（`record --name`），所以这里只做「就地补字段」，
 * 不再有「先写规范名、再删掉」那段窗口——那段窗口里规范名指向的是单片判定，
 * 闸门若恰好在窗口内运行，单片 APPROVE 就能放行整份变更。
 */
export function finalizeShardRecord(target, { index, total, diffSha256 }) {
  let record
  try {
    record = JSON.parse(readFileSync(target, 'utf8'))
  } catch (error) {
    throw new ContractError('E_UNAVAILABLE', `读取分片记录失败: ${error.message}`)
  }
  // 纵深防御：文件名由请求里的 pr/head_sha 推导，记录内容由包从同一请求组装；
  // 两者理论上必然一致，但旧实现的名字取自 record 自身，新实现少了这层隐式保证，显式校验一次。
  const parsedName = parseShardRecordName(basename(target))
  if (parsedName === null || parsedName.pr !== record.pr || parsedName.headSha !== record.head_sha) {
    throw new ContractError(
      'E_RECORD',
      `分片记录内容与文件名不符: ${target}（记录 pr=${record.pr} sha=${String(record.head_sha).slice(0, 8)}）`,
    )
  }
  const sharded = {
    ...record,
    shard: { index, total, ...(diffSha256 ? { diffSha256 } : {}) },
  }
  const tmp = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(sharded, null, 2)}\n`, 'utf8')
    renameSync(tmp, target)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw new ContractError('E_UNAVAILABLE', `分片记录落盘失败: ${error.message}`)
  }
  return { file: target, record: sharded }
}

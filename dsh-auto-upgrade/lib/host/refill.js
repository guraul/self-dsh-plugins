/**
 * 实测结论回填（issue #300 的 P4）：把「冒烟结论 → 补丁」做成纯函数，不碰磁盘。
 *
 * - `buildRefillPlan()`：哪些插件该记什么结论、什么深度；
 * - `patchCompatibility()`：不重排整个文件，只插/换那一行（**保留 CRLF**——整份重排会炸出几百行假 diff）；
 */

/** 允许写进矩阵的深度，由浅到深（回填只看这四个值，别的一律当非法）。 */
const DEPTHS = ['L1', 'L2', 'L3', 'L4']

/**
 * 把冒烟结果翻成「该记什么」。
 *
 * 口径（与 #300 P3 一致）：
 * - **全量冒烟通过**（插件自己写了 `dsh.smoke` 且断言全过）→ `compatible` / **L2**
 * - **只有兜底三项通过**（`partial`，插件没写 `dsh.smoke`）→ `compatible` / **L1**
 *   ——装得上、也起来了，但行为没人断言过，不能算 L2
 * - **失败** → 不记结论（该走的路径是自动开 issue，不是把失败写进矩阵）
 * @param {{version: string, results: object[]}} input 冒烟结果。
 * @returns {{version: string, entries: {name: string, verdict: string, depth: string}[]}} 计划。
 */
export function buildRefillPlan(input) {
  const entries = []
  for (const result of input.results ?? []) {
    if (result.ok !== true) continue
    entries.push({
      name: result.name,
      verdict: 'compatible',
      depth: result.partial === true ? 'L1' : 'L2',
    })
  }
  return { version: input.version, entries }
}

/**
 * 在 JSON 文本里找 `"key": { … }` 这段对象，返回它的起止偏移（字符串感知的括号计数）。
 * @param {string} text 文本。
 * @param {string} key 键名。
 * @returns {{start: number, end: number}|undefined} 花括号的起止偏移（`end` 指向 `}`）。
 */
function findObjectRange(text, key) {
  const keyIndex = text.indexOf(`"${key}"`)
  if (keyIndex === -1) return undefined
  const open = text.indexOf('{', keyIndex)
  if (open === -1) return undefined
  let depth = 0
  let inString = false
  for (let i = open; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (char === '\\') i += 1
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return { start: open, end: i }
    }
  }
  return undefined
}

/**
 * 往一个对象字面量里写一个键值对：已有同名键就换值，没有就按文件现有缩进/换行插进去。
 *
 * **只动这一处**：不 parse + stringify，避免把 CRLF、缩进、键序全部重排。
 * @param {string} text 整个 JSON 文本。
 * @param {string} objectKey 目标对象名（如 `dshReleases`）。
 * @param {string} entryKey 要写的键（版本号）。
 * @param {string} value 要写的值。
 * @returns {string|undefined} 改好的文本；找不到目标对象时返回 undefined。
 */
export function upsertInObject(text, objectKey, entryKey, value) {
  const range = findObjectRange(text, objectKey)
  if (range === undefined) return undefined
  const body = text.slice(range.start, range.end + 1)
  const escaped = entryKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const existing = new RegExp(`("${escaped}"\\s*:\\s*)"[^"]*"`)
  if (existing.test(body)) {
    const replaced = body.replace(existing, `$1"${value}"`)
    return text.slice(0, range.start) + replaced + text.slice(range.end + 1)
  }
  // 插到最后一个非空行之后，沿用那一行的缩进与换行风格（CRLF 文件就插 CRLF）。
  const inner = body.slice(1, -1)
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const indentMatch = /(\r?\n)([ \t]+)"/.exec(inner)
  const indent = indentMatch === null ? '        ' : indentMatch[2]
  const trimmed = inner.replace(/\s+$/, '')
  const needsComma = trimmed.trim() !== '' && !trimmed.trim().endsWith(',')
  const withComma = needsComma ? `${trimmed},` : trimmed
  const rebuilt = `{${withComma}${newline}${indent}"${entryKey}": "${value}"${newline}${indent.slice(2) || '      '}}`
  return text.slice(0, range.start) + rebuilt + text.slice(range.end + 1)
}

/**
 * 读某个对象里已有的值。
 * @param {string} text 文本。
 * @param {string} objectKey 对象名。
 * @param {string} entryKey 键名。
 * @returns {string|undefined} 已有值。
 */
export function readInObject(text, objectKey, entryKey) {
  const range = findObjectRange(text, objectKey)
  if (range === undefined) return undefined
  const escaped = entryKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matched = new RegExp(`"${escaped}"\\s*:\\s*"([^"]*)"`).exec(text.slice(range.start, range.end + 1))
  return matched === null ? undefined : matched[1]
}

/**
 * 把一条结论写进插件 `package.json` 的 `dsh.compatibility.dshReleases` 与 `dshDepth`。
 * @param {object} input 输入。
 * @param {string} input.text package.json 原文。
 * @param {string} input.version dsh 版本。
 * @param {string} input.verdict `compatible` / `incompatible`。
 * @param {string} input.depth 深度，`L1`–`L4`。
 * @returns {{text: string, changed: boolean, depth: string}} 结果（`depth` 是**实际采用**的深度，可能比入参更深）。
 * @throws {Error} 没找到 `dsh.compatibility` 结构，或深度非法。
 */
export function patchCompatibility(input) {
  if (!DEPTHS.includes(input.depth)) throw new Error(`非法的深度：${String(input.depth)}`)
  // **深度只升不降**：已有 L3（编译期）时，再来一次只到 L2 的冒烟不该把它改浅——
  // 那等于把「验过更多」的记录丢掉。结论本身（compatible / incompatible）照写。
  const recorded = readInObject(input.text, 'dshDepth', input.version)
  const depth = DEPTHS.includes(recorded) && DEPTHS.indexOf(recorded) > DEPTHS.indexOf(input.depth)
    ? recorded
    : input.depth
  const withVerdict = upsertInObject(input.text, 'dshReleases', input.version, input.verdict)
  if (withVerdict === undefined) throw new Error('package.json 里没有 dsh.compatibility.dshReleases')
  const withDepth = upsertInObject(withVerdict, 'dshDepth', input.version, depth)
  if (withDepth === undefined) throw new Error('package.json 里没有 dsh.compatibility.dshDepth')
  // 写盘前的最后一道闸：补丁必须还能被解析，否则宁可报错也不能把文件写坏。
  JSON.parse(withDepth)
  return { text: withDepth, changed: withDepth !== input.text, depth }
}

/**
 * 组装 `docs/COMPATIBILITY.md` 矩阵表的一行。
 * @param {object} input 输入：`name` / `packageVersion` / `version` / `depth` / `date` / `how`。
 * @param {string} input.name 包名。
 * @param {string} input.packageVersion 插件版本。
 * @param {string} input.version 验过的 dsh 版本。
 * @param {string} input.depth 深度。
 * @param {string} [input.date] 日期（`YYYY-MM-DD`）。
 * @param {string} [input.how] 怎么验的。
 * @returns {string} 一行 markdown。
 */
export function compatRow(input) {
  const how = input.how ?? ({
    L1: '装配/兜底三项通过，插件未写 dsh.smoke（行为未验证）',
    L2: '兜底三项 + 插件自报断言通过',
    L3: '沿用之前的更深记录（编译期已验），本次补冒烟',
    L4: '沿用之前的更深记录（业务链路已实测）',
  }[input.depth] ?? `本次回填：${String(input.depth)}`)
  return `| \`${input.name}\` | \`${input.packageVersion}\` | \`${input.version}\` | **${input.depth}** | ✅ 通过 | ${input.date ?? ''} | ${how} |`
}

/**
 * 把一行插进矩阵表末尾（表头与其余行不动）。
 * @param {string} text COMPATIBILITY.md 原文。
 * @param {string} row 要插的行。
 * @returns {string|undefined} 新文本；找不到矩阵表时 undefined。
 */
export function appendCompatRow(text, row) {
  // 必须用 `\r?\n` 切：`split('\n')` 会把 `\r` 留在行尾，再按 CRLF 拼回去就成了 `\r\r\n`。
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const header = lines.findIndex((line) => line.startsWith('| 插件 |'))
  if (header === -1) return undefined
  let last = header
  for (let i = header + 1; i < lines.length && lines[i].startsWith('|'); i += 1) last = i
  lines.splice(last + 1, 0, row)
  return lines.join(newline)
}

/**
 * 实测结论回填：写盘 + 开 PR（issue #300 的 P4 下半）。
 *
 * 上半（`refill.js`）只算补丁；这里负责把它安全地落到仓库里。两条硬约束：
 *
 * 1. **绝不碰用户的工作区**：所有改动都在一个临时 git worktree 里做（从 `origin/main`
 *    切出来），提交、推分支、开 PR 之后把 worktree 删掉。用户正在改的文件一个都不动。
 * 2. **任何一步失败都清场**：worktree 必须在 `finally` 里移除，否则会一直挂在
 *    `git worktree list` 里，还会让后续的 `merge --ff-only` 卡住。
 *
 * 全部 I/O 通过注入的 `git` / `gh` 执行器完成，编排本身可单测。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 组装这次回填的提交信息与 PR 内容（纯函数）。
 * @param {{version: string, entries: {name: string, depth: string}[]}} input 输入。
 * @returns {{branch: string, title: string, body: string}} 提交与 PR 元数据。
 */
export function planRefillPr(input) {
  const changed = input.entries.filter((entry) => entry.changed !== false)
  const names = changed.map((entry) => entry.name)
  const branch = `chore/compat-refill-${input.version}`
  const title = `chore(compat): 回填 ${input.version} 的实测结论（自动，${String(changed.length)} 个插件）`
  const body = [
    `按冒烟结果回填 \`dsh.compatibility.dshReleases\` / \`dshDepth\` 与 \`docs/COMPATIBILITY.md\`。`,
    '',
    '| 插件 | 结论 | 深度 |',
    '|---|---|---|',
    ...changed.map((entry) => `| \`${entry.name}\` | \`compatible\` | **${entry.depth}** |`),
    '',
    `> 由 dsh-auto-upgrade 在 ${new Date().toISOString()} 自动生成；人工只需核对表格。`,
    `> 涉及插件：${names.join('、')}`,
    '',
  ].join('\n')
  return { branch, title, body }
}

/**
 * 在临时 worktree 里跑一次回填并开 PR。
 *
 * @param {object} options 输入。
 * @param {string} options.repoRoot 仓库根（`<repo>`，其下必须有 `.git`）。
 * @param {string} options.worktreePath worktree 容器（一般 `<repo>/.worktrees`）。
 * @param {string} options.version 当前 dsh 版本。
 * @param {{name: string, relDir: string, depth: string, changed?: boolean, row?: string}[]} options.entries 要回填的插件（`relDir` 是仓库内相对路径，`row` 是矩阵行）。
 * @param {(args: string[], cwd: string) => Promise<{ok: boolean, stdout?: string, error?: string}>} options.git git 执行器。
 * @param {(args: string[], cwd: string) => Promise<{ok: boolean, stdout?: string, error?: string}>} options.gh gh 执行器（**要带 cwd**，在 worktree 里跑）。
 * @param {(text: string, row: string) => string|undefined} options.appendRow 往矩阵表插一行（`refill.js` 的 `appendCompatRow`）。
 * @param {(input: {text: string, version: string, verdict: string, depth: string}) => {text: string, changed: boolean, depth: string}} options.patch 补丁函数（即 `refill.js` 的 `patchCompatibility`）。
 * @param {number} [options.now] 时间戳（测试可注入）。
 * @returns {Promise<{ok: boolean, skipped?: boolean, branch?: string, prUrl?: string, detail?: string}>} 结果。
 */
export async function openRefillPullRequest(options) {
  const changed = options.entries.filter((entry) => entry.changed !== false)
  if (changed.length === 0) return { ok: true, skipped: true, detail: '没有需要回填的结论（都已是最新）' }
  const { branch, title, body } = planRefillPr({ version: options.version, entries: changed })
  const stamp = String(options.now ?? Date.now())
  const path = join(options.worktreePath, `refill-${options.version.replace(/[^\w.-]/g, '_')}-${stamp}`)
  let created = false
  try {
    await mkdir(options.worktreePath, { recursive: true })
    // origin/main 可能陈旧：先 fetch，否则会基于过期的 main 开 PR 或 push 失败。
    const fetched = await options.git(['fetch', 'origin', 'main'], options.repoRoot)
    if (!fetched.ok) return { ok: false, detail: `fetch origin main 失败：${String(fetched.error)}` }
    // 从 origin/main 切，保证不带上用户工作区的任何未提交改动。
    const added = await options.git(['worktree', 'add', '-b', branch, path, 'origin/main'], options.repoRoot)
    if (!added.ok) return { ok: false, detail: `创建 worktree 失败：${String(added.error)}` }
    created = true

    const applied = []
    const rows = []
    for (const entry of changed) {
      // `relDir` 是**仓库内相对路径**（worktree 里插件在 `<path>/<relDir>`，不是宿主上的绝对路径）。
      const file = join(path, entry.relDir, 'package.json')
      const patched = options.patch({
        text: await readFile(file, 'utf8'),
        version: options.version,
        verdict: 'compatible',
        depth: entry.depth,
      })
      await writeFile(file, patched.text)
      applied.push({ name: entry.name, depth: patched.depth })
      if (typeof entry.row === 'string') rows.push(entry.row)
    }

    // 本仓纪律：verdict 要**同时**落 package.json 与 docs/COMPATIBILITY.md。
    const docsFile = join(path, 'docs', 'COMPATIBILITY.md')
    try {
      let doc = await readFile(docsFile, 'utf8')
      for (const row of rows) {
        const next = options.appendRow(doc, row)
        if (next !== undefined) doc = next
      }
      await writeFile(docsFile, doc)
    } catch {
      // 文档不在这个 worktree 里就只回填 package.json，PR 正文会如实说明。
    }

    const staged = await options.git(['add', '-A'], path)
    if (!staged.ok) return { ok: false, detail: `git add 失败：${String(staged.error)}` }
    const committed = await options.git(['commit', '-m', `chore(compat): 回填 ${options.version} 的实测结论`], path)
    if (!committed.ok) {
      // 记录已经是最新的：不是错误，干净地当成「无需回填」。
      // git 把「nothing to commit」打在 **stdout**，只认 error/stderr 会漏（会误报 500）。
      const detail = `${String(committed.stdout ?? '')}\n${String(committed.error ?? '')}`
      if (/nothing to commit|no changes added|nothing added to commit/i.test(detail)) {
        return { ok: true, skipped: true, detail: '记录已是最新，无需回填' }
      }
      return { ok: false, detail: `git commit 失败：${detail.trim()}` }
    }
    const pushed = await options.git(['push', 'origin', `${branch}:${branch}`], path)
    if (!pushed.ok) return { ok: false, detail: `git push 失败：${String(pushed.error)}` }
    // **必须带 `--head` 且在 worktree 里跑**：否则 gh 会按宿主 cwd 的当前分支开 PR
    // ——主工作区在 main 时必失败，在你的开发分支上则会把未审核的 WIP 开成 PR。
    const pr = await options.gh(['pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body', body], path)
    if (!pr.ok) return { ok: false, branch, detail: `gh pr create 失败：${String(pr.error)}` }

    const matched = /https:\/\/\S+/.exec(String(pr.stdout ?? ''))
    return { ok: true, branch, ...(matched === null ? {} : { prUrl: matched[0] }), detail: `回填 ${String(applied.length)} 个插件` }
  } finally {
    if (created) {
      // 清场：worktree 留着会一直挂在 `git worktree list` 里，还会卡住后续的 ff 合并。
      await options.git(['worktree', 'remove', '--force', path], options.repoRoot).catch(() => {})
      await options.git(['worktree', 'prune'], options.repoRoot).catch(() => {})
    }
  }
}

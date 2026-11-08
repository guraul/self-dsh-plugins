/**
 * `/s` 列表的分页与截断——纯函数，便于单测（issue #390）。
 *
 * 这些规则原来埋在 `sessionListText` 闭包里（依赖 `ctx.get` 与 `activePinFor`），
 * 分页边界、末页提示、超长标题截断只能靠人工验证，没有回归护栏。
 */

/** 一条待渲染的会话条目：`id` 用于绑定，`text` 是渲染出来的两行。 */
export interface ListEntry {
  id: string
  text: string
}

/** 一页：本页显示的 id 与行。 */
export interface ListPage {
  ids: string[]
  lines: string[]
}

/** 按 UTF-8 字节数（含行尾换行）计长，和企微的 2048 字节上限同一口径。 */
export function bytesOf(text: string): number {
  return Buffer.byteLength(`${text}\n`, 'utf8')
}

/**
 * 把「标题行 + id 行」压到预算内：**先截标题，保住 id 行**。
 *
 * 否则整条溢出后会被 `replyCommand` 在 1800 字节处截断，正好切掉 id 行和页脚，
 * 用户又拿不到 id（#372 review 轮 1 抓到的正是这个）。
 * @param head 标题行（不含 id 行）。
 * @param idLine id 行（以换行开头）。
 * @param budget 这一条允许占用的字节数。
 * @returns 放得下的标题行（必要时带 `…`）与 id 行拼起来的完整文本。
 */
export function fitEntry(head: string, idLine: string, budget: number): string {
  const room = budget - bytesOf(idLine)
  if (bytesOf(head) <= room) return `${head}${idLine}`
  // 按码点切，避免切出孤立代理项（半个 emoji）；`…` 自己也占 3 字节，必须一起算进去，
  // 否则截完仍然超预算（#390 的单测当场抓到的）。
  const chars = [...head]
  let cut = chars
  while (cut.length > 0 && bytesOf(`${cut.join('')}…`) > room) cut = cut.slice(0, -1)
  return `${cut.join('')}…${idLine}`
}

/**
 * 按字节预算把条目切成页。
 *
 * 整条放不下就翻页，不硬砍；单条自身超预算时独占一页（由 {@link fitEntry} 先压过）。
 * @param entries 待分页的条目（顺序即全局序号）。
 * @param budget 每页可用字节数（已扣掉页眉与页脚）。
 * @returns 至少一页；空输入返回空数组。
 */
export function buildListPages(entries: ListEntry[], budget: number): ListPage[] {
  const pages: ListPage[] = []
  let current: { ids: string[]; lines: string[]; used: number } = { ids: [], lines: [], used: 0 }
  for (const entry of entries) {
    const entryBytes = bytesOf(entry.text)
    if (current.ids.length > 0 && current.used + entryBytes > budget) {
      pages.push({ ids: current.ids, lines: current.lines })
      current = { ids: [], lines: [], used: 0 }
    }
    current.ids.push(entry.id)
    current.lines.push(...entry.text.split('\n'))
    current.used += entryBytes
  }
  if (current.ids.length > 0) pages.push({ ids: current.ids, lines: current.lines })
  return pages
}

/**
 * 取第 `page` 页；越界与负数都按取模回绕（`/s more` 在末页会回到第 1 页）。
 * @param pages {@link buildListPages} 的结果。
 * @param page 请求的页码（0 起）。
 * @returns 归一后的页码与该页；`pages` 为空时返回第 0 页的空页。
 */
export function pickPage(pages: ListPage[], page: number): { index: number; total: number; page: ListPage } {
  const total = Math.max(pages.length, 1)
  const index = ((Math.trunc(page) % total) + total) % total
  return { index, total, page: pages[index] ?? { ids: [], lines: [] } }
}

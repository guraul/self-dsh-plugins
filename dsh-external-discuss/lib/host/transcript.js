/**
 * 会话 → 可投递文本。
 *
 * 数据来源是宿主的会话投影（`session.deriveMessages()`），它把 append-only 日志折算成
 * 模型实际看到的消息序列 —— 比抓页面 DOM 干净，也不会把按钮、时间戳这些 UI 噪声带进去。
 */

/** 默认字符上限：网页端输入框会自动折叠，这里只防住荒谬的超长会话。 */
export const DEFAULT_MAX_CHARS = 200000

/**
 * 取一条消息里对人有意义的文本。
 * @param {readonly {type?: string, text?: string}[]} content 消息内容块。
 * @returns {string} 拼接后的文本。
 */
function messageText(content) {
  const parts = []
  for (const block of content ?? []) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[图片]')
  }
  return parts.join('\n\n').trim()
}

/**
 * 把会话折算成「我 / 助手」的对话记录。
 * @param {{ deriveMessages: () => readonly {role: string, content: readonly {type?: string, text?: string}[]}[] }} session 会话实例。
 * @param {{maxChars?: number}} [options] 选项。
 * @returns {{messages: {role: string, text: string}[], text: string, truncated: boolean, chars: number}} 投递内容。
 */
export function collectConversation(session, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0 ? options.maxChars : DEFAULT_MAX_CHARS
  /** @type {{role: string, text: string}[]} */
  const messages = []
  for (const message of session.deriveMessages()) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = messageText(message.content)
    if (text.length === 0) continue
    messages.push({ role: message.role, text })
  }
  const full = messages
    .map((message) => `${message.role === 'user' ? '## 我' : '## 助手'}\n\n${message.text}`)
    .join('\n\n---\n\n')
  const truncated = full.length > maxChars
  const text = truncated ? `${full.slice(0, maxChars)}\n\n…（内容过长，已截断）` : full
  return { messages, text, truncated, chars: text.length }
}

/**
 * 会话没有标题时的兜底：取第一条用户消息的首个非空行。
 * @param {{role: string, text: string}[]} messages 会话消息。
 * @returns {string} 标题。
 */
export function fallbackTitle(messages) {
  const first = messages.find((message) => message.role === 'user')?.text ?? ''
  const line = first
    .split('\n')
    .map((candidate) => candidate.replace(/^#+\s*/, '').trim())
    .find((candidate) => candidate.length > 0)
  if (line === undefined) return ''
  return line.length > 40 ? `${line.slice(0, 40)}…` : line
}

/**
 * 后台 service worker：DSH 页面 → 清言页面的搬运工。
 *
 * 职责只有三件：找到（必要时打开）清言标签页、把它切到前台、把内容转交给它的 content script。
 * 内容本身不解析、不落盘、不联网——纯粹的本机标签页之间转发。
 */

const QINGYAN_MATCH = 'https://chatglm.cn/*'
const QINGYAN_URL = 'https://chatglm.cn/'
/** 新建标签页后等内容脚本就绪的重试节奏。 */
const READY_RETRY_MS = 400
const READY_RETRIES = 25

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 找已打开的（优先已激活的）清言标签页。
 * @returns {Promise<chrome.tabs.Tab | undefined>} 标签页。
 */
async function findQingyanTab() {
  const tabs = await chrome.tabs.query({ url: QINGYAN_MATCH })
  if (tabs.length === 0) return undefined
  return tabs.find((tab) => tab.active === true) ?? tabs[0]
}

/**
 * 等标签页加载完成。
 * @param {number} tabId 标签页 id。
 * @returns {Promise<void>} 完成。
 */
async function waitForComplete(tabId) {
  for (let index = 0; index < READY_RETRIES; index += 1) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (tab.status === 'complete') return
    } catch {
      return
    }
    await sleep(READY_RETRY_MS)
  }
}

/**
 * 给标签页发消息，内容脚本还没注入时重试。
 * @param {number} tabId 标签页 id。
 * @param {unknown} message 消息。
 * @returns {Promise<object>} 内容脚本的回答。
 */
async function sendWithRetry(tabId, message) {
  let lastError = ''
  for (let index = 0; index < READY_RETRIES; index += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message)
      if (response !== undefined && response !== null) return response
      lastError = '内容脚本没有返回结果'
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(READY_RETRY_MS)
  }
  return { ok: false, detail: `无法连接清言页面内容脚本：${lastError}` }
}

/**
 * 处理一次转发。
 * @param {{target?: string, title?: string, text?: string}} message 转发请求。
 * @returns {Promise<{ok: boolean, detail: string}>} 结果。
 */
async function forward(message) {
  const target = message.target ?? 'qingyan'
  if (target !== 'qingyan') return { ok: false, detail: `暂不支持的目标：${target}` }
  if (typeof message.text !== 'string' || message.text.length === 0) {
    return { ok: false, detail: '没有可投递的会话内容' }
  }

  let tab = await findQingyanTab()
  if (tab === undefined || tab.id === undefined) {
    tab = await chrome.tabs.create({ url: QINGYAN_URL, active: true })
    if (tab.id === undefined) return { ok: false, detail: '无法打开清言页面' }
    await waitForComplete(tab.id)
    await sleep(1200)
  } else {
    await chrome.tabs.update(tab.id, { active: true })
    if (typeof tab.windowId === 'number') {
      try {
        await chrome.windows.update(tab.windowId, { focused: true })
      } catch {
        // 窗口聚焦失败不影响投递
      }
    }
  }

  return sendWithRetry(tab.id, {
    type: 'qingyan:ingest',
    title: typeof message.title === 'string' ? message.title : '',
    text: message.text,
  })
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message === null || typeof message !== 'object' || message.type !== 'forward') return undefined
  forward(message)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, detail: error instanceof Error ? error.message : String(error) }))
  // 异步回答
  return true
})

// content script 可用性探针：DSH 页问一句「扩展在不在」。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message === null || typeof message !== 'object' || message.type !== 'ping') return undefined
  sendResponse({ ok: true, detail: 'extension alive' })
  return undefined
})

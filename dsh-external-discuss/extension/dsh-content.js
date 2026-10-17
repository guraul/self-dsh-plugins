/**
 * DSH 页面上的 content script：页面 ↔ 扩展的桥。
 *
 * 页面里的插件按钮只做一件事：window.postMessage 一个约定信封。
 * 这里把它转给后台，再把后台的结果回投给页面（插件据此显示「已投递 / 失败原因」）。
 *
 * 刻意不读页面内容、不碰 DOM——投递正文由插件从宿主路由取，避免我们的脚本去猜渲染结构。
 */

const SOURCE = 'dsh-external-discuss'

window.addEventListener('message', (event) => {
  // 只认本窗口发出的、带约定频道名的信封
  if (event.source !== window) return
  const data = event.data
  if (data === null || typeof data !== 'object' || data.source !== SOURCE || data.type !== 'send') return

  const reply = (ok, detail) => {
    window.postMessage({ source: SOURCE, type: 'ack', ok, detail, target: data.target }, '*')
  }

  try {
    chrome.runtime.sendMessage(
      {
        type: 'forward',
        target: typeof data.target === 'string' ? data.target : 'qingyan',
        title: typeof data.title === 'string' ? data.title : '',
        text: typeof data.text === 'string' ? data.text : '',
      },
      (response) => {
        const failure = chrome.runtime.lastError
        if (failure !== undefined && failure !== null) {
          reply(false, `扩展后台无响应：${failure.message ?? ''}`)
          return
        }
        reply(response?.ok === true, typeof response?.detail === 'string' ? response.detail : '')
      },
    )
  } catch (error) {
    reply(false, `扩展运行时不可用：${error instanceof Error ? error.message : String(error)}`)
  }
})

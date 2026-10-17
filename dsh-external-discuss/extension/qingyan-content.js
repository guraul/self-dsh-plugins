/**
 * 清言页面（chatglm.cn）上的 content script：真正干活的一端。
 *
 * 一次投递按用户的实测流程走四步：
 *   1. 点左侧目录树上的「新对话」
 *   2. 把新会话按 DSH 会话标题重命名
 *   3. 把长正文粘进右下方输入框（网页端会自动折叠，不做截断）
 *   4. 点发送
 *
 * ⚠️ 清言是第三方页面，选择器会随它改版失效。所以这里：
 *   - 一律按「可见元素的文本/aria-label」定位，不写哈希类名；
 *   - 每一步失败都如实返回是哪一步、当时看到了什么，绝不静默错投；
 *   - 内置 probe 探针，出问题时把现场 DOM 摘要打回来，便于快速修选择器。
 */
;(() => {
  const CONFIG = {
    /** 「新对话」入口的候选文本。 */
    newChatTexts: ['新对话', '新建对话', '开启新对话', '新的对话', '新建会话', '开启新对话'],
    /** 新会话生成后的默认标题候选（用来在左侧树里认出这一条）。 */
    defaultTitleTexts: ['新的对话', '新对话', '新建对话', '新的会话', '未命名对话'],
    /** 重命名菜单项的候选文本。 */
    renameTexts: ['重命名', '重命名对话', '修改名称', '改名'],
    /** 重命名确认按钮的候选文本。 */
    confirmTexts: ['确定', '确认', '保存', '完成', '提交'],
    /** 发送按钮的候选文本。 */
    sendTexts: ['发送'],
    /** 每步之后的静置时间。 */
    stepDelayMs: 700,
    /** 是否在页面控制台打日志（排障时看得到整条流水）。 */
    debug: true,
  }

  const log = (...args) => {
    if (CONFIG.debug) console.log('[dsh→清言]', ...args)
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

  function isVisible(element) {
    if (!(element instanceof Element)) return false
    const rect = element.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return false
    const style = getComputedStyle(element)
    if (style.visibility === 'hidden' || style.display === 'none') return false
    return Number(style.opacity === '' ? 1 : style.opacity) !== 0
  }

  const allVisible = (selector, root = document) => [...root.querySelectorAll(selector)].filter(isVisible)

  const depth = (element) => {
    let levels = 0
    let cursor = element
    while (cursor.parentElement !== null) {
      levels += 1
      cursor = cursor.parentElement
    }
    return levels
  }

  const area = (element) => {
    const rect = element.getBoundingClientRect()
    return rect.width * rect.height
  }

  /** 命中文本的可见元素里，取最深（最内层）的那个，避免点到包裹容器。 */
  function findByTexts(texts, selector) {
    const hits = allVisible(selector).filter((element) => texts.includes(norm(element.textContent)))
    if (hits.length === 0) return null
    hits.sort((left, right) => depth(right) - depth(left) || area(left) - area(right))
    return hits[0]
  }

  /** 命中 aria-label 的可见元素。 */
  function findByAria(pattern, selector) {
    const hits = allVisible(selector).filter((element) => pattern.test(element.getAttribute('aria-label') ?? ''))
    return hits.length === 0 ? null : hits[hits.length - 1]
  }

  /** 从命中元素向上找到真正可点的祖先。 */
  function clickableFor(element) {
    return element.closest('button, [role="button"], [role="menuitem"], a, li') ?? element
  }

  /** 尽量模拟真实指针序列地点击。 */
  function click(element) {
    const target = clickableFor(element)
    target.scrollIntoView({ block: 'center' })
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent
      target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true }))
    }
    target.click()
    log('clicked', target.tagName, norm(target.textContent).slice(0, 24))
  }

  /** 悬停（会话条目上的操作按钮通常要 hover 才出现）。 */
  function hover(element) {
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent
      element.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true }))
    }
  }

  function pressEnter(element) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      element.dispatchEvent(
        new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }),
      )
    }
  }

  /** 用原生 setter 写值，绕过 React 受控组件的值拦截。 */
  function setNativeValue(element, value) {
    const prototype =
      element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : element.tagName === 'INPUT' ? HTMLInputElement.prototype : null
    if (prototype !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
      if (descriptor !== undefined && typeof descriptor.set === 'function') {
        descriptor.set.call(element, value)
        element.dispatchEvent(new Event('input', { bubbles: true }))
        return
      }
    }
    element.textContent = value
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
  }

  /**
   * 往输入框里塞长文本，按可靠度依次尝试三种策略，并逐一验证是否真的进去了。
   * @param {Element} element 输入框。
   * @param {string} text 正文。
   * @returns {string} 生效的策略名。
   */
  function insertIntoComposer(element, text) {
    element.focus()
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
      setNativeValue(element, text)
      return 'value-setter'
    }

    // 策略 1：execCommand —— 会产生真实的 beforeinput/input 事件，富文本编辑器最认这个
    try {
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(element)
      range.collapse(false)
      selection?.removeAllRanges()
      selection?.addRange(range)
      if (document.execCommand('insertText', false, text) && norm(element.textContent).length > 0) return 'execCommand'
    } catch (error) {
      log('execCommand 失败', error)
    }

    // 策略 2：伪造粘贴事件
    try {
      const data = new DataTransfer()
      data.setData('text/plain', text)
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
      if (norm(element.textContent).length > 0) return 'paste-event'
    } catch (error) {
      log('paste 事件失败', error)
    }

    // 策略 3：直接改内容 + input 事件（最脏，但至少能让下一跳看见文本）
    element.textContent = text
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
    return 'textContent'
  }

  /** 找右下方的主输入框：可见的 contenteditable / textarea 里面积最大的那个。 */
  function findComposer() {
    const candidates = allVisible('div[contenteditable="true"], textarea, [role="textbox"]').filter(
      (element) => element.getAttribute('contenteditable') !== 'false' && element.getAttribute('aria-hidden') !== 'true',
    )
    if (candidates.length === 0) return null
    const lowerHalf = candidates.filter((element) => element.getBoundingClientRect().top > window.innerHeight * 0.4)
    const pool = lowerHalf.length > 0 ? lowerHalf : candidates
    pool.sort((left, right) => area(right) - area(left))
    return pool[0]
  }

  /** 左侧会话列表里的目标条目。 */
  function findConversationRow() {
    const inLeftRail = (element) => element.getBoundingClientRect().left < 360
    const selector = 'div, span, a, li, [role="treeitem"], [role="option"], [role="listitem"]'

    const byDefaultTitle = allVisible(selector)
      .filter(inLeftRail)
      .filter((element) => CONFIG.defaultTitleTexts.includes(norm(element.textContent)))
    if (byDefaultTitle.length > 0) {
      const leaf = byDefaultTitle.sort((left, right) => depth(right) - depth(left))[0]
      return leaf.closest('[role="treeitem"], [role="listitem"], li, [class*="item"], [class*="conversation"], [class*="session"]') ?? leaf
    }

    // 兜底：左侧最靠上、且带操作按钮的条目
    const rows = allVisible('[role="treeitem"], [role="listitem"], li')
      .filter(inLeftRail)
      .filter((element) => element.querySelector('button, [role="button"], svg') !== null)
    if (rows.length === 0) return null
    rows.sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)
    return rows[0]
  }

  /** 会话条目上的「更多」按钮。 */
  function findRowMoreButton(row) {
    const byAria = [...row.querySelectorAll('button, [role="button"]')].filter((element) =>
      /更多|更多操作|more|菜单|menu/i.test(element.getAttribute('aria-label') ?? ''),
    )
    if (byAria.length > 0) return byAria[byAria.length - 1]
    const buttons = [...row.querySelectorAll('button, [role="button"]')]
    if (buttons.length > 0) return buttons[buttons.length - 1]
    // 有些实现把操作按钮放在行的兄弟节点里
    const parent = row.parentElement
    if (parent !== null) {
      const siblings = [...parent.querySelectorAll('button, [role="button"]')]
      if (siblings.length > 0) return siblings[siblings.length - 1]
    }
    return null
  }

  /** 重命名弹层里的文本输入框。 */
  function findRenameInput() {
    const inputs = allVisible('input[type="text"], input:not([type]), textarea, div[contenteditable="true"]')
    if (inputs.length === 0) return null
    inputs.sort((left, right) => area(right) - area(left))
    return inputs[0]
  }

  class StepError extends Error {
    constructor(step, message) {
      super(message)
      this.name = 'StepError'
      this.step = step
    }
  }

  /** 第一步：点「新对话」。 */
  async function ensureNewChat(steps) {
    const entry = findByTexts(CONFIG.newChatTexts, 'button, [role="button"], a, div, span')
    if (entry === null) throw new StepError('new-chat', '找不到「新对话」入口')
    click(entry)
    steps.push('已点击「新对话」')
    await sleep(CONFIG.stepDelayMs * 1.5)
  }

  /** 第二步：按标题重命名新会话。失败不致命，但要如实记进结果。 */
  async function renameConversation(title, steps) {
    if (title.length === 0) {
      steps.push('标题为空，跳过重命名')
      return
    }
    const row = findConversationRow()
    if (row === null) throw new StepError('rename', '左侧会话列表里找不到新建的会话')
    hover(row)
    await sleep(300)

    let opened = false
    const more = findRowMoreButton(row)
    if (more !== null) {
      click(more)
      await sleep(400)
      opened = findByTexts(CONFIG.renameTexts, 'button, [role="menuitem"], li, div, span, a') !== null
    }
    if (!opened) {
      // 退一步：右键菜单
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true }))
      await sleep(400)
    }

    const renameItem = findByTexts(CONFIG.renameTexts, 'button, [role="menuitem"], li, div, span, a')
    if (renameItem === null) throw new StepError('rename', '打开的操作菜单里找不到「重命名」')
    click(renameItem)
    await sleep(400)

    const input = findRenameInput()
    if (input === null) throw new StepError('rename', '重命名后没出现输入框')
    input.focus()
    setNativeValue(input, title)
    await sleep(200)

    const confirm = findByTexts(CONFIG.confirmTexts, 'button, [role="button"]')
    if (confirm !== null) click(confirm)
    else pressEnter(input)
    await sleep(400)
    steps.push(`已重命名为「${title}」`)
  }

  /** 第三步：粘贴正文。 */
  async function pastePrompt(text, steps) {
    const composer = findComposer()
    if (composer === null) throw new StepError('paste', '找不到右下方输入框')
    const strategy = insertIntoComposer(composer, text)
    await sleep(CONFIG.stepDelayMs)
    const landed = norm(composer.textContent ?? composer.value ?? '').length
    steps.push(`已用 ${strategy} 写入正文（${landed} 字可见）`)
    if (landed === 0) throw new StepError('paste', `正文没进输入框（策略 ${strategy}）`)
  }

  /** 第四步：发送。 */
  async function clickSend(steps) {
    const button =
      findByAria(/发送|send/i, 'button, [role="button"]') ?? findByTexts(CONFIG.sendTexts, 'button, [role="button"]')
    if (button !== null) {
      click(button)
      steps.push('已点击发送')
      return
    }
    const composer = findComposer()
    if (composer === null) throw new StepError('send', '找不到发送按钮，也找不到输入框')
    composer.focus()
    pressEnter(composer)
    steps.push('找不到发送按钮，已用回车键发送')
  }

  /**
   * 一次完整投递。
   * @param {{title?: string, text: string}} message 请求。
   * @returns {Promise<{ok: boolean, detail: string, steps?: string[]}>} 结果。
   */
  async function ingest(message) {
    const steps = []
    log('收到投递请求', { title: message.title, chars: message.text?.length ?? 0 })
    try {
      await ensureNewChat(steps)
      try {
        await renameConversation(typeof message.title === 'string' ? message.title : '', steps)
      } catch (error) {
        // 重命名只是锦上添花：失败也要把正文送到
        steps.push(`重命名失败（已继续）：${error instanceof Error ? error.message : String(error)}`)
      }
      await pastePrompt(message.text, steps)
      await clickSend(steps)
      log('投递完成', steps)
      return { ok: true, detail: steps.join(' → '), steps }
    } catch (error) {
      const step = error instanceof StepError ? error.step : 'unknown'
      const detail = error instanceof Error ? error.message : String(error)
      log('投递失败', step, detail, steps)
      return { ok: false, detail: `[${step}] ${detail}（已完成：${steps.join(' → ') || '无'}）`, steps }
    }
  }

  /** 现场 DOM 摘要：选择器失效时用它校准，而不是靠猜。 */
  function probe() {
    const describe = (element) => {
      const rect = element.getBoundingClientRect()
      return {
        tag: element.tagName.toLowerCase(),
        text: norm(element.textContent).slice(0, 40),
        aria: element.getAttribute('aria-label') ?? '',
        cls: String(element.className ?? '').slice(0, 60),
        at: `${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
      }
    }
    return {
      url: location.href,
      title: document.title,
      buttons: allVisible('button, [role="button"]').slice(0, 40).map(describe),
      editables: allVisible('div[contenteditable="true"], textarea, [role="textbox"]').slice(0, 15).map(describe),
      inputs: allVisible('input').slice(0, 15).map(describe),
      leftRail: allVisible('div, span, a, li')
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          return rect.left < 360 && norm(element.textContent).length > 0 && norm(element.textContent).length < 30
        })
        .slice(0, 40)
        .map(describe),
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message === null || typeof message !== 'object') return undefined
    if (message.type === 'qingyan:ingest') {
      ingest(message)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, detail: error instanceof Error ? error.message : String(error) }))
      return true
    }
    if (message.type === 'qingyan:probe') {
      try {
        sendResponse({ ok: true, detail: 'probe ok', probe: probe() })
      } catch (error) {
        sendResponse({ ok: false, detail: error instanceof Error ? error.message : String(error) })
      }
      return undefined
    }
    return undefined
  })

  log('content script 已就绪', location.href)
})()

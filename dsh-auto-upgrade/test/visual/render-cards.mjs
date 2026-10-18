/**
 * 视觉验收 · 步骤 2：把「官方账号通知卡」和「本插件新浮层」并排渲染，量 computed style + 截图。
 *
 *   cd ~/.agents/skills/playwright-skill
 *   AU_URL="http://127.0.0.1:3080/?token=…" node run.js \
 *     /path/to/dsh-auto-upgrade/test/visual/render-cards.mjs
 *
 * 为什么不是「真 GUI 里的两张卡」：
 *   - 官方卡只在 `signedIn && !onboarding && notices` 时渲染，`notices` 由服务端下发，本机 DOM 里
 *     `[data-front]` 为 0 → **官方侧只能是「按官方 CSS/DOM 逐字注入的复刻」**，脚本会打印这句标注。
 *   - 正在运行的宿主 link 的是主工作区那份插件（本任务的改动在 worktree 里，刻意不碰主工作区），
 *     所以本插件侧用**worktree 里的真实 lib/client.js**渲染（真 React + 真组件 + 真样式），
 *     token 用**从正在运行的 GUI 里抓下来的主题 CSS 原文**，不是手抄的数值。
 *
 * 产出：
 *   - <plugin>/docs/screenshots/overlay.png               本插件卡片（裁切）
 *   - <plugin>/docs/screenshots/overlay-vs-official.png   官方复刻 vs 本插件，并排
 *   - stdout：两边 computed style 的原始 JSON、逐项比对、定位公式的三组断言
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..', '..')
const docsDir = join(pluginRoot, 'docs', 'screenshots')

/** 本机 dsh 安装目录（用 `which dsh` 反推，不走 npm）。 */
function dshInstallDir() {
  if (process.env.DSH_INSTALL_DIR) return process.env.DSH_INSTALL_DIR
  const bin = realpathSync(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim())
  let dir = dirname(bin)
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (manifest.name === '@deepseek-ai/dsh') return dir
    }
    dir = dirname(dir)
  }
  throw new Error('找不到 @deepseek-ai/dsh 安装目录，用 DSH_INSTALL_DIR 指定')
}

/** React UMD（插件自己 node_modules 里那份）。 */
function reactUmd() {
  const file = join(pluginRoot, 'node_modules', 'react', 'umd', 'react.development.js')
  if (!existsSync(file)) throw new Error(`找不到 ${file}（先在 dsh-auto-upgrade 里 pnpm install）`)
  return file
}

/**
 * ReactDOM UMD：本仓库不依赖 react-dom（只有设置页/浮层，不需要它），验收脚本借本机已有的那份。
 * 用 AU_REACT_DOM 指定，或在 ~/workspace 的 pnpm 虚拟目录里找 react-dom@18。
 */
function reactDomUmd() {
  if (process.env.AU_REACT_DOM) return process.env.AU_REACT_DOM
  const local = join(pluginRoot, 'node_modules', 'react-dom', 'umd', 'react-dom.development.js')
  if (existsSync(local)) return local
  const workspace = join(process.env.HOME ?? '', 'workspace')
  const found = []
  for (const dir of readdirSync(workspace)) {
    const pnpm = join(workspace, dir, 'node_modules', '.pnpm')
    if (!existsSync(pnpm)) continue
    for (const entry of readdirSync(pnpm)) {
      if (!entry.startsWith('react-dom@18')) continue
      const candidate = join(pnpm, entry, 'node_modules', 'react-dom', 'umd', 'react-dom.development.js')
      if (existsSync(candidate)) found.push(candidate)
    }
  }
  if (found.length === 0) throw new Error('找不到 react-dom 18 的 UMD 构建；用 AU_REACT_DOM 指定')
  return found[0]
}

/** 官方 AccountNotice 的 CSS 原文（从官方 client.js 的字面量里取）。 */
function officialCssFromSource() {
  const source = readFileSync(join(
    dshInstallDir(), 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings-account', 'lib', 'client.js',
  ), 'utf8')
  const match = /const css\$4 = ("(?:[^"\\]|\\.)*");/.exec(source)
  if (match === null) throw new Error('官方 client.js 里没找到 AccountNotice 的 CSS 字面量（css$4）')
  return JSON.parse(match[1])
}

const FIXTURE = {
  status: {
    ok: true,
    dsh: { installed: '0.2.1-rc.2' },
    settings: { overlay: true, dismissed: false },
    policy: { dailyCheck: true },
    lastCheck: null,
    pendingRestart: null,
    capabilities: {},
  },
  check: { ok: true, decision: 'update-available', installed: '0.2.1-rc.2', target: '0.2.2-rc.1', incompatible: [] },
  diagnostics: { ok: true, log: [], result: null },
}

const OFFICIAL_MESSAGE = '本机 dsh 有新版本 0.2.2-rc.1 可用（当前 0.2.1-rc.2）。'
const OFFICIAL_TITLE = 'dsh 更新'

/** 关闭图标：官方用 primitives 的 IconCloseOutlineRegular(size 10)，包已不在，两边都用同尺寸等价 ×。 */
const CLOSE_SVG = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">'
  + '<path d="M1.75 1.75 8.25 8.25M8.25 1.75 1.75 8.25" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>'

const BELL_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none">'
  + '<path d="M3.6355 6.93969C3.6355 4.8398 5.33779 3.1375 7.43768 3.1375C9.53757 3.1375 11.23987 4.8398 11.23987 6.93968V11.363H3.6355V6.93969Z" fill="currentColor" fill-opacity="0.2" stroke="currentColor" stroke-width="0.875"/>'
  + '<path d="M1.641 11.3645H12.36M5.053 13.3095H8.9479M7.4375 4.27422V2.70137912" stroke="currentColor" stroke-width="0.875"/></svg>'

/**
 * 量一个卡片（官方前缀 zwW4-W_ / 本插件前缀 dsh-au-）的 computed style。
 * @param {string} root 卡片根选择器。
 * @param {string} pref 类名前缀。
 * @returns {object} 指标。
 */
function measure(root, pref) {
  const card = document.querySelector(root)
  const pick = (suffix) => card.querySelector(`.${pref}${suffix}`)
  const style = (node) => (node === null ? null : getComputedStyle(node))
  const cs = getComputedStyle(card)
  const copy = pick('copy')
  const title = pick('title')
  const icon = pick('icon')
  const close = pick('close')
  const paragraph = copy === null ? null : copy.querySelector('p')
  const rect = card.getBoundingClientRect()
  const box = (node) => {
    if (node === null) return null
    const s = getComputedStyle(node)
    const r = node.getBoundingClientRect()
    return {
      width: s.width,
      height: s.height,
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      padding: s.padding,
      background: s.backgroundColor,
      border: s.border,
      color: s.color,
      position: s.position,
      top: s.top,
      right: s.right,
      display: s.display,
      cursor: s.cursor,
      marginTop: s.marginTop,
      flex: s.flex,
      outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`,
    }
  }
  return {
    card: {
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height, bottom: rect.bottom },
      boxSizing: cs.boxSizing,
      width: cs.width,
      maxWidth: cs.maxWidth,
      padding: cs.padding,
      border: cs.border,
      borderRadius: cs.borderRadius,
      background: cs.backgroundColor,
      backgroundImage: cs.backgroundImage,
      backdropFilter: cs.backdropFilter,
      boxShadow: cs.boxShadow,
      color: cs.color,
      fontSize: cs.fontSize,
      lineHeight: cs.lineHeight,
      position: cs.position,
      pointerEvents: cs.pointerEvents,
      zIndex: cs.zIndex,
      transform: cs.transform,
      transformOrigin: cs.transformOrigin,
      transition: cs.transition,
      overflow: cs.overflow,
    },
    copy: copy === null ? null : {
      display: style(copy).display,
      flexDirection: style(copy).flexDirection,
      gap: style(copy).gap,
      overflowWrap: style(copy).overflowWrap,
      maxHeight: style(copy).maxHeight,
      overflowY: style(copy).overflowY,
      role: copy.getAttribute('role'),
    },
    title: title === null ? null : {
      display: style(title).display,
      alignItems: style(title).alignItems,
      gap: style(title).gap,
      fontWeight: style(title).fontWeight,
      lineHeight: style(title).lineHeight,
      fontSize: style(title).fontSize,
    },
    icon: box(icon),
    paragraph: paragraph === null ? null : {
      whiteSpace: style(paragraph).whiteSpace,
      margin: style(paragraph).margin,
      fontSize: style(paragraph).fontSize,
      lineHeight: style(paragraph).lineHeight,
      color: style(paragraph).color,
    },
    close: box(close),
  }
}

export default async function ({ page, context }) {
  const url = process.env.AU_URL
  if (!url) throw new Error('AU_URL 未设置（用日志最后一条 `dsh web: http` 行）')

  // —— 1) 从正在运行的 GUI 抓「官方 CSS 原文」与「主题 CSS 原文」——
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('body', { timeout: 15000 })
  const live = await page.evaluate(() => {
    const styles = [...document.querySelectorAll('style[data-plugin-css]')]
    const id = '@deepseek-ai/dsh-client-ui-settings-account/AccountNotice.module.css'
    const notice = styles.find((node) => node.dataset.pluginCss === id)
    return {
      noticeCss: notice === undefined ? null : notice.textContent,
      themeCss: styles
        .filter((node) => (node.dataset.pluginCss || '').startsWith('@deepseek-ai/dsh-client-ui-theme'))
        .map((node) => node.textContent)
        .join('\n'),
      tokens: (() => {
        const body = getComputedStyle(document.body)
        const names = [
          '--dsw-specific-input-major',
          '--dsw-alias-brand-primary-new-colorprimary-new-color',
          '--dsw-alias-label-caption',
          '--dsw-alias-label-secondary',
          '--dsw-elevation-panel',
          '--dsw-focus-ring-color',
          '--dsw-alias-state-business-primary',
        ]
        return Object.fromEntries(names.map((name) => [name, body.getPropertyValue(name).trim()]))
      })(),
      officialCards: document.querySelectorAll('[data-front]').length,
    }
  })
  if (live.noticeCss === null) throw new Error('运行中的 GUI 里没有官方 AccountNotice 样式（插件没装？）')
  const officialCss = officialCssFromSource()
  const sameCss = officialCss === live.noticeCss
  console.log(`[render] 官方 CSS：包内源码 ${officialCss.length}B vs GUI 已注入 ${live.noticeCss.length}B → ${sameCss ? '逐字一致' : '不一致！'}`)
  console.log(`[render] 官方卡在真 GUI 里的节点数 [data-front] = ${live.officialCards}（0 = 本机不可真实触发，只能用注入复刻）`)
  console.log(`[render] 主题 CSS 原文 ${live.themeCss.length}B 已抓到`)
  console.log(`[render] token: ${JSON.stringify(live.tokens)}`)
  if (!sameCss) throw new Error('官方 CSS 源码与 GUI 注入的不一致，先查清楚再截图')

  // —— 2) 搭离线画布：真主题 CSS + 官方 CSS + 官方 DOM 复刻 + 本插件真组件 ——
  const harness = await context.newPage()
  const view = { width: 760, height: 560 }
  await harness.setViewportSize(view)
  await harness.setContent('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>AccountNotice 外观比对</title></head><body></body></html>')
  await harness.addStyleTag({ content: live.themeCss })
  await harness.addStyleTag({ content: officialCss })
  await harness.addStyleTag({ content: 'html,body{margin:0;height:100%;background:#eef0f2;} .au-label{position:fixed;font:12px/18px -apple-system,"PingFang SC",sans-serif;color:#61666b;max-width:280px;}' })

  await harness.evaluate(({ message, title, bell, close }) => {
    // 官方 DOM：逐字照 NoticeCard 的 JSX（stack > aside.card[data-front] > div.copy[role=status] > title + p，close 绝对定位）
    const stack = document.createElement('div')
    stack.className = 'zwW4-W_stack'
    stack.style.left = '8px'
    stack.style.bottom = '264px'
    stack.innerHTML = [
      '<aside class="zwW4-W_card" data-front="true" style="--notice-depth:0;--notice-scale:1">',
      '<div role="status" class="zwW4-W_copy">',
      '<div class="zwW4-W_title"><span class="zwW4-W_icon" aria-hidden="true">', bell, '</span><span>', title, '</span></div>',
      '<p>', message, '</p>',
      '</div>',
      `<button type="button" class="zwW4-W_close" aria-label="关闭">${close}</button>`,
      '</aside>',
    ].join('')
    document.body.appendChild(stack)

    // 本插件的锚点：侧栏底部账号按钮的替身（不可见，但 getBoundingClientRect 真实）。
    const anchor = document.createElement('button')
    anchor.type = 'button'
    anchor.id = 'au-fake-anchor'
    anchor.setAttribute('aria-haspopup', 'menu')
    anchor.setAttribute('data-signed-out', 'true')
    anchor.style.cssText = 'position:fixed;left:392px;top:300px;width:260px;height:44px;visibility:hidden;'
    document.body.appendChild(anchor)

    // 本插件的挂载点：模仿宿主 overlayLayer（pointer-events:none，子元素可点）
    const layer = document.createElement('div')
    layer.id = 'au-overlay-layer'
    layer.style.cssText = 'position:absolute;inset:0;z-index:20;pointer-events:none;'
    layer.style.setProperty('pointer-events', 'none')
    document.body.appendChild(layer)
    const slot = document.createElement('div')
    slot.id = 'au-slot'
    slot.style.pointerEvents = 'auto'
    layer.appendChild(slot)
  }, { message: OFFICIAL_MESSAGE, title: OFFICIAL_TITLE, bell: BELL_SVG, close: CLOSE_SVG })

  await harness.evaluate((fixture) => {
    window.__AU_SPEC = null
    window.__ModuleLoader__ = { load: (spec) => { window.__AU_SPEC = spec } }
    // 只桩掉网络：/status + /check/auto + /restart/diagnostics 都给一份「有新版本」的夹具。
    window.fetch = async (input) => {
      const target = String(input)
      const payload = target.includes('/check/') ? fixture.check
        : target.includes('/restart/diagnostics') ? fixture.diagnostics
          : fixture.status
      return { status: 200, ok: true, json: async () => payload }
    }
  }, FIXTURE)

  await harness.addScriptTag({ path: reactUmd() })
  await harness.addScriptTag({ path: reactDomUmd() })
  await harness.addScriptTag({ path: join(pluginRoot, 'lib', 'client.js') })

  const mounted = await harness.evaluate(() => {
    const captured = { component: null }
    const mod = window.__AU_SPEC.factory((name) => {
      if (name === 'react') return window.React
      throw new Error(`unexpected require: ${name}`)
    })
    mod.apply({
      get: (name) => (name === 'locale' ? { register: () => {}, bind: () => (key) => key } : undefined),
      effect: (fn) => fn(),
      inject: (_deps, callback) => callback({
        slots: {
          inject: (_slot, mount) => mount(),
          register: (options, component) => {
            if (options.name === 'shell.overlay') captured.component = component
            if (options.name === 'settings.section') captured.settings = component
            return () => {}
          },
        },
      }),
    })
    if (captured.component === null) throw new Error('没拿到 shell.overlay 组件')
    window.__AU_COMPONENT = captured.component
    window.__AU_SETTINGS = captured.settings ?? null
    window.__AU_ROOT = window.ReactDOM.createRoot(document.getElementById('au-slot'))
    // 不传 props.t → 组件走自己的 ZH 字典（与线上默认一致）
    window.__AU_ROOT.render(window.React.createElement(captured.component))
    return true
  })
  if (mounted !== true) throw new Error('挂载失败')

  await harness.waitForSelector('[data-shell-overlay="dsh-auto-upgrade"]', { timeout: 10000 })
  // 等定位算出来（拿到锚点之前 stack 是 visibility:hidden）
  await harness.waitForFunction(() => {
    const stack = document.querySelector('.dsh-au-stack')
    return stack !== null && stack.style.visibility !== 'hidden' && stack.style.left !== ''
  }, { timeout: 10000 })
  await harness.evaluate(() => document.fonts.ready)

  // —— 3) 定位公式：三组锚点 → 实测 left/bottom vs 公式 ——
  const positionChecks = []
  for (const spot of [{ left: 392, top: 300 }, { left: 4, top: 300 }, { left: 470, top: 90 }, { left: 200, top: 512 }]) {
    const expectedLeft = Math.max(8, Math.min(spot.left, view.width - 288))
    await harness.evaluate(({ left, top }) => {
      const anchor = document.getElementById('au-fake-anchor')
      anchor.style.left = `${left}px`
      anchor.style.top = `${top}px`
      window.dispatchEvent(new Event('resize'))
    }, spot)
    await harness.waitForFunction(
      (left) => document.querySelector('.dsh-au-stack').style.left === left,
      `${expectedLeft}px`,
      { timeout: 3000 },
    ).catch(() => {})
    const after = await harness.evaluate(() => {
      const stack = document.querySelector('.dsh-au-stack')
      return { left: stack.style.left, bottom: stack.style.bottom, viewport: { width: window.innerWidth, height: window.innerHeight } }
    })
    positionChecks.push({
      anchor: spot,
      formula: {
        left: expectedLeft,
        bottom: Math.max(8, view.height - spot.top + 4),
      },
      computed: after,
    })
  }

  // 回到截图用的位置
  await harness.evaluate(() => {
    const anchor = document.getElementById('au-fake-anchor')
    anchor.style.left = '392px'
    anchor.style.top = '300px'
    window.dispatchEvent(new Event('resize'))
  })
  await harness.waitForFunction(() => document.querySelector('.dsh-au-stack').style.left === '392px', { timeout: 3000 })

  // —— 4) 量两边 + 标注 ——
  const metrics = await harness.evaluate(({ measureSource }) => {
    // eslint-disable-next-line no-new-func
    const measure = new Function(`return (${measureSource})`)()
    const official = measure('.zwW4-W_card', 'zwW4-W_')
    const ours = measure('.dsh-au-card', 'dsh-au-')
    const stack = (selector) => {
      const node = document.querySelector(selector)
      const s = getComputedStyle(node)
      return {
        width: s.width,
        maxWidth: s.maxWidth,
        position: s.position,
        zIndex: s.zIndex,
        isolation: s.isolation,
        left: s.left,
        bottom: s.bottom,
      }
    }

    const label = (text, rect) => {
      const node = document.createElement('div')
      node.className = 'au-label'
      node.textContent = text
      node.style.left = `${rect.left}px`
      node.style.top = `${Math.max(8, rect.top - 46)}px`
      document.body.appendChild(node)
    }
    label('官方 AccountNotice —— 按官方 CSS/DOM 逐字注入的复刻（本机不可真实触发，非真实卡）', official.card.rect)
    label('dsh-auto-upgrade 新浮层 —— worktree 里的真实组件渲染（真主题 token）', ours.card.rect)

    return { official, ours, stack: { official: stack('.zwW4-W_stack'), ours: stack('.dsh-au-stack') } }
  }, { measureSource: measure.toString() })

  // —— 5) 截图 ——
  mkdirSync(docsDir, { recursive: true })
  const compareFile = join(docsDir, 'overlay-vs-official.png')
  await harness.screenshot({ path: compareFile })
  writeFileSync('/tmp/au-compare.png', readFileSync(compareFile))

  const ours = metrics.ours.card.rect
  const pad = 24
  // 裁切前先摘掉标注，免得标签文字漏进卡片截图
  await harness.evaluate(() => { document.querySelectorAll('.au-label').forEach((node) => node.remove()) })
  const cardFile = join(docsDir, 'overlay.png')
  await harness.screenshot({
    path: cardFile,
    clip: {
      x: Math.max(0, ours.left - pad),
      y: Math.max(0, ours.top - pad),
      width: Math.min(view.width, ours.width + pad * 2),
      height: Math.min(view.height, ours.height + pad * 2),
    },
  })
  writeFileSync('/tmp/au-overlay.png', readFileSync(cardFile))

  // —— 5b) 关闭按钮焦点环（官方 .close:focus-visible）——
  const focus = await harness.evaluate(() => {
    const read = (selector) => {
      const node = document.querySelector(selector)
      node.focus()
      const s = getComputedStyle(node)
      return {
        focusVisible: node.matches(':focus-visible'),
        outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`,
        outlineOffset: s.outlineOffset,
        borderRadius: s.borderRadius,
      }
    }
    const official = read('.zwW4-W_close')
    const ours = read('.dsh-au-close')
    return { official, ours }
  })

  // —— 5c) prefers-reduced-motion：两边都必须只剩 transition:none ——
  await harness.emulateMedia({ reducedMotion: 'reduce' })
  const reduced = await harness.evaluate(() => {
    const official = getComputedStyle(document.querySelector('.zwW4-W_card'))
    const ours = getComputedStyle(document.querySelector('.dsh-au-card'))
    return {
      official: { transition: official.transition, duration: official.transitionDuration },
      ours: { transition: ours.transition, duration: ours.transitionDuration },
    }
  })
  await harness.emulateMedia({ reducedMotion: 'no-preference' })

  // —— 5d) 锚点缺失：先 visibility:hidden，15s 后回退到 left:8px / bottom:16px ——
  await harness.evaluate(() => {
    // 把替身锚点改名，让两个选择器都不再匹配
    document.getElementById('au-fake-anchor').setAttribute('aria-haspopup', 'menu-disabled')
    const slot = document.createElement('div')
    slot.id = 'au-slot-2'
    document.getElementById('au-overlay-layer').appendChild(slot)
    window.ReactDOM.createRoot(slot).render(window.React.createElement(window.__AU_COMPONENT))
  })
  await harness.waitForSelector('#au-slot-2 .dsh-au-stack', { state: 'attached', timeout: 5000 })
  const fallbackBefore = await harness.evaluate(() => {
    const node = document.querySelector('#au-slot-2 .dsh-au-stack')
    return { visibility: node.style.visibility, left: node.style.left, bottom: node.style.bottom }
  })
  await harness.waitForFunction(
    () => document.querySelector('#au-slot-2 .dsh-au-stack').style.left !== '',
    { timeout: 25000 },
  )
  const fallbackAfter = await harness.evaluate(() => {
    const node = document.querySelector('#au-slot-2 .dsh-au-stack')
    return { visibility: node.style.visibility, left: node.style.left, bottom: node.style.bottom }
  })

  // —— 5e) 设置页回归冒烟：同一个 client.js 的 settings.section 也要照旧能渲染 ——
  await harness.evaluate(() => {
    document.getElementById('au-slot').style.display = 'none'
    document.getElementById('au-slot-2').style.display = 'none'
    document.querySelector('.zwW4-W_stack').style.display = 'none'
    document.activeElement?.blur?.()
    const host = document.createElement('div')
    host.id = 'au-settings'
    host.style.cssText = 'position:absolute;left:16px;top:16px;width:640px;background:#fff;padding:16px;'
    document.body.appendChild(host)
    window.ReactDOM.createRoot(host).render(window.React.createElement(window.__AU_SETTINGS))
  })
  await harness.waitForSelector('[data-dsh-auto-upgrade="settings"]', { timeout: 10000 })
  await harness.evaluate(() => document.fonts.ready)
  const settingsBox = await harness.evaluate(() => {
    const rect = document.getElementById('au-settings').getBoundingClientRect()
    return { x: rect.left, y: rect.top, width: rect.width, height: Math.min(rect.height, 560 - rect.top) }
  })
  await harness.screenshot({ path: '/tmp/au-settings.png', clip: settingsBox })

  // —— 6) 报告 ——
  const pairs = [
    ['stack.width', metrics.stack.official.width, metrics.stack.ours.width],
    ['stack.maxWidth', metrics.stack.official.maxWidth, metrics.stack.ours.maxWidth],
    ['stack.position', metrics.stack.official.position, metrics.stack.ours.position],
    ['stack.zIndex', metrics.stack.official.zIndex, metrics.stack.ours.zIndex],
    ['stack.isolation', metrics.stack.official.isolation, metrics.stack.ours.isolation],
    ['card.width', metrics.official.card.width, metrics.ours.card.width],
    ['card.maxWidth', metrics.official.card.maxWidth, metrics.ours.card.maxWidth],
    ['card.boxSizing', metrics.official.card.boxSizing, metrics.ours.card.boxSizing],
    ['card.padding', metrics.official.card.padding, metrics.ours.card.padding],
    ['card.border', metrics.official.card.border, metrics.ours.card.border],
    ['card.borderRadius', metrics.official.card.borderRadius, metrics.ours.card.borderRadius],
    ['card.background', metrics.official.card.background, metrics.ours.card.background],
    ['card.boxShadow', metrics.official.card.boxShadow, metrics.ours.card.boxShadow],
    ['card.backdropFilter', metrics.official.card.backdropFilter, metrics.ours.card.backdropFilter],
    ['card.color', metrics.official.card.color, metrics.ours.card.color],
    ['card.fontSize', metrics.official.card.fontSize, metrics.ours.card.fontSize],
    ['card.lineHeight', metrics.official.card.lineHeight, metrics.ours.card.lineHeight],
    ['card.position', metrics.official.card.position, metrics.ours.card.position],
    ['card.pointerEvents', metrics.official.card.pointerEvents, metrics.ours.card.pointerEvents],
    ['card.transform', metrics.official.card.transform, metrics.ours.card.transform],
    ['card.transformOrigin', metrics.official.card.transformOrigin, metrics.ours.card.transformOrigin],
    ['card.transition', metrics.official.card.transition, metrics.ours.card.transition],
    ['card.boxWidth', `${metrics.official.card.rect.width}`, `${metrics.ours.card.rect.width}`],
    ['copy.display', metrics.official.copy.display, metrics.ours.copy.display],
    ['copy.flexDirection', metrics.official.copy.flexDirection, metrics.ours.copy.flexDirection],
    ['copy.gap', metrics.official.copy.gap, metrics.ours.copy.gap],
    ['copy.overflowWrap', metrics.official.copy.overflowWrap, metrics.ours.copy.overflowWrap],
    ['copy.role', metrics.official.copy.role, metrics.ours.copy.role],
    ['title.display', metrics.official.title.display, metrics.ours.title.display],
    ['title.alignItems', metrics.official.title.alignItems, metrics.ours.title.alignItems],
    ['title.gap', metrics.official.title.gap, metrics.ours.title.gap],
    ['title.fontWeight', metrics.official.title.fontWeight, metrics.ours.title.fontWeight],
    ['title.lineHeight', metrics.official.title.lineHeight, metrics.ours.title.lineHeight],
    ['icon.width', metrics.official.icon.width, metrics.ours.icon.width],
    ['icon.height', metrics.official.icon.height, metrics.ours.icon.height],
    ['icon.color', metrics.official.icon.color, metrics.ours.icon.color],
    ['icon.marginTop', metrics.official.icon.marginTop, metrics.ours.icon.marginTop],
    ['icon.flex', metrics.official.icon.flex, metrics.ours.icon.flex],
    ['paragraph.whiteSpace', metrics.official.paragraph.whiteSpace, metrics.ours.paragraph.whiteSpace],
    ['paragraph.margin', metrics.official.paragraph.margin, metrics.ours.paragraph.margin],
    ['close.width', metrics.official.close.width, metrics.ours.close.width],
    ['close.height', metrics.official.close.height, metrics.ours.close.height],
    ['close.position', metrics.official.close.position, metrics.ours.close.position],
    ['close.top', metrics.official.close.top, metrics.ours.close.top],
    ['close.right', metrics.official.close.right, metrics.ours.close.right],
    ['close.padding', metrics.official.close.padding, metrics.ours.close.padding],
    ['close.background', metrics.official.close.background, metrics.ours.close.background],
    ['close.border', metrics.official.close.border, metrics.ours.close.border],
    ['close.color', metrics.official.close.color, metrics.ours.close.color],
    ['close.cursor', metrics.official.close.cursor, metrics.ours.close.cursor],
    ['close.display', metrics.official.close.display, metrics.ours.close.display],
  ]

  console.log('\n=== computed style（官方复刻）===')
  console.log(JSON.stringify(metrics.official, null, 2))
  console.log('\n=== computed style（本插件）===')
  console.log(JSON.stringify(metrics.ours, null, 2))

  console.log('\n=== 定位公式断言（锚点 rect → 官方公式 → 实测 stack.left/bottom）===')
  let failures = 0
  for (const check of positionChecks) {
    const ok = check.computed.left === `${check.formula.left}px` && check.computed.bottom === `${check.formula.bottom}px`
    if (!ok) failures += 1
    console.log(JSON.stringify({ ...check, ok }))
  }

  console.log('\n=== 关闭按钮焦点环（官方 .close:focus-visible）===')
  const focusOk = focus.official.outline === focus.ours.outline
    && focus.official.outlineOffset === focus.ours.outlineOffset
    && focus.official.borderRadius === focus.ours.borderRadius
  if (!focusOk) failures += 1
  console.log(JSON.stringify({ ...focus, ok: focusOk }, null, 2))

  console.log('\n=== 锚点缺失时的回退（visibility:hidden → 左下角 8/16）===')
  const fallbackOk = fallbackBefore.visibility === 'hidden'
    && fallbackBefore.left === ''
    && fallbackAfter.left === '8px'
    && fallbackAfter.bottom === '16px'
  if (!fallbackOk) failures += 1
  console.log(JSON.stringify({ before: fallbackBefore, after: fallbackAfter, ok: fallbackOk }, null, 2))

  console.log('\n=== prefers-reduced-motion（两边都必须没有过渡）===')
  const reducedOk = reduced.official.transition === reduced.ours.transition
    && reduced.ours.duration === '0s'
  if (!reducedOk) failures += 1
  console.log(JSON.stringify({ ...reduced, ok: reducedOk }, null, 2))

  console.log('\n=== 逐项比对（官方 vs 本插件）===')
  let diff = 0
  for (const [name, a, b] of pairs) {
    const ok = a === b
    if (!ok) diff += 1
    console.log(`${ok ? 'OK  ' : 'DIFF'}  ${name.padEnd(22)} official=${JSON.stringify(a)}  ours=${JSON.stringify(b)}`)
  }
  console.log(`\n[render] 不一致项: ${diff} / ${pairs.length}`)
  console.log(`[render] 定位/焦点/回退断言失败: ${failures}`)
  console.log(`[render] 位置是实例数据，两边刻意不同：official 左侧 ${metrics.stack.official.left}/底部 ${metrics.stack.official.bottom}，ours 左侧 ${metrics.stack.ours.left}/底部 ${metrics.stack.ours.bottom}`)
  console.log(`[render] 截图: ${compareFile}`)
  console.log(`[render] 截图: ${cardFile}`)
  if (diff > 0 || failures > 0) process.exitCode = 1
}

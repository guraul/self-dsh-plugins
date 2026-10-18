/**
 * 视觉验收 · 步骤 1：从**正在运行的** GUI 里取基准事实（只读）。
 *
 *   cd ~/.agents/skills/playwright-skill
 *   AU_URL="http://127.0.0.1:3080/?token=…" node run.js \
 *     /path/to/dsh-auto-upgrade/test/visual/probe-gui.mjs
 *
 * 取什么：
 *   - 官方 AccountNotice 用到的 design token 的实际计算值（getComputedStyle(document.body)）
 *   - 主题 CSS 原文（`style[data-plugin-css^="@deepseek-ai/dsh-client-ui-theme"]`），
 *     给同目录的 render-cards.mjs 离线复现同一套 token
 *   - 锚点按钮（侧栏底部账号按钮）是否存在、rect 是多少
 *   - 官方通知卡是否真的挂在 DOM 里（`[data-front]`）
 *
 * 输出：stdout 打 JSON；文件写 /tmp/au-tokens.json、/tmp/au-theme.css。
 */
import { writeFileSync } from 'node:fs'

const TOKENS = [
  '--dsw-specific-input-major',
  '--dsw-alias-brand-primary-new-colorprimary-new-color',
  '--dsw-alias-label-caption',
  '--dsw-alias-label-secondary',
  '--dsw-elevation-panel',
  '--dsw-focus-ring-color',
  '--dsw-alias-state-business-primary',
]

export default async function ({ page }) {
  const url = process.env.AU_URL
  if (!url) throw new Error('AU_URL 未设置（用日志最后一条 `dsh web: http` 行）')

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('body', { timeout: 15000 })
  // 侧栏（含账号按钮）是异步挂载的；给 15s 等它出现，等不到也继续（会如实报 null）。
  const anchor = await page
    .waitForSelector('button[aria-haspopup="menu"][data-signed-out]', { timeout: 15000 })
    .catch(() => null)

  const data = await page.evaluate((tokens) => {
    const body = getComputedStyle(document.body)
    const values = {}
    for (const name of tokens) values[name] = body.getPropertyValue(name).trim()

    const anchorNode = document.querySelector('button[aria-haspopup="menu"][data-signed-out]')
    const fallbackNode = document.querySelector('button[aria-label="账号菜单"]')
    const rectOf = (node) => {
      if (node === null) return null
      const rect = node.getBoundingClientRect()
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      }
    }

    const themeStyles = [...document.querySelectorAll('style[data-plugin-css]')]
      .filter((node) => (node.dataset.pluginCss || '').startsWith('@deepseek-ai/dsh-client-ui-theme'))
    const pluginStyles = [...document.querySelectorAll('style[data-plugin-css]')]
      .map((node) => ({ id: node.dataset.pluginCss, bytes: node.textContent.length }))

    const rect = rectOf(anchorNode)
    const expected = rect === null ? null : {
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)),
      bottom: Math.max(8, window.innerHeight - rect.top + 4),
    }

    return {
      href: location.origin + location.pathname,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      bodyTheme: {
        dataDsDarkTheme: document.body.dataset.dsDarkTheme ?? null,
        className: document.body.className,
      },
      tokens: values,
      anchor: {
        selector: 'button[aria-haspopup="menu"][data-signed-out]',
        found: anchorNode !== null,
        rect,
        text: anchorNode === null ? null : anchorNode.textContent.trim().slice(0, 40),
        ariaHaspopup: anchorNode === null ? null : anchorNode.getAttribute('aria-haspopup'),
        dataSignedOut: anchorNode === null ? null : anchorNode.getAttribute('data-signed-out'),
        fallbackFound: fallbackNode !== null,
        expectedPosition: expected,
      },
      officialNoticeCard: {
        dataFrontNodes: document.querySelectorAll('[data-front]').length,
        note: '官方通知卡只在 signedIn && !onboarding && notices 时渲染；notices 由服务端下发',
      },
      autoUpgradeOverlay: {
        nodes: document.querySelectorAll('[data-shell-overlay="dsh-auto-upgrade"]').length,
      },
      themeStyles: themeStyles.map((node) => node.textContent.length),
      pluginStyles,
    }
  }, TOKENS)

  const themeCss = await page.evaluate(() => [...document.querySelectorAll('style[data-plugin-css]')]
    .filter((node) => (node.dataset.pluginCss || '').startsWith('@deepseek-ai/dsh-client-ui-theme'))
    .map((node) => node.textContent)
    .join('\n'))

  writeFileSync('/tmp/au-tokens.json', `${JSON.stringify(data, null, 2)}\n`)
  writeFileSync('/tmp/au-theme.css', themeCss)
  console.log(JSON.stringify(data, null, 2))
  console.log(`[probe] anchor found = ${anchor !== null}`)
  console.log('[probe] theme css → /tmp/au-theme.css ; tokens → /tmp/au-tokens.json')
}

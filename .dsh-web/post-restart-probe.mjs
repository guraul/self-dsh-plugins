// 重启后的插件验收探针（只读）。
// 用：DSH_URL="http://127.0.0.1:3080/?token=…" node run.js <本文件>
// 验收点：① boot 图里本插件的 inject 是否换成新声明；② 设置页「自动升级」section 是否仍挂载；③ 无页面错误。
export default async function ({ page }) {
  const errs = []
  page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message.slice(0, 200)}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(`[console.error] ${m.text().slice(0, 200)}`)
  })

  await page.goto(process.env.DSH_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(8000)

  const boot = await page.evaluate(() => {
    const entries = window.__DSH_BOOT__?.entries ?? []
    const mine = entries.filter((e) => /auto-upgrade/.test(e.id ?? ''))
    return {
      total: entries.length,
      mine: mine.map((e) => ({ id: e.id, inject: e.inject ?? null })),
      styleTag: !!document.querySelector('style[data-plugin-css="dsh-auto-upgrade"]'),
      overlayNodes: document.querySelectorAll('[data-shell-overlay="dsh-auto-upgrade"]').length,
    }
  })
  console.log('[probe] boot entries =', boot.total)
  console.log('[probe] auto-upgrade inject =', JSON.stringify(boot.mine))
  console.log('[probe] styleTag =', boot.styleTag, '| overlay nodes =', boot.overlayNodes, '（dismissed=true 时为 0 属正常）')

  // 设置页「自动升级」section 是否仍挂载（这是注入声明写错时最先坏的路径）
  try {
    await page.locator('button[aria-haspopup="menu"][data-signed-out]').first().click()
    await page.waitForTimeout(1000)
    await page.getByText('设置', { exact: true }).first().click()
    await page.waitForTimeout(2000)
    await page.getByText('自动升级', { exact: true }).first().click()
    await page.waitForTimeout(2500)
    const section = await page.evaluate(() => {
      const el = document.querySelector('[data-dsh-auto-upgrade="settings"]')
      return el ? (el.innerText || '').replace(/\n+/g, ' | ').slice(0, 220) : null
    })
    console.log('[probe] 设置页 section =', section ?? '(未渲染！)')
  } catch (error) {
    console.log('[probe] 设置页路径失败:', error instanceof Error ? error.message.slice(0, 200) : String(error))
  }

  console.log('[probe] 页面错误:', errs.length === 0 ? '无' : JSON.stringify(errs))
}

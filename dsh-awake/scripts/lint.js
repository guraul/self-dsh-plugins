// 跨平台语法检查：对 lib/ 与 test/ 下每个模块跑一次 `node --check`。
// 与 dsh-plugin-product-subagents/scripts/lint.js 同形（本仓各插件各带一份，互不依赖）。
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const files = []

/**
 * 递归收集脚本文件。
 * @param {string} dir 目录。
 * @returns {void}
 */
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(path)
  }
}

walk(join(root, 'lib'))
walk(join(root, 'test'))

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
}

console.log(`lint ok: ${files.length} files`)

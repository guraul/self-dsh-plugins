/**
 * dsh-plugin-memx 构建脚本。
 *
 * 两件产物：
 *   - `lib/config.js`：Host 半的 schemastery 配置声明（ESM；`@deepseek-ai/*` 保持外部，
 *     由 profile 的 node_modules 解析）。单独打包是因为 `lib/index.js` 是手写的转发
 *     文件（含只作用于 memx 源码的 TypeScript load hook），不经 esbuild。
 *   - `lib/client.js`：Web 客户端组件，必须打成宿主 `ModuleLoader` 认识的
 *     lazy-CJS factory 形态（`window.__ModuleLoader__.load({ id, factory })`），
 *     `react` / `react-dom` / `@deepseek-ai/*` 是页面运行时外部模块，不进 bundle。
 *
 * ⚠️ loader id 必须等于插件 npm 包名：宿主 client-modules 按包名 serve bundle 并
 * 校验注册 id，不一致会被拒绝（与 dsh-prompt-optimizer 踩过的 #4 同一个坑）。
 */
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'

await mkdir('lib', { recursive: true })

// Host 半：配置声明。
await build({
  entryPoints: ['src/config.ts'],
  outfile: 'lib/config.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  logLevel: 'info',
})

// Client 半：loader 的 lazy-CJS factory 形态（对齐官方包产物结构）。
const pkgName = JSON.parse(readFileSync('package.json', 'utf8')).name
const banner = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(pkgName)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
].join('\n')
const footer = ['\t\treturn module.exports;', '\t}', '});'].join('\n')

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2020',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/*', '@deepseek-ai/*'],
  banner: { js: banner },
  footer: { js: footer },
  logLevel: 'info',
})

console.log('[build] lib/config.js + lib/client.js done')

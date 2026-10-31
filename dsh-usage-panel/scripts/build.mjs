#!/usr/bin/env node
// Build pipeline:
//   1. esbuild  host   : src/host/index.ts        → lib/index.js   (ESM, all deps external)
//   2. esbuild  client : src/client/index.tsx     → .tmp/client.cjs (CJS bundle, react external)
//   3. wrap-client     : .tmp/client.cjs          → lib/client.js  (window.__ModuleLoader__.load factory)
//   4. tsc             : declaration emit for the host half → lib/host/*.d.ts + lib/shared/*.d.ts
// The lib/ outputs are committed so the GitHub install channel needs no build step.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

const root = new URL('..', import.meta.url).pathname
mkdirSync(root + '.tmp', { recursive: true })

await build({
  entryPoints: [root + 'src/host/index.ts'],
  outfile: root + 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  packages: 'external',
  sourcemap: false,
  logLevel: 'info',
})

await build({
  entryPoints: [root + 'src/client/index.tsx'],
  outfile: root + '.tmp/client.cjs',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'transform',
  external: ['react'],
  sourcemap: false,
  logLevel: 'info',
})

// Wrap the CJS bundle into the DSH browser module loader factory.
const { wrapClient } = await import('./wrap-client.mjs')
wrapClient(root + '.tmp/client.cjs', root + 'lib/client.js')

// Declaration emit for the host half (exports "." types).
execFileSync('npx', ['tsc', '-p', 'tsconfig.host.json'], { cwd: root, stdio: 'inherit' })
console.log('[build] done: lib/index.js, lib/client.js, lib/host/*.d.ts')

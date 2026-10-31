#!/usr/bin/env node
// Compile tests/**/*.test.ts with esbuild (node ESM, deps external) into
// tests-dist/ and run them with the Node built-in test runner.
import { build } from 'esbuild'
import { globSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const root = new URL('..', import.meta.url).pathname
const entries = globSync(root + 'tests/**/*.test.ts')
if (!entries.length) {
  console.error('[run-tests] no tests found under tests/**/*.test.ts')
  process.exit(1)
}

await build({
  entryPoints: entries,
  outdir: root + 'tests-dist',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  packages: 'external',
  sourcemap: false,
  logLevel: 'info',
})

const res = spawnSync('node', ['--test', 'tests-dist/**/*.test.js'], {
  cwd: root,
  stdio: 'inherit',
})
process.exit(res.status ?? 1)

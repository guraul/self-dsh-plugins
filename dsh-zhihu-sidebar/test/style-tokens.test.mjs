import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const ALLOWED_VARS = new Set([
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-link',
  '--dsw-static-neutral-00',
  '--dsw-static-neutral-100',
  '--dsw-static-neutral-200',
  '--dsw-static-neutral-700',
  '--dsw-radius-sm',
  '--dsw-radius-lg',
  '--dsw-radius-md',
  '--dsw-radius-xl',
  '--dsw-radius-xs',
  '--dsw-font-xs-13',
  '--dsw-font-xs-13-line-height',
  '--dsw-font-xs-13-font-size',
  '--dsw-font-xs-13-font-family',
  '--dsw-font-xxs-12',
  '--dsw-font-xxs-12-line-height',
  '--dsw-font-xxs-12-font-size',
  '--dsw-font-xxs-12-font-family',
  '--dsw-font-xxxs-11',
  '--dsw-font-xxxs-11-line-height',
  '--dsw-font-xxxs-11-font-size',
  '--dsw-font-xxxs-11-font-family',
  '--dsh-content-font-size',
  '--dsh-content-font-size-secondary',
  '--dsw-focus-ring-color',
  '--dsw-font-family',
  '--dsw-elevation-panel',
])

function matchAll(pattern) {
  return [...source.matchAll(pattern)]
}

test('不使用裸 fontSize 数值', () => {
  const hits = matchAll(/fontSize:\s*\d/g)
  assert.deepEqual(
    hits.map((hit) => hit[0]),
    [],
  )
})

test('不使用裸 borderRadius 数值', () => {
  const hits = matchAll(/borderRadius:\s*\d/g)
  assert.deepEqual(
    hits.map((hit) => hit[0]),
    [],
  )
})

test('不使用裸 lineHeight 数值', () => {
  const hits = matchAll(/lineHeight:\s*\d+(\.\d+)?\s*[,}]/g)
  assert.deepEqual(
    hits.map((hit) => hit[0]),
    [],
  )
})

test('行高一律带 px 单位', () => {
  const hits = matchAll(/lineHeight:\s*'[^']*'/g)
  for (const hit of hits) {
    assert.match(hit[0], /var\(--dsw-font-[a-z0-9-]+-line-height, \d+px\)/)
  }
})

test('不把 font 简写变量当 fontSize 用', () => {
  const hits = matchAll(/fontSize:\s*'var\(--dsw-font-[a-z0-9]+-\d+,/g)
  assert.deepEqual(
    hits.map((hit) => hit[0]),
    [],
  )
})

test('不使用 font: inherit', () => {
  const hits = matchAll(/font:\s*'inherit'/g)
  assert.deepEqual(
    hits.map((hit) => hit[0]),
    [],
  )
})

test('font 简写必须带字号与行高回退', () => {
  const hits = matchAll(/font:\s*'[^']*'/g)
  const withVar = hits.filter((hit) => hit[0].includes('var(--dsw-font-'))
  assert.ok(withVar.length > 0)
  for (const hit of withVar) {
    assert.match(hit[0], /^font:\s*'var\(--dsw-font-[a-z0-9]+-\d+, \d+px\/\d+px [^']+'$/)
  }
})

test('所有设计变量都在 DSH 白名单内', () => {
  const hits = matchAll(/var\((--[a-z0-9-]+)/g)
  assert.ok(hits.length > 0)
  const unknown = [...new Set(hits.map((hit) => hit[1]))].filter((name) => !ALLOWED_VARS.has(name))
  assert.deepEqual(unknown, [])
})

test('不使用 DSH 中不存在的 state-warning-primary', () => {
  assert.equal(source.includes('state-warning-primary'), false)
})

test('除变量回退值外不出现裸十六进制颜色', () => {
  const stripped = source.replace(/var\(--[a-z0-9-]+,\s*[^)]*\)/g, '')
  const hits = [...stripped.matchAll(/#[0-9a-fA-F]{3,8}/g)]
  assert.deepEqual(
    hits.map((hit) => hit[0]),
    [],
  )
})

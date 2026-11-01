import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveOptions } from '../lib/index.js'

test('resolveOptions 返回 Map（PR6 事故回归）', () => {
  const { roles, maxDepth } = resolveOptions()
  assert.ok(roles instanceof Map, '传给工具的 roles 必须是 Map，否则 keys() 直接抛错')
  assert.equal(typeof roles.get, 'function')
  assert.equal(typeof roles.keys, 'function')
  assert.equal(maxDepth, 3)
})

test('resolveOptions 能取到 reviewer 与 executor', () => {
  const { roles } = resolveOptions()
  assert.equal(roles.get('executor')?.outputContract, 'text')
  assert.equal(roles.get('reviewer')?.outputContract, 'review-result')
  assert.equal(roles.get('reviewer')?.permissionMode, 'readonly')
})

test('resolveOptions 尊重 maxDepth 覆盖', () => {
  assert.equal(resolveOptions({ maxDepth: 5 }).maxDepth, 5)
})

test('resolveOptions 对不存在的 rolesDir 也能返回 Map', () => {
  const { roles } = resolveOptions({ rolesDir: '/tmp/definitely-not-a-roles-dir' })
  assert.ok(roles instanceof Map)
  assert.equal(roles.size, 0)
})

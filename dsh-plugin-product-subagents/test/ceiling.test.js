import test from 'node:test'
import assert from 'node:assert/strict'

import { PERM_RANK, checkDelegationPermission } from '../lib/permission-gate.js'

/**
 * 委派权限天花板：readonly(0) < default(1) < full(2)。
 * 根（无绑定）无上限；合法 product 子代理不能派生比自己更高的后代。
 *
 * ⚠️ 这里直接调**实现**（`checkDelegationPermission`），不再本地复刻一份判定——
 * 复刻版曾把这个 bug 测成「通过」（issue #58）。
 */
test('PERM_RANK 顺序固定', () => {
  assert.deepEqual(PERM_RANK, { readonly: 0, default: 1, full: 2 })
})

test('根代理（无绑定）无上限', () => {
  assert.equal(checkDelegationPermission(undefined, 'full').ok, true)
})

test('default 子代理不能派生 full', () => {
  const caller = { settings: { permissionMode: 'default' } }
  assert.equal(checkDelegationPermission(caller, 'full').ok, false)
  assert.equal(checkDelegationPermission(caller, 'default').ok, true)
})

test('readonly 子代理只能派生 readonly', () => {
  const caller = { settings: { permissionMode: 'readonly' } }
  assert.equal(checkDelegationPermission(caller, 'readonly').ok, true)
  assert.equal(checkDelegationPermission(caller, 'default').ok, false)
  assert.equal(checkDelegationPermission(caller, 'full').ok, false)
})

test('full 子代理可派生任意后代', () => {
  const caller = { settings: { permissionMode: 'full' } }
  for (const mode of ['readonly', 'default', 'full']) {
    assert.equal(checkDelegationPermission(caller, mode).ok, true)
  }
})

test('#58 回归：绑定存在但 settings 缺失 → 视为未声明，不拦', () => {
  const stale = { product: 'codebuddy', remote: { sessionId: 'ses_x' }, settings: undefined }
  const gate = checkDelegationPermission(stale, 'full')
  assert.equal(gate.ok, true)
  assert.equal(gate.undeclared, true)
})

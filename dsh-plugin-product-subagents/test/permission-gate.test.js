import test from 'node:test'
import assert from 'node:assert/strict'

import { PERM_RANK, callerPermissionMode, checkDelegationPermission } from '../lib/permission-gate.js'

// issue #58：绑定记录存在但 settings 缺失时必须放行（根代理），否则「第一次能派、之后全被拦」。
test('PERM_RANK 顺序：readonly < default < full', () => {
  assert.equal(PERM_RANK.readonly < PERM_RANK.default, true)
  assert.equal(PERM_RANK.default < PERM_RANK.full, true)
})

test('根代理（无绑定）可以派全权子代理', () => {
  const gate = checkDelegationPermission(undefined, 'full')
  assert.deepEqual(gate, { ok: true, undeclared: false })
})

test('绑定存在但 settings 缺失 → 视为未声明，不拦（#58 回归）', () => {
  const record = { product: 'codebuddy', remote: { sessionId: 'x' }, settings: undefined }
  assert.equal(callerPermissionMode(record), undefined)
  const gate = checkDelegationPermission(record, 'full')
  assert.equal(gate.ok, true)
  assert.equal(gate.undeclared, true)
})

test('settings 里 permissionMode 非法 → 同样视为未声明', () => {
  const gate = checkDelegationPermission({ settings: { permissionMode: 'banana' } }, 'full')
  assert.equal(gate.ok, true)
})

test('已声明的只读子代理不能派生全权后代', () => {
  const gate = checkDelegationPermission({ settings: { permissionMode: 'readonly' } }, 'full')
  assert.deepEqual(gate, { ok: false, callerMode: 'readonly', requestedMode: 'full' })
})

test('已声明的 default 子代理不能派生全权后代，但可以派生 default/readonly', () => {
  assert.equal(checkDelegationPermission({ settings: { permissionMode: 'default' } }, 'full').ok, false)
  assert.equal(checkDelegationPermission({ settings: { permissionMode: 'default' } }, 'default').ok, true)
  assert.equal(checkDelegationPermission({ settings: { permissionMode: 'default' } }, 'readonly').ok, true)
})

test('全权子代理可以派生任意后代', () => {
  for (const mode of ['readonly', 'default', 'full']) {
    assert.equal(checkDelegationPermission({ settings: { permissionMode: 'full' } }, mode).ok, true)
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { ContractError, makeNonce } from '../lib/contract.js'

test('makeNonce 生成 12 位 base32', () => {
  for (let i = 0; i < 20; i += 1) {
    assert.match(makeNonce(), /^[A-Z2-7]{12}$/)
  }
})

test('ContractError 带错误码与名字', () => {
  const error = new ContractError('E_PARSE', '判定行缺失')
  assert.equal(error.name, 'ContractError')
  assert.equal(error.code, 'E_PARSE')
  assert.equal(error.message, '判定行缺失')
})

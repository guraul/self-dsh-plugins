import test from 'node:test'
import assert from 'node:assert/strict'

import { compareVersions, isExactVersion, parseVersion, pickNewestAbove } from '../lib/host/semver.js'

test('parseVersion 接受规范版本、拒绝范围与垃圾', () => {
  assert.equal(parseVersion('0.2.0-rc.2').pre.length, 2)
  assert.equal(parseVersion('v1.2.3+build.5').major, 1)
  assert.equal(parseVersion('^0.2.0'), undefined)
  assert.equal(parseVersion(''), undefined)
  assert.equal(parseVersion(undefined), undefined)
})

test('isExactVersion 只认精确版本', () => {
  assert.equal(isExactVersion('0.2.0-rc.2'), true)
  assert.equal(isExactVersion('^0.2.0'), false)
  assert.equal(isExactVersion('0.2.x'), false)
})

test('compareVersions 按 semver §11 排序', () => {
  assert.ok(compareVersions('0.2.0', '0.1.9') > 0)
  assert.ok(compareVersions('0.2.0-rc.2', '0.2.0-rc.10') < 0)
  assert.ok(compareVersions('0.2.0-rc.2', '0.2.0') < 0)
  assert.ok(compareVersions('0.2.0-alpha', '0.2.0-beta') < 0)
  assert.ok(compareVersions('0.2.0-alpha.1', '0.2.0-alpha') > 0)
  assert.equal(compareVersions('0.2.0-rc.2', '0.2.0-rc.2'), 0)
  assert.equal(compareVersions('garbage', '0.2.0'), 0)
})

test('pickNewestAbove 默认跳过预发布版，没有正式候选时退化', () => {
  const versions = ['0.2.0-rc.2', '0.2.0', '0.3.0-alpha.1']
  assert.equal(pickNewestAbove(versions, '0.2.0-rc.2'), '0.2.0')
  assert.equal(pickNewestAbove(['0.3.0-alpha.1'], '0.2.0-rc.2'), '0.3.0-alpha.1')
  assert.equal(pickNewestAbove(versions, '0.3.0'), undefined)
})

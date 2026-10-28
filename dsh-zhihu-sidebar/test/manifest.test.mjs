import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { inject, name } from '../lib/index.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

test('cordis 插件 id 与包名分离', () => {
  assert.equal(name, 'dsh-zhihu-sidebar')
  assert.equal(pkg.name, 'dsh-plugin-zhihu-sidebar')
  assert.deepEqual(inject, ['webServer'])
})

test('package.json 遵守仓库结构约定', () => {
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.exports['./package.json'], './package.json')
  assert.equal(pkg.scripts.test, 'node --test "test/*.test.mjs"')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.repository.directory, 'dsh-zhihu-sidebar')
  assert.equal(pkg.license, 'MIT')
})

test('cordis.patch.yml 用 id + 包名插入', () => {
  assert.match(patch, /- insert:/)
  assert.match(patch, /id: dsh-zhihu-sidebar/)
  assert.match(patch, /name: 'dsh-plugin-zhihu-sidebar'/)
})

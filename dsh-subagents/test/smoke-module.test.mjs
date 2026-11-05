import test from 'node:test'
import assert from 'node:assert/strict'

import { run } from '../smoke.mjs'

test('冒烟模块自身可用：全部断言通过（#300 P2c）', async () => {
  const result = await run({})
  const failed = result.checks.filter((check) => !check.ok)
  assert.deepEqual(failed, [], `有断言失败：${JSON.stringify(failed)}`)
  assert.equal(result.ok, true)
})

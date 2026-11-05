import test from 'node:test'
import assert from 'node:assert/strict'

import {
  appendCompatRow,
  buildRefillPlan,
  compatRow,
  patchCompatibility,
  upsertInObject,
} from '../lib/host/refill.js'

/** 一段 CRLF 的 package.json 片段（照 im-bridge 的真实结构裁的，含两处列表）。 */
const CRLF_FIXTURE = [
  '{',
  '  "name": "p",',
  '  "dsh": {',
  '    "compatibility": {',
  '      "dsh": "^0.2.1-rc.2",',
  '      "dshReleases": {',
  '        "0.2.1-rc.2": "compatible"',
  '      },',
  '      "dshDepth": {',
  '        "0.2.1-rc.2": "L2"',
  '      }',
  '    }',
  '  }',
  '}',
  '',
].join('\r\n')

test('buildRefillPlan：全量冒烟→L2，只有兜底→L1，失败不记结论', () => {
  const plan = buildRefillPlan({
    version: '0.2.2-rc.1',
    results: [
      { name: 'full', ok: true, partial: false },
      { name: 'fallback-only', ok: true, partial: true },
      { name: 'broken', ok: false, partial: false },
    ],
  })
  assert.deepEqual(plan.entries, [
    { name: 'full', verdict: 'compatible', depth: 'L2' },
    { name: 'fallback-only', verdict: 'compatible', depth: 'L1' },
  ])
  assert.equal(plan.version, '0.2.2-rc.1')
})

test('upsertInObject：插新键时沿用 CRLF 与缩进，不把整段重排', () => {
  const patched = upsertInObject(CRLF_FIXTURE, 'dshReleases', '0.2.2-rc.1', 'compatible')
  assert.ok(patched !== undefined)
  assert.ok(patched.includes('\r\n'), 'CRLF 必须保留')
  assert.equal((patched.match(/\n/g) ?? []).length, (CRLF_FIXTURE.match(/\n/g) ?? []).length + 1, '只多一行')
  assert.match(patched, /"0\.2\.1-rc\.2": "compatible",\r\n {8}"0\.2\.2-rc\.1": "compatible"\r\n {6}\}/)
})

test('upsertInObject：同名键就换值，不新增行', () => {
  const patched = upsertInObject(CRLF_FIXTURE, 'dshReleases', '0.2.1-rc.2', 'incompatible')
  assert.match(patched, /"0\.2\.1-rc\.2": "incompatible"/)
  assert.equal((patched.match(/\n/g) ?? []).length, (CRLF_FIXTURE.match(/\n/g) ?? []).length, '行数不变')
})

test('upsertInObject：找不到目标对象时返回 undefined（由调用方报错）', () => {
  assert.equal(upsertInObject(CRLF_FIXTURE, 'nopeReleases', '1.0.0', 'x'), undefined)
})

test('patchCompatibility：两个列表一起写，且再次执行是幂等的', () => {
  const first = patchCompatibility({ text: CRLF_FIXTURE, version: '0.2.2-rc.1', verdict: 'compatible', depth: 'L2' })
  assert.equal(first.changed, true)
  assert.match(first.text, /"0\.2\.2-rc\.1": "compatible"/)
  assert.match(first.text, /"0\.2\.2-rc\.1": "L2"/)
  const second = patchCompatibility({ text: first.text, version: '0.2.2-rc.1', verdict: 'compatible', depth: 'L2' })
  assert.equal(second.changed, false, '同样的结论重复回填不该再改文件')
})

test('patchCompatibility：深度非法 / 缺结构都明确报错，不静默写坏', () => {
  assert.throws(() => patchCompatibility({ text: CRLF_FIXTURE, version: '1', verdict: 'compatible', depth: 'L9' }), /非法的深度/)
  assert.throws(() => patchCompatibility({ text: '{"name":"x"}', version: '1', verdict: 'compatible', depth: 'L2' }), /dshReleases/)
})

test('compatRow：写清包版本、dsh 版本、深度与「怎么验的」', () => {
  const row = compatRow({
    name: 'dsh-awake', packageVersion: 'dsh-awake@1.2.3', version: '0.2.2-rc.1', depth: 'L2', date: '2026-11-05',
  })
  assert.match(row, /^\| `dsh-awake` \| `dsh-awake@1\.2\.3` \| `0\.2\.2-rc\.1` \| \*\*L2\*\* \| ✅ 通过 \| 2026-11-05 \|/)
  assert.match(row, /插件自报断言/, 'L2 要说明验了自报断言')

  const l1 = compatRow({ name: 'x', packageVersion: 'x@1', version: '1.0.0', depth: 'L1', date: '2026-11-05' })
  assert.match(l1, /兜底三项，插件未写 dsh\.smoke/, 'L1 要说明行为没验')
})

test('appendCompatRow：插在矩阵表末尾，不动表头', () => {
  const doc = ['# 兼容矩阵', '', '| 插件 | 包版本 |', '|---|---|', '| `a` | `a@1` |', '', '尾巴'].join('\n')
  const next = appendCompatRow(doc, '| `b` | `b@1` |')
  assert.ok(next !== undefined)
  const lines = next.split('\n')
  assert.equal(lines[4], '| `a` | `a@1` |', '原有行不动')
  assert.equal(lines[5], '| `b` | `b@1` |', '新行追加在表尾')
  assert.equal(lines[6], '', '表格之后的空行还在')
})

test('appendCompatRow：文档里没有矩阵表时返回 undefined', () => {
  assert.equal(appendCompatRow('# 空文档', '| x |'), undefined)
})

test('patchCompatibility：深度只升不降——已有 L3 时不会被只到 L2 的冒烟改浅', () => {
  const withL3 = CRLF_FIXTURE.replace('"0.2.1-rc.2": "L2"', '"0.2.1-rc.2": "L3"')
  const result = patchCompatibility({ text: withL3, version: '0.2.1-rc.2', verdict: 'compatible', depth: 'L2' })
  assert.equal(result.changed, false, '既然结论一样、深度更深，就该原封不动')
  assert.match(result.text, /"0\.2\.1-rc\.2": "L3"/)

  const upgrade = patchCompatibility({ text: withL3, version: '0.2.1-rc.2', verdict: 'compatible', depth: 'L4' })
  assert.equal(upgrade.changed, true, '更深的结论要能写进去')
  assert.match(upgrade.text, /"0\.2\.1-rc\.2": "L4"/)
})

test('patchCompatibility：返回实际采用的深度（只升不降时以旧的更深者为准）', () => {
  const withL3 = CRLF_FIXTURE.replace('"0.2.1-rc.2": "L2"', '"0.2.1-rc.2": "L3"')
  const kept = patchCompatibility({ text: withL3, version: '0.2.1-rc.2', verdict: 'compatible', depth: 'L2' })
  assert.equal(kept.depth, 'L3', '矩阵行必须跟补丁保持一致')
  const raised = patchCompatibility({ text: withL3, version: '0.9.9', verdict: 'compatible', depth: 'L1' })
  assert.equal(raised.depth, 'L1')
})

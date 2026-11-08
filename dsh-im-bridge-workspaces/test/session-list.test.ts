import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildListPages, bytesOf, fitEntry, pickPage } from '../src/session-list.ts'

/** 造一条占 `bytes` 字节的条目（含行尾换行）。 */
function entryOf(id: string, bytes: number): { id: string; text: string } {
  const head = `${id}:`
  return { id, text: `${head}${'x'.repeat(Math.max(0, bytes - bytesOf(head) - 1))}` }
}

describe('#390 fitEntry：超长标题截断但保住 id 行', () => {
  it('放得下就原样返回', () => {
    const text = fitEntry('1. 标题 · /tmp', '\n   id: session-1', 200)
    assert.equal(text, '1. 标题 · /tmp\n   id: session-1')
  })

  it('放不下时截标题、保住 id 行', () => {
    const longHead = `1. ${'很长的标题'.repeat(200)} · /tmp`
    const text = fitEntry(longHead, '\n   id: session-1', 200)
    assert.match(text, /id: session-1$/, 'id 行必须完整保留')
    assert.equal(bytesOf(text) <= 200, true, '整条要压进预算')
    assert.match(text, /…/)
  })

  it('预算小于 id 行时也不崩（至少返回 id 行）', () => {
    const text = fitEntry('1. 标题', '\n   id: session-1', 10)
    assert.match(text, /id: session-1$/)
  })
})

describe('#390 buildListPages：整条翻页，不硬砍', () => {
  it('装得下就是一页', () => {
    const pages = buildListPages([entryOf('a', 100), entryOf('b', 100)], 300)
    assert.equal(pages.length, 1)
    assert.deepEqual(pages[0]?.ids, ['a', 'b'])
  })

  it('装不下就翻页，条目不会被拆开', () => {
    const pages = buildListPages([entryOf('a', 100), entryOf('b', 100), entryOf('c', 100)], 200)
    assert.equal(pages.length, 2)
    assert.deepEqual(pages.flatMap((page) => page.ids), ['a', 'b', 'c'], 'id 一个都不能少')
    for (const page of pages) {
      assert.equal(page.lines.length, page.ids.length, '一条两行按条切，不该有半条')
    }
  })

  it('单条就超预算时独占一页，不丢', () => {
    const pages = buildListPages([entryOf('big', 500), entryOf('a', 50)], 200)
    assert.equal(pages[0]?.ids[0], 'big')
    assert.equal(pages.flatMap((page) => page.ids).includes('big'), true)
  })

  it('空输入返回空数组', () => {
    assert.deepEqual(buildListPages([], 200), [])
  })
})

describe('#390 pickPage：越界与负数按取模回绕', () => {
  const pages = [{ ids: ['a'], lines: ['a'] }, { ids: ['b'], lines: ['b'] }]

  it('正常页码', () => {
    assert.equal(pickPage(pages, 0).index, 0)
    assert.equal(pickPage(pages, 1).index, 1)
  })

  it('末页再翻回到第一页（/s more 的语义）', () => {
    assert.equal(pickPage(pages, 2).index, 0)
  })

  it('负数页码也不越界', () => {
    assert.equal(pickPage(pages, -1).index, 1)
  })

  it('空页表返回空页而不是崩', () => {
    const picked = pickPage([], 3)
    assert.equal(picked.total, 1)
    assert.deepEqual(picked.page.ids, [])
  })
})

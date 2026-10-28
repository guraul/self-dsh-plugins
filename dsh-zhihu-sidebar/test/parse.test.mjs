import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeCapabilities,
  normalizeContents,
  normalizeHot,
  normalizeSearch,
  parseResult,
  REASON,
} from '../lib/host/parse.js'

const okBody = (data) => JSON.stringify({ Code: 0, Message: 'success', Data: data })

test('退出码 0 + Code 0 → 成功并拆出 Data', () => {
  const result = parseResult({
    code: 0,
    stdout: okBody({ Total: 1, Items: [{ Title: 'A', Url: 'u' }] }),
    stderr: '',
  })
  assert.equal(result.ok, true)
  assert.equal(result.data.Items.length, 1)
  assert.equal(result.businessCode, 0)
  assert.match(result.raw, /"Code":0/)
})

test('退出码 0 + Code 0 但没有 Data → 整个响应即数据', () => {
  const result = parseResult({ code: 0, stdout: JSON.stringify({ Code: 0, Message: 'success' }) })
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, { Code: 0, Message: 'success' })
})

test('退出码 0 + ok:false 信封 → 读 error.code', () => {
  const result = parseResult({
    code: 0,
    stdout: JSON.stringify({
      ok: false,
      error: { source: 'cli', code: 'AUTH_REQUIRED', message: '需要密钥', action_url: 'https://a.b' },
    }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, REASON.AUTH_REQUIRED)
  assert.equal(result.message, '需要密钥')
  assert.equal(result.actionUrl, 'https://a.b')
})

test('退出码 0 + ok:false INVALID_ARGUMENT → invalid_argument', () => {
  const result = parseResult({
    code: 0,
    stdout: JSON.stringify({
      ok: false,
      error: { source: 'cli', code: 'INVALID_ARGUMENT', message: 'unknown flag: --json' },
    }),
  })
  assert.equal(result.reason, REASON.INVALID_ARGUMENT)
  assert.equal(result.actionUrl, undefined)
})

test('退出码 0 + 未知信封码 → cli_error', () => {
  const result = parseResult({
    code: 0,
    stdout: JSON.stringify({ ok: false, error: { code: 'SOMETHING_NEW', message: 'x' } }),
  })
  assert.equal(result.reason, REASON.CLI_ERROR)
})

test('退出码 3 → auth_required，带 action_url', () => {
  const result = parseResult({
    code: 3,
    stdout: JSON.stringify({
      ok: false,
      error: {
        source: 'cli',
        code: 'AUTH_REQUIRED',
        message: '请登录知乎开放平台并获取 Access Secret',
        action_url: 'https://developer.zhihu.com/profile',
      },
    }),
  })
  assert.equal(result.reason, REASON.AUTH_REQUIRED)
  assert.equal(result.actionUrl, 'https://developer.zhihu.com/profile')
})

test('退出码 4 → rate_limited', () => {
  const result = parseResult({
    code: 4,
    stdout: JSON.stringify({ ok: false, error: { code: 'RATE_LIMITED', message: 'rate limit exceeded' } }),
  })
  assert.equal(result.reason, REASON.RATE_LIMITED)
})

test('退出码 2 → invalid_argument', () => {
  const result = parseResult({
    code: 2,
    stdout: JSON.stringify({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'bad flag' } }),
  })
  assert.equal(result.reason, REASON.INVALID_ARGUMENT)
})

test('退出码 5–8 映射到网络 / 服务端 / 钥匙串 / 安装', () => {
  assert.equal(parseResult({ code: 5, stdout: '' }).reason, REASON.NETWORK_ERROR)
  assert.equal(parseResult({ code: 6, stdout: '' }).reason, REASON.SERVER_ERROR)
  assert.equal(parseResult({ code: 7, stdout: '' }).reason, REASON.KEYCHAIN_UNAVAILABLE)
  assert.equal(parseResult({ code: 8, stdout: '' }).reason, REASON.INSTALL_ERROR)
  assert.equal(parseResult({ code: 99, stdout: '' }).reason, REASON.UNKNOWN)
})

test('退出码 4 + 信封 QUOTA_EXHAUSTED → 更精确的 quota_exhausted', () => {
  const result = parseResult({
    code: 4,
    stdout: JSON.stringify({ ok: false, error: { code: 'QUOTA_EXHAUSTED', message: 'no quota' } }),
  })
  assert.equal(result.reason, REASON.QUOTA_EXHAUSTED)
})

test('退出码 0 + 业务码 30001 → rate_limited', () => {
  const result = parseResult({ code: 0, stdout: JSON.stringify({ Code: 30001, Message: 'rate limit exceeded' }) })
  assert.equal(result.ok, false)
  assert.equal(result.reason, REASON.RATE_LIMITED)
  assert.equal(result.businessCode, 30001)
  assert.equal(result.message, 'rate limit exceeded')
})

test('退出码 0 + 业务码 20001 → auth_required', () => {
  const result = parseResult({ code: 0, stdout: JSON.stringify({ Code: 20001, Message: 'unauthorized' }) })
  assert.equal(result.reason, REASON.AUTH_REQUIRED)
})

test('退出码 0 + 未知业务码 → business_error', () => {
  const result = parseResult({ code: 0, stdout: JSON.stringify({ Code: 12345, Message: 'weird' }) })
  assert.equal(result.reason, REASON.BUSINESS_ERROR)
  assert.equal(result.businessCode, 12345)
})

test('业务码不是数字 → parse_error', () => {
  const result = parseResult({ code: 0, stdout: JSON.stringify({ Code: 'abc' }) })
  assert.equal(result.reason, REASON.PARSE_ERROR)
})

test('退出码 0 + 无 Code 的普通对象（capabilities/version）→ 成功', () => {
  const payload = { name: 'zhihu-cli', version: '0.6.1', commands: [] }
  const result = parseResult({ code: 0, stdout: JSON.stringify(payload) })
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, payload)
})

test('非 JSON / 空 stdout / 数组 → parse_error', () => {
  assert.equal(parseResult({ code: 0, stdout: 'not json' }).reason, REASON.PARSE_ERROR)
  assert.equal(parseResult({ code: 0, stdout: '   ' }).reason, REASON.PARSE_ERROR)
  assert.equal(parseResult({ code: 0, stdout: '[]' }).reason, REASON.PARSE_ERROR)
})

test('进程没正常退出 → timeout / cli_missing / unknown', () => {
  assert.equal(parseResult({ code: null, timedOut: true, stdout: '' }).reason, REASON.TIMEOUT)
  assert.equal(parseResult({ code: null, spawnError: 'ENOENT', stdout: '' }).reason, REASON.CLI_MISSING)
  assert.equal(parseResult({ code: null, spawnError: 'EACCES', stdout: '' }).reason, REASON.UNKNOWN)
})

test('raw 永远保留原始 stdout', () => {
  const result = parseResult({ code: 3, stdout: '{"ok":false}', stderr: 'diag' })
  assert.equal(result.raw, '{"ok":false}')
  assert.equal(result.stderr, 'diag')
})

test('normalizeHot 用 PascalCase 字段并过滤空项', () => {
  const hot = normalizeHot({
    Total: 2,
    Items: [
      { Title: 'A', Url: 'u1', ThumbnailUrl: 't1', Summary: 's1' },
      { title: 'B', url: 'u2' },
      { Summary: 'no title no url' },
    ],
  })
  assert.equal(hot.total, 2)
  assert.equal(hot.pageSize, 2)
  assert.equal(hot.items.length, 2)
  assert.deepEqual(hot.items[0], { title: 'A', url: 'u1', thumbnailUrl: 't1', summary: 's1' })
  assert.deepEqual(hot.items[1], { title: 'B', url: 'u2', thumbnailUrl: '', summary: '' })
})

test('normalizeHot 容忍空数据', () => {
  assert.deepEqual(normalizeHot(undefined), { total: 0, pageSize: 0, items: [] })
  assert.deepEqual(normalizeHot({ Items: 'nope' }), { total: 0, pageSize: 0, items: [] })
})

test('normalizeSearch 映射作者与正文，翻页只给 hasMore', () => {
  const result = normalizeSearch({
    HasMore: true,
    SearchHashId: 'fake-hash',
    Items: [{ Title: 'T', Url: 'U', AuthorName: 'A', ContentText: 'C' }],
  })
  assert.deepEqual(result.items[0], { title: 'T', url: 'U', author: 'A', summary: 'C' })
  assert.equal(result.pageSize, 1)
  assert.equal(result.hasMore, true)
  assert.equal(Object.hasOwn(result, 'total'), false)
})

test('normalizeSearch 缺 HasMore → hasMore 为 null 而不是猜', () => {
  const result = normalizeSearch({ Items: [{ Title: 'T', Url: 'U' }] })
  assert.equal(result.hasMore, null)
  assert.equal(result.pageSize, 1)
})

test('normalizeContents 映射类型、Unix 秒时间戳与 Paging 总数', () => {
  const result = normalizeContents({
    Items: [
      {
        ContentType: 'answer',
        Url: 'https://www.zhihu.com/question/0000000000000000000/answer/1',
        CreatedAt: 1793161647,
        LikeCount: 3,
        CommentCount: 1,
        FavoriteCount: 0,
        Title: '测试标题：合成数据',
        Summary: '测试摘要：合成数据',
      },
      {
        ContentType: 'article',
        Url: 'https://zhuanlan.zhihu.com/p/000000000',
        CreatedAt: 1793161648,
        Title: '测试标题二',
      },
    ],
    Paging: { IsEnd: false, NextOffset: 20, Totals: 57 },
  })
  assert.equal(result.total, 57)
  assert.equal(result.pageSize, 2)
  assert.equal(result.hasMore, true)
  assert.equal(result.nextOffset, 20)
  assert.deepEqual(result.items[0], {
    title: '测试标题：合成数据',
    url: 'https://www.zhihu.com/question/0000000000000000000/answer/1',
    type: 'answer',
    createdAt: 1793161647,
    summary: '测试摘要：合成数据',
  })
  assert.equal(result.items[1].createdAt, 1793161648)
})

test('normalizeContents 缺 Paging → total / hasMore / nextOffset 均为 null', () => {
  const result = normalizeContents({ Items: [{ ContentType: 'answer', Url: 'u', CreatedAt: 1793161647 }] })
  assert.equal(result.total, null)
  assert.equal(result.hasMore, null)
  assert.equal(result.nextOffset, null)
  assert.equal(result.items[0].createdAt, 1793161647)
})

test('normalizeContents 时间戳不是数字 → createdAt 为 null', () => {
  const result = normalizeContents({ Items: [{ Url: 'u', CreatedAt: '2026-10-01' }] })
  assert.equal(result.items[0].createdAt, null)
})

test('normalizeCapabilities 只留参数边界', () => {
  const result = normalizeCapabilities({
    version: '0.6.1',
    commands: [
      { name: 'hot', limit: { default: 30, max: 30, min: 1 }, path: '/x' },
      { name: 'search zhihu', count: { default: 10, max: 10, min: 1 } },
      { name: 'quota' },
    ],
  })
  assert.equal(result.version, '0.6.1')
  assert.deepEqual(result.commands[0], { name: 'hot', limit: { min: 1, max: 30, default: 30 }, count: null })
  assert.deepEqual(result.commands[2], { name: 'quota', limit: null, count: null })
})

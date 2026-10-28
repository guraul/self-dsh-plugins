#!/usr/bin/env node
import { appendFileSync, closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.ZHIHU_FAKE_DIR
if (typeof dir !== 'string' || dir === '') {
  process.stderr.write('ZHIHU_FAKE_DIR is required\n')
  process.exit(64)
}

const logPath = join(dir, 'calls.jsonl')
const scenarioPath = join(dir, 'scenario.json')
const seqPath = join(dir, 'seq')
const lockPath = join(dir, 'active.lock')

const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'))
const modes = Array.isArray(scenario.modes) && scenario.modes.length > 0 ? scenario.modes : ['success']

let index = 0
try {
  index = Number(readFileSync(seqPath, 'utf8'))
} catch {
  index = 0
}
if (!Number.isFinite(index)) index = 0
writeFileSync(seqPath, String(index + 1))

const mode = modes[Math.min(index, modes.length - 1)]
const entry = { event: 'start', at: Date.now(), pid: process.pid, args: process.argv.slice(2), mode }

let locked = true
try {
  closeSync(openSync(lockPath, 'wx'))
} catch {
  locked = false
  entry.overlap = true
}
appendFileSync(logPath, `${JSON.stringify(entry)}\n`)

const hot = {
  Code: 0,
  Message: 'success',
  Data: {
    Total: 3,
    Items: [
      {
        Title: '热榜一',
        Url: 'https://www.zhihu.com/question/1?utm_medium=openapi_platform&utm_source=fake',
        ThumbnailUrl: 'https://pic1.zhihu.com/a.jpg',
        Summary: '摘要一',
      },
      {
        Title: '热榜二',
        Url: 'https://www.zhihu.com/question/2?utm_medium=openapi_platform&utm_source=fake',
        ThumbnailUrl: 'https://pic1.zhihu.com/b.jpg',
        Summary: '摘要二',
      },
      {
        Title: '热榜三',
        Url: 'https://www.zhihu.com/question/3?utm_medium=openapi_platform&utm_source=fake',
        ThumbnailUrl: 'https://pic1.zhihu.com/c.jpg',
        Summary: '摘要三',
      },
    ],
  },
}

const search = {
  Code: 0,
  Message: 'success',
  Data: {
    HasMore: false,
    SearchHashId: 'fake-search-hash',
    Items: [
      {
        Title: '合成搜索结果一',
        ContentType: 'answer',
        ContentID: '0000000000000000001',
        ContentText: '合成正文甲',
        Url: 'https://www.zhihu.com/question/0000000000000000011',
        CommentCount: 2,
        VoteUpCount: 5,
        AuthorName: '作者甲',
        AuthorAvatar: 'https://pic1.zhihu.com/fake-avatar-a.jpg',
        AuthorBadge: 'none',
        AuthorBadgeText: '',
        EditTime: 1793161647,
        AuthorityLevel: 1,
        RankingScore: 0.5,
      },
      {
        Title: '合成搜索结果二',
        ContentType: 'article',
        ContentID: '0000000000000000002',
        ContentText: '合成正文乙',
        Url: 'https://zhuanlan.zhihu.com/p/0000000000000000012',
        CommentCount: 0,
        VoteUpCount: 1,
        AuthorName: '作者乙',
        AuthorAvatar: 'https://pic1.zhihu.com/fake-avatar-b.jpg',
        AuthorBadge: 'none',
        AuthorBadgeText: '',
        EditTime: 1793161648,
        AuthorityLevel: 1,
        RankingScore: 0.3,
      },
    ],
  },
}

const contents = {
  Code: 0,
  Message: 'success',
  Data: {
    Items: [
      {
        ContentType: 'answer',
        Url: 'https://www.zhihu.com/question/0000000000000000021/answer/0000000001',
        CreatedAt: 1793161647,
        LikeCount: 3,
        CommentCount: 1,
        FavoriteCount: 0,
        Title: '合成作品：回答',
        Summary: '合成摘要一',
      },
      {
        ContentType: 'article',
        Url: 'https://zhuanlan.zhihu.com/p/0000000000000000001',
        CreatedAt: 1793161648,
        LikeCount: 0,
        CommentCount: 0,
        FavoriteCount: 0,
        Title: '合成作品：文章',
        Summary: '合成摘要二',
      },
    ],
    Paging: { IsEnd: true, NextOffset: 2, Totals: 2 },
  },
}

const capabilities = {
  name: 'zhihu-cli',
  version: '0.6.1',
  platforms: ['darwin/amd64'],
  commands: [
    { name: 'hot', limit: { default: 30, max: 30, min: 1 }, path: '/api/v1/content/hot_list' },
    { name: 'search zhihu', count: { default: 10, max: 10, min: 1 }, path: '/api/v1/content/zhihu_search' },
    { name: 'me contents', limit: { default: 20, max: 50, min: 1 }, pagination: 'offset' },
  ],
}

const quotaFull = {
  Code: 0,
  Message: 'success',
  Data: [
    { APIID: 'hot_list', APIName: '热榜', TotalQuota: 100, TotalUsed: 10, RemainingQuota: 90 },
    { APIID: 'zhihu_search', APIName: '搜索', TotalQuota: 5000, TotalUsed: 0, RemainingQuota: 5000 },
    { APIID: 'user_data', APIName: '用户数据', TotalQuota: 10000, TotalUsed: 0, RemainingQuota: 10000 },
  ],
}

const quotaZero = {
  Code: 0,
  Message: 'success',
  Data: [{ APIID: 'hot_list', APIName: '热榜', TotalQuota: 100, TotalUsed: 100, RemainingQuota: 0 }],
}

const payloadFor = (args) => {
  if (args[0] === 'hot') return hot
  if (args[0] === 'search') return search
  if (args[0] === 'me') return contents
  if (args[0] === 'capabilities') return capabilities
  if (args[0] === 'quota') return quotaFull
  return { Code: 0, Message: 'success', Data: {} }
}

let code = 0
let body = ''
let stderr = ''

switch (mode) {
  case 'auth_required':
    code = 3
    body = JSON.stringify({
      ok: false,
      error: {
        source: 'cli',
        code: 'AUTH_REQUIRED',
        message: '请登录知乎开放平台并获取 Access Secret',
        action_url: 'https://developer.zhihu.com/profile',
      },
    })
    break
  case 'rate_limited':
    code = 4
    body = JSON.stringify({
      ok: false,
      error: { source: 'cli', code: 'RATE_LIMITED', message: 'rate limit exceeded' },
    })
    break
  case 'business_rate_limited':
    code = 0
    body = JSON.stringify({ Code: 30001, Message: 'rate limit exceeded' })
    break
  case 'business_auth':
    code = 0
    body = JSON.stringify({ Code: 20001, Message: 'unauthorized' })
    break
  case 'invalid_argument':
    code = 2
    body = JSON.stringify({
      ok: false,
      error: { source: 'cli', code: 'INVALID_ARGUMENT', message: 'unknown flag: --json' },
    })
    break
  case 'garbage':
    code = 0
    body = 'not json at all'
    break
  case 'empty':
    code = 0
    body = ''
    break
  case 'stderr':
    code = 6
    body = ''
    stderr = 'boom\n'
    break
  case 'env': {
    const keys = Object.keys(process.env).sort()
    writeFileSync(
      join(dir, 'env.json'),
      JSON.stringify({
        keys,
        secretLike: keys.filter((key) => /SECRET|TOKEN|COOKIE|PASSWORD|PASSWD/i.test(key)),
      }),
    )
    code = 0
    body = JSON.stringify({ Code: 0, Message: 'success', Data: {} })
    break
  }
  case 'quota_zero':
    code = 0
    body = JSON.stringify(quotaZero)
    break
  case 'hang':
    setInterval(() => {}, 1000)
    break
  default:
    code = 0
    body = JSON.stringify(payloadFor(process.argv.slice(2)))
    break
}

if (body !== '') process.stdout.write(body)
if (stderr !== '') process.stderr.write(stderr)

const finish = () => {
  appendFileSync(logPath, `${JSON.stringify({ event: 'end', at: Date.now(), pid: process.pid, mode })}\n`)
  if (locked) {
    try {
      unlinkSync(lockPath)
    } catch {
      // 已经被外部清掉也不影响断言。
    }
  }
  process.exit(code)
}

if (mode !== 'hang') {
  const delay = typeof scenario.delayMs === 'number' ? scenario.delayMs : 0
  if (delay > 0) setTimeout(finish, delay)
  else finish()
}

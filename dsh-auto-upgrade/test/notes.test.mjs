import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { candidateTags, fetchReleaseNotes, plainNotes, repositorySlug } from '../lib/host/notes.js'

test('repositorySlug 认各种 GitHub 写法，别的返回 undefined', () => {
  assert.equal(repositorySlug({ repository: { url: 'git+https://github.com/deepseek-ai/deepseek-harness.git' } }), 'deepseek-ai/deepseek-harness')
  assert.equal(repositorySlug({ repository: { url: 'https://github.com/owner/repo' } }), 'owner/repo')
  assert.equal(repositorySlug({ repository: { url: 'git@github.com:owner/repo.git' } }), 'owner/repo')
  assert.equal(repositorySlug({ repository: { url: 'git+https://github.com/owner/repo.git#main' } }), 'owner/repo')
  assert.equal(repositorySlug({ repository: 'https://github.com/owner/repo.git' }), 'owner/repo')
  assert.equal(repositorySlug({ repository: { url: 'https://gitlab.com/owner/repo.git' } }), undefined)
  assert.equal(repositorySlug({}), undefined)
  assert.equal(repositorySlug(undefined), undefined)
})

test('candidateTags 先试 dsh 官方的 dsh-v 前缀', () => {
  assert.deepEqual(candidateTags('0.2.1-alpha.5'), ['dsh-v0.2.1-alpha.5', 'v0.2.1-alpha.5', '0.2.1-alpha.5'])
})

test('plainNotes 把 dsh 真实正文里的 HTML 与锚点链接压成纯文本', () => {
  // 取自 dsh-v0.2.1-alpha.5 的真实形状
  const body = '[中文](#cn-v0.2.1-alpha.5) | [English](#en-v0.2.1-alpha.5)\n\n<h3 id="cn-v0.2.1-alpha.5">问题修复</h3>\n\n- 修复了 A\n- 修复了 B\n\n\n\n![截图](https://example.invalid/x.png)\n'
  const plain = plainNotes(body)
  assert.equal(plain.includes('<'), false, '不能残留 HTML 标签')
  assert.equal(plain.includes(']('), false, '不能残留 markdown 链接语法')
  assert.equal(plain.includes('example.invalid'), false, '图片要整条去掉')
  assert.match(plain, /中文 \| English/)
  assert.match(plain, /问题修复/)
  assert.match(plain, /· 修复了 A/)
  assert.equal(plain.includes('\n\n\n'), false, '连续空行要压掉')
})

test('plainNotes 超长截断并加省略号；非字符串给空串', () => {
  const plain = plainNotes(`<p>${'x'.repeat(50)}</p>`, 20)
  assert.equal(plain.length, 21)
  assert.match(plain, /…$/)
  assert.equal(plainNotes(undefined), '')
  assert.equal(plainNotes(null), '')
})

test('fetchReleaseNotes 同时给出原始正文与压好的 plain', async () => {
  const github = await makeGithub({
    'dsh-v1.0.0': { name: 'n', body: '<h3 id="a">标题</h3>\n\n- 一条', html_url: 'https://example.invalid/r' },
  })
  try {
    const result = await fetchReleaseNotes({ slug: 'o/r', version: '1.0.0', apiBase: github.url })
    assert.equal(result.available, true)
    assert.match(result.notes, /<h3/)
    assert.equal(result.plain.includes('<'), false)
    assert.match(result.plain, /标题/)
  } finally {
    await github.close()
  }
})

/**
 * 起一个假 GitHub API。
 * @param {Record<string, object>} releases tag → release 对象；未列出的 tag 返回 404。
 * @param {{status?:number}} [options] 选项。
 * @returns {Promise<{url:string, close:()=>Promise<void>, calls:string[]}>} 服务信息。
 */
async function makeGithub(releases, options = {}) {
  const calls = []
  const server = createServer((req, res) => {
    calls.push(req.url)
    if (options.status !== undefined) {
      res.writeHead(options.status, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const tag = decodeURIComponent(String(req.url).split('/releases/tags/')[1] ?? '')
    const release = releases[tag]
    if (release === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"message":"Not Found"}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(release))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('fetchReleaseNotes：命中 dsh-v 前缀，带回正文与链接', async () => {
  const github = await makeGithub({
    'dsh-v0.2.1-alpha.5': { name: 'dsh v0.2.1-alpha.5', body: '## 亮点\n- 修了 X', html_url: 'https://github.com/x/y/releases/tag/dsh-v0.2.1-alpha.5' },
  })
  try {
    const result = await fetchReleaseNotes({ slug: 'deepseek-ai/deepseek-harness', version: '0.2.1-alpha.5', apiBase: github.url })
    assert.equal(result.available, true)
    assert.equal(result.tag, 'dsh-v0.2.1-alpha.5')
    assert.match(result.notes, /修了 X/)
    assert.match(result.url, /releases\/tag\/dsh-v0\.2\.1-alpha\.5/)
    assert.deepEqual(github.calls, ['/repos/deepseek-ai/deepseek-harness/releases/tags/dsh-v0.2.1-alpha.5'])
  } finally {
    await github.close()
  }
})

test('fetchReleaseNotes：三个候选都没有 → 如实说没有，并列出试过的标签', async () => {
  const github = await makeGithub({})
  try {
    const result = await fetchReleaseNotes({ slug: 'o/r', version: '9.9.9', apiBase: github.url })
    assert.equal(result.available, false)
    assert.match(result.reason, /dsh-v9\.9\.9 \/ v9\.9\.9 \/ 9\.9\.9/)
    assert.equal(github.calls.length, 3)
  } finally {
    await github.close()
  }
})

test('fetchReleaseNotes：GitHub 报错与网络不可达都不抛，只报 reason', async () => {
  const broken = await makeGithub({}, { status: 503 })
  try {
    const result = await fetchReleaseNotes({ slug: 'o/r', version: '1.0.0', apiBase: broken.url })
    assert.equal(result.available, false)
    assert.match(result.reason, /503/)
  } finally {
    await broken.close()
  }

  const unreachable = await fetchReleaseNotes({
    slug: 'o/r',
    version: '1.0.0',
    apiBase: 'http://127.0.0.1:1',
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED') },
  })
  assert.equal(unreachable.available, false)
  assert.match(unreachable.reason, /ECONNREFUSED/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { authenticates, refreshUrlFile, repoRootFrom } from '../lib/host/url-file.mjs'

const REPO = '/repo'

/**
 * 造一个可控的刷新环境。
 * @param {{log?: string, previous?: string, alive?: boolean}} options 输入。
 * @returns {{written: string[], check: Function, readLog: Function, writeUrl: Function}} 夹具。
 */
function harness(options = {}) {
  const written = []
  return {
    written,
    readUrl: async () => '',
    readLog: async () => {
      if (options.log === undefined) throw new Error('ENOENT')
      return options.log
    },
    writeUrl: async (text) => { written.push(text) },
    check: async () => options.alive !== false,
  }
}

test('#365 日志里没有 token 地址 → 不写', async () => {
  const h = harness({ log: '启动完成\n没有地址\n' })
  const result = await refreshUrlFile({ repoRoot: REPO, port: 3080, ...h })
  assert.equal(result.changed, false)
  assert.match(result.reason, /没有带令牌的启动地址/)
  assert.deepEqual(h.written, [])
})

test('#365 读不到日志 → 不写', async () => {
  const h = harness({})
  const result = await refreshUrlFile({ repoRoot: REPO, port: 3080, ...h })
  assert.equal(result.changed, false)
  assert.match(result.reason, /读不到日志/)
})

test('#365 地址没变 → 不写（避免每次启动都动文件）', async () => {
  const url = 'http://127.0.0.1:3080/?token=AAAAAA'
  const written = []
  const result = await refreshUrlFile({
    repoRoot: REPO,
    port: 3080,
    readLog: async () => `dsh web: ${url}\n`,
    readUrl: async () => `${url}\n`,
    writeUrl: async (text) => { written.push(text) },
    check: async () => true,
  })
  assert.equal(result.changed, false, '内容相同时不该写')
  assert.deepEqual(written, [])
})

test('#365 候选地址认证失败 → 不写（写个 401 的地址比留着旧的更糟）', async () => {
  const h = harness({ log: 'dsh web: http://127.0.0.1:3080/?token=NEWTOKEN\n', alive: false })
  const result = await refreshUrlFile({ repoRoot: REPO, port: 3080, ...h })
  assert.equal(result.changed, false)
  assert.match(result.reason, /认证失败/)
  assert.deepEqual(h.written, [])
})

test('#365 只认指定端口的地址，且取最后一条', async () => {
  const log = [
    'dsh web: http://127.0.0.1:3080/?token=OLDTOKEN',
    'dsh web: http://127.0.0.1:9999/?token=OTHERTOKEN',
    'dsh web: http://127.0.0.1:3080/?token=NEWTOKEN',
  ].join('\n')
  const h = harness({ log })
  const result = await refreshUrlFile({ repoRoot: REPO, port: 3080, ...h })
  assert.equal(result.changed, true)
  assert.match(h.written[0], /token=NEWTOKEN/)
})

test('#365 authenticates：只有 200/302/303 算活，连不上算死', async () => {
  const ok = async () => ({ status: 303 })
  const dead = async () => ({ status: 401 })
  const boom = async () => { throw new Error('ECONNREFUSED') }
  assert.equal(await authenticates('http://x', ok), true)
  assert.equal(await authenticates('http://x', dead), false)
  assert.equal(await authenticates('http://x', boom), false, '连不上不能算活')
})

test('#365 repoRootFrom：从插件模块路径往上四层', () => {
  const url = 'file:///Users/x/repo/dsh-auto-upgrade/lib/host/url-file.mjs'
  assert.equal(repoRootFrom(url), join('/Users/x/repo'))
})

test('#365 只认「加载之后」新写的日志：旧进程的地址不能被当成本进程的', async () => {
  const oldUrl = 'http://127.0.0.1:3080/?token=OLDOLD\n'
  const newUrl = 'http://127.0.0.1:3080/?token=NEWNEW\n'
  const log = `插件挂载完成\n${oldUrl}`
  const written = []
  // 偏移正好落在旧地址之后：此时新进程还没打印，必须什么都不写
  const result = await refreshUrlFile({
    repoRoot: REPO, port: 3080, since: log.length,
    readLog: async () => log,
    readUrl: async () => '',
    writeUrl: async (text) => { written.push(text) },
    check: async () => true,
  })
  assert.equal(result.changed, false, '加载那一刻不该写（最后一条还是上个进程的）')
  assert.deepEqual(written, [])

  // 宿主随后打印了新地址：同一偏移下这次应写入新地址
  const later = log + newUrl
  const next = await refreshUrlFile({
    repoRoot: REPO, port: 3080, since: log.length,
    readLog: async () => later,
    readUrl: async () => '',
    writeUrl: async (text) => { written.push(text) },
    check: async () => true,
  })
  assert.equal(next.changed, true)
  assert.match(written[0], /token=NEWNEW/)
})

test('#365 since 是**字符**偏移：中文日志下也不能切错（字节偏移会切到末尾之外）', async () => {
  const oldLine = '插件挂载完成：中文日志会让字节数远大于字符数\n'
  const oldUrl = 'http://127.0.0.1:3080/?token=OLDOLD\n'
  const log = oldLine + oldUrl
  const written = []
  // 用字符数当基线（实现要求）；若误用 Buffer.byteLength 就会切空
  const result = await refreshUrlFile({
    repoRoot: REPO, port: 3080, since: log.length,
    readLog: async () => log + 'http://127.0.0.1:3080/?token=NEWNEW\n',
    readUrl: async () => '',
    writeUrl: async (text) => { written.push(text) },
    check: async () => true,
  })
  assert.equal(result.changed, true)
  assert.match(written[0], /token=NEWNEW/, '中文前缀下也要能切到新地址')
  assert.equal(Buffer.byteLength(log, 'utf8') > log.length, true, '前提：这条日志的字节数确实大于字符数')
})

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

test('#365 repoRootFrom：从插件模块路径往上三层', () => {
  const url = 'file:///Users/x/repo/dsh-auto-upgrade/lib/host/url-file.mjs'
  assert.equal(repoRootFrom(url), join('/Users/x/repo'))
})

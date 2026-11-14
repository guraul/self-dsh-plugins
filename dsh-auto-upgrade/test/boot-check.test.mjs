import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BOOT_CHECK_FILE,
  BOOT_CHECK_SCHEMA,
  CORE_PLUGINS,
  classifyResults,
  disableLoadedPlugin,
  findLoaderEntry,
  isCorePlugin,
  readBootCheck,
  runBootCheck,
  shouldSkipBootCheck,
  toBootCheckResult,
} from '../lib/host/boot-check.js'

/**
 * 造一个临时状态目录。
 * @returns {Promise<string>} 目录。
 */
async function makeStateDir() {
  return mkdtemp(join(tmpdir(), 'dsh-au-boot-'))
}

/** 兜底三项全过的检查。 */
const fallbackOk = [
  { name: 'bundle', ok: true, detail: 'ok' },
  { name: 'installed', ok: true, detail: 'ok' },
  { name: 'inject', ok: true, detail: 'ok' },
]

/**
 * 造一条冒烟结果。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 结果。
 */
function result(overrides) {
  return { name: 'plugin', ok: true, partial: false, hasSmoke: true, selfOk: true, checks: fallbackOk, ...overrides }
}

/**
 * 造一个记录调用的开单函数。
 * @returns {{calls: object[], fn: Function}} 记录器。
 */
function reporter() {
  const calls = []
  return {
    calls,
    fn: async (input) => {
      calls.push(input)
      return { number: 42, created: true }
    },
  }
}

test('自报失败 → 运行时禁用 + 记入 disabled + 开 issue', async () => {
  const stateDir = await makeStateDir()
  const disabled = []
  const issues = reporter()
  try {
    const report = await runBootCheck({
      stateDir,
      dshVersion: '0.2.2-rc.3',
      from: '0.2.2-rc.2',
      at: 1794585407794,
      slug: 'guraul/self-dsh-plugins',
      report: issues.fn,
      disable: async (name) => {
        disabled.push(name)
        return { disabled: true }
      },
      smoke: async () => ({
        results: [
          result({
            name: 'dsh-awake',
            ok: false,
            selfOk: false,
            checks: [...fallbackOk, { name: '行为', ok: false, detail: '坏了' }],
          }),
        ],
      }),
    })
    assert.deepEqual(disabled, ['dsh-awake'])
    assert.deepEqual(report.disabled, ['dsh-awake'])
    assert.equal(report.problems, 1)
    assert.deepEqual(report.unverified, [])
    assert.equal(issues.calls.length, 1)
    assert.match(issues.calls[0].title, /dsh-awake/)
    assert.equal(issues.calls[0].slug, 'guraul/self-dsh-plugins')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('兜底三项失败 → 只计入 problems 并开 issue，绝不禁用', async () => {
  const stateDir = await makeStateDir()
  const disabled = []
  const issues = reporter()
  try {
    const report = await runBootCheck({
      stateDir,
      dshVersion: '0.2.2-rc.3',
      slug: 'guraul/self-dsh-plugins',
      report: issues.fn,
      disable: async (name) => {
        disabled.push(name)
        return { disabled: true }
      },
      smoke: async () => ({
        results: [result({
          name: 'dsh-usage-panel',
          ok: false,
          partial: true,
          hasSmoke: false,
          selfOk: undefined,
          checks: [{ name: 'bundle', ok: false, detail: '没启用' }, ...fallbackOk.slice(1)],
        })],
      }),
    })
    assert.deepEqual(disabled, [], '兜底失败不是「摘掉就能好」，不许禁用')
    assert.deepEqual(report.disabled, [])
    assert.equal(report.problems, 1)
    assert.deepEqual(report.unverified, ['dsh-usage-panel'])
    assert.equal(issues.calls.length, 1)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('没写 dsh.smoke（未验证）→ 记 unverified，不开 issue 也不禁用', async () => {
  const stateDir = await makeStateDir()
  const disabled = []
  const issues = reporter()
  try {
    const report = await runBootCheck({
      stateDir,
      dshVersion: '0.2.2-rc.3',
      slug: 'guraul/self-dsh-plugins',
      report: issues.fn,
      disable: async (name) => {
        disabled.push(name)
        return { disabled: true }
      },
      smoke: async () => ({
        results: [
          result({ name: 'dsh-awake', partial: true, hasSmoke: false, selfOk: undefined }),
          result({ name: 'dsh-usage-panel', partial: true, hasSmoke: false, selfOk: undefined }),
        ],
      }),
    })
    assert.equal(report.problems, 0)
    assert.deepEqual(report.disabled, [])
    assert.deepEqual(report.unverified, ['dsh-awake', 'dsh-usage-panel'])
    assert.equal(issues.calls.length, 0)
    assert.equal(disabled.length, 0)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('核心插件自报失败：豁免运行时禁用，但仍计入 problems 并开 issue', async () => {
  const stateDir = await makeStateDir()
  const issues = reporter()
  try {
    for (const name of CORE_PLUGINS) {
      let disableCalled = false
      const report = await runBootCheck({
        stateDir,
        dshVersion: '0.2.2-rc.3',
        slug: 'guraul/self-dsh-plugins',
        report: issues.fn,
        disable: async () => {
          disableCalled = true
          return { disabled: true }
        },
        smoke: async () => ({ results: [result({ name, ok: false, selfOk: false })] }),
      })
      assert.equal(disableCalled, false, `${name} 必须豁免`)
      assert.deepEqual(report.disabled, [])
      assert.equal(report.problems, 1)
      assert.equal(isCorePlugin(name), true)
    }
    assert.equal(issues.calls.length, CORE_PLUGINS.length)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('重复启动：版本没变且已有结果就跳过；版本变了或结果缺失则重跑', () => {
  assert.equal(shouldSkipBootCheck({ lastBootCheckVersion: '0.2.2-rc.3', dshVersion: '0.2.2-rc.3', hasResult: true }), true)
  assert.equal(shouldSkipBootCheck({ lastBootCheckVersion: '0.2.2-rc.3', dshVersion: '0.2.2-rc.4', hasResult: true }), false)
  assert.equal(shouldSkipBootCheck({ lastBootCheckVersion: '0.2.2-rc.3', dshVersion: '0.2.2-rc.3', hasResult: false }), false)
  assert.equal(shouldSkipBootCheck({ lastBootCheckVersion: null, dshVersion: '0.2.2-rc.3', hasResult: true }), false)

  // 落盘后可以被下一轮读到：去重靠的正是这份结果。
  return makeStateDir().then(async (stateDir) => {
    try {
      assert.equal(await readBootCheck(stateDir), undefined)
      await runBootCheck({ stateDir, dshVersion: '0.2.2-rc.3', smoke: async () => ({ results: [] }) })
      assert.notEqual(await readBootCheck(stateDir), undefined)
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})

test('文件原子写：契约字段齐全、JSON 可读、不留临时文件', async () => {
  const stateDir = await makeStateDir()
  try {
    const at = 1794585407794
    const report = await runBootCheck({
      stateDir,
      dshVersion: '0.2.2-rc.3',
      from: '0.2.2-rc.2',
      at,
      smoke: async () => ({ results: [result({ name: 'p' })] }),
    })
    const files = await readdir(stateDir)
    assert.deepEqual(files, [BOOT_CHECK_FILE], '不该留下 .tmp-<pid>')
    const written = JSON.parse(await readFile(join(stateDir, BOOT_CHECK_FILE), 'utf8'))
    assert.deepEqual(written, report)
    assert.deepEqual(Object.keys(written).sort(), [
      'at', 'disabled', 'from', 'problems', 'results', 'schema', 'to', 'unverified',
    ])
    assert.equal(written.schema, BOOT_CHECK_SCHEMA)
    assert.equal(written.at, at)
    assert.equal(written.from, '0.2.2-rc.2')
    assert.equal(written.to, '0.2.2-rc.3')
    assert.equal(written.problems, 0)
    assert.deepEqual(written.results, [{ name: 'p', ok: true, checks: fallbackOk }])
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('损坏的结果文件按「没有结果」处理（不崩、不跳过）', async () => {
  const stateDir = await makeStateDir()
  try {
    await writeFile(join(stateDir, BOOT_CHECK_FILE), '{not json')
    assert.equal(await readBootCheck(stateDir), undefined)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('toBootCheckResult：只保留契约字段，detail 缺省不补', () => {
  assert.deepEqual(
    toBootCheckResult({ name: 'p', ok: false, partial: false, hasSmoke: true, selfOk: false, checks: [{ name: 'x', ok: false }] }),
    { name: 'p', ok: false, checks: [{ name: 'x', ok: false }] },
  )
  assert.deepEqual(toBootCheckResult({}), { name: 'unknown', ok: false, checks: [] })
})

test('classifyResults：自报失败与兜底失败分开，未验证单独列', () => {
  const classified = classifyResults([
    result({ name: 'self', ok: false, selfOk: false }),
    result({ name: 'fallback', ok: false, partial: true, hasSmoke: false }),
    result({ name: 'plain', partial: true, hasSmoke: false }),
  ])
  assert.deepEqual(classified.problems.map((item) => item.name), ['self', 'fallback'])
  assert.deepEqual(classified.selfFailed.map((item) => item.name), ['self'])
  assert.deepEqual(classified.fallbackFailed.map((item) => item.name), ['fallback'])
  assert.deepEqual(classified.unverified, ['fallback', 'plain'])
})

test('disableLoadedPlugin：找到 entry 并 dispose fiber；找不到 / 没有 fiber 都如实返回', async () => {
  let disposed = 0
  const entry = { options: { name: 'p' }, fiber: { dispose: async () => { disposed += 1 } } }
  const loader = { entries: function* entries() { yield entry } }
  assert.equal(findLoaderEntry(loader, 'p'), entry)
  assert.deepEqual(await disableLoadedPlugin(loader, 'p'), { disabled: true })
  assert.equal(disposed, 1)

  assert.deepEqual(await disableLoadedPlugin(loader, 'missing'), { disabled: false, reason: 'no-loader-entry' })
  const noFiber = { entries: function* entries() { yield { options: { name: 'q' } } } }
  assert.deepEqual(await disableLoadedPlugin(noFiber, 'q'), { disabled: false, reason: 'no-fiber' })

  const failing = {
    entries: function* entries() {
      yield { options: { name: 'r' }, fiber: { dispose: async () => { throw new Error('boom') } } }
    },
  }
  const outcome = await disableLoadedPlugin(failing, 'r')
  assert.equal(outcome.disabled, false)
  assert.match(outcome.reason, /dispose-failed: boom/)
})

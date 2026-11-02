import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { pipelineCliCandidates, resolvePipelineCli } from '../lib/record-bridge.js'

const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))
const SHA = 'f'.repeat(40)
const NONCE = 'BRIDGE123456'

function tmp(prefix = 'dsh-subagents-bridge-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 不含 DSH_PIPELINE_HOME 的环境：别让开发机上的真包影响判定。 */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.DSH_PIPELINE_HOME
  return { ...env, ...extra }
}

/**
 * 假「插件仓」：<repo>/dsh-subagents/ 是插件副本（ascent 起点在它的 lib 里），
 * <repo>/tools/node_modules/dsh-pipeline/ 是桩包。这样能稳定复现
 * 「--root 指向无关目录、tools 却在插件仓」的跨仓场景。
 */
function fakePluginRepo({ withTools = true } = {}) {
  const repo = tmp('dsh-subagents-fake-repo-')
  const plugin = join(repo, 'dsh-subagents')
  cpSync(PLUGIN_DIR, plugin, { recursive: true, filter: (src) => !src.includes('node_modules') })

  const stub = { cli: null, argvFile: null, env: {} }
  if (withTools) {
    const home = join(repo, 'tools', 'node_modules', 'dsh-pipeline')
    stub.cli = join(home, 'bin', 'cli.mjs')
    mkdirSync(join(home, 'bin'), { recursive: true })
    stub.argvFile = join(repo, 'argv.txt')
    const script = [
      '#!/bin/sh',
      ': > "$DSH_STUB_ARGV"',
      'for a in "$@"; do printf \'%s\\n\' "$a" >> "$DSH_STUB_ARGV"; done',
      `printf '%s' '{"schemaVersion":1,"policyVersion":"0.1.0","pr":7,"round":1,"verdict":"APPROVE","head_sha":"${SHA}","nonce":"${NONCE}","findings":[],"evidence":[],"form":"cli","provider":"stub","model":"stub/model","createdAt":"2026-11-02T00:00:00.000Z"}'`,
      '',
    ].join('\n')
    writeFileSync(stub.cli, script, { mode: 0o755 })
    stub.env = { DSH_STUB_ARGV: stub.argvFile }
  }
  return {
    repo,
    plugin,
    lib: join(plugin, 'lib'),
    stub,
    /** `--root`：被审目标仓，故意不放 tools/。 */
    target: tmp('dsh-subagents-target-'),
  }
}

function runCli(cli, args, env = {}) {
  const out = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: cleanEnv(env) })
  return { code: out.status, stdout: out.stdout, stderr: out.stderr }
}

function reviewFiles(root) {
  const request = join(root, 'req.json')
  const response = join(root, 'res.txt')
  writeFileSync(request, JSON.stringify({ request: { pr: 7, head_sha: SHA, nonce: NONCE } }))
  writeFileSync(response, `${NONCE} VERDICT: APPROVE SHA: ${SHA}\n`)
  return { request, response }
}

test('解析顺序：$DSH_PIPELINE_HOME 优先于插件仓与目标仓', () => {
  const fake = fakePluginRepo()
  const home = tmp('dsh-pipeline-env-')
  mkdirSync(join(home, 'bin'), { recursive: true })
  writeFileSync(join(home, 'bin', 'cli.mjs'), '')

  const { cli } = resolvePipelineCli({
    from: fake.lib,
    root: fake.target,
    env: { DSH_PIPELINE_HOME: home },
  })
  assert.equal(cli, join(home, 'bin', 'cli.mjs'))
})

test('root 无 tools 时回退到插件仓的包', () => {
  const fake = fakePluginRepo()
  assert.equal(existsSync(join(fake.target, 'tools')), false, '目标仓必须没有 tools，否则测不到回退')

  const tried = pipelineCliCandidates({ from: fake.lib, root: fake.target, env: {} })
  assert.deepEqual(tried.at(-1), join(fake.target, 'tools', 'node_modules', 'dsh-pipeline', 'bin', 'cli.mjs'))

  const { cli } = resolvePipelineCli({ from: fake.lib, root: fake.target, env: {} })
  assert.equal(cli, fake.stub.cli, '应命中插件仓里的包，而不是目标仓')
})

test('worktree 没装 tools 时继续向上命中主仓', () => {
  const fake = fakePluginRepo({ withTools: false })
  const nested = tmp('dsh-subagents-nested-')
  const mainRepo = join(nested, 'main-repo')
  const worktree = join(mainRepo, '.worktrees', 'wt')
  cpSync(join(fake.repo, 'dsh-subagents'), join(worktree, 'dsh-subagents'), { recursive: true })
  const vendored = join(mainRepo, 'tools', 'node_modules', 'dsh-pipeline', 'bin')
  mkdirSync(vendored, { recursive: true })
  writeFileSync(join(vendored, 'cli.mjs'), '')

  assert.equal(existsSync(join(worktree, 'tools')), false, 'worktree 层必须没有 tools')
  const { cli } = resolvePipelineCli({
    from: join(worktree, 'dsh-subagents', 'lib'),
    root: fake.target,
    env: {},
  })
  assert.equal(cli, join(vendored, 'cli.mjs'), 'worktree 没装时应继续向上找到主仓的包')
})

test('两处都没有时报错并列出所有试过的路径', () => {
  const fake = fakePluginRepo({ withTools: false })
  const { cli, tried } = resolvePipelineCli({ from: fake.lib, root: fake.target, env: {} })
  assert.equal(cli, null)
  assert.ok(tried.length >= 3, `应列出多个候选，实际 ${tried.length}`)
  assert.ok(tried.some((candidate) => candidate.startsWith(fake.repo)))
  assert.ok(tried.some((candidate) => candidate.startsWith(fake.target)))
})

test('record 的 --root 指向无关目录也能用插件仓的包落记录', () => {
  const fake = fakePluginRepo()
  const { request, response } = reviewFiles(fake.target)

  const out = runCli(join(fake.plugin, 'lib', 'cli.js'), [
    'record',
    '--request',
    request,
    '--response',
    response,
    '--round',
    '1',
    '--root',
    fake.target,
  ], fake.stub.env)

  assert.equal(out.code, 0, `stderr: ${out.stderr}`)
  assert.match(out.stdout, /已写入审核记录/)
  const argv = readFileSync(fake.stub.argvFile, 'utf8').trim().split('\n')
  assert.deepEqual(argv.slice(0, 3), ['record', '--request', request])
  assert.ok(argv.includes('--json'), '桥必须带 --json，判定才由插件翻译')
  assert.equal(argv[argv.indexOf('--root') + 1], fake.target, '--root 仍指向被审仓，不能被替换成插件仓')
})

test('包完全缺失时 record 退出 2，错误里带试过的路径', () => {
  const fake = fakePluginRepo({ withTools: false })
  const { request, response } = reviewFiles(fake.target)

  const out = runCli(join(fake.plugin, 'lib', 'cli.js'), [
    'record',
    '--request',
    request,
    '--response',
    response,
    '--root',
    fake.target,
  ])

  assert.equal(out.code, 2)
  assert.match(out.stderr, /找不到共享 pipeline 包/)
  assert.match(out.stderr, /已尝试/)
  assert.match(out.stderr, /tools\/node_modules\/dsh-pipeline\/bin\/cli\.mjs/)
  assert.ok(out.stderr.includes(fake.target), '错误信息应包含目标仓候选路径')
})

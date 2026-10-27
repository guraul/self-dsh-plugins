import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClaudeBridge } from '../lib/bridges/claude.js'
import { checkDelegationPermission } from '../lib/permission-gate.js'

/**
 * issue #58 的约束：修权限天花板时**不能影响 codebuddy 子代理本身**。
 *
 * 两件事分别验证：
 *  1. 判定层与 provider 无关——codebuddy 的绑定记录（product=codebuddy）走同一套规则；
 *  2. 传输层不变——权限模式到 CLI 参数的映射仍是 full→`--dangerously-skip-permissions`、
 *     readonly→`--permission-mode plan`、default→不加参数。
 */
const dir = mkdtempSync(join(tmpdir(), 'codebuddy-perm-'))
const shim = join(dir, 'shim.sh')
const argvFile = join(dir, 'argv.txt')

writeFileSync(
  shim,
  `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argvFile).slice(1, -1)}\necho '{"type":"result","result":"ok","session_id":"s1"}'\n`,
)
chmodSync(shim, 0o755)

async function runWith(settings) {
  const bridge = createClaudeBridge({ command: shim })
  const remote = await bridge.create()
  const out = await bridge.submit(remote, 'hello world', undefined, dir, settings)
  const args = readFileSync(argvFile, 'utf8').trim().split('\n')
  return { out, args }
}

test('codebuddy/full：仍带 --dangerously-skip-permissions，且不加 --permission-mode', async () => {
  const { out, args } = await runWith({ permissionMode: 'full' })
  assert.ok(args.includes('--dangerously-skip-permissions'), `args=${args.join(' ')}`)
  assert.ok(!args.includes('--permission-mode'))
  assert.equal(out.text, 'ok')
})

test('codebuddy/readonly：走 plan 模式，不带 skip-permissions', async () => {
  const { args } = await runWith({ permissionMode: 'readonly' })
  assert.ok(args.includes('--permission-mode'))
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan')
  assert.ok(!args.includes('--dangerously-skip-permissions'))
})

test('codebuddy/default 与未声明：都不额外加权限参数（沿用产品自身默认）', async () => {
  for (const settings of [{ permissionMode: 'default' }, {}]) {
    const { args } = await runWith(settings)
    assert.ok(!args.includes('--dangerously-skip-permissions'))
    assert.ok(!args.includes('--permission-mode'))
  }
})

test('判定层与 provider 无关：codebuddy 记录缺 settings → 放行；声明 default → 仍受天花板约束', () => {
  const codebuddyRoot = { product: 'codebuddy', remote: { sessionId: 'x' }, settings: undefined }
  assert.equal(checkDelegationPermission(codebuddyRoot, 'full').ok, true)

  const codebuddyChild = { product: 'codebuddy', remote: { sessionId: 'y' }, settings: { permissionMode: 'default' } }
  assert.equal(checkDelegationPermission(codebuddyChild, 'full').ok, false)
  assert.equal(checkDelegationPermission(codebuddyChild, 'default').ok, true)
})

test('cleanup', () => {
  rmSync(dir, { recursive: true, force: true })
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  createProductProvider,
  detectProducts,
  extractText,
  productArgv,
  providerName,
} from '../lib/provider.js'
import { outputText } from '../lib/tools/delegate.js'

function fakeChild({ stdout = '', stderr = '', code = 0 } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
  }
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', stdout)
    if (stderr) child.stderr.emit('data', stderr)
    child.emit('close', code)
  })
  return child
}

test('providerName 带 product-subagents 前缀', () => {
  assert.equal(providerName('opencode'), 'product-subagents:opencode')
})

test('productArgv 按产品拼参数', () => {
  assert.deepEqual(productArgv('opencode', { model: 'opencode/x', task: 't' }), {
    bin: 'opencode',
    args: ['run', '--model', 'opencode/x', 't'],
  })
  assert.deepEqual(productArgv('codebuddy', { model: 'codebuddy/glm-5.3', task: 't' }), {
    bin: 'codebuddy',
    args: ['-p', '--output-format', 'json', '--model', 'codebuddy/glm-5.3', 't'],
  })
  assert.deepEqual(productArgv('opencode', { task: 't' }).args, ['run', 't'])
})

test('productArgv 拒绝未知产品与空任务', () => {
  assert.throws(() => productArgv('claude-code', { task: 't' }), /未支持的 product/)
  assert.throws(() => productArgv('opencode', { task: '' }), /不能为空/)
})

test('extractText 解 codebuddy 的 JSON 信封', () => {
  assert.equal(extractText('{"type":"result","result":"ok"}'), 'ok')
  assert.equal(extractText('plain text\n'), 'plain text\n')
  assert.equal(extractText('{not json'), '{not json')
})

test('createProductProvider 返回规范句柄', async () => {
  const provider = createProductProvider({
    product: 'opencode',
    spawnImpl: () => fakeChild({ stdout: 'approved\n' }),
  })
  assert.equal(provider.name, 'product-subagents:opencode')
  assert.equal(provider.inheritsParentContext, false)
  assert.deepEqual(provider.capabilities, {
    agentOptions: false,
    agentPreset: false,
    outputSchema: false,
    depthLimit: true,
  })
  const handle = await provider.start({ prompt: '审查一下' })
  assert.match(handle.id, /^opencode-/)
  const settled = await handle.result
  assert.deepEqual(settled.output, [{ type: 'text', text: 'approved\n' }])
  assert.equal(settled.stopReason, 'end')
  await handle.dispose()
})

test('createProductProvider 必须忽略子进程 stdin（PR9 事故回归）', async () => {
  const calls = []
  const provider = createProductProvider({
    product: 'opencode',
    spawnImpl: (bin, args, options) => {
      calls.push({ bin, args, options })
      return fakeChild({ stdout: 'ok' })
    },
  })
  const handle = await provider.start({ prompt: 'x' })
  await handle.result
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe'])
})

test('createProductProvider 把非零退出码变成 E_UNAVAILABLE', async () => {
  const provider = createProductProvider({
    product: 'codebuddy',
    spawnImpl: () => fakeChild({ stderr: 'boom', code: 2 }),
  })
  const handle = await provider.start({ prompt: 'x' })
  await assert.rejects(handle.result, (error) => {
    assert.equal(error.code, 'E_UNAVAILABLE')
    assert.match(error.message, /boom/)
    return true
  })
})

test('createProductProvider 在 spawn 报错时给出 E_UNAVAILABLE', async () => {
  const provider = createProductProvider({
    product: 'opencode',
    spawnImpl: () => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}
      setImmediate(() => child.emit('error', new Error('ENOENT')))
      return child
    },
  })
  const handle = await provider.start({ prompt: 'x' })
  await assert.rejects(handle.result, /ENOENT/)
})

test('detectProducts 只返回存在的产品', () => {
  assert.deepEqual(detectProducts({ env: {}, exists: (bin) => bin === 'opencode' }), ['opencode'])
  assert.deepEqual(detectProducts({ env: {}, exists: () => false }), [])
  assert.deepEqual(detectProducts({ env: {}, exists: () => true }), ['opencode', 'codebuddy'])
})

test('outputText 兼容字符串与分段数组', () => {
  assert.equal(outputText('abc'), 'abc')
  assert.equal(outputText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(outputText(undefined), '')
})

test('activationSpec 必须带 signal（PR8 事故回归）', async () => {
  const { activationSpec } = await import('../lib/tools/delegate.js')
  const controller = new AbortController()
  const spec = activationSpec({
    provider: 'opencode',
    role: { instructions: '你是执行者' },
    task: '修一下',
    agent: { id: 'parent' },
    signal: controller.signal,
    maxDepth: 2,
  })
  assert.equal(spec.provider, 'product-subagents:opencode')
  assert.equal(spec.signal, controller.signal)
  assert.equal(spec.request.parent.id, 'parent')
  assert.equal(spec.request.maxDepth, 2)
  assert.deepEqual(spec.request.prompt.map((part) => part.type), ['text'])
  assert.match(spec.request.prompt[0].text, /你是执行者[\s\S]*修一下/)
})

test('activationSpec 的 prompt 带执行前言（防反问确认）', async () => {
  const { activationSpec, DELEGATION_PREAMBLE } = await import('../lib/tools/delegate.js')
  const spec = activationSpec({
    provider: 'codebuddy',
    role: { instructions: '你是审核方' },
    task: '审一下',
    agent: { id: 'p' },
    signal: new AbortController().signal,
  })
  assert.match(spec.request.prompt[0].text, new RegExp(DELEGATION_PREAMBLE.slice(0, 8)))
  assert.match(spec.request.prompt[0].text, /不要请求确认/)
})

test('activationSpec 缺 signal / provider / agent 时报错', async () => {
  const { activationSpec } = await import('../lib/tools/delegate.js')
  const signal = new AbortController().signal
  const base = { provider: 'opencode', role: {}, task: 't', agent: { id: 'p' }, signal }
  assert.throws(() => activationSpec({ ...base, signal: undefined }), /signal 不能为空/)
  assert.throws(() => activationSpec({ ...base, provider: '' }), /provider 不能为空/)
  assert.throws(() => activationSpec({ ...base, agent: undefined }), /agent 不能为空/)
})

test('productArgv 按角色权限附加 CLI 参数', () => {
  const readonlyOpen = productArgv('opencode', { model: 'm', task: 't', permissionMode: 'readonly' })
  assert.deepEqual(readonlyOpen.args.slice(-2), ['--agent', 'plan'])
  const readonlyBuddy = productArgv('codebuddy', { model: 'm', task: 't', permissionMode: 'readonly' })
  assert.deepEqual(readonlyBuddy.args.slice(-2), ['--permission-mode', 'plan'])
  const fullOpen = productArgv('opencode', { model: 'm', task: 't', permissionMode: 'full' })
  assert.deepEqual(fullOpen.args.slice(-1), ['--auto'])
  const fullBuddy = productArgv('codebuddy', { model: 'm', task: 't', permissionMode: 'full' })
  assert.deepEqual(fullBuddy.args.slice(-2), ['--permission-mode', 'auto'])
})

test('permissionArgs 缺省不附加参数', () => {
  assert.deepEqual(productArgv('opencode', { task: 't' }).args, ['run', 't'])
  assert.deepEqual(productArgv('codebuddy', { task: 't', permissionMode: 'default' }).args, [
    '-p',
    '--output-format',
    'json',
    't',
  ])
})

test('createProductProvider 支持配置二进制路径', async () => {
  const calls = []
  const provider = createProductProvider({
    product: 'codebuddy',
    bin: '/Users/gubin/workspace/codebuddy-shim.py',
    spawnImpl: (bin) => {
      calls.push(bin)
      return fakeChild({ stdout: 'ok' })
    },
  })
  const handle = await provider.start({ prompt: 'x', permissionMode: 'readonly' })
  await handle.result
  assert.equal(calls[0], '/Users/gubin/workspace/codebuddy-shim.py')
})

test('buildReviewPrompt 要求不要请求确认', async () => {
  const { buildReviewPrompt } = await import('../lib/request.js')
  const prompt = buildReviewPrompt({
    request: {
      pr: 1,
      head_sha: 'a'.repeat(40),
      nonce: 'ABCDEFGH2345',
      files: ['a.js'],
      diff: '<<<D>>>',
      issue: { body: 'b' },
    },
    role: { instructions: '你是审核方' },
  })
  assert.match(prompt, /不要请求确认/)
})

test('activationSpec 把 model 放进 request（PR13 事故回归）', async () => {
  const { activationSpec } = await import('../lib/tools/delegate.js')
  const spec = activationSpec({
    provider: 'codebuddy',
    role: { instructions: 'x' },
    task: 't',
    agent: { id: 'p' },
    signal: new AbortController().signal,
    model: 'codebuddy/glm-5.3',
  })
  assert.equal(spec.request.model, 'codebuddy/glm-5.3')
})

test('reportedModels 解析 modelUsage，normalizeModelName 去前缀', async () => {
  const { normalizeModelName, reportedModels } = await import('../lib/provider.js')
  const stdout = JSON.stringify({ type: 'result', result: 'ok', modelUsage: { 'glm-5.3': {} } })
  assert.deepEqual(reportedModels(stdout), ['glm-5.3'])
  assert.deepEqual(reportedModels('plain text'), [])
  assert.equal(normalizeModelName('codebuddy/glm-5.3'), 'glm-5.3')
  assert.equal(normalizeModelName('glm-5.3'), 'glm-5.3')
})

test('实际模型与请求不一致 -> E_UNAVAILABLE 停止（不降级）', async () => {
  const provider = createProductProvider({
    product: 'codebuddy',
    spawnImpl: () =>
      fakeChild({
        stdout: JSON.stringify({ type: 'result', result: 'ok', modelUsage: { 'hy4-preview': {} } }) + '\n',
      }),
  })
  const handle = await provider.start({ prompt: 'x', model: 'codebuddy/glm-5.3' })
  await assert.rejects(handle.result, (error) => {
    assert.equal(error.code, 'E_UNAVAILABLE')
    assert.match(error.message, /模型不一致/)
    return true
  })
})

test('实际模型与请求一致 -> 正常返回', async () => {
  const provider = createProductProvider({
    product: 'codebuddy',
    spawnImpl: () =>
      fakeChild({ stdout: JSON.stringify({ type: 'result', result: 'ok', modelUsage: { 'glm-5.3': {} } }) + '\n' }),
  })
  const handle = await provider.start({ prompt: 'x', model: 'codebuddy/glm-5.3' })
  const settled = await handle.result
  assert.equal(settled.output[0].text, 'ok')
})

test('defaultTimeout 按产品区分且可覆盖', async () => {
  const { defaultTimeout } = await import('../lib/provider.js')
  assert.equal(defaultTimeout('codebuddy'), 600000)
  assert.equal(defaultTimeout('opencode'), 300000)
  assert.throws(() => defaultTimeout('nope'), /未支持的 product/)
})

test('buildReviewPrompt 要求先读 diff 再读仓库', async () => {
  const { buildReviewPrompt } = await import('../lib/request.js')
  const prompt = buildReviewPrompt({
    request: { pr: 1, head_sha: 'a'.repeat(40), nonce: 'ABCDEFGH2345', files: [], diff: 'x', issue: { body: '' } },
    role: {},
  })
  assert.match(prompt, /先通读 diff/)
})

test('sessionArgs 按产品给续接参数', async () => {
  const { sessionArgs } = await import('../lib/provider.js')
  assert.deepEqual(sessionArgs('codebuddy', 'abc'), ['--resume', 'abc'])
  assert.deepEqual(sessionArgs('opencode', 'abc'), ['--session', 'abc'])
  assert.deepEqual(sessionArgs('codebuddy', null), [])
})

test('extractSessionId 从各自输出里取会话 id', async () => {
  const { extractSessionId } = await import('../lib/provider.js')
  const buddy = JSON.stringify({ type: 'result', result: 'ok', session_id: 'sid-1' })
  assert.equal(extractSessionId('codebuddy', buddy), 'sid-1')
  const open = JSON.stringify({ type: 'text', sessionID: 'ses_2', part: { text: 'ok' } })
  assert.equal(extractSessionId('opencode', open), 'ses_2')
  assert.equal(extractSessionId('codebuddy', 'plain'), null)
  assert.equal(extractSessionId('opencode', '{"type":"x"}'), null)
})

test('productArgv 带 sessionId 时拼续接参数且不影响权限参数', async () => {
  const { productArgv } = await import('../lib/provider.js')
  const buddy = productArgv('codebuddy', { task: 't', sessionId: 'sid-1', permissionMode: 'readonly' })
  assert.ok(buddy.args.includes('--resume'))
  assert.ok(buddy.args.includes('sid-1'))
  assert.deepEqual(buddy.args.slice(-2), ['--permission-mode', 'plan'])
  const open = productArgv('opencode', { task: 't', sessionId: 'ses_2' })
  assert.deepEqual(open.args.slice(0, 3), ['run', '--session', 'ses_2'])
})

test('运行结束后记住最近一次会话并附带 sessionId', async () => {
  const { createProductProvider, lastSession } = await import('../lib/provider.js')
  const provider = createProductProvider({
    product: 'codebuddy',
    spawnImpl: () =>
      fakeChild({
        stdout: JSON.stringify({ type: 'result', result: 'ok', session_id: 'sid-9', modelUsage: { 'glm-5.3-flash': {} } }) + '\n',
      }),
  })
  const handle = await provider.start({ prompt: 'x', model: 'codebuddy/glm-5.3-flash' })
  const settled = await handle.result
  assert.equal(settled.sessionId, 'sid-9')
  assert.equal(lastSession('codebuddy'), 'sid-9')
})

test('sessionArgs 对未知产品报错而不是猜', async () => {
  const { sessionArgs } = await import('../lib/provider.js')
  assert.throws(() => sessionArgs('nope', 'id'), /未支持的 product/)
  assert.deepEqual(sessionArgs('nope', null), [])
})

test('activationSpec 带 cwd 时写进 request（跨仓任务必需）', async () => {
  const { activationSpec } = await import('../lib/tools/delegate.js')
  const spec = activationSpec({
    provider: 'codebuddy',
    role: { instructions: 'x' },
    task: 't',
    agent: { id: 'p' },
    signal: new AbortController().signal,
    cwd: '/Users/gubin/workspace/agent-mobile',
  })
  assert.equal(spec.request.cwd, '/Users/gubin/workspace/agent-mobile')
})

test('executor 角色是 full，reviewer 是 readonly', async () => {
  const { getRole } = await import('../lib/roles.js')
  assert.equal(getRole('executor').permissionMode, 'full')
  assert.equal(getRole('reviewer').permissionMode, 'readonly')
})

test('显式 cwd 优先于 parent.cwd（否则跨仓委派被静默遮蔽）', async () => {
  const seen = []
  const provider = createProductProvider({
    product: 'codebuddy',
    spawnImpl: (bin, args, options) => {
      seen.push(options.cwd)
      return fakeChild({ stdout: JSON.stringify({ type: 'result', result: 'ok', modelUsage: { 'glm-5.3-flash': {} } }) + '\n' })
    },
  })
  const handle = await provider.start({
    prompt: 'x',
    model: 'codebuddy/glm-5.3-flash',
    cwd: '/tmp/target-repo',
    parent: { cwd: '/tmp/parent-repo' },
  })
  await handle.result
  assert.equal(seen[0], '/tmp/target-repo')
})

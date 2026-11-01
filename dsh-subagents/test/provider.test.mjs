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
    args: ['-p', '--model', 'codebuddy/glm-5.3', 't'],
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

test('activationSpec 缺 signal / provider / agent 时报错', async () => {
  const { activationSpec } = await import('../lib/tools/delegate.js')
  const signal = new AbortController().signal
  const base = { provider: 'opencode', role: {}, task: 't', agent: { id: 'p' }, signal }
  assert.throws(() => activationSpec({ ...base, signal: undefined }), /signal 不能为空/)
  assert.throws(() => activationSpec({ ...base, provider: '' }), /provider 不能为空/)
  assert.throws(() => activationSpec({ ...base, agent: undefined }), /agent 不能为空/)
})

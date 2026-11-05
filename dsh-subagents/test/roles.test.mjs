import test from 'node:test'
import assert from 'node:assert/strict'
import { loadRoles, normalizeRole, resolveRoleModel, resolveRoleProvider } from '../lib/roles.js'
import { registerDelegateTool } from '../lib/tools/delegate.js'

/**
 * 假宿主：只登记工具、把 startActivation 收下的 spec 记下来。
 * 不 spawn 任何产品 CLI——本文件验的是「传给 CLI 之前」的取值与冲突拦截。
 */
async function fakeHost() {
  const tools = new Map()
  const specs = []
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    subagents: {
      startActivation: async (spec) => {
        specs.push(spec)
        return { result: Promise.resolve({ output: 'ok', stopReason: 'end', sessionId: 's-1' }) }
      },
    },
  }
  await registerDelegateTool(ctx, { roles: loadRoles().roles })
  const exec = { agent: { id: 'parent' }, signal: new AbortController().signal }
  return { tools, specs, exec }
}

test('normalizeRole 保留 model（与 provider）', () => {
  const role = normalizeRole('reviewer', { provider: 'codebuddy', model: 'codebuddy/glm-5.3-flash' })
  assert.equal(role.provider, 'codebuddy')
  assert.equal(role.model, 'codebuddy/glm-5.3-flash')
  assert.equal(normalizeRole('executor').model, '', '没写 model 归一成空串，表示不钉')
  assert.equal(normalizeRole('x', { model: 42 }).model, '', '非字符串一律降级成不钉')
})

test('内置角色：reviewer 钉 provider + model，executor 不钉', () => {
  const { roles } = loadRoles()
  assert.equal(roles.get('reviewer').provider, 'codebuddy')
  assert.equal(roles.get('reviewer').model, 'codebuddy/glm-5.3-flash')
  assert.equal(roles.get('executor').provider, '')
  assert.equal(roles.get('executor').model, '')
})

test('不传 model 调 reviewer → 下发角色钉的 codebuddy/glm-5.3-flash', async () => {
  const { tools, specs, exec } = await fakeHost()
  const out = await tools.get('product_delegate').execute({ role: 'reviewer', task: '审一下' }, exec)
  assert.equal(specs.length, 1)
  assert.equal(specs[0].provider, 'product-subagents:codebuddy')
  assert.equal(specs[0].request.model, 'codebuddy/glm-5.3-flash')
  assert.equal(out.role, 'reviewer')
  assert.equal(out.provider, 'codebuddy')
})

test('传角色钉的 model（等价）→ 放行，下发角色钉的带前缀形式', async () => {
  const { tools, specs, exec } = await fakeHost()
  await tools
    .get('product_delegate')
    .execute({ role: 'reviewer', model: 'codebuddy/glm-5.3-flash', task: 't' }, exec)
  assert.equal(specs[0].request.model, 'codebuddy/glm-5.3-flash')

  await tools.get('product_delegate').execute({ role: 'reviewer', model: 'glm-5.3-flash', task: 't' }, exec)
  assert.equal(specs[1].request.model, 'codebuddy/glm-5.3-flash', '去掉 codebuddy/ 前缀视为同一个模型')
})

test('传冲突模型直接报错，且不发起调用', async () => {
  const { tools, specs, exec } = await fakeHost()
  await assert.rejects(
    () => tools.get('product_delegate').execute({ role: 'reviewer', model: '别的模型', task: 't' }, exec),
    (error) => {
      assert.ok(error.message.includes('角色 reviewer 钉的模型是 codebuddy/glm-5.3-flash'))
      assert.ok(error.message.includes('本次请求 别的模型'))
      return true
    },
  )
  assert.equal(specs.length, 0, '冲突必须在发起调用之前抛出')
})

test('传冲突 provider 直接报错', async () => {
  const { tools, specs, exec } = await fakeHost()
  await assert.rejects(
    () =>
      tools.get('product_delegate').execute({ role: 'reviewer', provider: 'opencode', task: 't' }, exec),
    (error) => {
      assert.ok(error.message.includes('角色 reviewer 钉的 provider 是 codebuddy'))
      assert.ok(error.message.includes('本次请求 opencode'))
      return true
    },
  )
  assert.equal(specs.length, 0)
})

test('executor 不钉 provider/model → 调用方给什么就用什么', async () => {
  const { tools, specs, exec } = await fakeHost()
  await tools
    .get('product_delegate')
    .execute(
      { role: 'executor', provider: 'opencode', model: 'opencode/deepseek-v4.1-flash', task: 't' },
      exec,
    )
  assert.equal(specs[0].provider, 'product-subagents:opencode')
  assert.equal(specs[0].request.model, 'opencode/deepseek-v4.1-flash')

  await tools.get('product_delegate').execute({ role: 'executor', provider: 'codebuddy', task: 't' }, exec)
  assert.equal('model' in specs[1].request, false, '没钉也没传就不带 model')
})

test('product_continue 续接同样吃角色钉的模型，冲突也报错', async () => {
  const { tools, specs, exec } = await fakeHost()
  await tools
    .get('product_continue')
    .execute({ role: 'reviewer', session: 's-abc', task: '补一条 finding' }, exec)
  assert.equal(specs.length, 1)
  assert.equal(specs[0].request.model, 'codebuddy/glm-5.3-flash')
  assert.equal(specs[0].request.sessionId, 's-abc')

  await assert.rejects(
    () =>
      tools
        .get('product_continue')
        .execute({ role: 'reviewer', session: 's-abc', model: '别的模型', task: 't' }, exec),
    (error) => error.message.includes('角色 reviewer 钉的模型是 codebuddy/glm-5.3-flash'),
  )
  assert.equal(specs.length, 1, '冲突那次不发起调用')
})

test('resolveRoleModel：没钉就透传，钉了没传就用钉的', () => {
  const pinned = { id: 'reviewer', model: 'codebuddy/glm-5.3-flash' }
  assert.equal(resolveRoleModel(pinned, undefined), 'codebuddy/glm-5.3-flash')
  assert.equal(resolveRoleModel(pinned, ''), 'codebuddy/glm-5.3-flash')
  assert.equal(resolveRoleModel(pinned, 'glm-5.3-flash'), 'codebuddy/glm-5.3-flash')
  assert.equal(resolveRoleModel({ id: 'executor' }, 'opencode/x'), 'opencode/x')
  assert.equal(resolveRoleModel({ id: 'executor' }, undefined), undefined)
  assert.throws(
    () => resolveRoleModel(pinned, 'glm-5.3'),
    /角色 reviewer 钉的模型是 codebuddy\/glm-5\.3-flash，本次请求 glm-5\.3/,
  )
})

test('resolveRoleProvider：直接字符串比较，不做规范化', () => {
  const role = { id: 'reviewer', provider: 'codebuddy' }
  assert.equal(resolveRoleProvider(role, undefined), 'codebuddy')
  assert.equal(resolveRoleProvider(role, ''), 'codebuddy')
  assert.equal(resolveRoleProvider(role, 'codebuddy'), 'codebuddy')
  assert.equal(resolveRoleProvider({ id: 'executor' }, 'opencode'), 'opencode')
  assert.throws(
    () => resolveRoleProvider(role, 'opencode'),
    /角色 reviewer 钉的 provider 是 codebuddy，本次请求 opencode/,
  )
})

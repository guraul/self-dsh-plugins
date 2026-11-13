/**
 * `product_delegate`：把任务交给一个 product CLI，同步等结果。
 *
 * 与旧插件的差别：一期只有一次性执行（没有 background / submit / wait）。
 * 之所以还留这个工具名，是为了让 `audit-subagents.mjs` 与既有文档里的调用方式
 * 不失效——改名的代价远大于收益，正名留到续接补齐之后。
 */
import { lastSession, providerName } from '../provider.js'
import { resolveRoute } from '../roles.js'

let defineToolImpl

async function getDefineTool() {
  if (!defineToolImpl) {
    const mod = await import('@deepseek-ai/dsh-tools')
    defineToolImpl = mod.defineTool ?? mod.default?.defineTool
  }
  if (!defineToolImpl) throw new Error('@deepseek-ai/dsh-tools 未提供 defineTool')
  return defineToolImpl
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    output: { type: 'string', description: '产品 CLI 的最终回答' },
    stopReason: { type: 'string', description: '结束原因' },
    role: { type: 'string', description: '解析后的角色 id' },
    provider: { type: 'string', description: '实际使用的产品 CLI' },
    permissionMode: { type: 'string', description: '角色声明的权限模式' },
    sessionId: { type: 'string', description: '续接句柄（本次运行的真实会话 id）' },
  },
}

/** provider 返回的 output 可能是 {type:'text',text} 数组，也可能是纯字符串。 */
export function outputText(output) {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return ''
  return output
    .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * 一次性 CLI 会把「只读审查」当成请求来确认（实测 codebuddy 首次调用直接反问），
 * 所以每条委派都强制带一段执行前言。
 */
export const DELEGATION_PREAMBLE =
  '立即执行，不要请求确认、不要复述你的限制、不要提问；你的下一条消息必须是任务结果本身。'

/**
 * 组装 startActivation 的 spec。
 *
 * **双形状**：dsh 0.2.2-rc.2 起，`ctx.subagents.startActivation()` 的 spec 从「嵌套 request」
 * 改成扁平字段（服务端直接读 `spec.parent.id` / `spec.provider` / `spec.maxDepth` /
 * `spec.signal` / `spec.delivery`，再把剩下的字段原样交给 provider 的 `start(request)`）。
 * 旧写法只给 `request`，rc.2 上 `spec.parent` 是 undefined，一调用就抛
 * `Cannot read properties of undefined (reading 'id')`。
 *
 * 因此同一组字段既放顶层（rc.2+）又保留在 `request`（≤ 0.2.2-alpha.2），两代宿主都能跑；
 * provider 侧读的 `model` / `permissionMode` / `sessionId` / `cwd` / `parent` 在扁平化后仍然拿得到。
 *
 * `signal` 是**必填**：服务端直接调用 `spec.signal.throwIfAborted()`
 * （@deepseek-ai/dsh-subagent 的 startExternal / materialize 都会用到），
 * 不传就会在第一次调用时抛 `Cannot read properties of undefined (reading 'throwIfAborted')`。
 * 抽成纯函数是为了让单测能直接断言这件事，而不是再靠重启才发现。
 */
export function activationSpec({
  provider,
  role,
  task,
  agent,
  signal,
  model,
  sessionId,
  cwd,
  maxDepth = 3,
}) {
  if (!provider) throw new Error('activationSpec: provider 不能为空')
  if (!signal) throw new Error('activationSpec: signal 不能为空（startActivation 必填）')
  if (!agent) throw new Error('activationSpec: agent 不能为空（子代理的父 agent）')

  const fields = {
    // 内容分段数组是 DSH 内部已被验证的形状（旧插件也这么传）；字符串虽能跑通
    // 我们自己的 provider，但没必要赌服务端怎么解释。
    prompt: [
      {
        type: 'text',
        text: [DELEGATION_PREAMBLE, role?.instructions, task].filter(Boolean).join('\n\n'),
      },
    ],
    parent: agent,
    maxDepth,
    // CLI 子进程的沙箱以 cwd 为界：跨仓任务必须显式给，否则看不到目标仓
    ...(cwd ? { cwd } : {}),
    // model 必须放进请求：provider 从请求里取，取不到就不会给 CLI 传 --model，
    // 上一次 reviewer 就是这样静默跑到了 codebuddy 的默认模型。
    ...(model ? { model } : {}),
    // 续接：同一个远端会话再问一次（路线 a，复用 CLI 自己的会话）
    ...(sessionId ? { sessionId } : {}),
    // 角色权限交给 provider 映射成 CLI 参数（readonly → plan，full → auto）
    permissionMode: role?.permissionMode ?? 'default',
  }

  return {
    provider: providerName(provider),
    signal,
    // rc.2+ 读顶层字段；`delivery: 'parent'` 声明结果回流给父 agent
    ...fields,
    delivery: 'parent',
    // ≤ 0.2.2-alpha.2 读嵌套 request。同一组字段，不另存副本。
    request: fields,
  }
}

/**
 * @param {any} ctx 插件上下文
 * @param {{ roles: Map<string, object>, maxDepth?: number }} options
 */
export async function registerDelegateTool(ctx, { roles, maxDepth = 3 }) {
  const defineTool = await getDefineTool()
  const roleIds = [...roles.keys()]

  ctx.tools.register(
    defineTool({
      name: 'product_delegate',
      description:
        '把一个自包含的任务交给外部产品 CLI（opencode / codebuddy）同步执行，返回最终回答。' +
        '角色决定权限模式与附加指令。需要追问时用返回里的 [delegate-session: <id>] 调 product_continue。',
      parameters: {
        role: {
          type: 'string',
          enum: roleIds.length > 0 ? roleIds : ['executor'],
          description: '角色 id（product_roles 可列出）。缺省 executor。',
        },
        provider: {
          type: 'string',
          description: '产品 CLI，缺省用角色声明的 provider；两者都没有则报错。',
        },
        model: {
          type: 'string',
          description:
            '产品侧模型标识；缺省用角色钉的模型，没钉则用角色软默认（executor 有）；与硬钉不一致直接报错。',
        },
        cwd: { type: 'string', description: '子进程工作目录（跨仓任务必填，否则沙箱只看得到当前仓）。' },
        task: { type: 'string', required: true, description: '交给产品 CLI 的任务正文。' },
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: String(value.output ?? '') }],
      },
      async execute(args, exec) {
        const role = roles.get(args.role || 'executor')
        if (!role) throw new Error(`product_delegate: 未知角色 "${args.role}"`)
        // 硬钉冲突在 startActivation 之前就抛，不会发起调用；软默认只在调用方没传时补位
        const { provider, model } = resolveRoute(role, { provider: args.provider, model: args.model })
        if (!provider) throw new Error(`product_delegate: 未指定 provider，角色 "${role.id}" 也没钉 provider`)

        const handle = await ctx.subagents.startActivation(
          activationSpec({
            provider,
            role,
            task: args.task,
            agent: exec.agent,
            signal: exec.signal,
            model,
            cwd: args.cwd,
            maxDepth,
          }),
        )
        const settled = await handle.result
        // 只用本次运行真实的会话 id：回退到「上一次」会发放指向别的会话的句柄
        const sessionId = settled?.sessionId
        const text = outputText(settled?.output)
        return {
          output: sessionId ? `${text}\n\n[delegate-session: ${sessionId}]` : text,
          stopReason: settled?.stopReason ?? 'end',
          role: role.id,
          provider,
          permissionMode: role.permissionMode,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'product_continue',
      description:
        '续接上一次委派：把追问发给同一个远端会话，保留它的上下文。' +
        'session 用 product_delegate 输出末尾的 [delegate-session: <id>]；不传则用该产品最近一次。',
      parameters: {
        task: { type: 'string', required: true, description: '追问正文。' },
        session: { type: 'string', description: '会话 id；缺省用该产品最近一次委派。' },
        role: { type: 'string', enum: roleIds.length > 0 ? roleIds : ['executor'], description: '角色 id。' },
        provider: { type: 'string', description: '产品 CLI，缺省用角色声明的 provider。' },
        model: { type: 'string', description: '产品侧模型标识；缺省用角色钉的模型，没钉则用角色软默认；与硬钉不一致直接报错。' },
        cwd: { type: 'string', description: '子进程工作目录（跨仓续接时必填）。' },
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: String(value.output ?? '') }],
      },
      async execute(args, exec) {
        const role = roles.get(args.role || 'executor')
        if (!role) throw new Error(`product_continue: 未知角色 "${args.role}"`)
        // 续接同样吃角色的硬钉 / 软默认：否则复审这一轮可能与上一轮跑在不同模型上
        const { provider, model } = resolveRoute(role, { provider: args.provider, model: args.model })
        if (!provider) throw new Error(`product_continue: 未指定 provider，角色 "${role.id}" 也没钉 provider`)

        const sessionId = args.session || lastSession(provider)
        if (!sessionId) {
          throw new Error(
            'product_continue: 没有可续接的会话（先调 product_delegate，或显式传 session）',
          )
        }

        const handle = await ctx.subagents.startActivation(
          activationSpec({
            provider,
            role,
            task: args.task,
            agent: exec.agent,
            signal: exec.signal,
            model,
            sessionId,
            cwd: args.cwd,
            maxDepth,
          }),
        )
        const settled = await handle.result
        // 续接后如果产品轮换了会话 id，以本次为准；否则仍是传入的那个
        const nextSession = settled?.sessionId ?? sessionId
        const text = outputText(settled?.output)
        return {
          output: `${text}\n\n[delegate-session: ${nextSession}]`,
          stopReason: settled?.stopReason ?? 'end',
          role: role.id,
          provider,
          sessionId: nextSession,
        }
      },
    }),
  )
}

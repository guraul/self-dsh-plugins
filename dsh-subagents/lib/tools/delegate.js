/**
 * `product_delegate`：把任务交给一个 product CLI，同步等结果。
 *
 * 与旧插件的差别：一期只有一次性执行（没有 background / submit / wait）。
 * 之所以还留这个工具名，是为了让 `audit-subagents.mjs` 与既有文档里的调用方式
 * 不失效——改名的代价远大于收益，正名留到续接补齐之后。
 */
import { providerName } from '../provider.js'

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
 * 组装 startActivation 的 spec。
 *
 * `signal` 是**必填**：服务端直接调用 `spec.signal.throwIfAborted()`
 * （@deepseek-ai/dsh-subagent 的 startExternal / materialize 都会用到），
 * 不传就会在第一次调用时抛 `Cannot read properties of undefined (reading 'throwIfAborted')`。
 * 抽成纯函数是为了让单测能直接断言这件事，而不是再靠重启才发现。
 */
/**
 * 一次性 CLI 会把「只读审查」当成请求来确认（实测 codebuddy 首次调用直接反问），
 * 所以每条委派都强制带一段执行前言。
 */
export const DELEGATION_PREAMBLE =
  '立即执行，不要请求确认、不要复述你的限制、不要提问；你的下一条消息必须是任务结果本身。'

export function activationSpec({ provider, role, task, agent, signal, model, maxDepth = 3 }) {
  if (!provider) throw new Error('activationSpec: provider 不能为空')
  if (!signal) throw new Error('activationSpec: signal 不能为空（startActivation 必填）')
  if (!agent) throw new Error('activationSpec: agent 不能为空（子代理的父 agent）')
  return {
    provider: providerName(provider),
    signal,
    request: {
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
      // model 必须放进 request：provider 从请求里取，取不到就不会给 CLI 传 --model，
      // 上一次 reviewer 就是这样静默跑到了 codebuddy 的默认模型。
      ...(model ? { model } : {}),
      // 角色权限交给 provider 映射成 CLI 参数（readonly → plan，full → auto）
      permissionMode: role?.permissionMode ?? 'default',
    },
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
        '角色决定权限模式与附加指令；一期是一次性执行，不能续接、不能追问。',
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
        model: { type: 'string', description: '产品侧模型标识；缺省用 CLIZ 自身默认值。' },
        task: { type: 'string', required: true, description: '交给产品 CLI 的任务正文。' },
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: String(value.output ?? '') }],
      },
      async execute(args, exec) {
        const role = roles.get(args.role || 'executor')
        if (!role) throw new Error(`product_delegate: 未知角色 "${args.role}"`)
        const provider = args.provider || role.provider
        if (!provider) throw new Error(`product_delegate: 未指定 provider，角色 "${role.id}" 也没钉 provider`)

        const handle = await ctx.subagents.startActivation(
          activationSpec({
            provider,
            role,
            task: args.task,
            agent: exec.agent,
            signal: exec.signal,
            model: args.model,
            maxDepth,
          }),
        )
        const settled = await handle.result
        return {
          output: outputText(settled?.output),
          stopReason: settled?.stopReason ?? 'end',
          role: role.id,
          provider,
          permissionMode: role.permissionMode,
        }
      },
    }),
  )
}

/**
 * dsh-plugin-subagents 的宿主半边。
 *
 * 一期职责只有两件：按本机可用性注册 product provider，注册 `product_delegate`
 * 工具。角色库与判定契约是纯函数，宿主侧不参与。
 *
 * provider 名必须与旧插件同名前缀（`product-subagents:*`）：
 *   - `scripts/pipeline/audit-subagents.mjs` 靠它识别 product 子代理会话；
 *   - 代价是两个插件**不能同时挂载**——重名会让整个 profile 插件树启动失败。
 *     这里捕获注册失败并大声告警，而不是让宿主起不来。
 */
import { loadRoles } from './roles.js'
import { createProductProvider, detectProducts } from './provider.js'
import { registerDelegateTool } from './tools/delegate.js'

export const name = 'subagents'
export const inject = ['subagents', 'tools']

/**
 * 工具与 provider 共用的参数。抽成独立导出是为了让单测能直接断言
 * 「传给工具的 roles 是 Map」——PR6 就是在这里把 `{ roles, skipped }` 整个传下去，
 * 导致 `product_delegate` 静默未注册。
 */
export function resolveOptions(config = {}) {
  const { roles } = loadRoles(config.rolesDir)
  return { roles, maxDepth: config.maxDepth ?? 3, products: config.products }
}

export async function apply(ctx, config = {}) {
  // config.products 支持 'opencode' 或 { product: 'codebuddy', bin: '/path/to/shim' }
  const configured = Array.isArray(config.products) && config.products.length > 0
    ? config.products.map((item) =>
        typeof item === 'string' ? { product: item } : { product: item.product, bin: item.bin },
      )
    : detectProducts({ env: process.env }).map((product) => ({ product }))

  if (configured.length === 0) {
    console.warn('[subagents] 本机没有可用的 product CLI（opencode / codebuddy），不注册任何 provider')
  }

  for (const { product, bin } of configured) {
    try {
      ctx.subagents.registerProvider(createProductProvider({ product, bin, env: process.env }))
    } catch (error) {
      console.warn(
        `[subagents] 注册 ${product} 失败: ${error.message}` +
          '（若旧插件 dsh-plugin-product-subagents 仍挂载，两者 provider 重名，必须先摘掉旧的）',
      )
    }
  }

  const { roles, maxDepth } = resolveOptions(config)
  try {
    await registerDelegateTool(ctx, { roles, maxDepth })
  } catch (error) {
    // 拿不到 @deepseek-ai/dsh-tools 时不能让整个 profile 起不来：provider 已经注册，
    // 没有工具只是「不能委派」，应当降级并大声说明。
    console.warn(`[subagents] product_delegate 未注册: ${error.message}`)
  }
}

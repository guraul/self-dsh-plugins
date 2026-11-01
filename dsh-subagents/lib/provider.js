/**
 * 形态 B 的 provider：把请求交给外部产品 CLI，一次性取回文本。
 *
 * 与旧插件的差别：一期只做一次性委派（没有 prepareContinuable），因此不持有
 * 远端会话；续接语义留到下一期，见 docs/pipeline/review-loop.md 的「一期缺口」。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ContractError } from './contract.js'

export const PRODUCTS = {
  opencode: {
    bin: 'opencode',
    argv: ({ model, task }) => ['run', ...(model ? ['--model', model] : []), task],
    // plan 是 opencode 内置的只读 agent：能读仓库、不能写。
    permissionArgs: { readonly: ['--agent', 'plan'], default: [], full: ['--auto'] },
  },
  codebuddy: {
    bin: 'codebuddy',
    // json 输出里带 modelUsage，可以用来核对「实际用的模型」
    argv: ({ model, task }) => ['-p', '--output-format', 'json', ...(model ? ['--model', model] : []), task],
    // default 不附加参数：保持与旧行为一致，只在显式 readonly / full 时才改变权限
    permissionArgs: {
      readonly: ['--permission-mode', 'plan'],
      default: [],
      full: ['--permission-mode', 'auto'],
    },
  },
}

/** 角色权限 → CLI 参数。不传权限时按 default（不附加任何参数）。 */
export function permissionArgs(product, permissionMode) {
  const spec = PRODUCTS[product]
  if (!spec) throw new ContractError('E_UNAVAILABLE', `未支持的 product: ${product}`)
  return spec.permissionArgs[permissionMode ?? 'default'] ?? []
}

/** provider 的注册名必须带 `product-subagents:` 前缀——audit-subagents.mjs 靠它识别会话。 */
export function providerName(product) {
  return `product-subagents:${product}`
}

export function productArgv(product, { model, task, permissionMode }) {
  const spec = PRODUCTS[product]
  if (!spec) throw new ContractError('E_UNAVAILABLE', `未支持的 product: ${product}`)
  if (!task) throw new ContractError('E_UNAVAILABLE', '委派任务不能为空')
  return {
    bin: spec.bin,
    args: [...spec.argv({ model, task }), ...permissionArgs(product, permissionMode)],
  }
}

/** 去掉我们自己的 `codebuddy/` 前缀，用于与 CLI 自报的模型名比对。 */
export function normalizeModelName(model) {
  return String(model ?? '').replace(/^codebuddy\//, '')
}

/**
 * 请求了具体模型时，核对 CLI 自报的实际模型；不一致返回错误文案，一致或无从判断返回 null。
 * 只有 codebuddy 提供 modelUsage；opencode 的 json 是事件流，暂无等价校验。
 */
export function modelMismatch(product, model, stdout) {
  if (product !== 'codebuddy' || !model) return null
  const used = reportedModels(stdout)
  const wanted = normalizeModelName(model)
  if (used.length === 0 || used.includes(wanted)) return null
  return `模型不一致：请求 ${wanted}，实际使用 ${used.join(',')}——已停止，不降级`
}

/** 从 codebuddy 的 json 信封里取实际使用的模型列表；取不到返回空数组。 */
export function reportedModels(stdout) {
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed.modelUsage === 'object' && parsed.modelUsage !== null) {
        return Object.keys(parsed.modelUsage)
      }
    } catch {
      // 不是信封行，继续
    }
  }
  return []
}

/** codebuddy 在部分参数组合下会吐 JSON 信封；解出 result，其余按纯文本处理。 */
export function extractText(stdout) {
  const text = String(stdout ?? '')
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return text
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed.result === 'string') return parsed.result
  } catch {
    // 不是信封
  }
  return text
}

function requestTask(request) {
  const prompt = request?.prompt
  if (typeof prompt === 'string') return prompt
  if (Array.isArray(prompt)) {
    return prompt
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('\n')
  }
  return ''
}

/**
 * @param {{ product: string, timeoutMs?: number, env?: object, spawnImpl?: Function }} options
 */
export function createProductProvider({ product, bin, timeoutMs = 300000, env = process.env, spawnImpl = spawn }) {
  let seq = 0
  return {
    name: providerName(product),
    inheritsParentContext: false,
    // 四项如实声明：我们不用 agentOptions / agentPreset / outputSchema，只限制递归深度。
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: true },
    async start(request) {
      const started = Date.now()
      const task = requestTask(request)
      const model = request?.model ?? request?.productSettings?.model
      const command = productArgv(product, { model, task, permissionMode: request?.permissionMode })
      const args = command.args
      // 配置里给的二进制优先（codebuddy 在本机是 shim，不在 PATH 上）
      const executable = bin ?? command.bin
      const cwd = request?.parent?.cwd ?? request?.cwd ?? process.cwd()

      // stdin 必须是 ignore：`opencode run` 在 stdin 为「未关闭的管道」时会等输入，
      // 表现为永远不返回（实测：默认 stdio 卡死，ignore 后 2 秒返回）。
      const child = spawnImpl(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr?.on('data', (chunk) => {
        stderr += chunk
      })
      const abort = () => child.kill('SIGTERM')
      request?.signal?.addEventListener?.('abort', abort, { once: true })

      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGTERM')
          const detail = String(stderr).trim().split('\n').slice(-3).join(' ')
          reject(
            new ContractError(
              'E_TIMEOUT',
              `${product} 超过 ${timeoutMs}ms 未返回${detail ? `；stderr: ${detail}` : ''}`,
            ),
          )
        }, timeoutMs)
        child.on('error', (error) => {
          clearTimeout(timer)
          reject(new ContractError('E_UNAVAILABLE', `${executable} 启动失败: ${error.message}`))
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (code === 0) {
            // 防降级：请求了具体模型时，CLI 自报的 modelUsage 必须包含它。
            const mismatch = modelMismatch(product, model, stdout)
            if (mismatch) {
              const error = new ContractError('E_UNAVAILABLE', mismatch)
              error.durationMs = Date.now() - started
              reject(error)
              return
            }
            resolve({ output: [{ type: 'text', text: extractText(stdout) }], stopReason: 'end' })
            return
          }
          const detail = String(stderr).trim().split('\n').slice(-2).join(' ')
          reject(new ContractError('E_UNAVAILABLE', `${product} 退出码 ${code}: ${detail}`))
        })
      })

      return {
        id: `${product}-${Date.now().toString(36)}-${++seq}`,
        localAgent: undefined,
        result,
        async dispose() {
          request?.signal?.removeEventListener?.('abort', abort)
          if (!child.killed) child.kill('SIGTERM')
        },
      }
    },
  }
}

/** 本机装了哪个 product 才注册哪个，避免注册出一个一调就失败的 provider。 */
export function detectProducts({ env = process.env, exists = defaultExists, candidates = Object.keys(PRODUCTS) } = {}) {
  return candidates.filter((product) => exists(PRODUCTS[product].bin, env))
}

function defaultExists(bin, env) {
  const searchPath = String(env.PATH ?? '')
  for (const dir of searchPath.split(':')) {
    if (!dir) continue
    try {
      if (existsSync(join(dir, bin))) return true
    } catch {
      // 目录不可读，跳过
    }
  }
  return false
}

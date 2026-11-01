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
  },
  codebuddy: {
    bin: 'codebuddy',
    argv: ({ model, task }) => ['-p', ...(model ? ['--model', model] : []), task],
  },
}

/** provider 的注册名必须带 `product-subagents:` 前缀——audit-subagents.mjs 靠它识别会话。 */
export function providerName(product) {
  return `product-subagents:${product}`
}

export function productArgv(product, { model, task }) {
  const spec = PRODUCTS[product]
  if (!spec) throw new ContractError('E_UNAVAILABLE', `未支持的 product: ${product}`)
  if (!task) throw new ContractError('E_UNAVAILABLE', '委派任务不能为空')
  return { bin: spec.bin, args: spec.argv({ model, task }) }
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
export function createProductProvider({ product, timeoutMs = 300000, env = process.env, spawnImpl = spawn }) {
  let seq = 0
  return {
    name: providerName(product),
    inheritsParentContext: false,
    // 四项如实声明：我们不用 agentOptions / agentPreset / outputSchema，只限制递归深度。
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: true },
    async start(request) {
      const task = requestTask(request)
      const model = request?.model ?? request?.productSettings?.model
      const { bin, args } = productArgv(product, { model, task })
      const cwd = request?.parent?.cwd ?? request?.cwd ?? process.cwd()

      // stdin 必须是 ignore：`opencode run` 在 stdin 为「未关闭的管道」时会等输入，
      // 表现为永远不返回（实测：默认 stdio 卡死，ignore 后 2 秒返回）。
      const child = spawnImpl(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
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
          reject(new ContractError('E_UNAVAILABLE', `${bin} 启动失败: ${error.message}`))
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (code === 0) {
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

/**
 * 形态 B：把请求交给一个外部 CLI，拿回纯文本。
 *
 * 一期只做一次性调用（`opencode run` / `codebuddy -p`），不移植 ACP 会话：
 * reviewer 天然是一次性调用，续接对它没有意义；ACP 会话状态机与 executor
 * 一起放到 PR4，避免「契约校验错了」和「会话管理错了」混在一个红灯里。
 */
import { spawnSync } from 'node:child_process'
import { ContractError } from './contract.js'

const PROVIDERS = {
  opencode: {
    bin: 'opencode',
    args: (model, prompt) => ['run', '--model', model, prompt],
  },
  codebuddy: {
    bin: 'codebuddy',
    args: (model, prompt) => ['-p', '--output-format', 'text', '--model', model, prompt],
  },
}

export function providerCommand(provider, model, prompt, env = process.env) {
  const spec = PROVIDERS[provider]
  if (!spec) {
    throw new ContractError('E_UNAVAILABLE', `未支持的 provider: ${provider}（一期只有 opencode / codebuddy）`)
  }
  if (!model) throw new ContractError('E_UNAVAILABLE', '形态 B 必须显式指定 model')
  const bin = env[`DSH_SUBAGENTS_${provider.toUpperCase()}_BIN`] || spec.bin
  return { bin, args: spec.args(model, prompt) }
}

/**
 * @returns {{ text: string, meta: { form: string, provider: string, model: string, durationMs: number } }}
 */
export function runProvider({ provider, model, prompt, timeoutMs = 300000, cwd, env = process.env }) {
  const { bin, args } = providerCommand(provider, model, prompt, env)
  const started = Date.now()
  const result = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    env,
    maxBuffer: 64 * 1024 * 1024,
  })
  const durationMs = Date.now() - started

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new ContractError('E_UNAVAILABLE', `找不到 ${bin}（形态 B 需要本机安装该 CLI）`)
    }
    if (result.error.code === 'ETIMEDOUT' || result.signal) {
      throw new ContractError('E_TIMEOUT', `${provider} 超过 ${timeoutMs}ms 未返回`)
    }
    throw new ContractError('E_UNAVAILABLE', `${provider} 调用失败: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = (result.stderr || '').trim().split('\n').slice(-2).join(' ')
    throw new ContractError('E_UNAVAILABLE', `${provider} 退出码 ${result.status}: ${detail}`)
  }

  return {
    text: result.stdout ?? '',
    meta: { form: 'cli', provider, model, durationMs },
  }
}

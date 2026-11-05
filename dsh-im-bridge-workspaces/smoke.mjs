/**
 * im-bridge 的冒烟断言（`dsh.smoke` 契约见 `docs/plugins/dsh-auto-upgrade.md`）。
 * 重点是 #299 那一类：dsh 改了 `installModelSelection` 签名，声明和试装都看不出来。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 跑一遍断言。
 * @returns {Promise<{ok: boolean, checks: {name: string, ok: boolean, detail?: string}[]}>} 结果。
 */
export async function run(context = {}) {
  const checks = []
  // 必须验**宿主实际加载的那份** dsh-agent：直接 import 会解析到本插件 node_modules 里的旧副本，
  // 那样断言就成了「对着老版本自证清白」（升级后仍然绿，等于没验）。
  const agent = context.dshDir === undefined
    ? await import('@deepseek-ai/dsh-agent')
    : await import(pathToFileURL(createRequire(join(context.dshDir, 'package.json')).resolve('@deepseek-ai/dsh-agent')).href)
  const install = agent.installModelSelection
  const arity = typeof install === 'function' ? install.length : -1
  checks.push({
    name: 'dsh-agent 仍导出 installModelSelection',
    ok: typeof install === 'function',
    detail: `arity=${String(arity)}`,
  })

  const bridge = await import('./lib/index.js')
  const needsSelection = bridge.needsSelectionArg(install)
  checks.push({
    name: '分流判定与运行时 arity 一致',
    ok: needsSelection === (arity >= 2),
    detail: `arity=${String(arity)} → needsSelectionArg=${String(needsSelection)}`,
  })

  const selection = { provider: 'smoke', model: 'smoke', reasoningEffort: 'high' }
  const withEffort = bridge.buildAgentOptions(selection, true)
  checks.push({
    name: '单参数线把 reasoningEffort 随 agentOptions 下发',
    ok: withEffort.reasoningEffort === 'high',
    detail: `reasoningEffort=${String(withEffort.reasoningEffort)}`,
  })
  const oldLine = bridge.buildAgentOptions(selection, false)
  checks.push({
    name: '两参数线不塞老版本没有的字段',
    ok: !('reasoningEffort' in oldLine),
  })
  checks.push({
    name: '插件导出面完整（apply / inject / name）',
    ok: ['apply', 'inject', 'name'].every((key) => key in bridge),
  })
  return { ok: checks.every((check) => check.ok), checks }
}

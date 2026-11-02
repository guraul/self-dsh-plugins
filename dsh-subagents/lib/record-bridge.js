/**
 * 记录桥：把「解析响应 → 组装记录 → 落盘」整段交给共享 pipeline 包。
 *
 * 插件端不再保留第二份组装逻辑——记录结构、判定提取与策略版本只有一个真源
 * （@guraul/dsh-pipeline）。这里只做参数映射与输出透传。
 *
 * 包位置解析与 scripts/pipeline/merge-pr.sh 保持一致：
 *   优先 $DSH_PIPELINE_HOME，缺省 <仓库根>/tools/node_modules/dsh-pipeline。
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { recordFile, reviewsDir } from './record.js'

function pipelineHome(root = process.cwd()) {
  const fromEnv = process.env.DSH_PIPELINE_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return resolve(root, 'tools', 'node_modules', 'dsh-pipeline')
}

function pipelineCli(root = process.cwd()) {
  return join(pipelineHome(root), 'bin', 'cli.mjs')
}

function optionalArg(args, name, value) {
  if (typeof value === 'string' && value.length > 0) args.push(`--${name}`, value)
}

/**
 * 调共享包的 `record` 子命令。
 *
 * 一律带 `--json` 调包：包里 stdout 就是刚写出的完整记录，插件据此复现对外
 * 退出码契约（判定不是 APPROVE → 1），不必去解析中文提示。包非 0 时原样透传。
 *
 * @param {object} options
 * @param {string} options.requestFile
 * @param {string} options.responseFile
 * @param {string} [options.findingsFile]
 * @param {string} [options.provider]
 * @param {string} [options.model]
 * @param {number} [options.round]
 * @param {string} [options.root]
 * @param {boolean} [options.json] 成功时输出记录 JSON（否则输出中文落盘提示）
 * @param {string} [options.form]
 * @param {number} [options.durationMs]
 * @returns {{ status: number, record: object | null }} 包进程退出码（2 表示参数/环境错误，含找不到包）与记录本体
 */
export function recordViaPackage({
  requestFile,
  responseFile,
  findingsFile,
  provider,
  model,
  round,
  root,
  json,
  form,
  durationMs,
} = {}) {
  const cwd = root || process.cwd()
  const cli = pipelineCli(cwd)
  if (!existsSync(cli)) {
    process.stderr.write(
      `错误: 找不到共享 pipeline 包: ${cli} （在 tools/ 里跑 pnpm install，或设置 DSH_PIPELINE_HOME）\n`,
    )
    return { status: 2, record: null }
  }

  const args = ['record', '--request', String(requestFile), '--response', String(responseFile)]
  optionalArg(args, 'findings', findingsFile)
  optionalArg(args, 'provider', provider)
  optionalArg(args, 'model', model)
  if (round !== undefined) args.push('--round', String(round))
  if (typeof root === 'string' && root.length > 0) args.push('--root', root)
  if (durationMs !== undefined) args.push('--duration-ms', String(durationMs))
  optionalArg(args, 'form', form)
  args.push('--json')

  const result = spawnSync(cli, args, { encoding: 'utf8' })
  if (result.error) {
    process.stderr.write(`错误: 无法执行共享 pipeline 包 CLI: ${result.error.message}\n`)
    return { status: 2, record: null }
  }
  if (result.status !== 0) {
    // 参数/环境错误：包自己的诊断原样透传，退出码不翻译。
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    return { status: typeof result.status === 'number' ? result.status : 2, record: null }
  }

  let record
  try {
    record = JSON.parse(String(result.stdout ?? ''))
  } catch {
    record = null
  }
  if (record === null || typeof record !== 'object' || typeof record.verdict !== 'string') {
    process.stderr.write('错误: 共享 pipeline 包的 --json 输出不是合法记录，无法确定判定\n')
    return { status: 2, record: null }
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
  } else {
    process.stdout.write(`已写入审核记录: ${recordFile(reviewsDir(cwd), record.pr, record.head_sha)}\n`)
  }
  return { status: 0, record }
}

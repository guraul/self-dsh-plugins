/**
 * 记录桥：把「解析响应 → 组装记录 → 落盘」整段交给共享 pipeline 包。
 *
 * 插件端不再保留第二份组装逻辑——记录结构、判定提取与策略版本只有一个真源
 * （@guraul/dsh-pipeline）。这里只做参数映射与输出透传。
 *
 * 包位置解析顺序（跨仓审核时 `--root` 是被审仓，包却装在插件自己所在的仓）：
 *   1. $DSH_PIPELINE_HOME
 *   2. 从插件自身 lib 目录向上最多 4 层找 tools/node_modules/dsh-pipeline
 *      ——主仓与 worktree 都能命中；worktree 没装 tools 时继续向上命中主仓
 *   3. <root>/tools/node_modules/dsh-pipeline（目标仓自带也认）
 *   4. 都没有才报错，错误信息里列出所有试过的路径
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { recordFile, reviewsDir } from './record.js'

/** 本文件所在目录 = 插件的 lib 目录；跨仓时这是唯一可靠的定位锚点。 */
export const PLUGIN_LIB_DIR = dirname(fileURLToPath(import.meta.url))

const RELATIVE_CLI = join('tools', 'node_modules', 'dsh-pipeline', 'bin', 'cli.mjs')
const MAX_ASCEND = 4

/**
 * 按解析顺序列出候选 CLI 路径（去重、保序，不判断存在性）。
 *
 * @param {object} [options]
 * @param {string} [options.root] 目标仓根（被审仓）
 * @param {string} [options.from] 向上查找的起点，默认插件自身 lib 目录
 * @param {NodeJS.ProcessEnv} [options.env] 默认 process.env
 * @returns {string[]}
 */
export function pipelineCliCandidates({ root, from = PLUGIN_LIB_DIR, env = process.env } = {}) {
  const candidates = []
  const push = (candidate) => {
    if (typeof candidate === 'string' && candidate.length > 0 && !candidates.includes(candidate)) {
      candidates.push(candidate)
    }
  }

  const home = env.DSH_PIPELINE_HOME
  if (typeof home === 'string' && home.length > 0) push(join(home, 'bin', 'cli.mjs'))

  let dir = resolve(from)
  push(join(dir, RELATIVE_CLI))
  for (let level = 0; level < MAX_ASCEND; level += 1) {
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
    push(join(dir, RELATIVE_CLI))
  }

  if (typeof root === 'string' && root.length > 0) push(join(resolve(root), RELATIVE_CLI))

  return candidates
}

/**
 * 命中第一个存在的候选；都没有时 `cli` 为 null，`tried` 供报错信息使用。
 *
 * @param {object} [options] 同 {@link pipelineCliCandidates}
 * @returns {{ cli: string | null, tried: string[] }}
 */
export function resolvePipelineCli(options = {}) {
  const tried = pipelineCliCandidates(options)
  const cli = tried.find((candidate) => existsSync(candidate))
  return { cli: cli ?? null, tried }
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
  const { cli, tried } = resolvePipelineCli({ root: cwd })
  if (cli === null) {
    process.stderr.write(
      `错误: 找不到共享 pipeline 包（在 tools/ 里跑 pnpm install，或设置 DSH_PIPELINE_HOME）。已尝试:\n${tried
        .map((candidate) => `  - ${candidate}`)
        .join('\n')}\n`,
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
    process.stderr.write(
      '错误: 共享 pipeline 包的 --json 输出不是合法记录，无法确定判定（记录可能已落盘，请检查 .dsh-web/reviews）\n',
    )
    return { status: 2, record: null }
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
  } else {
    process.stdout.write(`已写入审核记录: ${recordFile(reviewsDir(cwd), record.pr, record.head_sha)}\n`)
  }
  return { status: 0, record }
}

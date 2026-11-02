#!/usr/bin/env bash
# open-pr.sh — 薄转发：本仓的开 PR 入口交给共享包 @guraul/dsh-pipeline
#
# 为什么只有几十行: 自 issue #235 起，「校验 task 分支 → 推送 → 拼 PR body → 幂等开 PR」的
#   **唯一实现**是共享包 @guraul/dsh-pipeline 的 `pr` 子命令；本仓只保留一个
#   「文件名与参数都不变」的转发壳，免得两份实现各自漂移。
#
# 用法（与旧脚本一致）:
#   cd .worktrees/<号>-<slug> && scripts/pipeline/open-pr.sh
#
# 约定（由包侧执行）：当前分支必须是 task/<号>-<slug>，PR body 首行 Closes #<号>；
#   工作区必须干净；PR 已存在则只打印链接，不重推、不新建。
#
# 包位置: 优先 $DSH_PIPELINE_HOME，缺省 <repo>/tools/node_modules/dsh-pipeline。
#   注意：装的是 `dist/latest.tgz` 的**打包产物**（见 tools/package.json），不是源码 checkout。
#
# 退出码: 原样透传包侧退出码：0 成功 / PR 已存在；2 用法或环境错误（含不在 task 分支、
#   脏工作区、issue 无法访问）。
source "$(dirname "$0")/lib.sh"
set -u   # lib.sh 已设过，这里显式重申：本脚本靠它保护变量存在性判断

# lib.sh 的 die 退出 1；本壳的失败一律是「用法/环境错误」，按包侧语义退出 2
die() { echo "✗ $*" >&2; exit 2; }

require_gh

# —— 共享包位置 ——
PKG_HOME=""
if [[ -n "${DSH_PIPELINE_HOME+x}" ]]; then PKG_HOME="${DSH_PIPELINE_HOME}"; fi
if [[ -z "${PKG_HOME}" ]]; then PKG_HOME="${REPO_ROOT}/tools/node_modules/dsh-pipeline"; fi
CLI="${PKG_HOME}/bin/cli.mjs"
[[ -f "${CLI}" ]] \
  || die "找不到共享 pipeline 包: ${CLI} （在 tools/ 里跑 pnpm install，或设置 DSH_PIPELINE_HOME）"
command -v node >/dev/null 2>&1 || die "需要 node：共享包是 Node CLI"

# —— 参数原样转发（不做任何解析：分支校验 / 脏工作区 / PR body 全在包里做）——
info "已切换到共享 pipeline 包：${PKG_HOME}"
info "转发: node ${CLI} pr $*"

set +e
node "${CLI}" pr "$@"
RC=$?
set -e
exit "${RC}"

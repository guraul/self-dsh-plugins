#!/usr/bin/env bash
# lib.sh — pipeline 脚本公共常量与工具（被其他脚本 source，不直接执行）
# 手册：docs/pipeline/README.md
#
# 与 agent-mobile 版本的区别：本仓库没有服务器、没有部署，故不含
# SERVER_HOST / SERVER_USER / remote() / BFF_REPO 等部署侧常量。
# 本仓库的"交付物"是插件被本机 DSH profile 正确装配，见 install-check.sh。

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "✗ 必须在 self-dsh-plugins 仓库（或其 worktree）内运行" >&2; exit 1; }

GH_REPO="guraul/self-dsh-plugins"

# 第一层 git fetch 失败后的重试次数（macOS 自带没有 timeout，用重试代替）
FETCH_RETRY=2

# 九个插件：本仓库插件目录名白名单（SUMMARY 与 install-check 用）
# 包名不在这里维护——用 pkg_name() 从各插件 package.json 读，避免注定漂移的副本。
# 新增插件时第一个动作就是往这里加目录名，见 docs/pipeline/README.md「新增插件检查清单」。
PLUGIN_DIRS="dsh-auto-upgrade dsh-external-discuss dsh-im-bridge-workspaces dsh-plugin-product-subagents dsh-prompt-optimizer dsh-subagents dsh-zhihu-sidebar dsh-plugin-memx dsh-awake dsh-usage-panel"

die()  { echo "✗ $*" >&2; exit 1; }
info() { echo "→ $*"; }
ok()   { echo "✓ $*"; }

require_gh() {
  command -v gh >/dev/null 2>&1 || die "需要 gh CLI（https://cli.github.com），且已 gh auth login"
}

# 从 issue 标题生成文件名安全的短 slug（仅 [a-z0-9-]，截断 40）
# 非 ASCII 标题（本仓库 issue 多为中文）会被 sed 清空，此时回退成标题 sha1 的前 8 位：
# 确定性 —— 同一个 issue 重跑本脚本仍得到同一个分支名，worktree 判重才可靠。
slugify() {
  local title="$1"
  local slug
  slug=$(printf '%s' "${title}" | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40)
  if [[ -z "${slug}" ]]; then
    slug=$(printf '%s' "${title}" | shasum -a 1 | cut -c1-8)
  fi
  printf '%s' "${slug}"
}

# 校验参数是正整数 issue 号
is_issue_number() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

# 读插件 package.json 的 scripts.<键>；不存在或读不出则输出空串（软失败）
pkg_script() {
  node -e '
    const fs = require("fs");
    try {
      const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write((p.scripts && p.scripts[process.argv[2]]) || "");
    } catch (e) { process.stdout.write(""); }
  ' "$1" "$2" 2>/dev/null || printf ''
}

# 读插件 package.json 的 name（软失败）
pkg_name() {
  node -e '
    const fs = require("fs");
    try {
      const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(p.name || "");
    } catch (e) { process.stdout.write(""); }
  ' "$1" 2>/dev/null || printf ''
}

# 找检出某个分支的 worktree 绝对路径（找不到输出空串）
worktree_for_branch() {
  local want="$1" line path=""
  while IFS= read -r line; do
    case "${line}" in
      "worktree "*) path="${line#worktree }" ;;
      "branch refs/heads/${want}") printf '%s' "${path}"; return 0 ;;
    esac
  done < <(git -C "${REPO_ROOT}" worktree list --porcelain 2>/dev/null)
  printf ''
}

# 找检出 main 的主工作区绝对路径（找不到输出空串）
main_worktree() {
  local line path=""
  while IFS= read -r line; do
    case "${line}" in
      "worktree "*) path="${line#worktree }" ;;
      "branch refs/heads/main") printf '%s' "${path}"; return 0 ;;
    esac
  done < <(git -C "${REPO_ROOT}" worktree list --porcelain 2>/dev/null)
  printf ''
}

# —— 共享 pipeline 包（@guraul/dsh-pipeline）解析 ——
# 为什么需要集中解析: 转发壳可能在 worktree 里被调用，而依赖装在**主工作区**的
#   tools/node_modules；用 REPO_ROOT（= 当前 worktree 根）拼路径会落空（issue #235）。
# 查找顺序（三个转发壳共用，别再各写一份）：
#   ① $DSH_PIPELINE_HOME（显式覆盖：设了就是权威来源，不再回退——免得设错却静默用到别的包）
#   ② <主工作区>/tools/node_modules/dsh-pipeline
#      （主工作区 = git common dir 的父目录；worktree 里 common dir 指向主仓 .git）
#   ③ <当前目录所在仓>/tools/node_modules/dsh-pipeline（非 worktree 的常规场景）
# 结果: 成功设置 PIPELINE_CLI_PATH；失败返回 1，并把试过的路径逐行写进 PIPELINE_TRIED
#   （用全局变量而不是 stdout：调用方若在 $(...) 里取值，子 shell 里改的变量传不回来）。
PIPELINE_CLI_PATH=""
PIPELINE_HOME=""
PIPELINE_TRIED=""

_pipeline_cli_candidates() {
  local common main
  if [[ -n "${DSH_PIPELINE_HOME:-}" ]]; then
    printf '%s\n' "${DSH_PIPELINE_HOME%/}/bin/cli.mjs"
    return 0
  fi
  # 旧 git 可能返回相对路径（主工作区里就是 `.git`），统一折成绝对路径再取父目录
  common=$(git rev-parse --git-common-dir 2>/dev/null) || common=""
  if [[ -n "${common}" ]]; then
    common=$( (cd "${common}" 2>/dev/null && pwd -P) ) || common=""
  fi
  if [[ -n "${common}" ]]; then
    main=$(dirname "${common}")
    printf '%s\n' "${main}/tools/node_modules/dsh-pipeline/bin/cli.mjs"
  fi
  printf '%s\n' "${REPO_ROOT}/tools/node_modules/dsh-pipeline/bin/cli.mjs"
}

resolve_pipeline_cli() {
  local candidate seen=""
  PIPELINE_CLI_PATH=""
  PIPELINE_TRIED=""
  while IFS= read -r candidate; do
    [[ -n "${candidate}" ]] || continue
    # 主工作区 == 当前仓时候选会重复，只报一次
    case "${seen}" in *"|${candidate}|"*) continue ;; esac
    seen="${seen}|${candidate}|"
    if [[ -f "${candidate}" ]]; then
      PIPELINE_CLI_PATH="${candidate}"
      return 0
    fi
    PIPELINE_TRIED="${PIPELINE_TRIED}${candidate}"$'\n'
  done < <(_pipeline_cli_candidates)
  return 1
}

# 供转发壳调用：成功则设置 PIPELINE_CLI_PATH / PIPELINE_HOME；失败 die（壳侧把 die 映射成 exit 2）
require_pipeline_pkg() {
  if ! resolve_pipeline_cli; then
    die "找不到共享 pipeline 包（dsh-pipeline）。已尝试以下路径:
$(printf '%s' "${PIPELINE_TRIED}" | sed 's/^/  - /')
请在主工作区的 tools/ 里跑 pnpm install，或设置 DSH_PIPELINE_HOME 指向包目录"
  fi
  PIPELINE_HOME=$(dirname "$(dirname "${PIPELINE_CLI_PATH}")")
  command -v node >/dev/null 2>&1 || die "需要 node：共享包是 Node CLI"
}

# 高亮一行安装/检查结论（只渲染，不改变退出码）
mark() {
  case "$1" in
    ok)   echo "  ✓ $2" ;;
    skip) echo "  - $2（跳过）" ;;
    *)    echo "  ✗ $2" ;;
  esac
}

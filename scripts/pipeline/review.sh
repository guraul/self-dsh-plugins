#!/usr/bin/env bash
# review.sh — 审核循环里的机械步骤：prepare / publish / paths
#
# 不包含的一步：reviewer 的模型调用。那必须由会话内的 agent 发起（形态 A 或 B），
# 脚本只负责准备材料与发布结果。
#
# 产物一律写在项目内 .tmp/review/<pr>/（.gitignore 已覆盖）：macOS 每天会清理 /tmp
# 里 3 天未访问的文件，把证据放那儿会悄悄消失。
#
# 用法:
#   scripts/pipeline/review.sh prepare <pr> [--model <模型>]
#   scripts/pipeline/review.sh publish <pr> --record <记录文件> --round <n> [--dry-run] [--repo <owner/name>]
#   scripts/pipeline/review.sh paths <pr>
set -u
source "$(dirname "$0")/lib.sh"

CLI="${REPO_ROOT}/dsh-subagents/lib/cli.js"
# 产物落**主工作区**：reviewer 子代理的工作目录是主工作区（不是当前 worktree），
# worktree 还会在合并时被删掉。和审核记录落在主工作区是同一个理由。
MAIN_WT=$(main_worktree)
[[ -n "${MAIN_WT}" ]] || die "未找到 main 主工作区"
BASE_TMP="${MAIN_WT}/.tmp/review"
GH_REVIEWER_DIR="${GH_REVIEWER_DIR:-$HOME/.config/gh-reviewer}"

usage() {
  cat >&2 <<'USAGE'
用法:
  scripts/pipeline/review.sh prepare <pr> [--model <模型>]
  scripts/pipeline/review.sh publish <pr> --record <记录文件> --round <n> [--dry-run] [--repo <owner/name>]
  scripts/pipeline/review.sh paths <pr>

说明: reviewer 的模型调用不在本脚本内，由会话内 agent 发起（形态 A 或 B）。
USAGE
  exit 1
}

pr_dir() { echo "${BASE_TMP}/$1"; }

cmd_prepare() {
  local pr="$1"; shift
  local model=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --model) [[ $# -ge 2 ]] || usage; model="$2"; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ "${pr}" =~ ^[0-9]+$ ]] || usage

  local dir; dir=$(pr_dir "${pr}")
  mkdir -p "${dir}"

  local args=(prepare --pr "${pr}" --out "${dir}/request.json")
  if [[ -n "${model}" ]]; then args+=(--model "${model}"); fi
  node "${CLI}" "${args[@]}" >/dev/null || die "prepare 失败"
  node "${CLI}" prompt --request "${dir}/request.json" --out "${dir}/prompt.md" >/dev/null \
    || die "生成 prompt 失败"

  node -e '
const fs = require("node:fs")
const path = require("node:path")
const dir = process.argv[1]
const payload = JSON.parse(fs.readFileSync(path.join(dir, "request.json"), "utf8"))
const { request, stats } = payload
console.log(`PR #${request.pr}  nonce=${request.nonce}  head=${String(request.head_sha).slice(0, 8)}  diff=${stats.diffChars}  model=${request.model ?? "-"}`)
console.log(`产物: ${dir}/request.json`)
console.log(`      ${dir}/prompt.md`)
' "${dir}"
}

cmd_publish() {
  local pr="$1"; shift
  local record="" round="" dry="" repo=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --record) [[ $# -ge 2 ]] || usage; record="$2"; shift 2 ;;
      --round) [[ $# -ge 2 ]] || usage; round="$2"; shift 2 ;;
      --dry-run) dry="--dry-run"; shift ;;
      --repo) [[ $# -ge 2 ]] || usage; repo="$2"; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ "${pr}" =~ ^[0-9]+$ ]] || usage
  [[ -n "${record}" ]] || die "publish 需要 --record <文件>"
  [[ -n "${round}" ]] || die "publish 需要 --round <n>"
  [[ "${round}" =~ ^[0-9]+$ ]] || die "--round 必须是正整数"
  [[ -r "${record}" ]] || die "记录文件不可读: ${record}"

  # 位置参数里的 pr 必须与记录一致，否则「传错 PR 号」会被静默忽略
  local record_pr
  record_pr=$(node -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).pr))' "${record}") \
    || die "记录文件无法解析: ${record}"
  [[ "${record_pr}" == "${pr}" ]] \
    || die "位置参数 PR #${pr} 与记录里的 PR #${record_pr} 不一致"

  local args=(publish --record "${record}" --round "${round}")
  if [[ -n "${dry}" ]]; then args+=("${dry}"); fi
  if [[ -n "${repo}" ]]; then args+=(--repo "${repo}"); fi
  GH_CONFIG_DIR="${GH_REVIEWER_DIR}" node "${CLI}" "${args[@]}"
}

cmd_paths() {
  local pr="$1"
  [[ "${pr}" =~ ^[0-9]+$ ]] || usage
  local dir; dir=$(pr_dir "${pr}")
  echo "request: ${dir}/request.json"
  echo "prompt:  ${dir}/prompt.md"
}

[[ $# -ge 1 ]] || usage
CMD="$1"; shift
case "${CMD}" in
  prepare) [[ $# -ge 1 ]] || usage; cmd_prepare "$@" ;;
  publish) [[ $# -ge 1 ]] || usage; cmd_publish "$@" ;;
  paths)   [[ $# -ge 1 ]] || usage; cmd_paths "$@" ;;
  *) usage ;;
esac

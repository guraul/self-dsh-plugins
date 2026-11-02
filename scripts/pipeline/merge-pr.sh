#!/usr/bin/env bash
# merge-pr.sh — 薄转发：本仓的合并入口交给共享包 @guraul/dsh-pipeline
#
# 为什么只有几十行: 自 issue #187 起，「闸门 → CI → squash 合并 → 清理现场」的**唯一实现**
#   是共享包 @guraul/dsh-pipeline；本仓只保留一个「文件名与参数都不变」的转发壳，
#   免得两份实现各自漂移。原实现留在 scripts/pipeline/merge-pr.legacy.sh（已弃用，仅回滚用）。
#
# 用法（与旧脚本一致）:
#   cd <worktree> && scripts/pipeline/merge-pr.sh          # 用当前分支对应的 PR
#   scripts/pipeline/merge-pr.sh <PR号|分支名>              # 任意位置指定目标（分支名会解析成 PR 号）
#   scripts/pipeline/merge-pr.sh <PR号> --check-only        # 演练：跑到闸门/CI 为止，不合并、不清理
#   scripts/pipeline/merge-pr.sh <PR号> --review-record=<文件>
#   scripts/pipeline/merge-pr.sh <PR号> --no-review --reason=<文本>
#   scripts/pipeline/merge-pr.sh <PR号> --checks-file=<文件>
#   scripts/pipeline/merge-pr.sh <PR号> --force
#
# 参数映射: --review-record=<f> → 包里的 --record <f>；--no-review / --reason / --check-only /
#   --checks-file / --force 原样传；--dry-run 是 --check-only 的旧别名。
#
# 包位置（顺序固定，解析只在 lib.sh 的 resolve_pipeline_cli 里实现一次）:
#   ① $DSH_PIPELINE_HOME；② 主工作区 tools/node_modules/dsh-pipeline（worktree 场景）；
#   ③ 当前仓 tools/node_modules/dsh-pipeline（非 worktree）。
#   注意：装的是 `dist/latest.tgz` 的**打包产物**（见 tools/package.json），不是源码 checkout——
#   否则「包门禁通过才发布」这道护栏就形同虚设（ADR-0003 §4）。
#
# 与旧脚本的三处语义差异（都来自共享包，不是本壳的取舍）:
#   * --no-review 必须同时给 --reason（包要求跳过必须留原因）。
#   * --checks-file 读 JSON（形如 {"state":"success"}），不再读 `gh pr checks` 原文。
#   * DSH_REVIEWER=off 不再自动跳过审核；要跳过请显式 --no-review --reason=<文本>。
source "$(dirname "$0")/lib.sh"
set -u   # lib.sh 已设过，这里显式重申：本脚本靠它保护变量存在性判断

# lib.sh 的 die 退出 1；本壳的失败一律是「用法/环境错误」，按包侧语义退出 2（与另两个转发壳一致）
die() { echo "✗ $*" >&2; exit 2; }

TARGET=""; CHECK_ONLY=0; CHECKS_FILE=""; RECORD=""; NO_REVIEW=0; REASON=""; FORCE=0
HAS_CHECKS=0; HAS_RECORD=0; HAS_REASON=0
while [[ "$#" -gt 0 ]]; do
  a="$1"; shift
  case "${a}" in
    --force)                FORCE=1 ;;
    --check-only|--dry-run) CHECK_ONLY=1 ;;
    --no-review)            NO_REVIEW=1 ;;
    --checks-file=*)        CHECKS_FILE="${a#--checks-file=}"; HAS_CHECKS=1 ;;
    --review-record=*)      RECORD="${a#--review-record=}"; HAS_RECORD=1 ;;
    --reason=*)             REASON="${a#--reason=}"; HAS_REASON=1 ;;
    --checks-file|--review-record|--reason)
      [[ "$#" -gt 0 ]] || die "${a} 缺少取值"
      case "${a}" in
        --checks-file)   CHECKS_FILE="$1"; HAS_CHECKS=1 ;;
        --review-record) RECORD="$1"; HAS_RECORD=1 ;;
        --reason)        REASON="$1"; HAS_REASON=1 ;;
      esac
      shift ;;
    -*) die "未知参数: ${a} （可用: --check-only / --checks-file=<文件> / --review-record=<文件> / --no-review / --reason=<文本> / --force）" ;;
    *)  TARGET="${a}" ;;
  esac
done

# —— 共享包位置 ——
require_pipeline_pkg

# —— 主工作区（记录落在这里，不是 worktree） ——
MAIN_WT=$(git -C "${REPO_ROOT}" worktree list --porcelain | awk '/^worktree /{print $2; exit}')
[[ -n "${MAIN_WT}" ]] || die "找不到主工作区"
command -v gh >/dev/null 2>&1 || die "需要 gh：合并脚本要读 PR 状态"

# —— 目标 PR：包要求 --pr 是正整数，分支名/当前分支在这里先解析成 PR 号 ——
PR=""
if [[ -n "${TARGET}" ]]; then
  if [[ "${TARGET}" =~ ^[0-9]+$ ]]; then
    PR="${TARGET}"
  else
    PR=$(gh pr view "${TARGET}" --repo "${GH_REPO}" --json number -q .number 2>/dev/null) || PR=""
  fi
else
  BRANCH=$(git -C "${REPO_ROOT}" branch --show-current) || BRANCH=""
  [[ "${BRANCH}" == task/* ]] \
    || die "在 task/* 分支（worktree）内运行，或用 <PR号|分支名> 指定目标"
  PR=$(gh pr view "${BRANCH}" --repo "${GH_REPO}" --json number -q .number 2>/dev/null) || PR=""
fi
[[ -n "${PR}" ]] || die "找不到 PR: ${TARGET:-$(git -C "${REPO_ROOT}" branch --show-current)}"

# —— 参数转发（只做映射，不做任何判定）——
set -- merge --pr "${PR}" --root "${MAIN_WT}"
if [[ "${HAS_RECORD}" -eq 1 ]]; then set -- "$@" --record "${RECORD}"; fi
if [[ "${HAS_CHECKS}" -eq 1 ]]; then set -- "$@" --checks-file "${CHECKS_FILE}"; fi
if [[ "${HAS_REASON}" -eq 1 ]]; then set -- "$@" --reason "${REASON}"; fi
if [[ "${NO_REVIEW}" -eq 1 ]]; then set -- "$@" --no-review; fi
if [[ "${CHECK_ONLY}" -eq 1 ]]; then set -- "$@" --check-only; fi
if [[ "${FORCE}" -eq 1 ]]; then set -- "$@" --force; fi

info "已切换到共享 pipeline 包：${PIPELINE_HOME}"
info "转发: node ${PIPELINE_CLI_PATH} $*"

set +e
node "${PIPELINE_CLI_PATH}" "$@"
RC=$?
set -e
exit "${RC}"

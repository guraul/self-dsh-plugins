#!/usr/bin/env bash
# merge-pr.sh — squash 合并当前任务的 PR 并清理现场
#
# ⚠️ 人在环约定（见 docs/pipeline/README.md §一）：调用方必须先拿到用户对本次 review 的
#    **明确同意**才运行本脚本。本脚本不自己询问、也不校验"是否已同意"——这是调用纪律。
#
# 用法:
#   cd <worktree> && scripts/pipeline/merge-pr.sh        # 在 worktree 内：自动识别当前分支的 PR
#   scripts/pipeline/merge-pr.sh <PR号|分支名>            # 任意位置（含主工作区）指定 PR
#   scripts/pipeline/merge-pr.sh <PR号> --force           # CI 未过/未配置时仍合并（慎用）
#
# 行为: 定位 PR → CI checks 未过则拒绝 → gh pr merge --squash
#       → 删远端分支 → 删本地分支 → 清理对应 worktree → 主工作区 pull --ff-only 快进
# 幂等: PR 已合并（MERGED）时跳过合并步骤，仅继续清理现场并快进 main
#
# 与 agent-mobile 的差异（修掉那边已知的缺陷，见其 AGENTS.md 规定 15 ④ / issue #102）：
#   从主工作区运行时**不再跳过** worktree 清理与 main 快进——本脚本会通过
#   `git worktree list` 反查持有该分支的 worktree 并移除它，然后快进主工作区。
source "$(dirname "$0")/lib.sh"
require_gh

FORCE=0; TARGET=""
for a in "$@"; do
  case "${a}" in
    --force) FORCE=1 ;;
    *) TARGET="${a}" ;;
  esac
done

MAIN_WT=$(main_worktree)
[[ -n "${MAIN_WT}" ]] || die "未找到检出 main 的主工作区（git worktree list 里没有 main）"

# —— 定位 PR ——
if [[ -z "${TARGET}" ]]; then
  BRANCH=$(git -C "${REPO_ROOT}" branch --show-current) || BRANCH=""
  [[ "${BRANCH}" == task/* ]] \
    || die "在 task/* 分支（worktree）内运行，或用 <PR号|分支名> 指定目标"
  TARGET="${BRANCH}"
fi

PR_NUM=$(gh pr view "${TARGET}" --repo "${GH_REPO}" --json number -q .number 2>/dev/null) || PR_NUM=""
[[ -n "${PR_NUM}" ]] || die "找不到 PR: ${TARGET}"

PR_TITLE=$(gh pr view "${PR_NUM}" --repo "${GH_REPO}" --json title -q .title)
BRANCH=$(gh pr view "${PR_NUM}" --repo "${GH_REPO}" --json headRefName -q .headRefName)
STATE=$(gh pr view "${PR_NUM}" --repo "${GH_REPO}" --json state -q .state)
info "PR #${PR_NUM}: ${PR_TITLE} （${BRANCH} ，state=${STATE} ）"

# —— 清理现场（无论本次是新合并的还是早就合并过的，都要收拾干净）——
cleanup() {
  info "清理分支与 worktree"
  git -C "${REPO_ROOT}" push origin --delete "${BRANCH}" 2>/dev/null || true

  local WT_TO_REMOVE
  WT_TO_REMOVE=$(worktree_for_branch "${BRANCH}")
  if [[ -n "${WT_TO_REMOVE}" ]]; then
    info "移除 worktree: ${WT_TO_REMOVE}"
    git -C "${MAIN_WT}" worktree remove --force "${WT_TO_REMOVE}" 2>/dev/null \
      || die "worktree 移除失败: ${WT_TO_REMOVE} （手动 git worktree remove --force 后重跑）"
  else
    info "没有持有 ${BRANCH} 的 worktree，跳过移除"
  fi

  # squash 合并后原提交不是 main 的祖先，必须用 -D
  git -C "${MAIN_WT}" branch -D "${BRANCH}" 2>/dev/null || true
  git -C "${MAIN_WT}" worktree prune 2>/dev/null || true

  info "主工作区快进 main: ${MAIN_WT}"
  git -C "${MAIN_WT}" fetch origin main --quiet || die "fetch 失败，main 未快进（手工处理）"
  git -C "${MAIN_WT}" pull --ff-only origin main --quiet || die "main 无法 fast-forward（有分叉，手工处理）"
  git -C "${MAIN_WT}" log --oneline -1 | sed 's/^/  main → /'

  info "剩余 worktree（应只剩主工作区）"
  git -C "${MAIN_WT}" worktree list | sed 's/^/  /'
}

if [[ "${STATE}" == "MERGED" ]]; then
  ok "PR #${PR_NUM} 已经是 MERGED 状态，跳过合并，仅清理现场"
  cleanup
  ok "现场已清理，main 已是最新"
  exit 0
fi
[[ "${STATE}" == "OPEN" ]] || die "PR #${PR_NUM} 状态为 ${STATE} ，无法合并"

# —— CI 门槛 ——
if [[ "${FORCE}" -eq 1 ]]; then
  info "已指定 --force：跳过 CI checks 门槛（慎用）"
else
  if gh pr checks "${PR_NUM}" --repo "${GH_REPO}" >/dev/null 2>&1; then
    if gh pr checks "${PR_NUM}" --repo "${GH_REPO}" --fail-fast >/dev/null 2>&1; then
      ok "CI checks 全部通过"
    else
      gh pr checks "${PR_NUM}" --repo "${GH_REPO}" 2>&1 | sed 's/^/  /' || true
      die "存在未通过/进行中的 CI checks（确认无碍可加 --force）"
    fi
  else
    info "该 PR 没有 CI checks（或尚未开始），跳过门槛"
  fi
fi

info "squash 合并 PR #${PR_NUM}"
gh pr merge "${PR_NUM}" --repo "${GH_REPO}" --squash

cleanup
ok "PR #${PR_NUM} 已 squash 合并，现场已清理，main 已快进"

#!/usr/bin/env bash
# new-task.sh — 从 GitHub issue 创建开发 worktree + 分支
#
# 用法: scripts/pipeline/new-task.sh <issue号>
# 效果: 分支 task/<issue号>-<slug>，worktree .worktrees/<issue号>-<slug>（基于 origin/main）
#       并在新 worktree 内把当前 git 身份写进 worktree 局部配置（不动全局配置）
# 幂等: worktree 已存在时直接打印路径退出（不 fetch、不改动现场）
source "$(dirname "$0")/lib.sh"
require_gh

ISSUE=""
if [[ "$#" -ge 1 ]]; then ISSUE="$1"; fi
is_issue_number "${ISSUE}" || die "用法: $0 <issue号>"

TITLE=$(gh issue view "${ISSUE}" --repo "${GH_REPO}" --json title -q .title) \
  || die "issue #${ISSUE} 不存在或无法访问"
SLUG=$(slugify "${TITLE}")
BRANCH="task/${ISSUE}-${SLUG}"
WT="${REPO_ROOT}/.worktrees/${ISSUE}-${SLUG}"

# —— 幂等：worktree 已经存在就直接收工 ——
if git -C "${REPO_ROOT}" worktree list --porcelain 2>/dev/null | grep -qF "worktree ${WT}"; then
  ok "worktree 已存在: ${WT}"
  echo "  cd ${WT}"
  exit 0
fi

if [[ -e "${WT}" ]]; then
  die "路径已存在但不是本仓库的 worktree: ${WT} （先手工处理）"
fi

info "同步 origin/main"
n=1
while true; do
  if git -C "${REPO_ROOT}" fetch origin main --quiet; then break; fi
  if [[ "${n}" -ge "${FETCH_RETRY}" ]]; then
    die "无法访问 GitHub（origin fetch ${FETCH_RETRY} 次均失败）；稍后重试"
  fi
  info "fetch 失败，3 秒后重试（第 $((n + 1))/${FETCH_RETRY} 次）"
  sleep 3
  n=$((n + 1))
done

info "创建分支 ${BRANCH} （基于 origin/main）+ worktree"
git -C "${REPO_ROOT}" worktree add -b "${BRANCH}" "${WT}" origin/main >/dev/null

# 复制当前 git 身份到新 worktree（worktree 共享配置，通常无事；仅在全局缺失时兜底）
GIT_NAME=$(git -C "${REPO_ROOT}" config user.name 2>/dev/null) || GIT_NAME=""
GIT_EMAIL=$(git -C "${REPO_ROOT}" config user.email 2>/dev/null) || GIT_EMAIL=""
if [[ -n "${GIT_NAME}" ]]; then git -C "${WT}" config user.name "${GIT_NAME}"; fi
if [[ -n "${GIT_EMAIL}" ]]; then git -C "${WT}" config user.email "${GIT_EMAIL}"; fi

ok "issue #${ISSUE}: ${TITLE}"
echo "  分支:     ${BRANCH}"
echo "  worktree: ${WT}"
echo "  下一步:   cd ${WT} && 开发（提交信息建议带 #${ISSUE} ）"

#!/usr/bin/env bash
# open-pr.sh — 推送当前分支并开 PR（在对应 worktree 目录内运行）
#
# 用法: cd .worktrees/<号>-<slug> && scripts/pipeline/open-pr.sh
# 约定: 分支名必须为 task/<号>-<slug>；PR body 首行 Closes #<号>
# 幂等: 分支已推送则重推；PR 已存在则只打印链接，不新建
source "$(dirname "$0")/lib.sh"
require_gh

BRANCH=$(git -C "${REPO_ROOT}" branch --show-current) || BRANCH=""
BRANCH_DISPLAY="${BRANCH}"
if [[ -z "${BRANCH_DISPLAY}" ]]; then BRANCH_DISPLAY="<detached>"; fi
[[ "${BRANCH}" == task/* ]] \
  || die "当前不在 task/* 分支上（应在对应 worktree 里运行本脚本）: ${BRANCH_DISPLAY}"
ISSUE=$(printf '%s' "${BRANCH}" | sed -E 's|^task/([0-9]+)-.*|\1|')
is_issue_number "${ISSUE}" || die "无法从分支名解析 issue 号: ${BRANCH}"

TITLE=$(gh issue view "${ISSUE}" --repo "${GH_REPO}" --json title -q .title) \
  || die "issue #${ISSUE} 无法访问"

if [[ -n "$(git -C "${REPO_ROOT}" status --porcelain)" ]]; then
  die "工作区有未提交改动，先 commit（或 stash）"
fi

# —— 幂等：PR 已存在就只报告 ——
EXIST=$(gh pr view "${BRANCH}" --repo "${GH_REPO}" --json url -q .url 2>/dev/null) || EXIST=""
if [[ -n "${EXIST}" ]]; then
  ok "PR 已存在: ${EXIST}"
  exit 0
fi

info "推送 ${BRANCH}"
git -C "${REPO_ROOT}" push -u origin "${BRANCH}"

info "创建 PR（base: main ← ${BRANCH} ）"
BODY="Closes #${ISSUE}

---
由 scripts/pipeline/open-pr.sh 创建。
合并前必须：(1) CI 通过；(2) 拿到用户对本次 review 的明确同意（见 docs/pipeline/README.md §一）。"
gh pr create --repo "${GH_REPO}" --base main --head "${BRANCH}" \
  --title "${TITLE} (#${ISSUE})" --body "${BODY}"
ok "PR 已创建；等待 CI，然后请用户 review（用户同意后才跑 merge-pr.sh）"

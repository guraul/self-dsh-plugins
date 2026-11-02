#!/usr/bin/env bash
# install-hooks.sh — 安装本仓库的 git 钩子（当前只有 pre-push 直推 main 拦截）
#
# 用法: scripts/pipeline/install-hooks.sh    # 幂等，可重复执行
#
# worktree 里 .git 是文件而不是目录，所以钩子目录必须从
# `git rev-parse --git-common-dir`（主仓 git 目录）推算，装一次对所有 worktree 生效。

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
GUARD="${SCRIPT_DIR}/pre-push-main-guard.sh"

[ -f "${GUARD}" ] || { echo "✗ 找不到 ${GUARD}" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "✗ 需要 git" >&2; exit 1; }

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) \
  || { echo "✗ 必须在 git 仓库（或其 worktree）内运行" >&2; exit 1; }

COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null) \
  || { echo "✗ 无法定位 git 目录" >&2; exit 1; }
case "${COMMON_DIR}" in
  /*) ;;
  *) COMMON_DIR="${REPO_ROOT}/${COMMON_DIR}" ;;
esac

HOOKS_DIR="${COMMON_DIR}/hooks"
TARGET="${HOOKS_DIR}/pre-push"

mkdir -p "${HOOKS_DIR}" || { echo "✗ 无法创建 ${HOOKS_DIR}" >&2; exit 1; }

# 已装且内容一致就只报告，避免无谓改动
if [ -f "${TARGET}" ] && cmp -s "${GUARD}" "${TARGET}"; then
  chmod +x "${TARGET}"
  echo "✓ pre-push 钩子已是最新（幂等跳过）: ${TARGET}"
  exit 0
fi

cp "${GUARD}" "${TARGET}" || { echo "✗ 复制失败: ${GUARD} -> ${TARGET}" >&2; exit 1; }
chmod +x "${TARGET}" || { echo "✗ chmod +x 失败: ${TARGET}" >&2; exit 1; }

echo "✓ 已安装 pre-push 钩子: ${TARGET}"
echo "  作用: 拦截直推 origin/main；例外 ALLOW_DIRECT_MAIN=1 git push origin main"
echo "  说明: 钩子装在主仓 git 目录，所有 worktree 共用"

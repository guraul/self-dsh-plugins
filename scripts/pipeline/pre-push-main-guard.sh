#!/usr/bin/env bash
# pre-push-main-guard.sh — 拦截直推 / 删除 origin/main 的 git pre-push 钩子
#
# 安装：scripts/pipeline/install-hooks.sh（装到 $(git rev-parse --git-common-dir)/hooks/pre-push）
# 例外：ALLOW_DIRECT_MAIN=1 git push origin main
#
# git 调用约定：
#   参数 1 = remote name，参数 2 = remote url
#   stdin 每行 = <local ref> <local sha> <remote ref> <remote sha>
#
# macOS 自带 bash 3.2：不用 bash 4 语法，默认值一律用 if 判断（见 docs/pipeline/README.md §四 红线 8）。

set -u

REMOTE_NAME=""
if [ $# -ge 1 ]; then REMOTE_NAME="$1"; fi

ALLOW=""
if [ "${ALLOW_DIRECT_MAIN-}" = "1" ]; then ALLOW="1"; fi

HIT_MAIN=""
HIT_DELETE=""
# 注意：这里刻意**不加** `IFS=` 前缀。read 只有在用默认 IFS 时才按空白把一行切成四个字段；
# 一旦 IFS 为空，read 不做字段切分，整行落不到 REMOTE_REF 上，判定就全错。
while read -r LOCAL_REF LOCAL_SHA REMOTE_REF REMOTE_SHA; do
  # 空行 / 字段不足的行直接跳过
  if [ -z "${REMOTE_REF-}" ]; then continue; fi
  if [ "${REMOTE_NAME}" != "origin" ]; then continue; fi
  if [ "${REMOTE_REF}" != "refs/heads/main" ]; then continue; fi
  # 删除远端 main（git push origin :main / --delete main）：local ref 是 (delete)、
  # local sha 全 0 —— 和直推一样破坏闸门，必须一起拦。
  case "${LOCAL_SHA}" in
    0000000000000000000000000000000000000000) HIT_DELETE="1" ;;
  esac
  HIT_MAIN="1"
  break
done

if [ -z "${HIT_MAIN}" ]; then
  # 任务分支、删除其它分支、非 origin 远端：一律放行
  exit 0
fi

if [ -n "${ALLOW}" ]; then
  if [ -n "${HIT_DELETE}" ]; then
    echo "⚠️  ALLOW_DIRECT_MAIN=1：本次允许删除远端 origin/main（绕过 pipeline 审核闸门，请确认这是有意为之）" >&2
  else
    echo "⚠️  ALLOW_DIRECT_MAIN=1：本次允许直推 origin/main（绕过 pipeline 审核闸门，请确认这是有意为之）" >&2
  fi
  exit 0
fi

if [ -n "${HIT_DELETE}" ]; then
cat >&2 <<'EOF'
✗ 拒绝删除远端 origin/main。

本仓库的 main 只能由 pipeline 合并产生，直接删除远端 main 会切断所有人的基线、
让 worktree 与 PR 目标分支失效。规则见 ~/.dsh/AGENTS.md §7.1，
以及 docs/pipeline/README.md §一 / §三。

确实需要临时删除（例如紧急回滚误推），用一次性例外：
  ALLOW_DIRECT_MAIN=1 git push origin :main
EOF
  exit 1
fi

cat >&2 <<'EOF'
✗ 拒绝直推 origin/main。

本仓库所有改动必须走 pipeline（issue → task 分支 → PR → 审核 → squash 合并），
直推 main 会绕过审核闸门、破坏 worktree 与分支命名契约。规则见 ~/.dsh/AGENTS.md §7.1，
以及 docs/pipeline/README.md §一 / §三。

正确做法：
  scripts/pipeline/new-task.sh <issue号>     # 开 task/<号>-<slug> worktree
  scripts/pipeline/open-pr.sh                # 推分支并开 PR
  scripts/pipeline/merge-pr.sh --review-record=<记录>   # 有审核记录后合并

确实需要临时直推（例如紧急修复），用一次性例外：
  ALLOW_DIRECT_MAIN=1 git push origin main
EOF
exit 1

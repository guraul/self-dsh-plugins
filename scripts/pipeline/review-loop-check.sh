#!/usr/bin/env bash
# review-loop-check.sh — 切换 dsh-subagents 之后的只读体检
#
# 只读：不改任何文件、不启动会话、不调模型。
# 用法: scripts/pipeline/review-loop-check.sh
# 退出码: 0 全部通过；1 有检查失败
source "$(dirname "$0")/lib.sh"

PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/web"
NEW_PKG="dsh-plugin-subagents"
OLD_PKG="dsh-plugin-product-subagents"
FAILED=0

check() {
  local desc="$1" ok="$2"
  if [[ "${ok}" == "1" ]]; then
    ok_line "${desc}"
  else
    echo "✗ ${desc}" >&2
    FAILED=1
  fi
}

ok_line() { echo "✓ $1"; }

# 1. profile 依赖与 bundle 条目
if [[ -f "${PROFILE_DIR}/package.json" ]]; then
  if grep -q "\"${OLD_PKG}\"" "${PROFILE_DIR}/package.json"; then
    check "profile 里已无 ${OLD_PKG}" 0
  else
    check "profile 里已无 ${OLD_PKG}" 1
  fi
  if grep -q "\"${NEW_PKG}\"" "${PROFILE_DIR}/package.json"; then
    check "profile 里有 ${NEW_PKG}" 1
  else
    check "profile 里有 ${NEW_PKG}" 0
  fi
else
  check "profile 目录存在（${PROFILE_DIR}）" 0
fi

# 2. 软链是否悬空
if [[ -L "${PROFILE_DIR}/node_modules/${NEW_PKG}" ]]; then
  # 软链内容是相对路径，必须在链接所在目录解析，不能在仓库根直接 -d
  TARGET=$(cd "$(dirname "${PROFILE_DIR}/node_modules/${NEW_PKG}")" && cd "$(readlink "${PROFILE_DIR}/node_modules/${NEW_PKG}")" && pwd)
  if [[ -d "${TARGET}" ]]; then
    check "软链有效 -> ${TARGET}" 1
  else
    check "软链有效（悬空: ${TARGET}，需在 profile 目录跑 pnpm install）" 0
  fi
else
  check "node_modules 里有 ${NEW_PKG} 软链（需 pnpm install）" 0
fi

# 3. dump-config 里能看到插件
if command -v dsh >/dev/null 2>&1; then
  # 注意：`dsh plugin ...` 会把参数转发给 pnpm，dump-config 不是 plugin 的子命令
  if dsh --profile web --dump-config 2>/dev/null | grep -q "${NEW_PKG}"; then
    check "dsh --dump-config 能看到 ${NEW_PKG}" 1
  else
    check "dsh --dump-config 能看到 ${NEW_PKG}" 0
  fi
else
  check "dsh 命令可用" 0
fi

# 4. 审核记录目录可写
RECORDS="${REPO_ROOT}/.dsh-web/reviews"
mkdir -p "${RECORDS}" 2>/dev/null || true
if [[ -w "${RECORDS}" ]]; then
  check "审核记录目录可写（${RECORDS}）" 1
else
  check "审核记录目录可写（${RECORDS}）" 0
fi

echo
if [[ "${FAILED}" -eq 0 ]]; then
  echo "✓ 只读体检通过。人工再验一条：在新会话里调一次 product_delegate，能拿到回答即链路通。"
  exit 0
fi
echo "✗ 有检查未通过，见上方 ✗ 行；回滚步骤见 docs/pipeline/review-loop.md §三" >&2
exit 1

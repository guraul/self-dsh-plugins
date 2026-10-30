#!/usr/bin/env bash
# check-all.sh — 遍历插件跑各自的检查（测试 / check / typecheck）
#
# 用法:
#   scripts/pipeline/check-all.sh                             # 全部插件（以 lib.sh 的 PLUGIN_DIRS 为准）
#   scripts/pipeline/check-all.sh dsh-external-discuss        # 只跑指定插件（可多个）
#
# 规则:
#   * 有 scripts.test  → 跑 pnpm test
#   * 有 scripts.check → 跑 pnpm run check
#   * 有 scripts.typecheck → 跑 pnpm run typecheck（dsh-im-bridge-workspaces）
#   * 缺 node_modules 的插件 → 明确报告"未安装依赖，已跳过"，**不算失败**
# 退出码: 任一检查失败 → 1；其余情况 0（跳过不导致失败）
# 注意: 各插件的完整输出会直接打到 stdout（适合人看）；机器消费只看末尾汇总表。
set -euo pipefail
source "$(dirname "$0")/lib.sh"

# —— 解析参数：只跑指定插件 ——
TARGETS=""
if [[ "$#" -gt 0 ]]; then
  for d in "$@"; do
    FOUND=0
    for k in ${PLUGIN_DIRS}; do
      if [[ "${d}" == "${k}" ]]; then FOUND=1; fi
    done
    if [[ "${FOUND}" -eq 0 ]]; then die "未知插件目录: ${d} （可选: ${PLUGIN_DIRS} ）"; fi
    TARGETS="${TARGETS} ${d}"
  done
else
  TARGETS=" ${PLUGIN_DIRS}"
fi

ROWS=""
FAILED=0

add_row() {
  ROWS="${ROWS}$1|$2|$3
"
}

# 跑一个 pnpm 子命令并汇总（失败只记录，不中断，以便拿到完整汇总表）
run_one() {
  local dir="$1" label="$2"; shift 2
  local log rc
  log=$(mktemp -t "dsh-check-${dir}")
  info "[${dir}] pnpm $*"
  rc=0
  ( cd "${REPO_ROOT}/${dir}" && pnpm "$@" ) >"${log}" 2>&1 || rc=$?
  if [[ "${rc}" -eq 0 ]]; then
    ok "[${dir}] ${label} 通过"
    add_row "${dir}" "${label}" "通过"
  else
    echo "──── ${dir} / ${label} 输出（退出码 ${rc} ）────"
    cat "${log}"
    echo "──── 输出结束 ────"
    add_row "${dir}" "${label}" "失败（退出码 ${rc} ）"
    FAILED=$((FAILED + 1))
  fi
  rm -f "${log}"
}

for DIR in ${TARGETS}; do
  echo ""
  echo "══════ ${DIR} ══════"
  PKG="${REPO_ROOT}/${DIR}/package.json"
  if [[ ! -f "${PKG}" ]]; then
    echo "  - ${DIR}: package.json 不存在，已跳过"
    add_row "${DIR}" "package.json" "跳过（不存在）"
    continue
  fi
  if [[ ! -d "${REPO_ROOT}/${DIR}/node_modules" ]]; then
    echo "  ! ${DIR}: 未安装依赖，已跳过（先在 ${DIR}/ 里跑 pnpm install 再重跑本脚本）"
    add_row "${DIR}" "依赖" "跳过（未安装依赖）"
    continue
  fi

  TEST_S=$(pkg_script "${PKG}" test)
  CHECK_S=$(pkg_script "${PKG}" check)
  TYPE_S=$(pkg_script "${PKG}" typecheck)
  DONE=0

  if [[ -n "${TEST_S}" ]]; then
    DONE=1; run_one "${DIR}" test test
  else
    echo "  - ${DIR}: 无 scripts.test，已跳过"
    add_row "${DIR}" "test" "跳过（未定义）"
  fi

  if [[ -n "${CHECK_S}" ]]; then
    DONE=1; run_one "${DIR}" check run check
  else
    echo "  - ${DIR}: 无 scripts.check，已跳过"
    add_row "${DIR}" "check" "跳过（未定义）"
  fi

  if [[ -n "${TYPE_S}" ]]; then
    DONE=1; run_one "${DIR}" typecheck run typecheck
  else
    add_row "${DIR}" "typecheck" "跳过（未定义）"
  fi

  if [[ "${DONE}" -eq 0 ]]; then
    echo "  ✗ ${DIR}: 没有任何可跑的检查（test/check/typecheck 都未定义）"
    add_row "${DIR}" "-" "失败（无可跑检查）"
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "══════════ 汇总 ══════════"
printf '%s\n' "插件目录 | 检查 | 结果"
printf '%s' "${ROWS}" | while IFS='|' read -r d l r; do
  if [[ -n "${d}" ]]; then
    printf '%s | %s | %s\n' "${d}" "${l}" "${r}"
  fi
done
echo ""

if [[ "${FAILED}" -gt 0 ]]; then
  die "有 ${FAILED} 项检查失败（汇总见上）"
fi
ok "全部检查通过（跳过的项见上表）"

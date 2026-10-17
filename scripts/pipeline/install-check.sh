#!/usr/bin/env bash
# install-check.sh — 在一次性 $DSH_HOME 里验证插件能被 profile 正常安装与组合
#
# 用法:
#   scripts/pipeline/install-check.sh                          # 全部 4 个插件
#   scripts/pipeline/install-check.sh dsh-external-discuss      # 只验证指定插件（可多个）
#
# 效果（每个插件各跑一遍，全程只用临时目录）:
#   1. H=$(mktemp -d)
#   2. DSH_HOME=$H pnpm dlx @deepseek-ai/dsh@<当前 dsh 版本> plugin --profile headless add <插件绝对路径>
#   3. DSH_HOME=$H pnpm dlx @deepseek-ai/dsh@<当前 dsh 版本> --profile headless --dump-config
#      并 grep 到该插件在 package.json 里声明的 name（这是"装配成功"的判据）
#   4. rm -rf "$H"（exit trap 兜底，异常退出也会清理）
#
# ⚠️ 安全: 只写临时目录，**绝不触碰真实 ~/.dsh**。全程只读本仓库。
# 退出码: 任一插件失败 → 1
set -euo pipefail
source "$(dirname "$0")/lib.sh"

command -v pnpm >/dev/null 2>&1 || die "需要 pnpm（本机全局约定禁用 npx，用 pnpm dlx 代替）"
command -v dsh >/dev/null 2>&1 || die "需要 dsh 命令（用于取当前版本号）"

# —— 解析参数 ——
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

DSH_VERSION=$(dsh --version 2>/dev/null | head -1 | tr -d '[:space:]')
[[ -n "${DSH_VERSION}" ]] || die "无法获取 dsh 版本（dsh --version）"
info "当前 dsh 版本: ${DSH_VERSION}"
info "验证目标:${TARGETS}"
echo "  （每个插件都会新建一个临时 DSH_HOME，装完即删；真实 ~/.dsh 不受影响）"

FAILED=0
H=""

cleanup() {
  if [[ -n "${H}" && -d "${H}" ]]; then
    rm -rf "${H}"
    echo "  · 已清理临时 DSH_HOME: ${H}"
    H=""
  fi
}
trap cleanup EXIT

check_one() {
  local dir="$1"
  local abs="${REPO_ROOT}/${dir}"
  local pkg="${abs}/package.json"
  local name

  echo ""
  echo "══════ ${dir} ══════"
  if [[ ! -f "${pkg}" ]]; then
    echo "  ✗ package.json 不存在: ${pkg}"
    FAILED=$((FAILED + 1)); return 0
  fi
  if [[ ! -d "${abs}" ]]; then
    echo "  ✗ 插件目录不存在: ${abs}"
    FAILED=$((FAILED + 1)); return 0
  fi

  name=$(pkg_name "${pkg}")
  if [[ -z "${name}" ]]; then
    echo "  ✗ 无法读取 package.json 的 name"
    FAILED=$((FAILED + 1)); return 0
  fi
  echo "  包名: ${name}"

  H=$(mktemp -d /tmp/dsh-install-check-XXXXXX)
  echo "  临时 DSH_HOME: ${H}"

  info "  [1/2] plugin --profile headless add ${abs}"
  if ! DSH_HOME="${H}" pnpm dlx "@deepseek-ai/dsh@${DSH_VERSION}" plugin \
        --profile headless add "${abs}"; then
    echo "  ✗ add 失败"
    cleanup
    FAILED=$((FAILED + 1)); return 0
  fi

  info "  [2/2] --profile headless --dump-config | grep ${name}"
  if DSH_HOME="${H}" pnpm dlx "@deepseek-ai/dsh@${DSH_VERSION}" \
       --profile headless --dump-config 2>&1 | grep -Fq "${name}"; then
    echo "  ✓ 装配成功：dump-config 中出现 ${name}"
  else
    echo "  ✗ 装配失败：dump-config 中没有 ${name}"
    FAILED=$((FAILED + 1))
  fi
  cleanup
}

for DIR in ${TARGETS}; do
  check_one "${DIR}"
done

echo ""
if [[ "${FAILED}" -gt 0 ]]; then
  die "有 ${FAILED} 个插件未通过安装/装配验证"
fi
ok "全部插件在一次性 DSH_HOME 中安装 + 装配成功（真实 ~/.dsh 未被触碰）"

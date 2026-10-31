#!/usr/bin/env bash
# compat-matrix.sh — 对指定 dsh 版本跑一遍「全插件装配验收」，输出兼容矩阵表
#
# 用法:
#   scripts/pipeline/compat-matrix.sh <目标版本>                      # 全部插件
#   scripts/pipeline/compat-matrix.sh <目标版本> dsh-awake            # 只验指定插件（可多个）
#   scripts/pipeline/compat-matrix.sh <目标版本> --json               # 机器可读（给将来的 CI 定期跑留口）
#
# 每个插件各跑一遍（全程只用临时目录）:
#   1. H=$(mktemp -d)
#   2. DSH_HOME=$H pnpm dlx @deepseek-ai/dsh@<目标版本> plugin --profile headless add <插件绝对路径>
#   3. DSH_HOME=$H pnpm dlx @deepseek-ai/dsh@<目标版本> --profile headless --dump-config
#      并 grep 到该插件 package.json 里声明的 name（判据同 install-check.sh）
#   4. rm -rf "$H"（trap 兜底，异常退出也会清理）
#
# 判定口径（**只有 L1：能装配**，不代表业务链路可用）:
#   装配成功 → 建议 compatible；装配失败 → 建议 incompatible
#   与插件 package.json 的 dsh.compatibility.dshReleases[<目标版本>] 不一致 → 表格里标 ⚠️ 漂移（不算失败）
#
# ⚠️ 只读：只写 mktemp 临时目录，**绝不**自动改写任何插件的 dshReleases。
#    「写回矩阵」是人的决定，要 review（见 docs/COMPATIBILITY.md）。
# 退出码: 0 全部装配成功；1 有插件装配失败或参数错误
set -euo pipefail
source "$(dirname "$0")/lib.sh"

usage() {
  cat <<'EOF'
用法: scripts/pipeline/compat-matrix.sh <目标版本> [插件目录…] [--json]

  <目标版本>   要验的 dsh 版本，如 0.2.2-alpha.2（必须精确版本，不接受范围）
  插件目录     省略 = lib.sh 里 PLUGIN_DIRS 的全部插件
  --json       输出机器可读 JSON（不打印表格）

示例:
  scripts/pipeline/compat-matrix.sh 0.2.2-alpha.2
  scripts/pipeline/compat-matrix.sh 0.2.1-rc.5 dsh-im-bridge-workspaces --json
EOF
}

JSON=0
TARGET_VERSION=""
TARGETS=""
for arg in "$@"; do
  case "${arg}" in
    -h|--help) usage; exit 0 ;;
    --json) JSON=1 ;;
    -*) die "未知参数: ${arg}（可用: --json / --help）" ;;
    *)
      if [[ -z "${TARGET_VERSION}" ]]; then
        TARGET_VERSION="${arg}"
      else
        FOUND=0
        for k in ${PLUGIN_DIRS}; do
          if [[ "${arg}" == "${k}" ]]; then FOUND=1; fi
        done
        [[ "${FOUND}" -eq 1 ]] || die "未知插件目录: ${arg}（可选: ${PLUGIN_DIRS}）"
        TARGETS="${TARGETS} ${arg}"
      fi
      ;;
  esac
done

[[ -n "${TARGET_VERSION}" ]] || { usage; die "缺少 <目标版本>"; }
if ! [[ "${TARGET_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  die "目标版本必须是精确版本（如 0.2.2-alpha.2），收到: ${TARGET_VERSION}"
fi
[[ -n "${TARGETS}" ]] || TARGETS=" ${PLUGIN_DIRS}"

command -v pnpm >/dev/null 2>&1 || die "需要 pnpm（本机全局约定禁用 npx，用 pnpm dlx 代替）"

INSTALLED="$(command -v dsh >/dev/null 2>&1 && dsh --version 2>/dev/null | head -1 | tr -d '[:space:]' || true)"
[[ -n "${INSTALLED}" ]] || INSTALLED="（未知）"

# 先确认这个版本真的存在：否则下面每个插件都会「装配失败」，表格会误导人（issue #108 验收要求）。
if ! pnpm view "@deepseek-ai/dsh@${TARGET_VERSION}" version >/dev/null 2>&1; then
  die "npm 上没有 @deepseek-ai/dsh@${TARGET_VERSION}（拼写错误？或该版本已下架/未发布）"
fi

ROWS="$(mktemp /tmp/dsh-compat-matrix-XXXXXX)"
H=""

cleanup() {
  if [[ -n "${H}" && -d "${H}" ]]; then rm -rf "${H}"; H=""; fi
  [[ -f "${ROWS}" ]] && rm -f "${ROWS}"
}
trap cleanup EXIT

if [[ "${JSON}" -eq 0 ]]; then
  info "目标 dsh 版本: ${TARGET_VERSION}（本机已装: ${INSTALLED}）"
  info "验证插件:${TARGETS}"
  echo "  （每个插件新建一个临时 DSH_HOME，装完即删；真实 ~/.dsh 不受影响；只验 L1 装配）"
  echo ""
fi

FAILED=0
DRIFT=0
STRICTER=0

# 读插件的 name / version / 矩阵记录（一次 node 调用，避免三次启动开销）
read_meta() {
  node -e '
    const fs = require("fs");
    const target = process.argv[2];
    try {
      const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const releases = (p.dsh && p.dsh.compatibility && p.dsh.compatibility.dshReleases) || {};
      const declared = Object.prototype.hasOwnProperty.call(releases, target) ? String(releases[target]) : "";
      const scripts = p.scripts || {};
      process.stdout.write([p.name || "", p.version || "", declared, scripts.build ? "1" : "0"].join("|"));
    } catch (e) {
      process.stdout.write("|||");
    }
  ' "$1" "${TARGET_VERSION}" 2>/dev/null || printf '|||'
}

check_one() {
  local dir="$1"
  local abs="${REPO_ROOT}/${dir}"
  local pkg="${abs}/package.json"
  local meta name version declared needs_build
  local assembly suggest drift

  if [[ ! -f "${pkg}" ]]; then
    printf '%s\t\t\t\tfail\tincompatible\t\n' "${dir}" >>"${ROWS}"
    FAILED=$((FAILED + 1))
    [[ "${JSON}" -eq 0 ]] && echo "  ✗ ${dir}: package.json 不存在（${pkg}）"
    return 0
  fi

  meta="$(read_meta "${pkg}")"
  IFS='|' read -r name version declared needs_build <<<"${meta}"
  [[ -n "${name}" ]] || { printf '%s\t\t\t\tfail\tincompatible\t\n' "${dir}" >>"${ROWS}"; FAILED=$((FAILED + 1)); return 0; }

  if [[ -n "${needs_build}" && "${needs_build}" == "1" && "${JSON}" -eq 0 ]]; then
    echo "  ⚠ ${dir}: 该插件需构建，先跑 pnpm --dir ${dir} run build:host && pnpm --dir ${dir} run build:client（本脚本不构建）"
  fi

  H="$(mktemp -d /tmp/dsh-compat-matrix-home-XXXXXX)"
  assembly="fail"
  if DSH_HOME="${H}" pnpm dlx "@deepseek-ai/dsh@${TARGET_VERSION}" plugin \
       --profile headless add "${abs}" >/dev/null 2>&1 \
     && DSH_HOME="${H}" pnpm dlx "@deepseek-ai/dsh@${TARGET_VERSION}" \
          --profile headless --dump-config 2>&1 | grep -Fq "${name}"; then
    assembly="pass"
  fi
  rm -rf "${H}"; H=""

  if [[ "${assembly}" == "pass" ]]; then suggest="compatible"; else suggest="incompatible"; FAILED=$((FAILED + 1)); fi
  # 「漂移」分三类：不能把「矩阵更严」误判成「记录错了」——本脚本只验 L1，
  # 而矩阵里的 incompatible 可能来自 L3（类型检查）等更深层的结论（例：dsh-im-bridge 的 TS2554）。
  drift=""
  if [[ -z "${declared}" ]]; then
    drift="未验证→${suggest}"
  elif [[ "${declared}" == "${suggest}" ]]; then
    drift=""
  elif [[ "${declared}" == "incompatible" && "${suggest}" == "compatible" ]]; then
    drift="记录更严（L1 通过，但矩阵记不兼容，可能是 L3 等更深层结论）"
    STRICTER=$((STRICTER + 1))
  else
    drift="⚠️ 记录与实测冲突"
    DRIFT=$((DRIFT + 1))
  fi

  printf '%s|%s|%s|%s|%s|%s|%s\n' "${dir}" "${name}" "${version}" "${declared}" "${assembly}" "${suggest}" "${drift}" >>"${ROWS}"

  if [[ "${JSON}" -eq 0 ]]; then
    local mark_txt
    if [[ "${assembly}" == "pass" ]]; then mark_txt="✓ 装配成功"; else mark_txt="✗ 装配失败"; fi
    echo "  ${mark_txt}  ${dir}（${name}@${version}）  矩阵记录: ${declared:-无}"
    if [[ -n "${drift}" ]]; then echo "      ⚠ ${drift}（记录 ${declared:-（无）} / L1 实测 ${suggest}）"; fi
  fi
  return 0
}

for DIR in ${TARGETS}; do
  check_one "${DIR}"
done

if [[ "${JSON}" -eq 1 ]]; then
  node -e '
    const fs = require("fs");
    const rows = fs.readFileSync(process.argv[1], "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => {
      const [dir, name, version, declared, assembly, suggest, drift] = l.split("|");
      return { dir, name, version, declared: declared || null, assembly, suggest, drift: drift || null };
    });
    process.stdout.write(JSON.stringify({ target: process.argv[2], installed: process.argv[3], rows }, null, 2) + "\n");
  ' "${ROWS}" "${TARGET_VERSION}" "${INSTALLED}"
  [[ "${FAILED}" -eq 0 ]] || exit 1
  exit 0
fi

echo ""
echo "| 插件目录 | 包名@版本 | 矩阵记录 | 实测装配 | 建议 verdict | 漂移 |"
echo "|---|---|---|---|---|---|"
while IFS='|' read -r dir name version declared assembly suggest drift; do
  [[ -n "${dir}" ]] || continue
  printf '| %s | %s@%s | %s | %s | %s | %s |\n' \
    "${dir}" "${name:-?}" "${version:-?}" "${declared:-（无）}" "${assembly}" "${suggest}" "${drift:-—}"
done <"${ROWS}"

echo ""
if [[ "${FAILED}" -gt 0 ]]; then
  die "有 ${FAILED} 个插件在 ${TARGET_VERSION} 上装配失败（矩阵建议写 incompatible）"
fi
ok "全部插件在 ${TARGET_VERSION} 上装配成功（L1；业务链路未验）"
[[ "${STRICTER}" -eq 0 ]] || echo "· ${STRICTER} 个插件的矩阵记录比 L1 更严（不是错误；要改它得按更深层的验证结论来）"
[[ "${DRIFT}" -eq 0 ]] || echo "⚠ ${DRIFT} 个插件的矩阵记 compatible 但 L1 装配失败——这是真冲突，请复查"
echo "· 本脚本只验 L1（能否装配）；业务链路（L4）未验，不要把 L1 pass 直接当成「功能正常」"

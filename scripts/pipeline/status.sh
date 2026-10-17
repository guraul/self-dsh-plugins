#!/usr/bin/env bash
# status.sh — 本仓库全链路状态一览（**纯只读**，不改任何状态）
#
# 用法: scripts/pipeline/status.sh
# 检查项:
#   (a) 4 个插件各自的 test/check 脚本是否存在、node_modules 是否已安装
#   (b) dsh plugin --profile web version-exemptions（正常应为 {}）
#   (c) ~/.dsh/profiles/web/package.json 里 4 个 link: 依赖的目标路径是否存在（悬空检测）
#   (d) gh pr list / gh issue list 开放项
# 任何一段失败都不中断整体输出（全部软失败）。
source "$(dirname "$0")/lib.sh"

echo "════ 本仓库（${GH_REPO} ）════"
echo "  根目录:   ${REPO_ROOT}"
BRANCH=$(git -C "${REPO_ROOT}" branch --show-current) || BRANCH=""
BRANCH_DISPLAY="${BRANCH}"
if [[ -z "${BRANCH_DISPLAY}" ]]; then BRANCH_DISPLAY="<detached>"; fi
echo "  当前分支: ${BRANCH_DISPLAY}"
echo "  HEAD:     $(git -C "${REPO_ROOT}" log --oneline -1 2>/dev/null || echo '?')"
DIRTY=$(git -C "${REPO_ROOT}" status --porcelain 2>/dev/null | head -20)
if [[ -n "${DIRTY}" ]]; then
  echo "  工作区:   有未提交改动"
  printf '%s\n' "${DIRTY}" | sed 's/^/    /'
else
  echo "  工作区:   干净"
fi
echo "  worktree:"
git -C "${REPO_ROOT}" worktree list 2>/dev/null | sed 's/^/    /' || true

echo "════ 插件（脚本与依赖）════"
for DIR in ${PLUGIN_DIRS}; do
  PKG="${REPO_ROOT}/${DIR}/package.json"
  if [[ ! -f "${PKG}" ]]; then
    echo "  ${DIR}: ✗ package.json 不存在（目录缺失？）"
    continue
  fi
  NAME=$(pkg_name "${PKG}")
  if [[ -z "${NAME}" ]]; then NAME="?"; fi
  TEST_S=$(pkg_script "${PKG}" test)
  CHECK_S=$(pkg_script "${PKG}" check)
  TYPE_S=$(pkg_script "${PKG}" typecheck)
  DEPS="未安装"
  if [[ -d "${REPO_ROOT}/${DIR}/node_modules" ]]; then DEPS="已安装"; fi
  T="无"; C="无"; Y="无"
  if [[ -n "${TEST_S}" ]]; then T="有"; fi
  if [[ -n "${CHECK_S}" ]]; then C="有"; fi
  if [[ -n "${TYPE_S}" ]]; then Y="有"; fi
  echo "  ${DIR}  (${NAME})"
  echo "    test=${T}  check=${C}  typecheck=${Y}  node_modules=${DEPS}"
  if [[ -n "${TEST_S}" ]]; then echo "      test      → ${TEST_S}"; fi
  if [[ -n "${CHECK_S}" ]]; then echo "      check     → ${CHECK_S}"; fi
  if [[ -n "${TYPE_S}" ]]; then echo "      typecheck → ${TYPE_S}"; fi
done

echo "════ version-exemptions（dsh plugin --profile web）════"
if command -v dsh >/dev/null 2>&1; then
  EX=$(dsh plugin --profile web version-exemptions 2>&1) || EX="（命令失败）"
  printf '%s\n' "${EX}" | sed 's/^/  /'
else
  echo "  ✗ 找不到 dsh 命令"
fi

echo "════ profile link: 依赖悬空检测（~/.dsh/profiles/web/package.json）════"
# macOS bash 3.2：不使用带默认值的参数展开，DSH_HOME 用 printenv 显式探测再兜底
DSH_HOME_V=$(printenv DSH_HOME 2>/dev/null) || DSH_HOME_V=""
if [[ -z "${DSH_HOME_V}" ]]; then DSH_HOME_V="$HOME/.dsh"; fi
PROFILE_PKG="${DSH_HOME_V}/profiles/web/package.json"
if [[ -f "${PROFILE_PKG}" ]]; then
  node -e '
    const fs = require("fs");
    let ok = 0, bad = 0;
    try {
      const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const deps = p.dependencies || {};
      for (const [name, spec] of Object.entries(deps)) {
        if (!String(spec).startsWith("link:")) continue;
        const target = String(spec).slice(5);
        const exists = fs.existsSync(target);
        if (exists) ok++; else bad++;
        console.log("  " + (exists ? "✓" : "✗ 悬空") + "  " + name + " → " + target);
      }
      if (ok === 0 && bad === 0) console.log("  （没有 link: 依赖）");
      console.log("  合计: " + ok + " 个正常, " + bad + " 个悬空");
    } catch (e) { console.log("  ✗ 解析失败: " + e.message); }
  ' "${PROFILE_PKG}" 2>&1 || true
else
  echo "  ✗ 找不到 ${PROFILE_PKG}"
fi

echo "════ GitHub（${GH_REPO} ）════"
if command -v gh >/dev/null 2>&1; then
  echo "  开放 PR:"
  gh pr list --repo "${GH_REPO}" --limit 10 2>&1 | sed 's/^/    /' || true
  echo "  开放 issue:"
  gh issue list --repo "${GH_REPO}" --limit 10 2>&1 | sed 's/^/    /' || true
else
  echo "  ✗ 找不到 gh CLI"
fi

echo "════ 提示 ════"
echo "  本仓库的\"交付物\"是插件被本机 DSH profile 正确装配（没有服务器、没有部署）。"
echo "  一次性 DSH_HOME 里验证装配: scripts/pipeline/install-check.sh <插件目录名>"
echo "  跑全部插件的测试与检查:     scripts/pipeline/check-all.sh"

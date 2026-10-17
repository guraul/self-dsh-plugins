#!/usr/bin/env bash
# lib.sh — pipeline 脚本公共常量与工具（被其他脚本 source，不直接执行）
# 手册：docs/pipeline/README.md
#
# 与 agent-mobile 版本的区别：本仓库没有服务器、没有部署，故不含
# SERVER_HOST / SERVER_USER / remote() / BFF_REPO 等部署侧常量。
# 本仓库的"交付物"是插件被本机 DSH profile 正确装配，见 install-check.sh。

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "✗ 必须在 self-dsh-plugins 仓库（或其 worktree）内运行" >&2; exit 1; }

GH_REPO="guraul/self-dsh-plugins"

# 第一层 git fetch 失败后的重试次数（macOS 自带没有 timeout，用重试代替）
FETCH_RETRY=2

# 四个插件：目录名 + 包名（SUMMARY 与 install-check 用；注意二者不一致是常态）
PLUGIN_DIRS="dsh-auto-upgrade dsh-external-discuss dsh-im-bridge-workspaces dsh-plugin-product-subagents"
PLUGIN_NAMES="dsh-plugin-auto-upgrade dsh-plugin-external-discuss @mhfire/dsh-im-bridge dsh-plugin-product-subagents"

die()  { echo "✗ $*" >&2; exit 1; }
info() { echo "→ $*"; }
ok()   { echo "✓ $*"; }

require_gh() {
  command -v gh >/dev/null 2>&1 || die "需要 gh CLI（https://cli.github.com），且已 gh auth login"
}

# 从 issue 标题生成文件名安全的短 slug（仅 [a-z0-9-]，截断 40）
# 非 ASCII 标题（本仓库 issue 多为中文）会被 sed 清空，此时回退成标题 sha1 的前 8 位：
# 确定性 —— 同一个 issue 重跑本脚本仍得到同一个分支名，worktree 判重才可靠。
slugify() {
  local title="$1"
  local slug
  slug=$(printf '%s' "${title}" | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40)
  if [[ -z "${slug}" ]]; then
    slug=$(printf '%s' "${title}" | shasum -a 1 | cut -c1-8)
  fi
  printf '%s' "${slug}"
}

# 校验参数是正整数 issue 号
is_issue_number() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

# 读插件 package.json 的 scripts.<键>；不存在或读不出则输出空串（软失败）
pkg_script() {
  node -e '
    const fs = require("fs");
    try {
      const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write((p.scripts && p.scripts[process.argv[2]]) || "");
    } catch (e) { process.stdout.write(""); }
  ' "$1" "$2" 2>/dev/null || printf ''
}

# 读插件 package.json 的 name（软失败）
pkg_name() {
  node -e '
    const fs = require("fs");
    try {
      const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(p.name || "");
    } catch (e) { process.stdout.write(""); }
  ' "$1" 2>/dev/null || printf ''
}

# 找检出某个分支的 worktree 绝对路径（找不到输出空串）
worktree_for_branch() {
  local want="$1" line path=""
  while IFS= read -r line; do
    case "${line}" in
      "worktree "*) path="${line#worktree }" ;;
      "branch refs/heads/${want}") printf '%s' "${path}"; return 0 ;;
    esac
  done < <(git -C "${REPO_ROOT}" worktree list --porcelain 2>/dev/null)
  printf ''
}

# 找检出 main 的主工作区绝对路径（找不到输出空串）
main_worktree() {
  local line path=""
  while IFS= read -r line; do
    case "${line}" in
      "worktree "*) path="${line#worktree }" ;;
      "branch refs/heads/main") printf '%s' "${path}"; return 0 ;;
    esac
  done < <(git -C "${REPO_ROOT}" worktree list --porcelain 2>/dev/null)
  printf ''
}

# 高亮一行安装/检查结论（只渲染，不改变退出码）
mark() {
  case "$1" in
    ok)   echo "  ✓ $2" ;;
    skip) echo "  - $2（跳过）" ;;
    *)    echo "  ✗ $2" ;;
  esac
}

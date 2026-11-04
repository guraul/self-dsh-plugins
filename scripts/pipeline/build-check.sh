#!/usr/bin/env bash
# build-check.sh — 检查各消费仓装的共享包是不是同一个构建
#
# 为什么需要它：`doctor` 是手动命令，构建漂移不会自己叫。2026-11-04 实测过一次——
# `tools/` 装的还是旧构建，`review prompt` 直接报「未知动作」，全靠人回忆才定位。
#
# 比对的仓来自 `.dsh/pipeline.json` 的 `doctorRepos`（相对本仓根的路径）：
#   {"repo":"guraul/self-dsh-plugins", "doctorRepos":["../agent-mobile","../homebase","../memx"]}
# 本仓自己总是参与比对；不存在 / 没装包的兄弟仓会被跳过并说明（CI 里没有兄弟仓，
# 跳过不判失败——否则 CI 必红）。
#
# 用法:
#   scripts/pipeline/build-check.sh            # 人读：打印 doctor 表 + 结论
#   scripts/pipeline/build-check.sh --quiet    # 机器读：只打一行结论
# 退出码: 一致（或可比对的仓不足 2 个）→ 0；构建不一致 → 1；环境错误 → 2
set -euo pipefail
source "$(dirname "$0")/lib.sh"

QUIET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quiet) QUIET=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "✗ 未知参数: $1（见 --help）" >&2; exit 2 ;;
  esac
done

# 一律以**主工作区**为准：worktree 里既没有 tools/，兄弟仓的相对路径也会算错一层
MAIN_WT=$(main_worktree)
[[ -n "${MAIN_WT}" ]] || die "找不到主工作区"
resolve_pipeline_cli || die "未找到共享 pipeline 包（试过: ${PIPELINE_TRIED}）"

CONFIG="${MAIN_WT}/.dsh/pipeline.json"
[[ -r "${CONFIG}" ]] || die "读不到 ${CONFIG}"

# 兄弟仓清单：一行一个（没有就输出空）
SIBLINGS=$(node -e '
const fs = require("node:fs")
const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const list = Array.isArray(cfg.doctorRepos) ? cfg.doctorRepos : []
process.stdout.write(list.filter((p) => typeof p === "string" && p.trim().length > 0).join("\n"))
' "${CONFIG}") || die "解析 ${CONFIG} 失败"

REPOS=("${MAIN_WT}")
SKIPPED=""
while IFS= read -r rel; do
  [[ -n "${rel}" ]] || continue
  case "${rel}" in
    /*) abs="${rel}" ;;
    *)  abs="${MAIN_WT}/${rel}" ;;
  esac
  # 目录在、并且装了包才纳入比对：只装了一半的兄弟仓会让 doctor 报「未安装」
  if [[ -d "${abs}" && -f "${abs}/tools/node_modules/dsh-pipeline/bin/cli.mjs" ]]; then
    REPOS+=("$(cd "${abs}" && pwd)")
  else
    SKIPPED="${SKIPPED} ${rel}"
  fi
done <<< "${SIBLINGS}"

if [[ "${#REPOS[@]}" -lt 2 ]]; then
  [[ "${QUIET}" -eq 1 ]] && echo "构建检查: 跳过（可比对的仓不足 2 个${SKIPPED:+；未纳入:${SKIPPED}}）"
  [[ "${QUIET}" -eq 1 ]] || info "构建检查: 跳过（可比对的仓不足 2 个${SKIPPED:+；未纳入:${SKIPPED}}）"
  exit 0
fi

LIST=$(printf '%s,' "${REPOS[@]}"); LIST="${LIST%,}"
RC=0
OUT=$(node "${PIPELINE_CLI_PATH}" doctor --repo "${LIST}" 2>&1) || RC=$?

if [[ "${QUIET}" -eq 1 ]]; then
  if [[ "${RC}" -eq 0 ]]; then
    echo "构建检查: 一致（${#REPOS[@]} 仓）"
  else
    echo "构建检查: 不一致（${#REPOS[@]} 仓）"
  fi
else
  printf '%s\n' "${OUT}"
fi

if [[ "${RC}" -ne 0 ]]; then
  echo "" >&2
  echo "✗ 共享包构建不一致：上面几行里出现不同的 sha/时间，说明有仓装的是旧包。" >&2
  echo "  修法：cd <旧的那个仓>/tools && rm -rf node_modules pnpm-lock.yaml && pnpm install" >&2
  [[ -z "${SKIPPED}" ]] || echo "  （本次跳过:${SKIPPED}）" >&2
  exit 1
fi

[[ "${QUIET}" -eq 1 ]] || ok "构建一致：${#REPOS[@]} 个仓同一个共享包构建${SKIPPED:+（跳过:${SKIPPED}}"
exit 0

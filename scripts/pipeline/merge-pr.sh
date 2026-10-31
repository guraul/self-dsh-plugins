#!/usr/bin/env bash
# merge-pr.sh — squash 合并当前任务的 PR 并清理现场
#
# 审核闸门（fail-closed）：合并前必须有审核记录（--review-record=<文件>），由
#   dsh-subagents 校验判定、提交绑定、时效与高风险路径。要绕过必须**显式**声明：
#   --no-review 或 DSH_REVIEWER=off——绕过会打印警告并写一条跳过审计（可查）。
#   用户对本次 review 的明确同意仍是调用纪律（脚本不替用户做决定），但它不再是唯一闸门。
#
# 用法:
#   cd <worktree> && scripts/pipeline/merge-pr.sh        # 在 worktree 内：自动识别当前分支的 PR
#   scripts/pipeline/merge-pr.sh <PR号|分支名>            # 任意位置（含主工作区）指定 PR
#   scripts/pipeline/merge-pr.sh <PR号> --check-only      # 只跑到 CI 门槛为止（演练）：不合并、不清理
#   scripts/pipeline/merge-pr.sh <PR号> --checks-file=<文件>
#                                                        # 自测用：用文件内容替代 `gh pr checks` 原文
#   scripts/pipeline/merge-pr.sh <PR号> --review-record=<文件>
#                                                        # 审核记录（.dsh-web/reviews/<pr>-<sha>.json）
#   scripts/pipeline/merge-pr.sh <PR号> --no-review        # 显式跳过审核闸门（留痕）
#   scripts/pipeline/merge-pr.sh <PR号> --force           # CI 未过/未配置时仍合并（慎用）
#
# 行为: 定位 PR → CI checks 未过则拒绝 → 审核闸门未过则拒绝 → gh pr merge --squash
#       → 删远端分支 → 删本地分支 → 清理对应 worktree → 主工作区 fetch + merge --ff-only 快进
# 幂等: PR 已合并（MERGED）时跳过合并步骤，仅继续清理现场并快进 main
#
# 与 agent-mobile 的差异（修掉那边已知的缺陷，见其 AGENTS.md 规定 15 ④ / issue #102）：
#   从主工作区运行时**不再跳过** worktree 清理与 main 快进——本脚本会通过
#   `git worktree list` 反查持有该分支的 worktree 并移除它，然后快进主工作区。
source "$(dirname "$0")/lib.sh"
require_gh

FORCE=0; CHECK_ONLY=0; CHECKS_FILE=""; TARGET=""; REVIEW_RECORD=""; NO_REVIEW=0
if [[ -n "${DSH_REVIEWER+x}" ]] && [[ "${DSH_REVIEWER}" == "off" ]]; then NO_REVIEW=1; fi
for a in "$@"; do
  case "${a}" in
    --force) FORCE=1 ;;
    --check-only) CHECK_ONLY=1 ;;
    --dry-run) CHECK_ONLY=1 ;;
    --checks-file=*) CHECKS_FILE="${a#--checks-file=}" ;;
    --review-record=*) REVIEW_RECORD="${a#--review-record=}" ;;
    --no-review) NO_REVIEW=1 ;;
    -*) die "未知参数: ${a} （可用: --check-only / --checks-file=<文件> / --review-record=<文件> / --no-review / --force）" ;;
    *) TARGET="${a}" ;;
  esac
done

MAIN_WT=$(main_worktree)
[[ -n "${MAIN_WT}" ]] || die "未找到检出 main 的主工作区（git worktree list 里没有 main）"

# —— 定位 PR ——
if [[ -z "${TARGET}" ]]; then
  BRANCH=$(git -C "${REPO_ROOT}" branch --show-current) || BRANCH=""
  [[ "${BRANCH}" == task/* ]] \
    || die "在 task/* 分支（worktree）内运行，或用 <PR号|分支名> 指定目标"
  TARGET="${BRANCH}"
fi

PR_NUM=$(gh pr view "${TARGET}" --repo "${GH_REPO}" --json number -q .number 2>/dev/null) || PR_NUM=""
[[ -n "${PR_NUM}" ]] || die "找不到 PR: ${TARGET}"

PR_TITLE=$(gh pr view "${PR_NUM}" --repo "${GH_REPO}" --json title -q .title)
BRANCH=$(gh pr view "${PR_NUM}" --repo "${GH_REPO}" --json headRefName -q .headRefName)
STATE=$(gh pr view "${PR_NUM}" --repo "${GH_REPO}" --json state -q .state)
info "PR #${PR_NUM}: ${PR_TITLE} （${BRANCH} ，state=${STATE} ）"

# —— 快进 main ——
# ⚠️ 不要用 `git pull --ff-only origin main`（issue #22）：它依赖 .git/FETCH_HEAD，
#    而本机 git 2.37.1 的 builtin/pull.c 在 FETCH_HEAD 含 >1 个 for-merge 条目时
#    （`sha\t\tbranch ...`，中间字段为空者）且指定 --ff-only 会直接
#    die("Cannot fast-forward to multiple branches.")。该状态与"本地和远端真的分叉"
#    无关：`git fetch` 是**开始时截断、结束时追加** FETCH_HEAD，两个重叠的 fetch
#    （本仓库常有并发会话/子代理同时跑 fetch）交错时就会留下 2 条 for-merge。
#    实测危害：报错被误读成"main 有分叉"，进而可能误用 --force / reset 破坏主线；
#    且失败发生在"合并已成功"之后，exit=1 让调用方以为整个合并失败。
#    故这里改成 fetch + `git merge --ff-only origin/main`：显式命名 merge head，
#    完全不读 FETCH_HEAD，同时保持"绝不做非快进合并"的语义（必须 --ff-only）。
# 失败时区分「真分叉」与「临时状态」；前者提示不要 force，后者给可操作的一步，
# 并做**一次**"先验证无分叉再重试"的自动重试（禁止无验证的盲目重试）。
ff_main() {
  local out
  git -C "${MAIN_WT}" fetch --prune origin main --quiet \
    || die "fetch origin main 失败，main 未快进（检查网络后重跑本脚本的收尾步骤；脚本幂等）"

  if out=$(git -C "${MAIN_WT}" merge --ff-only origin/main --quiet 2>&1); then
    return 0
  fi

  if git -C "${MAIN_WT}" merge-base --is-ancestor main origin/main; then
    # main 是 origin/main 的祖先 → 没有分叉，只是这次快进没做成（临时状态）
    info "快进未生效，但已确认 main 是 origin/main 的祖先（无分叉）；疑似临时状态，重试一次"
    if git -C "${MAIN_WT}" merge --ff-only origin/main --quiet; then
      ok "重试成功：main 已快进"
      return 0
    fi
    printf '%s\n' "${out}" | sed 's/^/    │ /'
    die "main 快进重试仍失败（已确认无分叉：main 是 origin/main 的祖先）。这是临时状态，不是分叉 —— 重跑本脚本的收尾步骤即可（脚本幂等：PR 已是 MERGED 时只清理现场并快进 main）"
  fi

  printf '%s\n' "${out}" | sed 's/^/    │ /'
  die "main 与 origin/main 确实分叉（merge-base --is-ancestor 不成立），需人工处理：在 ${MAIN_WT} 里看 git log --oneline --graph main...origin/main 后再决定怎么合。⚠️ 不要用 --force / reset --hard 覆盖主线"
}

# —— 清理现场（无论本次是新合并的还是早就合并过的，都要收拾干净）——
cleanup() {
  info "清理分支与 worktree"
  git -C "${REPO_ROOT}" push origin --delete "${BRANCH}" 2>/dev/null || true

  local WT_TO_REMOVE
  WT_TO_REMOVE=$(worktree_for_branch "${BRANCH}")
  if [[ -n "${WT_TO_REMOVE}" ]]; then
    info "移除 worktree: ${WT_TO_REMOVE}"
    git -C "${MAIN_WT}" worktree remove --force "${WT_TO_REMOVE}" 2>/dev/null \
      || die "worktree 移除失败: ${WT_TO_REMOVE} （手动 git worktree remove --force 后重跑）"
  else
    info "没有持有 ${BRANCH} 的 worktree，跳过移除"
  fi

  # squash 合并后原提交不是 main 的祖先，必须用 -D
  git -C "${MAIN_WT}" branch -D "${BRANCH}" 2>/dev/null || true
  git -C "${MAIN_WT}" worktree prune 2>/dev/null || true

  info "主工作区快进 main: ${MAIN_WT}"
  ff_main
  git -C "${MAIN_WT}" log --oneline -1 | sed 's/^/  main → /'

  info "剩余 worktree（应只剩主工作区）"
  git -C "${MAIN_WT}" worktree list | sed 's/^/  /'
}

if [[ "${STATE}" == "MERGED" ]]; then
  ok "PR #${PR_NUM} 已经是 MERGED 状态，跳过合并，仅清理现场"
  cleanup
  ok "现场已清理，main 已是最新"
  exit 0
fi
[[ "${STATE}" == "OPEN" ]] || die "PR #${PR_NUM} 状态为 ${STATE} ，无法合并"

# —— CI 门槛 ——
# ⚠️ 不要用 `gh pr checks --fail-fast`（issue #5）：该 flag 只在 --watch 模式下有意义，
#    不带 --watch 单独用会直接报 "cannot use `--fail-fast` flag without `--watch` flag"
#    并 exit 1，把关卡误判成"有未通过的 checks"（本机 gh 2.42.1 实测）。
# ⚠️ 也不要只信 `gh pr checks` 的退出码：它的语义在各 gh 版本间并不统一
#    （0=全过 / 1=有失败**或**根本没有 checks / 8=有 pending …），故这里
#    **以输出文本判定为主、退出码只做兜底**，并把两份原始证据都留痕。
#
# ci_judge <checks原文>：无阻塞项 → 返回 0；有阻塞项 → 打印原文并返回 1。
#   阻塞状态: fail / pending / cancel（pending 覆盖 queued 与 in_progress）
#   放行状态: pass / skipping（skipping 是主动跳过，不算失败）
#   状态列两侧恒有制表符（形如 `name \t status \t elapsed \t url`），
#   所以用 `\t(status)\t` 匹配即可绕开 check 名里夹带换行的情况（本仓库的
#   `check (...)` 名就带换行，逐行按列切会切错）。
ci_judge() {
  local txt="$1" blockers
  blockers=$(printf '%s\n' "${txt}" \
    | grep -E "$(printf '\t')(fail|pending|cancel)$(printf '\t')" || true)
  if [[ -n "${blockers}" ]]; then
    printf '%s\n' "${blockers}" | sed 's/^/      /'
    return 1
  fi
  return 0
}

if [[ "${FORCE}" -eq 1 ]]; then
  info "已指定 --force：跳过 CI checks 门槛（慎用）"
else
  # 先把 `gh pr checks` 的原始输出与退出码都取出来（stdout+stderr），再做判断。
  if [[ -n "${CHECKS_FILE}" ]]; then
    [[ -r "${CHECKS_FILE}" ]] || die "自测开关 --checks-file 指定的文件不可读: ${CHECKS_FILE}"
    CHECKS_OUT=$(cat "${CHECKS_FILE}") || die "读取 --checks-file 失败: ${CHECKS_FILE}"
    CHECKS_RC=0
    info "自测：以 --checks-file 提供的原文替代 gh pr checks（${CHECKS_FILE}），未调用 gh"
  else
    set +e
    CHECKS_OUT=$(gh pr checks "${PR_NUM}" --repo "${GH_REPO}" 2>&1)
    CHECKS_RC=$?
    set -e
  fi
  info "gh pr checks #${PR_NUM} 原文（退出码 ${CHECKS_RC}）:"
  printf '%s\n' "${CHECKS_OUT}" | sed 's/^/    │ /'

  if [[ -z "${CHECKS_OUT}" ]] && [[ "${CHECKS_RC}" -eq 0 ]]; then
    info "该 PR 没有 CI checks，跳过门槛"
  elif printf '%s' "${CHECKS_OUT}" | grep -qi "no checks reported"; then
    info "该 PR 没有 CI checks（gh: no checks reported），跳过门槛"
  elif ! printf '%s' "${CHECKS_OUT}" \
      | grep -Eq "$(printf '\t')(pass|fail|pending|skipping|cancel)$(printf '\t')"; then
    # gh 不可用 / 输出格式变了 / PR 查不到 → 不静默放行（维持原 die 行为）
    die "无法从 gh pr checks 输出判定 CI 状态（退出码 ${CHECKS_RC}），不静默放行"
  elif ci_judge "${CHECKS_OUT}"; then
    ok "CI checks 全部通过（按输出文本判定；gh 退出码 ${CHECKS_RC}）"
  else
    die "存在未通过/进行中的 CI checks（上方为阻塞项原文；确认无碍可加 --force）"
  fi
fi

# —— 审核闸门 ——
# 排在 --check-only 之前：演练模式恰恰最该验证闸门是否真的拦得住。
# 判定、SHA 绑定、时效、高风险路径全部由 dsh-subagents 的校验器负责，本脚本只负责
# 「拿不到记录就拒绝」和「显式跳过要留痕」两件事。
review_skip_audit() {
  local reason="$1"
  DSH_ROOT="${REPO_ROOT}" SKIP_PR="${PR_NUM}" SKIP_REASON="${reason}" \
    node --input-type=module -e '
      const root = process.env.DSH_ROOT
      try {
        const { writeSkipAudit, reviewsDir } = await import(`${root}/dsh-subagents/lib/record.js`)
        const file = writeSkipAudit(reviewsDir(root), {
          pr: Number(process.env.SKIP_PR),
          headSha: null,
          reason: process.env.SKIP_REASON,
        })
        console.log(file)
      } catch (error) {
        console.error(`跳过审计写入失败: ${error.message}`)
        process.exit(1)
      }
    ' 2>/dev/null
}

if [[ "${NO_REVIEW}" -eq 1 ]]; then
  echo "⚠ 警告：审核闸门被显式跳过（--no-review 或 DSH_REVIEWER=off）" >&2
  SKIP_FILE=$(review_skip_audit "用户显式跳过（--no-review / DSH_REVIEWER=off）") || SKIP_FILE=""
  if [[ -n "${SKIP_FILE}" ]]; then
    info "已写入跳过审计: ${SKIP_FILE}"
  else
    echo "⚠ 警告：跳过审计未能写入，本次绕过没有留痕" >&2
  fi
else
  [[ -n "${REVIEW_RECORD}" ]] \
    || die "审核闸门: 未提供 --review-record（确需跳过请显式加 --no-review）"
  REVIEW_CLI="${REPO_ROOT}/dsh-subagents/lib/cli.js"
  [[ -f "${REVIEW_CLI}" ]] || die "审核闸门: 找不到校验器 ${REVIEW_CLI}"
  set +e
  REVIEW_OUT=$(node "${REVIEW_CLI}" check --pr "${PR_NUM}" --record "${REVIEW_RECORD}" --root "${REPO_ROOT}" 2>&1)
  REVIEW_RC=$?
  set -e
  printf '%s\n' "${REVIEW_OUT}" | sed 's/^/    │ /'
  if [[ "${REVIEW_RC}" -ne 0 ]]; then
    # 校验器的首行已经是 `审核闸门: …`，原样透出，不再套一层文案
    die "$(printf '%s' "${REVIEW_OUT}" | head -1)"
  fi
  ok "审核闸门通过"
fi

if [[ "${CHECK_ONLY}" -eq 1 ]]; then
  ok "演练模式（--check-only）：CI 门槛已通过，跳过合并与清理现场"
  exit 0
fi

info "squash 合并 PR #${PR_NUM}"
gh pr merge "${PR_NUM}" --repo "${GH_REPO}" --squash

cleanup
ok "PR #${PR_NUM} 已 squash 合并，现场已清理，main 已快进"

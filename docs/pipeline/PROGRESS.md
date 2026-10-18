# Pipeline 建设 · 总体进度记录（self-dsh-plugins）

> 本文件是本仓库 pipeline 建设的**唯一进度台账**：做了什么、为什么、下一步是什么。
> **怎么用**：每完成一项就把对应 checkbox 打勾，并在 §四 变更记录追加一行；决策变更要写明日期与理由。
> 流程手册见 [README.md](README.md)。

## 一、目标

把 [agent-mobile](https://github.com/guraul/agent-mobile) 的 pipeline 机制**照抄并适配**到本仓库：

```
GitHub Issue（任务入口）
  → worktree 开发（scripts/pipeline/new-task.sh）
  → 本地自测（check-all.sh 跑测试 / install-check.sh 验证装配）
  → PR（Closes #N）→ CI（只跑测试）→ 用户 review → squash 合并
  → 清理 worktree + 快进 main（**没有部署**）
```

范围：**只做脚手架，不改任何插件代码**。本仓库没有服务器、没有部署，交付物是"插件被本机 DSH profile 正确装配"。

## 二、已定决策

| # | 决策 | 日期 |
|---|------|------|
| D1 | 只移植**流程**（issue → worktree → PR → squash merge → 清理），不移植任何部署侧能力（无 `deploy.sh` / `rollback.sh` / `deploy-web.yml` / rsync / systemd / 线上验证） | 2026-10-17 |
| D2 | 本仓库的"交付物"是插件被本机 DSH profile 正确装配；对应验证脚本是 `install-check.sh`（一次性 `DSH_HOME`，**绝不碰真实 `~/.dsh`**） | 2026-10-17 |
| D3 | CI 只跑测试与语法检查（`pnpm test` / `node --check`），**零部署步骤**；另有 `typecheck` / `lint` 时一并跑 | 2026-10-17 |
| D4 | 保留**人在环唯一一步**：agent 开 PR 后必须问用户"review 是否完成"，用户回 ok 才允许跑 `merge-pr.sh` | 2026-10-17 |
| D5 | 修掉 agent-mobile `merge-pr.sh` 的已知缺陷（其 AGENTS.md 规定 15 ④ / issue #102：从主工作区运行会跳过 worktree 清理与 main 快进）——本仓库版本从主工作区运行也会反查并移除该分支的 worktree，再快进 main | 2026-10-17 |
| D6 | 文档一律中文；脚本按 macOS 自带 bash 3.2 编写（不用关联数组 / `mapfile` / `${var^^}` / `declare -A` / `${VAR:-默认值}`） | 2026-10-17 |

## 三、进度台账

### 🔨 阶段 0：脚手架（当前）

- [x] `scripts/pipeline/lib.sh`（公共常量与工具）
- [x] `scripts/pipeline/new-task.sh`（issue → worktree + 分支）
- [x] `scripts/pipeline/open-pr.sh`（推送 + 开 PR，自动 `Closes #N`）
- [x] `scripts/pipeline/merge-pr.sh`（squash 合并 + 清理现场 + 快进 main）
- [x] `scripts/pipeline/status.sh`（只读状态一览）
- [x] `scripts/pipeline/check-all.sh`（测试 / check / typecheck 遍历）
- [x] `scripts/pipeline/install-check.sh`（一次性 `DSH_HOME` 装配验证）
- [x] `docs/pipeline/README.md`（工作手册）+ `docs/pipeline/PROGRESS.md`（本台账）
- [x] `.github/workflows/ci.yml`（测试 + 语法检查，无部署）
- [x] `.gitignore` 追加 `.worktrees/`
- [ ] 7 个脚本 `bash -n` 语法检查全过（本轮）
- [ ] 把 `scripts/`、`docs/pipeline/`、`.github/` 纳入顶层白名单 `.gitignore`（**尚未决定**：当前白名单只收录 `dsh-auto-upgrade/`，不改的话这些文件不入库、CI 里 4 个插件只有 1 个会被检出）

### ⬜ 阶段 1：首次实跑

- [ ] 开一个真实 issue，走完 `new-task.sh` → 开发 → `check-all.sh` → `open-pr.sh`
- [ ] 确认 CI（`ci.yml`）真的跑到该插件的测试
- [ ] 用户 review 同意后跑 `merge-pr.sh`，确认 worktree 与本地分支被清理、main 被快进
- [ ] 记录 CI 首跑暴露的问题（尤其：非白名单目录不会被检出）

### ⬜ 阶段 2：常态化

- [ ] 每个插件补齐可跑的检查（`dsh-external-discuss` 目前无 lockfile / 无 `node_modules`）
- [ ] 决定是否给插件加 `check` 脚本（当前只有 `dsh-auto-upgrade` / `dsh-external-discuss` 有）
- [ ] `install-check.sh` 覆盖全部 4 个插件的装配验证并纳入日常

## 四、变更记录

| 日期 | 变更 | 说明 |
|------|------|------|
| 2026-10-17 | 建档 + 阶段 0 脚手架落地 | 照抄并适配 agent-mobile pipeline：7 个脚本 + CI + 手册 + 台账；决策 D1–D6；仅脚手架，未改任何插件代码 |
| 2026-10-18 | 修 `merge-pr.sh` CI 门禁误报（issue #5） | 去掉 `gh pr checks --fail-fast`（本机 gh 2.42.1 不带 `--watch` 时会报参数非法并 exit 1，被误判成"有未通过的 checks"）；改为取原文 + 退出码，**以输出文本判定为主**：`fail`/`pending`/`cancel` 拒绝并打印阻塞原文，`pass`/`skipping` 放行；无法判定时不静默放行。新增 `--check-only`（演练）与 `--checks-file=<文件>`（自测注入 checks 原文）两个开关 |
| 2026-10-18 | 修 `merge-pr.sh` 收尾快进 main 的 `FETCH_HEAD` 竞态（issue #22） | 收尾不再用 `git pull --ff-only`（它读 `.git/FETCH_HEAD`；本机 git 2.37.1 的 `pull.c` 在 FETCH_HEAD 含 >1 个 for-merge 条目时 `die`「Cannot fast-forward to multiple branches.」，与真分叉无关，却被报成"有分叉"，易诱使误用 `--force`/`reset`）；改为 `git fetch --prune origin main` + `git merge --ff-only origin/main`（显式命名 merge head，仍绝不做非快进合并）。失败时区分「真分叉」（提示不要 force）与「临时状态」（给可操作一步），并对后者做**一次**「先验证无分叉再重试」的自动重试 |

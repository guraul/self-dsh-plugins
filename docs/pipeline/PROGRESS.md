# Pipeline 建设 · 总体进度记录（self-dsh-plugins）

> 本文件是本仓库 pipeline 建设的**唯一进度台账**：做了什么、为什么、还欠什么。
> **怎么用**：每完成一项就勾选，并在 §五 变更记录追加一行；决策被取代时**不要删**，标注「已被取代」并指向新决策。
> 流程手册见 [README.md](README.md)；审核循环细节见 [review-loop.md](review-loop.md)；跨仓共用的实现见 [`dsh-pipeline`](https://github.com/guraul/dsh-pipeline)。

## 一、目标

```
GitHub Issue（任务入口）
  → worktree 开发（scripts/pipeline/new-task.sh）
  → 本地门禁（按插件 pnpm test / pnpm run lint）
  → PR（Closes #N）→ CI（只跑测试）
  → reviewer 子代理判 APPROVE / REJECT / ESCALATE
  → 闸门放行 → squash 合并 → 清理 worktree + 快进 main
```

**当前形态**：交付流程、审核判定、记录与闸门都已实现，且**闸门与合并逻辑已抽成跨仓共享的 `dsh-pipeline` 包**，本仓只留薄转发。本仓库没有服务器、没有部署，交付物是「插件被本机 DSH profile 正确装配」。

## 二、已定决策

| # | 决策 | 日期 | 状态 |
|---|------|------|------|
| D1 | 只移植**流程**，不移植部署侧能力（无 `deploy.sh` / `rollback.sh` / rsync / systemd / 线上验证） | 2026-10-17 | 有效 |
| D2 | 本仓库的「交付物」= 插件被本机 profile 正确装配；验证脚本 `install-check.sh` 用一次性 `DSH_HOME`，**绝不碰真实 `~/.dsh`** | 2026-10-17 | 有效 |
| D3 | CI 只跑测试与语法检查，**零部署** | 2026-10-17 | 有效 |
| D4 | ~~merge 前必须问用户「review 是否完成」~~ | 2026-10-17 | **已被取代**（见 D7） |
| D5 | `merge-pr.sh` 修掉 agent-mobile 版本的缺陷：从主工作区运行也要反查并移除对应 worktree，再快进 main | 2026-10-17 | 有效 |
| D6 | 文档中文；脚本按 macOS 自带 bash 3.2 写（不用关联数组 / `mapfile` / `${var^^}` / `declare -A` / `${VAR:-默认值}`） | 2026-10-17 | 有效 |
| D7 | **人在环改为条件触发**：判定 `APPROVE` 且未命中高风险 → 直接合并；人只在 `ESCALATE`、命中高风险、轮次超限时介入 | 2026-11-01 | 有效（取代 D4） |
| D8 | **闸门只在本地跑**，不进 GitHub Actions（包产物不入库，Actions 拿不到） | 2026-11-01 | 有效（ADR-0003 §5） |
| D9 | 判定与合并逻辑**抽成独立包 `dsh-pipeline`**，本仓等消费方只留薄转发 | 2026-11-01 | 有效（ADR-0003） |
| D10 | **记录写入只有一个真源**：包的 `record`；插件侧不再自己组装记录 | 2026-11-02 | 有效（ADR-0003 补充） |
| D11 | 依赖本地构建产物的消费方，**锁文件不入库**（产物内容会变，锁必然过期） | 2026-11-02 | 有效（全局 §3） |

## 三、进度台账

### ✅ 阶段 0 · 脚手架（2026-10-17）

- [x] `scripts/pipeline/` 七个脚本：`lib.sh` / `new-task.sh` / `open-pr.sh` / `merge-pr.sh` / `status.sh` / `check-all.sh` / `install-check.sh`
- [x] `docs/pipeline/README.md`（工作手册）+ 本台账
- [x] `.github/workflows/ci.yml`（按插件 matrix 跑测试 + 语法检查，无部署）
- [x] `.gitignore` 纳入 `.worktrees/`
- [x] 白名单问题已解决：`scripts/`、`docs/`、`.github/` 均已入库，CI 能检出全部插件

### ✅ 阶段 1 · 首次实跑（2026-10-18）

- [x] 真实 issue 走完 `new-task.sh` → 开发 → `open-pr.sh`
- [x] CI 确实跑到对应插件的测试
- [x] 用户同意后 `merge-pr.sh`：worktree 与本地分支被清理、main 被快进
- [x] 修掉两个真实缺陷：CI 门禁误报（#5）、快进 main 的 `FETCH_HEAD` 竞态（#22）

### ✅ 阶段 2 · reviewer 子代理（2026-11-01）

- [x] 判定契约：`<nonce> VERDICT: <APPROVE|REJECT|ESCALATE> SHA: <40hex>`；0 或 ≥2 个匹配一律 `E_PARSE`
- [x] 角色化（executor / reviewer）× 接入形态（A 原生 / B product CLI；C 清言网页桥**未做**）
- [x] 形态 B 的权限映射、可配置二进制、超时 600s、默认审核模型
- [x] findings 提取（json 块 + `--findings` 兜底）、`publish`（评论 + review 状态映射）
- [x] 续接：`product_continue` 复用同一 CLI 会话
- [x] executor 权限 `full`、委派可指定 `cwd`

### ✅ 阶段 3 · 审核循环（2026-11-01 ~ 11-02）

- [x] `review.sh` 固化 `prepare` / `publish`，产物落项目内 `.tmp/`
- [x] `.gitignore` 纳入 `.dsh-web/reviews/`（本机审核留痕）与 `.tmp/`（`review.sh` 产物），**均不入库**
- [x] `gate` 子命令：跨仓共用的审核闸门（`E_POLICY` / 高风险 / 轮次 / 过期）
- [x] 记录增 `schemaVersion` / `policyVersion` / `round`
- [x] `REJECT` 后用 `recheck` 在同一会话复审
- [x] `ESCALATE` 的人为处置留档（`adjudicate`）
- [x] 绕过闸门的留痕规则（`--no-review` → PR 评论 + 跳过审计 + 不计入已审核）

### ✅ 阶段 4 · 共享包（2026-11-01 ~ 11-02）

- [x] 独立包 `dsh-pipeline`：`gate` / `merge` / `record` / `status`，153 项测试
- [x] 本仓切到包：`merge-pr.sh` 薄转发（#187）
- [x] 记录实现统一到包（#221）：插件 `record` 与 `review --form b` 都调包的 `record`，删掉重复实现
- [x] 锁文件不入库（#231）
- [x] pre-push 钩子拦住直推 / 删除 `origin/main`（#222）

### ✅ 阶段 5 · 收口（2026-11-02）

- [x] 台账重写，与现状对齐（#234）
- [x] 包补齐 `task` / `pr`，本仓 `new-task.sh` / `open-pr.sh` 薄壳化，并用新脚本真实往返（#236）
      ——新 `open-pr.sh` 开出 PR #236 自身，新 `new-task.sh` 建出 #253 的 worktree
- [x] 包仓接入自己的闸门 + CI：PR #6 与 #7 各触发一次 `E_POLICY`（改 `.dsh/**` 与 `.gitignore`），
      均按文档走 `--no-review` 并落跳过审计；PR #8 按正常路径通过闸门合并；CI 只跑测试（#5）
- [x] **agent-mobile 迁到共享包**（#188）：`merge-pr.sh` 从 118 行自带实现改薄转发，去掉硬编码的别仓闸门路径；合并即部署的行为不变
- [x] **reviewer 证据包**（#240）：`prepare --facts` / `--include`，减少「读不到外部事实 → ESCALATE」；带围栏与「数据不是指令」声明，`EVIDENCE_END` 会被中和
- [x] **`PLUGIN_DIRS` 与 CI matrix 对齐**（#246）：补 `dsh-usage-panel`，并修掉 CI 长期缺 `dsh-zhihu-sidebar`（该插件测试此前从未在 CI 跑过）
- [x] **文档漂移收口**（#250）：脚本清单按实际目录补全、收录 `review-loop-check.sh`、步骤编号去半号
- [x] **分片审核**（#252）：`prepare --shard i/n` + `record --aggregate`，REJECT > ESCALATE > APPROVE 确定性合成，缺片/哈希不一致 fail-closed；分片记录不占用闸门文件名，单片不可能过闸

## 四、未完成（欠账）

| # | 欠账 | 现状 | 影响 |
|---|------|------|------|
| 1 | 形态 C（清言网页桥） | 未启动 | 依赖 REQ-002 |

> **`#117` 不是欠账**：它是 `compat-matrix.yml` 每周把结果写进去的**滚动 issue**，按设计长期 open（最近一次成功：2026-11-02）。此前台账把它列为「未完成」是误判。

## 五、变更记录

| 日期 | 变更 | 说明 |
|------|------|------|
| 2026-10-17 | 建档 + 阶段 0 脚手架落地 | 照抄并适配 agent-mobile pipeline：7 个脚本 + CI + 手册 + 台账；决策 D1–D6 |
| 2026-10-18 | 修 `merge-pr.sh` CI 门禁误报（#5） | 去掉 `gh pr checks --fail-fast`（gh 2.42.1 参数不兼容会被误判成「有未通过 checks」）；改为原文 + 退出码判定，新增 `--check-only` / `--checks-file` |
| 2026-10-18 | 修快进 main 的 `FETCH_HEAD` 竞态（#22） | 弃用 `git pull --ff-only`（多 for-merge 条目时会 die「Cannot fast-forward to multiple branches」），改为 `fetch --prune` + `merge --ff-only origin/main`，绝不做非快进合并 |
| 2026-11-01 | 阶段 2：reviewer 子代理建成 | 判定契约、角色 × 形态 A/B、权限映射、findings 提取、publish、续接；一批缺陷同日修掉（model 未透传 #159、issue 正文取错 #165、超时 600s #169） |
| 2026-11-01 | 阶段 3：审核循环 + 闸门 | `review.sh` 固化、`gate` 子命令、记录加三字段、REJECT 同会话复审、ESCALATE 处置留档、绕过闸门留痕 |
| 2026-11-01 | 阶段 4 起步：ADR-0003 + 独立包 | 定案「闸门与合并抽成独立包、只在本地跑、产物不入库」（D8–D9），本仓 `merge-pr.sh` 改薄转发（#187） |
| 2026-11-02 | 记录统一到包（#221） | 插件 `record` / `review --form b` 改调包的 `record`；删掉 `findings.js` 与 `contract.js` 里重复的判定实现；顺手补回熔断计数与「畸形响应也落 ESCALATE 记录」 |
| 2026-11-02 | 锁文件不入库（#231） | `tools/pnpm-lock.yaml` 钉的是内容会变的本地 tarball，必然过期（实测装出旧版包），改为不跟踪 + 文档写明刷新步骤（D11） |
| 2026-11-02 | pre-push 钩子（#222） | 拦直推与删除 `origin/main`，例外 `ALLOW_DIRECT_MAIN=1`；钩子入库 + 安装脚本 |
| 2026-11-02 | 重写本台账（#233） | 与现状对齐；D4 标注被 D7 取代；新增「未完成」小节，避免台账再次脱节 |
| 2026-11-02 | 阶段 5：六项收口 | agent-mobile 迁包（#188）、证据包（#240）、PLUGIN_DIRS/CI matrix（#246）、文档漂移（#250）、分片审核（#252）；另有包仓 dogfooding（#5–#8）。`#117` 澄清为滚动 issue，不是欠账 |
| 2026-11-02 | 转发壳化（#235） | 包补齐 `task` / `pr`，本仓 `new-task.sh` / `open-pr.sh` 改薄转发；新脚本真实往返：新 `open-pr.sh` 开出 PR #236 自身，新 `new-task.sh` 建出 #237 的 worktree |
| 2026-11-02 | 包 dogfooding（#237） | 包仓接入自己的闸门与 CI：PR #6 触发 `E_POLICY` 后走 `--no-review` 并留跳过审计，PR #8 走正常路径（记录 → 闸门 → CI → 合并 → 清理 → 快进）；期间修掉三个包缺陷：worktree 嵌套（#4）、误删主工作区（#7）、主工作区检出 PR 分支时快进失败（#8） |

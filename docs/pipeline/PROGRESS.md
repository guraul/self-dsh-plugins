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
      ——新 `open-pr.sh` 开出 PR #236 自身，新 `new-task.sh` 建出 #237 的 worktree
- [x] 包仓接入自己的闸门 + CI：PR #6 与 #7 各触发一次 `E_POLICY`（#6 改 `.dsh/**`、#7 改 `.gitignore`；#7 同一个 PR 还修了「误删主工作区」），
      均按文档走 `--no-review` 并落跳过审计；PR #8 按正常路径通过闸门合并；CI 只跑测试（#5）
- [x] **agent-mobile 迁到共享包**（issue agent-mobile#187 / PR #188）：`merge-pr.sh` 从 118 行自带实现改薄转发，去掉硬编码的别仓闸门路径；合并即部署的行为不变
- [x] **reviewer 证据包**（#240）：`prepare --facts` / `--include`，减少「读不到外部事实 → ESCALATE」；带围栏与「数据不是指令」声明，`EVIDENCE_END` 会被中和
- [x] **`PLUGIN_DIRS` 与 CI matrix 对齐**（#246）：补 `dsh-usage-panel`，并修掉 CI 长期缺 `dsh-zhihu-sidebar`（该插件测试此前从未在 CI 跑过）
- [x] **文档漂移收口**（#250）：脚本清单按实际目录补全、收录 `review-loop-check.sh`、步骤编号去半号
- [x] **分片审核**（#252）：`prepare --shard i/n` + `record --aggregate`，REJECT > ESCALATE > APPROVE 确定性合成，缺片/哈希不一致 fail-closed；分片记录不占用闸门文件名，单片不可能过闸
      （⚠️ 2026-11-03 修正：当时是「先写规范名再删除」，中间有一段窗口能让单片冒充整份；#262 起改为直接写分片名，该判断已不成立）

### ✅ 阶段 6 · 运行态回写（2026-11-04）

- [x] dsh-pipeline `deleteBranch` 修复（包提交 74c4ccf / PR #13）：`bin/cli.mjs` 适配层丢掉调用方 options，`{force:true}` 失效、squash 合并后删分支必走 `-d` 而失败
- [x] 新插件 `dsh-subagent-policy-fallback`：DSH 只在 `firstLiveSeq === 0` 的顶层会话采样 `subagent-model-selection-settings`，种子 / 恢复会话永远拿不到 `subagent/model-selection-policy`（上游 discussion #8444）；本插件按设置补写该事件，换 subagent 模型不必重开会话
- [x] 模型路由切换：executor 走形态 A（原生子代理）+ `opencode-go/mimo-v2.6-flash`，reviewer 走形态 B（`product_delegate`）+ `codebuddy/glm-5.3-flash`

### ✅ 阶段 7 · 审核准备/落盘收口（2026-11-04 下午）

- [x] **`dsh-pipeline` PR #15**：CLI 新增 `review` 子命令——`prepare` 生成 `.tmp/review/<pr>/request.json` + 12 位 nonce，`publish` 复用包的 `record` 落盘；测试 201→219。两轮审核：第 1 轮以「`files` 为空时高风险判定静默放行」判 minor，已修
- [x] **`homebase` PR #131**：新增 `scripts/pipeline/review.sh`（`prepare` / `publish` 转发壳），`test-forwarding.sh` 断言 10→13 组
- [x] **`agent-mobile` PR #195**：新增 `scripts/pipeline/review.sh` 与 `test-review.sh`（8 组断言）；第 1 轮审核 **REJECT**——`--root` 取成 worktree，会让 `.tmp/review/` 与 `.dsh-web/reviews/` 随 worktree 清理消失，且测试测不出该偏差；修后第 2 轮 **APPROVE**，并用「旧脚本喂新测试 → exit 1、21 处 ✗」反向验证测试有效
- [x] **`dsh-pipeline` PR #19 / #21**：`review prepare` 补 `--facts` / `--include`（证据包进标准入口），`review prompt` 独立成子命令（提示词模板归包）
- [x] **`dsh-pipeline` PR #23 / #25**：`task --worktrees-dir`（worktree 容器可指定，给「容器必须在仓外」的仓用）、`review prepare` 取 issue 正文；包测试 219→246
- [x] **本仓 `review.sh` 转发（PR #278，`70eaa3d`）**：`prepare` / `prompt` 改为转发共享包的 `review` 子命令；`publish`（把判定发到 GitHub 当 review，走 reviewer 专属 gh 身份）仍留本仓，属已知边界
- [x] **`memx` 接入共享包（memx PR #56）**：`tools/` + `.dsh/pipeline.json` + 五个转发壳 + `test-forwarding.sh`（13 组）；`new-task.sh` 固定 `--worktrees-dir /Users/gubin/workspace/memx-worktrees`（memx 被宿主加载源码，worktree 必须建在仓外）
- [x] 四仓 `doctor` 一致：构建 `cc13260 2026-11-04T12:18:01Z`（self-dsh-plugins / agent-mobile / homebase / memx）

同日上午三仓共享包刷新到构建 `0a7ea83 2026-11-04T08:10:47Z`，`doctor` 三行一致（同日晚些时候四仓统一到 `cc13260`，见上）。

## 四、未完成（欠账）

| # | 欠账 | 现状 | 影响 |
|---|------|------|------|
| 1 | 形态 C（清言网页桥） | 未启动 | 依赖 REQ-002（需求未写） |
| 2 | memx 迁到共享包 | **已完成**（memx PR #56）：`tools/` + `.dsh/pipeline.json` + 五个转发壳 + `test-forwarding.sh`（13 组）；`new-task.sh` 固定 `--worktrees-dir /Users/gubin/workspace/memx-worktrees`（包 PR #23 补的参数；memx 被 opencode 加载源码，worktree 必须建在仓外） | 无。memx 无 CI，按 `ci: []` 如实声明 |
| 3 | 本仓 `review.sh` 未统一到共享包 | **已完成**（本仓 PR #278，`70eaa3d`）：`prepare` / `prompt` 已转发到包的 `review` 子命令（`--facts` / `--include` / 提示词生成都由包提供）；四仓（agent-mobile / homebase / memx / 本仓）一致 | 剩余已知边界：`publish`（把判定发到 GitHub 当 review）仍留本仓自己实现，包侧 `review publish` 只落盘记录 |

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
| 2026-11-02 | 阶段 5：六项收口 | agent-mobile 迁包（issue #187 / PR #188）、证据包（#240）、PLUGIN_DIRS/CI matrix（#246）、文档漂移（#250）、分片审核（#252）；另有包仓 dogfooding（#5–#8）。`#117` 澄清为滚动 issue，不是欠账 |
| 2026-11-02 | 转发壳化（#235） | 包补齐 `task` / `pr`，本仓 `new-task.sh` / `open-pr.sh` 改薄转发；新脚本真实往返：新 `open-pr.sh` 开出 PR #236 自身，新 `new-task.sh` 建出 #237 的 worktree |
| 2026-11-02 | 包 dogfooding（#237） | 包仓接入自己的闸门与 CI：PR #6 与 #7 触发 `E_POLICY` 后均走 `--no-review` 并留跳过审计，PR #8 走正常路径（记录 → 闸门 → CI → 合并 → 清理 → 快进）；期间修掉三个包缺陷，均由包仓 PR 修掉：#4（worktree 嵌套）、#7（误删主工作区）、#8（主工作区检出 PR 分支时快进失败） |
| 2026-11-03 | 证据包进标准入口（#258） | `review.sh prepare` 透传 `--facts` / `--include`；空值按用法错误处理；counts 与手册同步 |
| 2026-11-03 | 分片 TOCTOU 根除（包 #9 + #262） | 包加 `record --name`，分片记录**直接**写成分片名，不再「先写规范名再删除」——那段窗口里单片 APPROVE 可放行整份变更；新增真包集成断言「全程不产生规范名」 |
| 2026-11-03 | homebase 迁包（homebase#127） | `merge-pr` / `new-task` / `open-pr` 改薄转发（`status.sh` 保留：带 BFF 探测）；PR 号解析走 REST 守住该仓 #22 的约定；旧自检换成 `test-forwarding.sh`；合并即部署（`scripts/**` 在 deploy 路径里）已确认接受 |
| 2026-11-03 | agent-mobile 补忽略项（agent-mobile#192） | `.dsh-web/`、`.tmp/` 进 `.gitignore` |
| 2026-11-03 | 文档漂移小修（#260） | `compat-matrix.yml` 注释不再写死滚动 issue 号 |
| 2026-11-03 | 包补两个参数（包 #10） | `task --slug`（中文标题自动 slug 退化成哈希时手指定）、`pr --issue`（分支名不含 issue 号时指定）；均为可选参数，不传时行为不变 |
| 2026-11-03 | 构建标识 + `doctor`（包 #11） | `pack.sh` 写 `build.json`、`--version` 带构建标识、`doctor` 比对多仓装的构建；解决「版本号都一样，内容可能不同」无从判断的问题（ADR-0003 §4b）。三仓刷新后实测同一构建 `8ad432b` |
| 2026-11-04 | dsh-pipeline `deleteBranch` 修复（包提交 74c4ccf / PR #13） | `bin/cli.mjs` 适配层丢掉调用方 options，`{force:true}` 失效、squash 合并后删分支必走 `-d` 而失败。**教训：注入式包装层必须透传 options，单测只注入假 git 时抓不到这类丢失** |
| 2026-11-04 | 新插件 `dsh-subagent-policy-fallback` 上线 | DSH 只在 `firstLiveSeq === 0` 的顶层会话采样 `subagent-model-selection-settings`，种子 / 恢复会话永远拿不到 `subagent/model-selection-policy`（上游 discussion #8444）；本插件按设置补写该事件，因此不必为「换个 subagent 模型」重开会话 |
| 2026-11-04 | 模型路由切换 | executor 走形态 A（原生 subagent）+ `opencode-go/mimo-v2.6-flash`，reviewer 走形态 B（`product_delegate`）+ `codebuddy/glm-5.3-flash`；形态 A 路由依赖 `subagent/model-selection-policy` 会话策略事件，缺口由上述插件补写 |
| 2026-11-04 | 审核准备/落盘收口：包补 `review` 子命令（包 PR #15） | `prepare` 生成 `.tmp/review/<pr>/request.json` + 12 位 nonce，`publish` 复用包的 `record` 落盘；测试 201→219。两轮审核：第 1 轮以「`files` 为空时高风险判定静默放行」判 minor，已修 |
| 2026-11-04 | 两仓 `review.sh` 转发壳（homebase PR #131 / agent-mobile PR #195） | homebase 新增 `scripts/pipeline/review.sh`（`prepare` / `publish` 转发壳），`test-forwarding.sh` 10→13 组断言；agent-mobile 新增 `review.sh` 与 `test-review.sh`（8 组），第 1 轮 **REJECT**、修后第 2 轮 **APPROVE**。**教训：`--root` 必须取主工作区**——取成 worktree 时，`.tmp/review/` 与 `.dsh-web/reviews/` 都落在 worktree 里，随 `git worktree remove` 一起消失（请求产物与审核记录全丢），且旧测试测不出该偏差；修完用「旧脚本喂新测试 → exit 1、21 处 ✗」反向验证测试有效 |
| 2026-11-04 | 三仓共享包刷新 + 欠账登记（§四 #2–#3） | 三仓共享包刷新到构建 `0a7ea83 2026-11-04T08:10:47Z`，`doctor` 三行一致；欠账：本仓 `review.sh` 仍是自有实现（多 `--facts` / `--include` / 提示词生成）未统一到包，`memx` 完全未接入 pipeline |
| 2026-11-04 | 包补四个入口（包 PR #19 / #21 / #23 / #25） | `review prepare` 补 `--facts` / `--include`、`review prompt` 独立成子命令、`task --worktrees-dir`（worktree 容器可指定）、`review prepare` 取 issue 正文；包测试 219→246 |
| 2026-11-04 | 本仓 `review.sh` 转发到包（#278，`70eaa3d`） | `prepare` / `prompt` 改为转发共享包的 `review` 子命令；`publish`（发 GitHub review）仍留本仓，属已知边界；欠账 #3 清零 |
| 2026-11-04 | memx 接入共享包（memx PR #56） | `tools/` + `.dsh/pipeline.json` + 五个转发壳 + `test-forwarding.sh`（13 组）；`new-task.sh` 固定 `--worktrees-dir /Users/gubin/workspace/memx-worktrees`（仓外 worktree 容器）；欠账 #2 清零 |
| 2026-11-04 | 四仓 `doctor` 一致 | 四仓（self-dsh-plugins / agent-mobile / homebase / memx）同一构建 `cc13260 2026-11-04T12:18:01Z` |
| 2026-11-04 | 台账收口（#279） | §三 阶段 7 补五行（包四个入口 / 本仓 #278 / memx #56 / 四仓 `doctor`），§四 欠账 #2 / #3 改「已完成」；`README.md` 脚本清单与 §review.sh 的跨仓状态、刷新共享包的构建标识、memx 仓外 worktree 容器说明同步更新 |

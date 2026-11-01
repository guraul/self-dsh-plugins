# 审核循环：切换与验证手册

> 面向「把 executor 从旧插件 `dsh-plugin-product-subagents` 切到 `dsh-subagents`」这件事。
> 架构背景见 [`docs/requirements/REQ-001-design.md`](../requirements/REQ-001-design.md) 与
> [`docs/adr/0002-审核由会话委派而非闸门驱动.md`](../adr/0002-审核由会话委派而非闸门驱动.md)。

## 为什么必须一次换完

两个插件注册的 provider 名字相同（`product-subagents:opencode` / `:codebuddy`）。
DSH 里 provider 的 `name` 全局唯一，**重名会让整个 profile 插件树启动失败**。
所以不存在「两个都挂着慢慢迁」这条路：要么旧的，要么新的。

## 一、切换（需要用户在场）

```bash
# 1. 摘掉旧插件：profile 的 package.json 删掉 link: 依赖与 dsh.profile.bundles 里的条目
cd ~/.dsh/profiles/web
#   "dsh-plugin-product-subagents": "link:/Users/gubin/workspace/self-dsh-plugins/dsh-plugin-product-subagents"
#   以及 dsh.profile.bundles 里的 "dsh-plugin-product-subagents"

# 2. 挂上新插件（同样两处）
#   "dsh-plugin-subagents": "link:/Users/gubin/workspace/self-dsh-plugins/dsh-subagents"
#   bundles 里加 "dsh-plugin-subagents"

# 3. 重装软链（不做会悬空，表现为插件加载失败）
pnpm install

# 4. 重启宿主（会终止当前会话；用延迟脚本让回复先发出去）
/Users/gubin/workspace/self-dsh-plugins/.dsh-web/restart-once.sh
```

## 一点五、审核循环里的脚本

机械步骤已固化，**reviewer 的模型调用不在脚本内**（必须由会话内 agent 发起）：

```bash
# 1) 准备材料：产物落在 .tmp/review/<pr>/（项目内，不会被 /tmp 的定期清理带走）
scripts/pipeline/review.sh prepare 173 --model codebuddy/glm-5.3-flash

# 2) 会话内 agent 读 .tmp/review/173/prompt.md 完成审核，把响应存成文件

# 3) 落记录（插件 CLI）
node dsh-subagents/lib/cli.js record --request .tmp/review/173/request.json --response <响应文件>

# 4) 发布：评论 + review 状态，用机器账号
scripts/pipeline/review.sh publish 173 --record .dsh-web/reviews/173-<sha>.json --round 1
#    --dry-run 可零网络预演

# 5) 合并（闸门）
scripts/pipeline/merge-pr.sh 173 --review-record=.dsh-web/reviews/173-<sha>.json
#    确需跳过时（须用户当场同意）：--no-review --reason="<为什么跳过>"
```

**合并脚本已改为转发共享包**（issue #187）：`merge-pr.sh` 只是薄壳，真正的闸门 / CI / squash 合并 /
清理都在 `@guraul/dsh-pipeline`（优先 `$DSH_PIPELINE_HOME`，否则本仓 `tools/node_modules/dsh-pipeline`——装的是 `dist/latest.tgz` 产物）。
因此有三点与旧脚本不同，写命令时别用旧写法：

| 差异 | 新语义 |
|---|---|
| 参数映射 | `--review-record=<f>` → 包侧 `--record <f>`；其余参数（`--no-review` / `--reason` / `--checks-file` / `--check-only` / `--force`）原样透传 |
| 跳过审核 | `--no-review` **必须**配 `--reason=<文本>`，裸 `--no-review` 被拒绝；`DSH_REVIEWER=off` **已不再生效** |
| `--checks-file` | 读的是 JSON `{"state":"success"｜"failure"}`，不再是 `gh pr checks` 原文；非 JSON / 不可读按 CI 未过拒绝 |

`scripts/pipeline/merge-pr.legacy.sh` 仅作**回滚**用，不要在日常流程里调用。

**为什么产物不放 `/tmp`**：macOS 的 `/etc/periodic/daily/110.clean-tmps` 每天清理 `/tmp` 里超过 3 天未访问的文件，重启也可能清掉；证据要留在项目内。

## 二、重启后验证

```bash
cd /Users/gubin/workspace/self-dsh-plugins
scripts/pipeline/review-loop-check.sh      # 只读检查，见下
```

脚本检查四件事（不启动会话、不调模型）：

1. profile 里**没有** `dsh-plugin-product-subagents`，**有** `dsh-plugin-subagents`；
2. `node_modules/dsh-plugin-subagents` 软链存在且指向仓库目录；
3. `dsh plugin --profile web --dump-config` 输出里出现 `dsh-plugin-subagents`；
4. `.dsh-web/reviews/` 目录可写。

**人工再验一条**：在新会话里让 agent 调一次 `product_delegate`（任务随便写「回复 ok」），
能拿到回答就说明 provider 注册成功、CLI 链路通。

## 三、回滚

```bash
cd ~/.dsh/profiles/web
# 把第 1、2 步反过来：删 dsh-plugin-subagents，恢复 dsh-plugin-product-subagents 的 link 与 bundle
pnpm install
.worktrees/../.dsh-web/restart-once.sh
```

代码侧 `git revert` 对应 squash 提交即可；`dsh-subagents` 目录保留不影响（未挂载就不加载）。

## 三半、形态 B 的沙盒边界与重试规则

| 边界 | 现象 | 应对 |
|---|---|---|
| 文件系统 | `codebuddy` 读不到 `/tmp`（实测返回「输入文件不可读」） | 任务卡**内联进 task 文本**；不要让它去读文件路径 |
| 首次调用 | 只读审查会被当成请求，先反问「请你确认」 | 委派 prompt 固定带 `DELEGATION_PREAMBLE`（「立即执行，不要请求确认」） |
| 输出格式 | 可能只给判定行、不给 json 块 | **在同一形态内重试一次**，只要求补 json 块；仍缺则接受空 findings，并在 PR 评论里标注「明细缺失」 |
| 超时预算 | plan 模式会读仓库核对，5k+ diff 实测超 300s | opencode `300s`、codebuddy `600s`；任务卡要求「先通读 diff，需要核实再读文件」；超时仍以 `E_TIMEOUT` 停下上报 |

**不因缺 json 块而 `ESCALATE`**：那会把一次已经通过的审核退回人工，代价大于收益。
**不退回形态 A**：退回同族模型等于把「独立视角」这个唯一价值悄悄换掉。

## 三点五、一期收尾清单

### 已完成

| 项 | 证据 |
|---|---|
| 契约（判定行 / schema / 错误码） | `dsh-subagents/lib/contract.js` + `schema/review-result.json`，单测覆盖四种判定行异常与注入 |
| 审核记录与闸门 | `.dsh-web/reviews/`（主工作区）、`merge-pr.sh --review-record` fail-closed、跳过审计 |
| 角色层与委派 | `roles/{executor,reviewer}.json`、`product_delegate`（一次性）、权限映射（readonly→plan / full→auto） |
| 形态 B 闭环 | `prepare → reviewer(B) → record → comment → review → merge` 全自动，PR #161 实测 |
| 模型防降级 | codebuddy 自报 `modelUsage`，与请求不一致即 `E_UNAVAILABLE` |
| 机器账号 | `dsh-bot-guraul` + `GH_CONFIG_DIR` 隔离，评论与 review 状态由它提交 |
| 续接（路线 a） | `product_continue` + `[delegate-session: <id>]`；2026-11-01 实测：第一次让 codebuddy「记住 42」，第二次用同一 session `01a19644-05c2-7c7c-b41b-f066a44b8fcf` 追问，答出 42（该数字只出现在第一轮），两次返回的 session id 一致 |

### 未做（及为什么现在不做）

| 项 | 为什么现在不做 |
|---|---|
| `product_submit`（异步提交）/ `product_wait`（后台等待） | 续接已由「同步 resume」覆盖（`product_continue`，路线 a）；真正需要「先提交、稍后来取」的场景还没出现，因此不做异步形态 |
| opencode 侧模型校验 | CLI 输出不含模型信息，无法自证；只能依赖「未知模型硬失败」 |
| 形态 C（网页清言） | 依赖 REQ-002 的桥接，尚未实现 |
| 分片审核 | 需要先定义多份判定的合成规则 |
| reviewer 跑 Bash | plan 模式屏蔽命令执行；放开等于给它执行权，先不开 |

### 已知限制

1. **reviewer 不能跑测试**：plan 模式只读，它只能静态核对。它会在结论里如实说明这一点。
2. **B 的任务卡必须内联**：codebuddy 读不到 `/tmp`。
3. **两个 provider 不能同时挂载**：provider 名相同。
4. **一期没有续接**：委派交出去就收不回来追问。

## 四、一期缺口（明确不交付）

| 缺口 | 影响 | 补的时机 |
|---|---|---|
| 没有异步的 `product_submit` / `product_wait` | 委派是同步的，提交与取结果在同一个调用里完成 | 需要后台等待时再做 |
| 没有 ACP 会话 | `acp` 产品未注册；`opencode` / `codebuddy` 走各自的 CLI | 同上 |
| 没有权限天花板 | 角色声明的 `permissionMode` 目前只透传给产品 CLI，未做「子代理不能派生更高权限」的校验 | 同上 |
| provider 名带 `product-` 前缀 | 名不副实，但改名会让 `audit-subagents.mjs` 静默失效 | 单独一次改名 + 同步审计脚本 |

这些缺口不阻塞 reviewer 循环：reviewer 走形态 A（宿主内置子代理），executor 走一次性委派。

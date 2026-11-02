# dsh-subagents

**角色化子代理层**。改这个插件之前先读这一页；面向使用者的安装与用法在
[`dsh-subagents/README.md`](../../dsh-subagents/README.md)。

| 项 | 值 |
|---|---|
| 包名 | `dsh-plugin-subagents` |
| 来源 | **原创**（重写替代 fork `dsh-plugin-product-subagents`，见 [ADR-0001](../adr/0001-不再跟随上游重写-subagents.md)） |
| 当前阶段 | 契约/角色/记录/CLI + executor 委派（provider + `product_delegate`，一次性） |
| 设计依据 | [`docs/requirements/REQ-001-design.md`](../requirements/REQ-001-design.md) |

## 改哪里

| 想改 | 改哪个文件 | 注意 |
|---|---|---|
| 判定行格式 / 解析规则 / 高风险路径 | 共享包 `tools/node_modules/dsh-pipeline`（`@guraul/dsh-pipeline`） | **插件端没有第二份实现**；改包要同步 `schema/review-result.json` 与 `REQ-001-design.md` §4 |
| 请求组装、diff 围栏、预算 | `lib/request.js` | diff 走 git，元数据走 gh；`--diff-file` / `--meta-file` 留给测试 |
| 记录落盘、traceId、熔断 | `lib/record.js` | 记录目录 `.dsh-web/reviews/` 已在 `.gitignore` 里忽略；**落在主工作区**（`mainWorktreeRoot`），不要改回 `cwd` |
| 分片切分 / 合成规则 | `lib/shard.js` | 按 diff 的 `diff --git` 段落切（段落是文件的真源）；缺片、越界片号、轮次不一致、各片 base 不一致一律报错，**不许放宽判定**；分片不计熔断，合成时按最终判定计一次 |
| 角色字段与加载 | `lib/roles.js` + `roles/*.json` | 非法值降级到最保守值，坏文件跳过 |
| 形态 B 的 CLI 调用 | `lib/bridge-cli.js` | 一期只有 `opencode` / `codebuddy`；ACP 在 PR4 |
| 子命令 | `lib/cli.js` | 退出码契约：0 通过 / 1 拒绝 / 2 参数或环境错误 |
| 宿主侧注册 | `lib/index.js` | 注册 `product-subagents:*` provider 与 `product_delegate`；见「已知坑」第一条 |
| provider 实现 | `lib/provider.js` | 一次性 spawn CLI；没有 `prepareContinuable`（续接是下一期） |
| 委派工具 | `lib/tools/delegate.js` | 动态 import `@deepseek-ai/dsh-tools`，拿不到就跳过注册并告警 |

## 形态 B 的默认配置与权限映射

reviewer 默认走**形态 B**（`codebuddy/glm-5.3-flash`）：独立模型家族，能读仓库但改不了文件。

| 角色权限 | opencode | codebuddy |
|---|---|---|
| `readonly` | `--agent plan`（内置只读 agent） | `--permission-mode plan` |
| `default` | 不附加参数 | 不附加参数 |
| `full` | `--auto` | `--permission-mode auto` |

超时按形态区分：opencode `300s`、codebuddy `600s`（plan 模式要读仓库，5k+ diff 实测超 300s），可在 `config.products[].timeoutMs` 覆盖。

映射实现在 `lib/provider.js` 的 `permissionArgs()`；`codebuddy` 在本机是 shim，路径通过 profile 的 `config.products` 指定。

**B 不可用时停下上报，不自动退回形态 A**——退回同族模型等于把「独立视角」这个唯一价值悄悄换掉。

## 已知坑

1. **provider 重名会让整个 profile 插件树启动失败。** 旧插件注册了 `product-subagents:opencode` 等；
   本插件 PR4 也要用同一前缀（`scripts/pipeline/audit-subagents.mjs` 硬编码了它）。因此**挂载前必须先卸载旧插件**，
   两者不能同时挂。
2. **不要提前注册 provider。** PR2 的 `lib/index.js` 是空的，这是刻意的：装配验证只验「装得进去」，
   注册对不对留到 PR4 一次验完，否则一个红灯查不出是装配问题还是注册问题。
3. **随机标记必须每次新生成。** 复用会让「判定行来自模型」这件事不可证。
4. **`nonce` 是 `ReviewResult` 的必填字段**，比 REQ-001 §7.2 多一个——结果不带它就无法证明对应哪次标记。
5. **不要在这里写「自动换模型」。** 模型不可用就 `ESCALATE`，静默降级比失败更危险。
6. **记录不能落在工作树里。** 工作树合并完就被删；`mainWorktreeRoot()` 就是为这件事存在的，PR3 上线后真实丢过一次跳过审计。
7. **与旧插件不能同时挂载。** 两者都注册 `product-subagents:opencode` / `:codebuddy`，provider 名全局唯一，重名会让整个 profile 插件树启动失败。切换与回滚步骤见 [`docs/pipeline/review-loop.md`](../pipeline/review-loop.md)。
8. **两个 gh 身份在 macOS 上会互相覆盖 active 指针。** bot 登录后主号会读到 bot 的 token；修法是 `gh auth switch --user guraul`（不需要重新授权），且辅助身份必须用 `--insecure-storage` 落在自己的 `GH_CONFIG_DIR`。
9. **spawn 产品 CLI 必须 `stdio: ['ignore','pipe','pipe']`。** `opencode run` 在 stdin 是未关闭管道时会一直等输入，表现为「宿主里调永远超时、终端里 5 秒返回」。这一条踩过一次（issue #146）。
10. **形态 B 的沙盒只能读工作目录内的文件。** `codebuddy` 读不到 `/tmp`（实测），所以任务卡必须**内联进 task 文本**，不要让它去读文件路径。
11. **形态 B 首次调用可能反问确认。** 委派 prompt 已固定带执行前言（`DELEGATION_PREAMBLE`）；自己手写任务书时也要带上，否则一次调用会空转。
12. **一期没有续接。** `product_submit` / `product_wait` 不存在，委派只能一次性拿结果；控制面写任务卡时要假定「交出去就收不回来追问」。
13. **分片记录绝不能写规范文件名。** 闸门读的是 `<pr>-<sha>.json`；分片如果落在那里，一片的 `APPROVE` 就能放行整份变更。分片写 `<pr>-<sha>.shard-<i>-of-<n>.json`，落盘后立刻删掉规范文件；`record --aggregate` 才写规范文件。
14. **规范文件「写入后立即删除」的窗口是已知且可接受的。** 共享包先把这条记录写成 `<pr>-<sha>.json`，`finalizeShardRecord` 再改名为分片文件名并删掉规范文件；两步之间有一个毫秒级窗口，此刻跑闸门会把「单片 APPROVE」当成整份变更的判定。接受它的理由：审核由控制面在**本机串行**驱动，窗口内不会并发跑闸门；能卡进这个窗口的人已经能直接往 `.dsh-web/reviews/` 写规范记录，信任边界没有扩大。真要收紧要靠共享包支持「直接以分片文件名落盘」，不是插件端加锁。
15. **各片必须来自同一次 diff。** `prepare --shard` 把**整份 diff** 的 sha256 写进 `request.shard.diffSha256`（切片后的哈希片片不同，无法作为共同基准），`record` 原样带进记录；`record --aggregate` 发现哈希缺失或集合不一致直接退出 2。同一 PR 同一轮只计一次熔断：分片记录不 bump，合成时按最终判定 bump 一次。

## 怎么验证

```bash
# 单插件门禁（测试 + 语法检查）
scripts/pipeline/check-all.sh dsh-subagents

# 一次性 DSH_HOME 装配验证（绝不碰真实 ~/.dsh）
scripts/pipeline/install-check.sh dsh-subagents

# 手工
cd dsh-subagents && node --test && node --check lib/cli.js
```

基线（2026-10-31，PR2）：`node --test` **37 项全过**。

真实调用形态 B 需要本机有 `opencode` 或 `codebuddy`，并且要用**完整权限**跑
（受限沙盒下 `gh` 读不到系统钥匙串，会报「令牌无效」）。

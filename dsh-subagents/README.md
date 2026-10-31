# dsh-plugin-subagents

角色化的子代理层。两个维度：

- **角色（role）** 决定「做什么」：`executor` 执行、`reviewer` 审核；
- **接入形态（form）** 决定「怎么连」：A 原生（宿主内注册的 provider）/ B 委派外部 CLI / C 伪模型。

三种形态共享同一份判定契约，所以上层调用方不需要知道背后差多少。

> 状态：**PR2（骨架）**。角色层、契约层、记录层与 CLI 已可用；宿主侧能力（注册
> `product-subagents:*` provider、审核 HTTP 路由）在 PR4 补齐，本包当前不挂真实 profile。

## 安装

```bash
dsh plugin --profile web add /path/to/self-dsh-plugins/dsh-subagents
```

本仓库没有发布流程，走 `link:` 依赖挂到 profile。PR4 之前请勿挂载——挂载会与
`dsh-plugin-product-subagents` 的 provider 重名。

## 用法

```bash
# 1. 组装审核请求（diff 走 git，PR 元数据走 gh）
node lib/cli.js prepare --pr 116 --out /tmp/req.json

# 2. 把 /tmp/req.json 里的 request 交给 reviewer，拿回文本响应

# 3. 解析响应、校验 schema、判高风险、落记录
node lib/cli.js record --request /tmp/req.json --response /tmp/res.txt --model codebuddy/glm-5.3

# 4. 一条命令跑完（形态 B，一次性调用）
node lib/cli.js review --pr 116 --form b --provider codebuddy --model codebuddy/glm-5.3

# 5. 合并前的闸门校验（给 merge-pr.sh 用）
node lib/cli.js check --pr 116 --record .dsh-web/reviews/116-<sha>.json

# 6. 按 traceId 反查
node lib/cli.js log --trace 20261031T121500Z-a1b2c3d4
```

退出码：`0` 通过 / `1` 拒绝（闸门不过或判定不是 `APPROVE`）/ `2` 参数或环境错误。

## 判定行

reviewer 必须输出恰好一行：

```
<随机标记> VERDICT: <APPROVE|REJECT|ESCALATE> SHA: <40 位提交>
```

解析规则（`lib/contract.js`）：

| 情况 | 结果 |
|---|---|
| 命中 0 次 | `ESCALATE` + `E_PARSE` |
| 命中 ≥2 次 | `ESCALATE` + `E_PARSE` |
| SHA 与请求不符 | `ESCALATE` + `E_SHA_MISMATCH` |
| diff 里出现该随机标记 | `ESCALATE` + `E_PARSE`（判定行可能来自被审内容） |

## 已知限制（诚实清单）

- **只有形态 B，且是一次性调用**：不移植 ACP 会话，因此没有「续接」；executor 的
  委派实现要等 PR4。
- **不分片**：diff 超过预算直接 `E_BUDGET`，交回人工。分片的合成规则（全过才算过 /
  多数 / 任一否决）是新的判定语义，一期不做。
- **不自动换模型**：`review` 必须显式给 `--model`；模型不可用就失败，不降级。
- **reviewer 与实现者同族**：独立模型家族的第二意见要等接入第二个家族。
- **`prepare` 依赖 `gh`**：受限沙盒下 `gh` 会报「令牌无效」，那是系统钥匙串被拦，
  不是令牌过期——用完整权限运行。

## 设计文档

- 需求：[`docs/requirements/REQ-001-reviewer-subagent.md`](../docs/requirements/REQ-001-reviewer-subagent.md)
- 实现方案：[`docs/requirements/REQ-001-design.md`](../docs/requirements/REQ-001-design.md)
- 为什么不再跟随上游：[`docs/adr/0001-…`](../docs/adr/0001-不再跟随上游重写-subagents.md)

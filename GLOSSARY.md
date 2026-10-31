# self-dsh-plugins

本仓是自维护的 DSH 插件集合，同时是本机 dsh web GUI 的工作目录。术语表只收**本仓特有的概念**，通用编程词汇（超时、幂等、schema）不在此列。

## 交付流程

**闸门**：
合并前必须通过的一道校验。本仓有两道：CI（测试与语法检查）与审核闸门（reviewer 的判定记录）。闸门默认关闭，只允许显式跳过。
_Avoid_: 门禁、卡点、gate

**审核闸门**：
`merge-pr.sh` 在合并前对审核记录做的校验，逐项检查存在、判定、提交绑定、时效、高风险路径。任一项不过即拒绝合并。
_Avoid_: review gate、人工闸门

**人在环**：
流程中必须由人做决定的那一步。本仓当前唯一的人在环是「合并前确认」，其上游产物是审核记录，不是口头同意。
_Avoid_: 人工确认、human in the loop

**跳过审计**：
用 `--no-review` 显式绕过审核闸门时写下的一条记录。它不阻止合并，只保证「谁在什么时候绕过了闸门」可查。
_Avoid_: 豁免、白名单

## 审核契约

**判定**：
reviewer 给出的三值结论：`APPROVE` / `REJECT` / `ESCALATE`。三值之外的一切（缺失、多义、解析失败）都算 `ESCALATE`。
_Avoid_: 结论、评分、结果

**交回人工**：
判定为 `ESCALATE` 时的处置：不自动放行，把决定权交还用户。它是**拒绝**的一种，不是「待定」。
_Avoid_: 升级、待定、pending

**提交绑定**：
判定只对某一个提交（`head_sha`）有效。提交一变，判定作废，必须重审。
_Avoid_: 版本对齐、SHA 校验

**判定行**：
reviewer 输出里唯一被采信的那一行，格式 `<随机标记> VERDICT: <判定> SHA: <提交>`。判定与提交写在同一行，二者不可分离。
_Avoid_: 结论行、verdict line

**随机标记**：
每次审核由调用方生成的一次性字符串，注入提示词并要求 reviewer 原样回显。作用是让「判定行来自模型」可证——diff 里出现同一字符串即判为注入。
_Avoid_: nonce、token、盐

**审核记录**：
一次审核的不可变摘要，落在 `.dsh-web/reviews/<pr>-<sha>.json`，只存 diff 的哈希与长度，不存全文。
_Avoid_: 审计日志、review log

**审计记录**：
`scripts/pipeline/audit-subagents.mjs` 产出的子代理执行合规日报，与「审核记录」是两回事。
_Avoid_: 审核日志

**熔断**：
连续失败达到阈值后，当天全部回退人工。跨天自动清零，成功一次不清零。
_Avoid_: 限流、断路器

## 子代理

**角色**：
子代理**做什么**：决定权限模式、输出契约、提示词。取值如 `executor` / `reviewer`，可扩展。
_Avoid_: 预设、persona、agent 类型

**接入形态**：
子代理**怎么连**：A 原生（宿主内注册的 provider）、B 委派（外部 CLI 经 ACP 桥）、C 伪模型（网页端点）。三种形态共享同一份契约。
_Avoid_: provider、通道、backend

**provider**：
仅指接入形态 B 内部的具体 CLI（`opencode` / `codebuddy` / `acp`）。形态 A 与 C 没有这一层。
_Avoid_: 模型、厂商、服务商

**输出契约**：
角色声明的结果形状：`text` 表示自由文本，`review-result` 表示必须过 `ReviewResult` schema。
_Avoid_: 输出格式、response schema

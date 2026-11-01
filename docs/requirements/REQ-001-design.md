# REQ-001 实现方案（design spec）

| 项 | 值 |
|---|---|
| 状态 | 已定档（2026-11-01 重写），随 issue #136 入库 |
| 上游需求 | [REQ-001](REQ-001-reviewer-subagent.md)（接入形态）、[REQ-002](REQ-002-qingyan-web-adapter.md)（形态 C 执行层） |
| 承载插件 | `dsh-subagents/`（包名 `dsh-plugin-subagents`），重写替代 `dsh-plugin-product-subagents`；见 [ADR-0001](../adr/0001-不再跟随上游重写-subagents.md) |
| 方向调整 | 由「闸门驱动」改为「会话 + 角色接转」；见 [ADR-0002](../adr/0002-审核由会话委派而非闸门驱动.md) |
| 本文性质 | 实现方案，不含代码 |

本文把 REQ-001 的开放问题与后续追加的架构决策逐条定档，给出可直接照着实现的三样东西：**流程与角色接转**、**契约（schema + 判定行 + 模板）**、**闸门与身份**。

---

## 1. 中心是什么

**流程的中心是会话，不是闸门。**

```
控制面会话（DSH）
  │  开 issue → 建 worktree → 委派开发
  ├─► @executor ─ 改代码 / 跑门禁 / 开 PR
  │
  ├─► @reviewer ─ 读 issue + PR + diff（带工具，能自己翻仓库）
  │     ├─ 有问题 → 写 PR comment（含第 N 次/共 3 次）→ CHANGES_REQUESTED
  │     │            → 委派 @executor 修复（任务卡）→ 回到上方再审
  │     └─ 没问题 → 写 PR comment → APPROVED
  │                  → 写审核记录 → 委派 @executor 合并
  │
  └─ 第 3 次审完仍不通过 / ESCALATE / 命中高风险 → 停下叫人
```

闸门（`merge-pr.sh --review-record`）退化成**最后一道校验**：它不再驱动流程，只负责在合并那一刻确认「记录在、判定是 APPROVE、提交没变、没过期、没命中高风险」。

---

## 2. 角色与权限

| 角色 | 能做什么 | 不能做什么 |
|---|---|---|
| 控制面会话 | 开 issue、建 worktree、委派、数轮次、超限时停并叫人 | 不参与判定 |
| `executor` | 改代码、跑门禁、提交、开 PR、**合并**、清理现场 | 不自审、不改 review 结论 |
| `reviewer` | 读代码与 diff、跑只读命令、**写 PR comment、提交 review 状态、写审核记录、委派 executor** | 不改代码、不合并、不碰 CI 配置 |
| 用户 | 高风险路径放行、`ESCALATE` 时裁决、轮次超限时决定 | —— |

**硬约束**：reviewer 与合并动作分离。reviewer 即使被诱导，最大破坏是给一个错误判定，不能自己把代码合进去。

**软约束（靠记录保证）**：executor 不能审自己的修改——这一轮修改交给 reviewer 再审，由 3 轮上限兜住。

---

## 3. 一次审核的生命周期

| 步 | 谁 | 动作 | 产物 |
|---|---|---|---|
| 1 | 控制面 | 组装委派：角色 + 任务卡（含第 N 次） | 子代理会话 |
| 2 | reviewer | 取 PR 元数据、diff、issue 正文 | —— |
| 3 | reviewer | 读代码（可跑只读命令交叉核对） | findings |
| 4 | reviewer | 写 PR comment（模板见 §6） | PR comment |
| 5 | reviewer | 提交 review 状态：`APPROVE` 或 `REQUEST_CHANGES` | GitHub review |
| 6a | reviewer | 若拒绝：写审核记录（`ESCALATE`）→ 委派 executor 修复 | 记录 + 任务卡 |
| 6b | reviewer | 若通过：写审核记录（`APPROVE`）→ 委派 executor 合并 | 记录 + 任务卡 |
| 7 | executor | 合并：`merge-pr.sh <pr> --review-record=<记录>` | 合并 + 清理 |
| 8 | 控制面 | 读记录与 comment，判断进入下一轮还是停下 | —— |

**第 4、5、6 步的顺序不能换**：先写 comment 再提交状态，最后才写记录——记录是「结论已对外可见」之后的存档，不是结论本身。

### 3.1 轮次

- **一轮 = reviewer 审一次**（第一次审就是第 1 轮）；
- 上限 **3 轮**；
- **计数在控制面**：它每委派一次 reviewer 就 +1。reviewer 自己不知道轮次，否则它可以「为了不超限而放行」；
- 第 3 轮仍 `REQUEST_CHANGES` → 控制面停止循环，叫人；
- 轮次写进 **PR comment 与任务卡**（`第 N 次 / 共 3 次`）。

### 3.2 人在哪

人只在三种情况被叫：判定 `ESCALATE`、命中高风险路径、轮次超限。其余全自动。

---

## 4. 接入形态

| 形态 | 谁发起 | 怎么跑 | 一期 |
|---|---|---|---|
| A 原生 | 控制面调 `subagent` 工具 | 宿主内 child agent，**带工具、能读仓库** | ✅ |
| B 委派 CLI | 控制面调委派工具，或 CLI `review --form b` | 插件 spawn `opencode` / `codebuddy` 子进程 | ✅ |
| C 伪模型 | 控制面发起 | 浏览器桥接（依赖 REQ-002） | ❌ 二期 |

**形态 A 只能由会话内的 agent 发起。** `subagent` 工具创建的是带父 agent 的 child agent；CLI 进程没有会话、没有父 agent，因此 `dsh-subagents review --form a` **明确拒绝**并提示改由 agent 发起——不做「假装 A」的实现（用 `ctx.llm` 补全虽然能跑，但它没有工具、读不了仓库，挂同一个名字等于骗人）。

形态 B 保留 CLI 入口，因为 CLI 是被调用的**子代理本体**（`opencode` / `codebuddy` 本身就是 CLI 进程），这条链天然成立。

---

## 5. 判定契约

### 5.1 判定行

```
<NONCE> VERDICT: <APPROVE|REJECT|ESCALATE> SHA: <40 位小写十六进制>
```

- `NONCE`：调用方每次生成，12 位 base32（字母表 `A-Z2-7`）；
- reviewer 必须输出**恰好一行**；
- 解析规则（`dsh-subagents/lib/contract.js` 已实现）：

| 情况 | 结果 |
|---|---|
| 命中 0 次 | `ESCALATE` + `E_PARSE` |
| 命中 ≥2 次 | `ESCALATE` + `E_PARSE` |
| SHA 与请求不符 | `ESCALATE` + `E_SHA_MISMATCH` |
| diff 内出现该 `NONCE` | `ESCALATE` + `E_PARSE`（判定行可能来自被审内容） |

判定与 SHA 写在同一行，是为了让「回显提交」与「给出判定」在物理上不可分离。

**findings 块**：reviewer 还要在判定行之前输出一个 ```json 代码块，供 `record` 提取明细：

```json
{"findings":[{"severity":"blocker","file":"lib/cli.js","line":120,"message":"应报 E_PARSE"}],"evidence":["lib/cli.js:118-124"]}
```

优先级：先解析这个块（`lib/findings.js` 的 `extractFindings`），没有或格式不合法时用 `record --findings <文件>` 兜底；两者都没有不算失败——结论仍有效，只是没有明细。这样「格式没跟上」不会让一次审核整体作废。

### 5.2 `ReviewResult`

单一真源：`dsh-subagents/schema/review-result.json`（文档引用它、代码读它、单测断言它）。

必填：`verdict` / `head_sha` / `nonce` / `findings` / `evidence` / `form` / `model` / `durationMs` / `traceId`；可选 `errorCode`。

相对 REQ-001 §7.2 的增补：**`nonce` 列为必填**。结果不带它，就无法证明这条结果对应哪一次随机标记。

### 5.3 错误码

`E_UNAVAILABLE` / `E_TIMEOUT` / `E_PARSE` / `E_SHA_MISMATCH` / `E_BUDGET` / `E_POLICY`，含义见 §8。

---

## 6. 任务卡与 PR comment（两层，不新增文件类型）

| 产物 | 受众 | 内容 |
|---|---|---|
| **PR comment** | 人、事后追溯 | 判定、第 N 次/共 3 次、findings（必须修 / 建议）、证据（文件:行） |
| **任务卡** | 下一位 agent | 修什么、**不许改什么**、怎么算修好、跑哪条门禁、指针 |

只用 comment 的问题：executor 得从散文里推断边界，最容易发生「顺手重构」。任务卡就是把边界写死。

### 6.1 PR comment 模板

```md
## 审核判定：REQUEST_CHANGES（第 2 次 / 共 3 次）

**提交**：<head_sha>
**形态/模型**：cli / codebuddy/glm-5.3
**耗时**：51s　**traceId**：20261101T021500Z-a1b2c3d4

### 必须修
- `lib/cli.js:120` 判定行重复命中时返回了第一条，应为 `E_PARSE`

### 建议（不阻塞）
- `lib/record.js:44` 熔断日期用本地时区，跨时区协作时有歧义

### 证据
- `lib/cli.js:118-124`
- `test/cli.test.mjs:96`
```

### 6.2 任务卡模板（塞进委派 prompt，≤300 字）

```
角色: executor
目标: 修复 PR #<n> 的审核问题
轮次: 第 N 次 / 共 3 次

边界:
- 只改 comment 里「必须修」列出的位置，不重构、不动无关文件
- 不许改 .github/ 与 scripts/pipeline/

验收:
- node --test dsh-subagents 全过
- 在 PR 里回复改了哪几处（对应 comment 的条目）

指针:
- PR #<n>
- comment <url>
- issue #<n>
```

渲染与校验在 `dsh-subagents/lib/card.js`（`renderCard` / `parseCard`），缺字段直接报错并指出缺哪个。

---

## 7. 闸门（`merge-pr.sh`）在新架构里的位置

| 项 | 规则 |
|---|---|
| 参数 | `--review-record=<文件>` 必填（fail-closed）；`--no-review` / `DSH_REVIEWER=off` 显式跳过并写审计 |
| 顺序 | 定位 PR → CI → 审核闸门 → 合并；闸门排在 `--check-only` **之前** |
| 校验 | 记录存在 → 判定为 `APPROVE` → `head_sha` 一致 → 未超 30 分钟 → 未命中高风险 |
| 退出码 | 恒 1；文案首行 `审核闸门: …` 说清哪项不过 |
| 失败文案 | 原样透出校验器的首行，不套第二层 |

**记录由谁写**：reviewer 在第 4、5 步之后写（`record` 子命令或委派内的等价动作），路径 `.dsh-web/reviews/<pr>-<sha>.json`，**落在主工作区**（工作树会被清理掉）。

**为什么不把闸门当驱动者**：闸门只能回答「能不能合」，回答不了「该谁去改、改完给谁看」。把驱动权交给会话，闸门退回它擅长的位置——一道防线。

---

## 8. 失败、降级与上限

| 场景 | 行为 | 用户可见结果 |
|---|---|---|
| 形态不可用 | `ESCALATE` + `E_UNAVAILABLE`，不重试 | 「审核方不可用，已交回人工」 |
| 超时（A/B 300s） | 重试 1 次，仍超时 → `ESCALATE` + `E_TIMEOUT` | 「审核超时」 |
| 判定行缺失/多义 | `ESCALATE` + `E_PARSE` | 「无法解析判定」 |
| 回显 SHA 不符 | `ESCALATE` + `E_SHA_MISMATCH` | 「判定与提交不匹配」 |
| 变更超预算 | `ESCALATE` + `E_BUDGET`（**不分片**） | 「变更过大，需人工」 |
| 命中高风险路径 | `ESCALATE` + `E_POLICY` | 「高风险变更，需人工」 |
| 连续失败 3 次 | 熔断：当天全部回退人工 | 「审核方熔断」 |
| 3 轮仍不通过 | 控制面停止循环 | 「请人工接管」 |

**不做跨形态自动重试**：换形态重试意味着同一份提交被两套上下文判过，而记录只留最后一条，审计上等于把「谁放的行」抹掉了。

**不分片**：分片会把「一次判定」变成「N 次判定的合成」，每种合成规则都是新的判定语义，会稀释「静默即拒绝」。

---

## 9. 身份与凭据

| 动作 | 身份 | 说明 |
|---|---|---|
| 开 issue / 开 PR / 合并 / 清理 | 主账号 `guraul` | gh 默认配置 + 系统钥匙串 |
| 写 PR comment / 提交 review 状态 | 机器账号 `dsh-bot-guraul` | `GH_CONFIG_DIR=~/.config/gh-reviewer` |

**为什么必须分身份**：GitHub 不允许同一账号 approve 自己的 PR。所有 PR 都由主账号创建，reviewer 用同一身份就永远无法 `APPROVE`。

**macOS 上的坑（2026-11-01 实测）**：

1. 钥匙串里 `gh` 的条目按账号存，但 gh 只按 **active account** 取；辅助身份登录后若不同步切回，主号会读到辅助身份的 token；
2. 修法是 `gh auth switch --user <主号>`——**不需要重新授权**，token 没丢；
3. 辅助身份必须用 `--insecure-storage`，让 token 只落在自己的 `GH_CONFIG_DIR`，不参与钥匙串的 active 指针竞争。

机器账号的注册与 token 申请只做一次（ToS 允许「个人账号 + 一个免费机器账号」）；凭据一律不进仓库、不进对话。

---

## 10. 高风险路径（命中即 `ESCALATE`）

| 路径 | 理由 |
|---|---|
| `.github/` | 改 CI 本身 |
| `scripts/pipeline/` | 改交付流程本身 |
| `AGENTS.md`、`docs/pipeline/` | 改规则与流程文档 |
| `package.json` 的依赖变更 | 供应链风险 |
| 单 PR 增删行数 > 400 | 审核质量下降 |
| 涉及凭据、密钥、部署脚本 | 不可逆风险 |
| `.dsh/profiles/**` | 改宿主装配 |
| `.gitignore` | 改白名单会让文件静默不入库 |

前六条来自 REQ-001 §10.2，后两条为本仓补充。

**预期内的「自我触发」**：新增插件目录的首个 PR 几乎必然命中（要同时改 `.github/`、`scripts/pipeline/`、`.gitignore`，行数也超 400）。不设豁免——新插件正是最该被人看一眼的变更类型。

---

## 11. 记录与审计

| 项 | 规则 |
|---|---|
| 位置 | `.dsh-web/reviews/<pr>-<head_sha>.json`，**主工作区**，不入库 |
| 内容 | 完整 `ReviewResult` + 请求摘要（diff 哈希与长度，不存全文）+ `policy` |
| `traceId` | `<UTC 时间戳>-<8 位随机>`；反查用 `log --trace` 扫目录，不建索引 |
| 幂等 | 键 `(pr, head_sha)`，重审覆盖同名记录 |
| 熔断 | `.dsh-web/reviews/circuit.json`，连续 3 次失败当天熔断，跨天清零 |
| 跳过审计 | `--no-review` 时写 `.dsh-web/reviews/skips/`，供事后查「谁绕过了闸门」 |

---

## 12. CLI 的职责边界

| 命令 | 谁用 | 为什么需要 |
|---|---|---|
| `prepare` | 管线 / reviewer | 组装 `ReviewRequest`（diff 走 git，元数据走 gh） |
| `record` | reviewer | 解析判定、校验 schema、判高风险、写记录 |
| `check` | `merge-pr.sh` | 闸门校验 |
| `log` | 人 | 按 `traceId` 反查 |
| `review --form b` | 可选 | 一条命令跑完 B 形态；B 的子代理本身就是 CLI |
| ~~`review --form a`~~ | —— | **不提供**：没有父 agent，跑不了真 A |

---

## 13. 与 REQ-001 的偏差清单

| REQ-001 原文 | 本文档 | 理由 |
|---|---|---|
| §8.1 形态 A 可带工具 | 保留，但只能由会话内 agent 发起 | CLI 无父 agent；不做「补全冒充 A」 |
| §8.5 失败按 A → B → 人工降级 | 失败即 `ESCALATE`，不跨形态重试 | 跨形态重试会让同一提交被两套上下文判过，审计失真 |
| §9 超预算「尝试分片」 | 不分片，直接 `E_BUDGET` | 分片合成规则是新的判定语义 |
| §7.2 九个必填字段 | 增补 `nonce` | 结果不带它无法对标记 |
| §5 reviewer「不写 PR」 | reviewer **写 comment、提交 review 状态**，但仍不改代码、不合并 | 会话驱动需要 reviewer 对外表达结论 |
| §10.2 六条高风险路径 | 增补 `.dsh/profiles/**` 与 `.gitignore` | 本仓真实踩过 |
| 三种形态全支持 | 一期 A、B；C 延后 | C 依赖 REQ-002 |

---

## 14. 验收映射

| 验收 | 一期怎么验 |
|---|---|
| 三种形态产出同一份 `ReviewResult` | A 与 B 各跑一次同一 PR，两份记录都过 schema 校验 |
| 判定与提交绑定 | 构造 SHA 不符 → `E_SHA_MISMATCH`，`merge-pr.sh` 拒绝 |
| 异常不等于通过 | 构造超时 / 畸形回复 / 不可用 → `ESCALATE`，闸门拒绝 |
| 判定不可伪造 | diff 内注入同一 nonce → `E_PARSE` |
| 高风险强制人工 | 构造 `.github/` 变更，模型判 APPROVE 也不放行 |
| 3 轮上限 | 构造三连拒绝，控制面在第 3 轮后停止并叫人 |
| 身份分离 | 机器账号能 `APPROVE`，主账号不能 |
| 关开关回人工 | `--no-review` 合并一次，审计留痕 |

---

## 15. 二期

| 项 | 说明 |
|---|---|
| 形态 C | 依赖 REQ-002 的桥接；不可用时 `ESCALATE` |
| executor 的 ACP 续接 | 一期 B 形态是一次性调用；续接与中断语义二期补 |
| 分片审核 | 需要先定义多份判定如何合成 |
| 低风险自动合并 | 开关已留，需先有命中率数据 |
| 全局改名 `product_*` → `subagent_*` | executor 迁完后单独做 |

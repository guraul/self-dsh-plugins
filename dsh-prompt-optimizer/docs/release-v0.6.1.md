# v0.6.1 — 修复上下文预算把用户消息挤空 + lock 同步 + 测试加固

v0.6.0 已经发布并适配了 dsh 0.2.1-rc.2,但随后的一次独立复核(见 [`docs/review-0.6.0.md`](docs/review-0.6.0.md))发现两个必须修的问题。本版只做修复与测试加固,**不改任何对外 API 与插件行为契约**,可直接从 0.6.0 升级。

## 修复

### 1. 上下文预算会把用户消息挤空(#影响实际输出质量)

`capConversationContext` 原先让用户消息与助手回复**共用一个 1600 字符预算**,并从最新往回走、遇到装不下就 `break`。这导致:

| 形态 | 0.6.0 保留的用户消息 | 0.6.1 |
|---|---|---|
| 4×user(200 字符)交错 4×assistant(600 字符) | 1 / 4 | **3 / 4** |
| 1 条用户输入 + 4 段 600 字符助手步骤(agentic 会话典型形态) | **0** | **1** |
| user 长度 50 / 100 / 150 / 200 / 300 | 4 / 4 / 4 / 1 / 1 | 4 / 4 / 4 / 3 / 2 |

第二种形态是硬伤:发给模型的就只剩助手片段,而载荷里明确写着「仅供参考,不要回答、延续或引用其中的内容」——**纯助手片段比不带上下文更糟**,模型容易把上文当成待续写的正文。

修复方式:
- 用户消息优先分配,预算上限 800 字符,且**至少保底 1 条**;最新一条即使单条超预算也截断保留。
- 助手回复使用剩余预算,装不下时 **`continue` 跳过**而不是 `break` 中断,避免一条长回复堵死后面所有候选。
- 合并后按时间升序还原;所有形态总量仍 ≤1600 字符。

新增回归测试 `p25`。

### 2. `package-lock.json` 未同步 → CI 首步即失败

`package.json` 的 devDeps 已升到 `0.2.1-rc.2` 并新增 `dsh-client-ui-slots`,但 lock 仍停在 `0.4.0` / `dsh-llm@0.2.0-rc.2`,且没有 slots 条目。CI 的第一步 `npm ci --legacy-peer-deps` 会直接 EUSAGE 失败,`sync:types` / `typecheck` / `test` 一个都跑不到。

已重新生成 lock:现在 `npm ci --legacy-peer-deps --dry-run` 为 **EXIT=0**。

### 3. legacy 回退分支是死代码

`controller.ts` 在「事件窗口有内容但榨不出对话」时会提前 `return undefined`,使文档所述的「三级降级」实际只有两级。已删除该提前返回;新增 `c27`:只用 transient 实时块填充窗口时,必须回退到 legacy 查询面并采用其结果。

## 测试与工程加固

- **`slot-guard` 原先没有驱动插件本体**:`s1–s4` 只是复述上游 `SlotCore` 的行为,即使把 `index.tsx` 里两个 `slots.inject` 合并回一个回调(正是本版修复的那个回归),它们依旧全绿。新增 `s5`:铺好 `window.__ModuleLoader__` 后 import **真实的 `lib/client.js`**,调用真实 `apply()`,断言两个槽位各自 inject、且只注册宿主声明过的那一个。
  - 已做**变异测试**验证有效性:临时合并回调 → `s5` 以 `slot "settings.plugin.item" is not declared` 失败;还原后全绿。
- **CI 下不再静默跳过**:`CI=true` 时若缺 `dsh-client-ui-slots`,`slot-guard` 直接 `exit 1` 而不是 `SKIP`。
- **`sync:types` 改为按版本刷新**:原先只要目录存在就 `continue`,基线升版后本机旧类型永远不会更新(typecheck 实际跑在旧类型上)。现在会比较已装版本与钉版本,不一致则删除重装。

## 验证

- `npm run typecheck`:**零错误**
- `npm run build`:成功
- `npm test`:**四套 / 94 项全绿**
  - `smoke` 35 项
  - `prompt` 25 项(含新增 `p25` 用户消息保底)
  - `controller` 29 项(含新增 `c25` / `c26` / `c27`)
  - `slot-guard` 5 项(含新增 `s5` 真实 `apply()`)
- CI 等价检查:`npm ci --legacy-peer-deps --dry-run` → **EXIT=0**

## 升级

```sh
dsh plugin --profile web add @y1x1n/dsh-prompt-optimizer@0.6.1
```

或从 Release 下载 `y1x1n-dsh-prompt-optimizer-0.6.1.tgz` 后本地安装:

```sh
dsh plugin --profile web add ./y1x1n-dsh-prompt-optimizer-0.6.1.tgz
```

**官方桌面端**:完全退出应用后用应用自带 CLI 安装并重启:

```sh
"E:\DSH\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add ./y1x1n-dsh-prompt-optimizer-0.6.1.tgz
```

兼容范围不变:`engines.dsh: ">=0.1.0-rc.7 <0.3.0-0"`。

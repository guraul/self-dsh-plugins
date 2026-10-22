# v0.6.0 — 适配 dsh 0.2.1-rc.2 + 会话上下文真正可用 + 设置页注册修复

本版针对 DeepSeek Harness **0.2.1-rc.2** 做适配。调研方式是把桌面端 `resources/app.asar` 里随包发布的 0.2.1-rc.2 运行时逐项核对,并与 npm 上 `@deepseek-ai/*@0.2.0-rc.2` / `@0.2.1-rc.2` 的类型与实现双向对读(完整记录见 [`docs/dsh-021-diff.md`](docs/dsh-021-diff.md))。

**结论先行**:0.2.1-rc.2 对本插件**没有编译层面的破坏**(换上 0.2.1 全量类型后 `tsc --noEmit` 零错误),但有一处**运行期必崩**的隐患和一处**长期静默失效**的功能,本版一并修复。

## 主要变更

### 修复:0.2.1 上设置页注册会抛未捕获异常(#必崩)

`settings.plugin.item` 槽位在 0.2.1-rc.2 已被上游**彻底移除**——在 `app.asar` 里的全部运行时 bundle 与 npm 包中检索该字符串均为 0 命中。而 `SlotCore.register` 对未声明槽位是**同步抛错**:

```
slot "settings.plugin.item" is not declared (a parent entry's children table must declare it)
```

旧实现把 `settings.plugins.tab`(0.2.x)与 `settings.plugin.item`(0.1.x)两个注册放进**同一个** `slots.inject` 回调。该回调只要**其中一个**槽位被声明就会触发,于是在 0.2.1 上会「先成功注册 tab、紧接着注册 item 时抛错」;更糟的是 `slots.inject` 捕获回调异常后会走 `queueMicrotask(() => { throw failure })`,把它变成**页面级未捕获异常**。

本版改为**两个槽位各自独立 inject**:未声明的那个只跳过自己,不影响另一个。新增 `test/slot-guard.test.mjs`,直接 import 上游真实的 `SlotCore` 固化这条边界——既证明旧写法确实抛错(防止上游将来改成静默忽略后本测试失去意义),也证明修复后两种宿主形态都安全。

### 修复:「携带会话上下文」在 0.2.x 上真正生效(#长期静默失效)

`connection.api.sessions.history` 这一旧查询面**上游从未实现过**(0.1.0-rc.7 → 0.2.1 全线都不提供),所以 v0.5.0 及更早的「优化时携带会话近期对话」实际一直在静默降级——设置页的开关看起来是开的,但发出去的请求里 `context` 恒为 `undefined`。

0.2.0/0.2.1 提供了真正的读取面:**会话事件窗口**

```ts
ctx.sessions.binding(sessionId).eventSource.getSnapshot().entries
// → readonly ({ type: 'event', event: SessionEvent } | { type: 'transient', … })[]
```

宿主在打开会话时已把尾部页灌进这个窗口(`HISTORY_PAGE_OPTIONS = { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }`),`loadOlder()` 再向前翻页;条目形状与旧路径完全一致,因此现有的 `extractContextTurns` 直接复用(仍按 `source.kind === 'user'` 过滤掉插件/运行时注入的消息,仍只采样最近 4 条用户输入 + 4 条助手回复并过预算收敛)。

**为什么不用 `session/page` RPC**:它虽然存在,但 `throughSeq` 是必填的、且必须来自 follow 开场帧;冷调用传 `-1` 会被宿主 `paginate()` 算成 `end = 0`,返回**空页**。用它反而会让上下文一直为空,所以刻意不采用(该结论已写进 `host-faces.ts` 的注释与 `docs/dsh-021-diff.md`)。

降级阶梯:事件窗口 → legacy 查询面 → 无上下文。`ctx.sessions` 走**独立可选 inject**,0.1.x 宿主没有该服务时不会阻塞客户端就绪。

### 修复:设置卡文案不再提「内存模式」

`ConfigFormSnapshot` 在 0.2.1 删除了 `mode: 'host' | 'memory'`(以及构造函数的 `persistence` 参数)——**内存模式不复存在**,设置总是宿主持久化。原先两句文案(「当前连接不可写设置(远程页面为内存模式)」「当前为内存模式:设置不会持久化」)已不成立:

- `settings.unavailable` 改写为「宿主未向此页面开放该设置命名空间」;
- `settings.memoryOnly` → `settings.readOnly`(「宿主拒绝写入,改动不会保存」),用于 `writable === false`。

### 新增:`package.json` 声明兼容范围

```json
"engines": { "node": ">=18", "dsh": ">=0.1.0-rc.7 <0.3.0-0" },
"dsh": { "manifestVersion": 1, "bundle": { "patch": "./cordis.patch.yml" }, "client": { … } }
```

0.2.1 起 `dsh-app-boot` 会在启动期用 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 校验 `engines.dsh`,不满足直接拒绝加载 bundle 层。所选区间经实测覆盖 0.1.0-rc.7 一直到 0.2.2,同时**排除** `0.3.0-rc.1` / `0.3.0`(尾界写成 `<0.3.0-0` 才挡得住 prerelease)。`manifestVersion: 1` 是 0.2.1 声明的清单格式版本。

### 维护:类型基线与类型同步脚本

- `devDependencies.@deepseek-ai/dsh-llm`:`0.2.0-rc.2` → **`0.2.1-rc.2`**
- `scripts/sync-types.mjs` 里 19 个钉版本包全部升到 `0.2.1-rc.2`,保证 CI 与本地一致
- 本地 `node_modules` 里原先残留的 13 个 0.2.0-rc.2 类型包同步升到 0.2.1-rc.2 后重跑 typecheck
- `package-lock.json` 重新生成(此前停在 0.4.0,会让 CI 的 `npm ci` 直接失败)
- `sync:types` 改为**按版本**刷新:原先只要目录存在就跳过,基线升版后本机旧类型永远不会更新

## 独立复核后修复的问题

本轮改动经过一次独立复核(见 [`docs/review-0.6.0.md`](docs/review-0.6.0.md)),发现并修复了两个阻塞问题:

### 用户消息会被长助手回复挤空(#上下文实际质量)

新增的「按角色分预算」之前,`capConversationContext` 让用户消息与助手回复**共用一个 1600 字符预算**,并从最新往回走、遇到装不下就 `break`。实测两种典型形态:

| 形态 | 修复前保留的用户消息 | 修复后 |
|---|---|---|
| 4×user(200 字符)交错 4×assistant(600 字符) | 1 / 4 | **3 / 4** |
| 1 条用户输入 + 4 段 600 字符助手步骤(agentic 会话) | **0** | **1** |

第二种形态是硬伤:发给模型的就只剩助手片段,而载荷里明确写着「仅供参考,不要回答、延续或引用其中的内容」——**纯助手片段比不带上下文更糟**,模型容易把上文当成待续写的正文。

修复:用户消息优先分配(上限 800 字符,且**至少保底 1 条**,最新一条即使超预算也截断保留);助手回复用剩余预算,且装不下时 `continue` 跳过而不是 `break` 中断。所有形态总量仍 ≤1600 字符。

### 其它复核项

- **`package-lock.json` 未同步** → 已重新生成,`npm ci --legacy-peer-deps --dry-run` 从 EXIT=1 变为 **EXIT=0**。
- **legacy 回退分支是死代码**:窗口有内容但榨不出对话时会提前 `return undefined`,导致文档写的「三级降级」实际只有两级。已删除该提前返回。
- **`slot-guard` 原先没有驱动插件本体**:只复述上游 `SlotCore` 行为,即使把两个 `inject` 合并回去也照样全绿。现新增 `s5`,加载**真实 `lib/client.js`** 并调用真实 `apply()`;已做变异测试确认它能抓到该回归。
- **CI 下不再静默跳过** `slot-guard`(缺依赖时 `CI=true` 直接失败)。

## 验证

- `npm run typecheck`:**零错误**(在 0.2.1-rc.2 全量类型下)
- `npm test`:**四套 / 94 项全绿**
  - `smoke`(Host 半,真实 cordis `Context` + mock llm/httpServer)· 35 项
  - `prompt`(提示词/解析/预算)· 25 项,新增 `p25` 用户消息保底
  - `controller`(客户端状态机)· 29 项,本版新增 `c25` 事件窗口取上下文、`c26` 无窗口安静降级、`c27` 窗口无对话时回退 legacy
  - `slot-guard`(本版新增)· 5 项,`s1–s4` 对真实 `SlotCore` 断言槽位边界,`s5` 驱动真实 `apply()`
- CI 等价检查:`npm ci --legacy-peer-deps --dry-run` → EXIT=0
- 上游事实核对(全部对 0.2.1-rc.2 真实产物):
  - `settings.plugin.item` 全库 0 命中 → 旧写法必抛
  - `settings.plugins.tab` 存在(`dsh-client-ui-settings-plugins`)
  - `ctx.sessions` 由 `dsh-api-session-controller` 提供(`rootCtx.reflect.provide("sessions", …)`),0.2.0 亦有
  - `eventSource` 为 `ObservableSnapshot<SessionEventWindow>`,`entries` 含 `{type:'event', event}`
  - Web 端真实用户消息 `source.kind === 'user'`,运行时注入为 `'runtime-context'`
  - `session/page` 的 `paginate()` 在 `throughSeq = -1` 时 `end = 0`(空页)

## 兼容性

| dsh 版本 | 优化路由 | 设置页 | 发送栏 / 面板 | 会话上下文 |
|---|---|---|---|---|
| **0.2.1-rc.2**(Web + 官方桌面端) | ✅ | ✅ | ✅ | ✅ 新增 |
| **0.2.0-rc.2**(Web + 官方桌面端) | ✅ | ✅ | ✅ | ✅ |
| 0.1.5-rc.2 / 0.1.5-rc.1 | ✅ | ✅ | ✅ | 降级 |
| 0.1.2-rc.1 / 0.1.2-alpha.5 | ✅ | ✅ | ✅ | 降级 |
| 0.1.1-rc.2 及以下(0.1.0-rc.7+) | ✅ | ✅ | ✅ | 降级 |
| ≥ 0.3.0 | — | — | — | `engines.dsh` 拒绝安装(显式放弃) |

## 升级注意

- **必须升级到 v0.6.0 才能在 0.2.1-rc.2 上正常打开设置页**:旧版本在 0.2.1 上会在挂载设置页时抛未捕获异常。
- 旧 profile 里装的 0.3.x/0.4.x/0.5.x 都不含本版修复,`dsh plugin --profile <profile> list` 确认版本后升级,并重启宿主 / 刷新页面。
- 若之前在设置里关掉过「携带上下文」,本版行为不变(仍不读取任何会话材料);打开后**现在会真的带上近期对话**——这是行为变化,首次使用可留意输出是否更贴合语境。
- `engines.dsh` 声明后,在 0.3.x 上安装会被宿主拒绝;如确需试用,可在 profile 的 `compatibility.json` 里按宿主提示授予该 `插件@版本 × 运行时版本` 的豁免。

## 安装

```sh
dsh plugin --profile web add @y1x1n/dsh-prompt-optimizer
```

或从 Release 下载 `y1x1n-dsh-prompt-optimizer-0.6.0.tgz` 后本地安装:

```sh
dsh plugin --profile web add ./y1x1n-dsh-prompt-optimizer-0.6.0.tgz
```

**官方桌面端**:完全退出应用,用应用自带 CLI 安装并重启动(Windows 示例):

```sh
"E:\Deepseek-Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add ./y1x1n-dsh-prompt-optimizer-0.6.0.tgz
```

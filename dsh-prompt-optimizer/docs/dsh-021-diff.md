# DSH 0.2.0-rc.2 → 0.2.1-rc.2 差异调研(插件面向面)

调研对象:`E:\DSH\resources\app.asar`(desktop-runtime **0.2.1-rc.2**,cordis 4.0.5)+ npm 上 `@deepseek-ai/*@0.2.0-rc.2` 与 `@0.2.1-rc.2` 的 tarball 类型与运行时代码对读。

结论先行:**本插件在 0.2.1-rc.2 上不会崩**(类型编译零错误、槽位契约、RPC 通道、LLM 契约全部兼容),但有 5 处需要跟进:2 处「新增能力应当用起来」、3 处「旧代码路径已死/文案已过时」。

---

## 1. 汇总表

| 面向面 | 0.2.1-rc.2 状态 | 对本插件的影响 | 处置 |
|---|---|---|---|
| `slots.register` / `SlotMap` / `PropsRuntime` | **加法** | 无破坏 | 无需改 |
| `conversation.input.right` / `conversation.input.dock`(list, session scope) | 不变 | 无 | 无需改 |
| `SlotEntryDef.inline?: true`(新增) | **加法** | 无 | 可选使用 |
| `configForms.get(entryId)` 快照 `{status,value,writable,...}` | 不变 | 无 | 无需改 |
| `ConfigFormSnapshot.mode`(`'host' \| 'memory'`) | **删除** | 我们的 `SettingsSnapshot` 只读 `status/value/writable`,未引用 `mode` | 无需改代码;**文案需改**(见 §4.2) |
| `connections.rpc.call(channel, endpoint, payload, signal)` | 不变(仍 `POST /api/<endpoint>`) | 无 | 无需改 |
| `modelDirectories.directoryFor(id).load()` | 不变 | 无 | 无需改 |
| `settings.configure({auto:false})` | 不变 | 无 | 无需改 |
| `settings.installSection` / `settings.register` | **0.2.0 起已不存在** | 既有代码是能力探测,探测失败即跳过 | 保留(向后兼容老宿主) |
| `settings.plugin.item` 槽位 | **0.2.1 全库已无此字符串** | 既有 `slots.register` 打在这个名字上会被 `SlotCore` 抛 `slot "..." is not declared` | **必须改**:该注册移入 `slots.inject` 守卫内 |
| `GenerateOptions.sessionId` / `purpose` | 不变 | 无 | 无需改 |
| `LlmRuntime.stream()` / `listProviders()` / `listModels()` / `resolveModelInfo()` | 不变 | 无 | 无需改 |
| `LlmReasoningEffortInfo.efforts` | **语义变化**:0.2.0 是「适配器偏好顺序」,0.2.1 明确为「从低到高的可选强度顺序」 | 我们本来就是按名字序数解析最低档(不依赖顺序)→ 更安全了 | 无需改,注释可更新 |
| `LlmRuntime.prepareCall(config, signal, configure?)` | **加法**(可选第三参) | 我们只用 `stream()`,未用 `prepareCall` | 无需改 |
| `dsh.manifestVersion` / `engines.dsh` / `icon` | 0.2.1 **新增并在启动时强制校验** | 我们两个字段都没有 → 不校验,等于「全版本兼容」 | **建议补**:声明 `manifestVersion: 1` + `engines.dsh` |
| `dsh.client.external` | 新增声明位 | 我们 client bundle 只 `require("react")`/`react/jsx-runtime`,两者都在隐式 baseline 内 | 无需改(可显式声明以求稳) |
| V8 inspector / `invariant` 伴生插件 | `lib/invariant.js` 在 llm/session/tools/renderer 中被删除 | 我们未引用 | 无需改 |
| `SessionSnapshot` 契约 | **逐字节相同** | `useSession(s => s).running` / `.queue` 仍成立 | 无需改 |

---

## 2. 逐项证据

### 2.1 槽位注册:未声明槽位会 **同步抛异常**

`@deepseek-ai/dsh-client-ui-slots@0.2.1-rc.2` `lib/index.js:165`(0.2.0 同位置同代码):

```js
register(options, component) {
    const rec = this.records.get(options.name);
    if (!rec?.spec) throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`);
```

而 `settings.plugin.item` 在 0.2.1 的**全部运行时 bundle 中检索为 0 命中**:

```
Get-ChildItem node_modules\@deepseek-ai -Recurse -Filter *.js | Select-String "plugin\.item"   →   无输出
```

`settings.plugins.tab` 仍然存在,见 `dsh-client-ui-settings-plugins/lib/client.js:69/125/179/202`:

```js
children: renderSlot("settings.plugins.tab", {}, { only: single.id })
...
const version = ctx.slots.getVersion("settings.plugins.tab");
tabs = ctx.slots.entries("settings.plugins.tab").map((entry) => ({
  id: entry.options.id ?? "", order: entry.options.order ?? 0,
  label: resolveSlotLabel(entry.options.label) ?? ""
})).sort((a, b) => a.order - b.order);
```

**风险**:`src/client/index.tsx` 里 `mountSettingsCard()` 无条件注册了两个槽位——

```ts
settingsDisposers = [
  slots.register({ name: 'settings.plugins.tab', ... }, card),
  slots.register({ name: 'settings.plugin.item', key: SETTINGS_ENTRY_ID }, card),
]
```

在 0.2.1 上,数组第一个注册成功,第二个**抛错**;抛错发生在 `slotsAny.inject('settings.plugins.tab', () => mountSettingsCard(ctx))` 的回调里 → 设置页挂载时抛异常。这正是必须修的点。

### 2.2 设置持久化模式已取消(`mode: 'host' | 'memory'` 删除)

`dsh-client-ui-settings` types diff:

```diff
 export interface ConfigFormSnapshot<T> {
-    /** Whether the Host document accepts writes; memory mode never does. */
+    /** Whether the Host document accepts writes. */
     writable: boolean;
-    /** `host` syncs with the Host document; `memory` keeps a remote browser process-local. */
-    mode: 'host' | 'memory';
 }
```

且 `ConfigForms` / `SettingsDescribeMirror` 构造函数里的 `persistence` 参数被整体删除(`constructor(ctx, spec, mirror, persistence, schema)` → `constructor(ctx, spec, mirror, schema)`)。

**风险**:本插件 `settings-face.ts` 的结构面只取 `{status, value, writable}`,**不受影响**;但 `i18n.ts` 里的两句文案(`settings.unavailable` 提到「远程页面为内存模式」、`settings.memoryOnly` 提到「当前为内存模式:设置不会持久化」)在 0.2.1 上已不成立 → 文案需改。

### 2.3 `ConnectionHandle` / RPC 通道:纯加法

`dsh-client-connection` 0.2.1 新增 `interactions`、`openWebSocket(path)`、`createWebSocket` 工厂、`client.node.js` / `client.browser.js` 双载体;`rpc` 成员与 `call` 签名不变。

`lib/client.browser.js:1213`:

```js
async call(channel, endpoint, payload, signal) {
    assertTarget(channel, endpoint);
    ...
    const response = await send(`${channel}/${endpoint}`.slice(1), { method: "POST", ... })
```

`dsh-api-gateway/lib/index.js:1457/1465` 仍要求 `payload` 是「恰好一个纯对象 `args`」:

```
typert gateway: Remote event result requires exactly one ... args
```

→ 我们 `sessionCatalog()` 发的 `{ args: {} }` 仍然正确。

### 2.4 `modelDirectories` 服务:不变

`dsh-client-ui-model-selection/lib/client.js:987/1000/1026`:

```
/** The `ctx.modelDirectories` session model-selection service. */
super(ctx, "modelDirectories");
...
directoryFor(sessionId) { ... }
```

### 2.5 LLM 契约:仅加法

- `GenerateOptions` 字段集**逐字段相同**(provider/model/reasoningEffort/messages/system/tools/toolHistory/temperature/maxTokens/stop/signal/sessionId/purpose);`purpose` 的注释改为「模型不可见的传输元数据」,不含生成策略。
- `LlmRuntime.stream()` 实现不变(`streamWithRegistration` → `waterfall("llm/stream") → adapterStream`)。
- `prepareCall` 新增**可选**第三参 `configure`,我们没用它 → 无影响。
- `efforts` 注释:`adapter-preferred display order` → **`least to greatest selectable reasoning effort`**。我们按名字序数解析(注释里已解释为何不信顺序),此变化让我们更安全。

### 2.6 打包清单:新增并在启动时**硬校验**

`@deepseek-ai/dsh-package-manifest@0.2.1-rc.2` 新增 `manifestVersion`、`engines.dsh`、`icon`。启动期校验在 `dsh-app-boot/lib/index.js:280-312`:

```js
const engines = ...;
if (Object.hasOwn(engines, "dsh")) {
    const range = engines.dsh;
    return satisfies(runtimeVersion, range, { includePrerelease: true }) ? {} : { "engines.dsh": range };
}
if (!Object.hasOwn(fields, "peerDependencies")) return {};
// 否则逐个校验 @deepseek-ai/dsh / @deepseek-ai/dsh-* peer
```

不满足时 `lib/index.js:1026` 直接 `throw`(bundle 层)或产出 warning(非 bundle 行)。**没有 `engines.dsh` 也没有 dsh-* peer 时恒通过**——这是当前状态,也是它能在 0.2.0/0.2.1 上都能装的原因。

`semver.satisfies` 用 `includePrerelease: true`,实测(range 见下)能够正确覆盖 0.2.1-rc.2:

```
RANGE ">=0.2.0-rc.2 <0.3.0"   (includePrerelease)
    0.2.0-rc.2   true
    0.2.0        true
    0.2.1-rc.2   true
    0.2.1        true
    0.2.2        true
    0.3.0        false
```

### 2.7 客户端模块装载:baseline 隐式外部

`dsh-web-frontend/dist/assets/index-*.js` 的 `staticModules`:

```js
function SZ(){return{react:sC,"react/jsx-runtime":uC,"react-dom":mC,"react-dom/client":yC,
"@deepseek-ai/cordis":Fb,zod:Zj,"@tanstack/react-virtual":Yj,
"@deepseek-ai/dsh-client-store":wI,"@deepseek-ai/dsh-client-ui-slots":SI,
"@deepseek-ai/dsh-client-ui-primitives":zU,"@deepseek-ai/dsh-client-ui-dockkit":xZ}}
```

我们的 `lib/client.js` 只 require `react` 与 `react/jsx-runtime` → 均在 baseline 内,无需 `dsh.client.external`。

### 2.8 `SessionSnapshot`:逐字节相同

`dsh-api-session-controller@0.2.0-rc.2` 与 `@0.2.1-rc.2` 的 `client/contract/snapshot.d.ts` SHA-256 相同(`917110BD…FCB796`),`running` / `queue` 未变。

---

## 3. 会话历史上下文:两代宿主都拿不到

`src/client/controller.ts` 取上下文走 `legacyQueryFace(ctx.connection)?.sessions?.history`,该面在上游**从未发布**,0.2.1 依旧没有。因此「携带会话近期对话」在 0.2.x 上一直是静默降级(按无上下文优化),而设置页开关看起来能开。这是本轮要补的**功能缺口**。

0.2.1 提供的替代路径(已核实存在):

- `ctx.conversation`(`ConversationController`,`dsh-client-ui-conversation`):`input`、`blocks`、`send`、`updateQueue`、`cancel`、`loadOlder` —— **没有**读取历史的公开方法。
- `useConversation(selector)`(session scope 标准 hook)返回 `ConversationSnapshot = { views, activeTargets }` —— **不含消息**。
- `ctx.sessions`(`ISessions`,`dsh-api-session-controller/client`):含 `history` 相关 RPC,但 `history` 面属于 **controller 侧**,插件可直接用 `ctx.connection.rpc.call('/api', ...)` 触达 `session/history` 端点。

结论:上下文应改走 `session/history` RPC(args 形状与 `ISessions` 声明一致),并保留现有降级路径。

---

## 4. 待办清单(按文件)

### 4.1 `src/client/index.tsx` — 修掉 0.2.1 必抛的注册

把两个槽位拆成各自独立的 `slots.inject` 守卫,各自注册,任一槽位未声明都不影响另一个:

```ts
slotsAny.inject('settings.plugins.tab', () => { /* 只注册 tab */ })
slotsAny.inject('settings.plugin.item', () => { /* 只注册 item(0.1.x) */ })
```

理由:`inject` 回调只在宿主**声明了该槽位**时触发;把两个注册放进同一个回调,等于要求两者同时存在。

### 4.2 `src/client/i18n.ts` — 文案跟随 0.2.1

- `settings.unavailable` / `settings.memoryOnly` 不再提「内存模式」。
- 新增一句「当前版本设置只读」用于 `writable === false`。

### 4.3 `src/client/controller.ts` — 上下文取真实会话历史

- 新增 `session/history` RPC 读取(沿用现有 `withParentCwd` 思路的降级:失败即无上下文)。
- 保留 legacy 面作为最后回退。

### 4.4 `package.json` — 声明兼容性

```json
"engines": { "node": ">=18", "dsh": ">=0.2.0-rc.2 <0.3.0" },
"dsh": {
  "manifestVersion": 1,
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "inject": [...] }
}
```

### 4.5 `scripts/sync-types.mjs` — 类型钉版升到 0.2.1-rc.2

`PACKAGES` 里的 `0.2.0-rc.2` 全部改成 `0.2.1-rc.2`,`devDependencies` 里的 `@deepseek-ai/dsh-llm` 同步。

---

## 5. 兼容性矩阵(实测/推演)

| 宿主版本 | Host 半 | Client 半 | 说明 |
|---|---|---|---|
| 0.1.0-rc.7 ~ 0.1.5 | ✅ | ✅ | 走 `settings.register` / `settingsScope` 老路径 |
| 0.2.0-rc.1/rc.2 | ✅ | ✅ | `configForms` + `settings.plugins.tab` |
| **0.2.1-rc.2** | ✅ | ✅(修 4.1 后) | `settings.plugin.item` 已彻底移除 |
| ≥ 0.3.0 | ❓ | ❓ | `engines.dsh` 会拒绝安装,属显式放弃 |

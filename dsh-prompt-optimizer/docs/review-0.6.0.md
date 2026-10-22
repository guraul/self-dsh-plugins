# v0.6.0 适配审查(独立复核,DSH 0.2.0-rc.2 → 0.2.1-rc.2)

审查对象:HEAD `9945523 feat: 适配 dsh 0.2.1-rc.2 (v0.6.0)`(`git diff HEAD~1 HEAD`,15 个文件,+843/−90)。
审查方式:读改动源码 + 读**上游真实产物**(`node_modules` 里 0.2.1-rc.2 的 `dsh-client-ui-slots` / `dsh-client-ui-renderer` / `dsh-api-session-controller` / `dsh-client-ui-settings[-plugins]` / `dsh-session` / `dsh-llm`,以及 `dsh-app-boot` 0.1.5 / 0.2.0 / 0.2.1 三个 tarball,桌面端 `app.asar` 字节级扫描)+ 实际跑命令。
本文件是**独立复核**,不改动任何源码/测试/package.json。

## 结论:**REQUEST CHANGES**

两个阻塞问题,都不是"设计错了",而是**本版自己引入的可验证缺陷**:
1. `package-lock.json` 没跟着 `package.json` 升版 → CI 第一步 `npm ci` 直接 EUSAGE 失败(HEAD~1 是绿的,本版把它弄红了);
2. 新接通的"会话事件窗口"上下文在 `capConversationContext` 里会**把用户消息全部挤出预算**,与代码自己写的"用户消息保底 4 条"相反 —— 而这正是本版新增功能的核心价值。

槽位拆分、`ctx.inject(['sessions'])`、`engines.dsh`、`manifestVersion`、i18n 重命名这几项**经核对无阻塞问题**,见第三节。

---

## 一、阻塞问题

### B1. `package-lock.json` 未同步 → CI `npm ci` 必失败

**位置**:`package-lock.json:3`(`"version": "0.4.0"`)、`package-lock.json:16`(`"@deepseek-ai/dsh-llm": "0.2.0-rc.2"`)、以及整个文件**没有** `node_modules/@deepseek-ai/dsh-client-ui-slots` 条目;对照 `package.json:66-67`(devDeps 已是 `0.2.1-rc.2` + 新增 slots)与 `.github/workflows/ci.yml:22`(`npm ci --legacy-peer-deps`)。

**证据**(用 `git archive` 导出干净副本,避免工作区 `node_modules` 干扰):

```
HEAD    : npm ci --legacy-peer-deps --ignore-scripts --dry-run  → EXIT=1
          npm error `npm ci` can only install packages when your package.json and
          package-lock.json or npm-shrinkwrap.json are in sync.
          Missing: @deepseek-ai/dsh-client-ui-slots@0.2.1-rc.2 from lock file
          Invalid: lock file's @deepseek-ai/dsh-llm@0.2.0-rc.2 does not satisfy @deepseek-ai/dsh-llm@0.2.1-rc.2
          Invalid: ... dsh-brand / dsh-timeout / dsh-typert-protocol / dsh-util-crypto /
                   dsh-util-values / @deepseek-ai/schemastery / zod / cosmokit ...
HEAD~1  : npm ci --legacy-peer-deps --ignore-scripts --dry-run  → EXIT=0
```

即:**上一版 lockfile 是同步的,本版把 devDeps 升到 0.2.1-rc.2 并新增 devDep,却没有重生成 lock**。CI 在 `npm ci` 这一步就死,`sync:types` / `typecheck` / `test` 一个都跑不到。发布侧 `npm pack` 不受影响(`files` 只含 `lib/`、`cordis.patch.yml`、`README.md`),但仓库级 CI 与"贡献者按 README 跑 `npm ci`"全部中断。

**最小修复**:在仓库根执行一次并提交 lock:

```powershell
npm install --legacy-peer-deps --package-lock-only
git add package-lock.json
```

**已验证该修复有效**(在同一 HEAD 干净副本上):

```
npm install --legacy-peer-deps --package-lock-only --ignore-scripts   → INSTALL=0
npm ci --legacy-peer-deps --ignore-scripts --dry-run                  → CI=0
package-lock.json 头部 → "version": "0.6.0"
package-lock.json 新增 → "node_modules/@deepseek-ai/dsh-client-ui-slots" (0.2.1-rc.2)
```

> 说明:本审查**未**代为提交 lock(约束只允许写本 md)。这条必须由作者在合入前补上,否则 CI 全红。

---

### B2. `capConversationContext` 会把用户消息全部挤出预算(与"保底 4 条"承诺相反)

**位置**:`src/prompt.ts:159-161`(预算常量)、`src/prompt.ts:176-187`(预算循环,`break` 在 `:183`);承诺写在 `src/client/controller.ts:95-106`(`sampleContextTurns` 注释:"用户消息优先保底……最近 4 条用户消息 + 最近 4 条助手回复")与 `src/client/controller.ts:108-113`(`extractContextTurns` 注释:"已按共享预算收敛(**用户消息保底 4 条**,总量 ≤8 条 / 1600 字符)")。

**机制**:`sampleContextTurns` 确实取到了 4 user + 4 assistant,但合并后交给 `capConversationContext` 时,单条 assistant 被截到 601 字符;预算循环**从最新往回**放,一旦某条放不下就 `break`(:183),于是"较新的几条 601 字符 assistant"吃掉 1600 预算后,更早的 4 条用户消息一条都进不去 —— 且 user 与 assistant 共用同一预算,没有任何按角色保底。

**实测**(直接调用构建产物 `lib/prompt.js` / `lib/controller.js`,非推测):

| 输入(升序) | 输出 |
|---|---|
| 4×user(200 字)与 4×assistant(600 字)**交错** | `assistant:600, user:202, assistant:600` → **users=1/4**,turns=3 |
| 1×user(短) + 4×assistant(600)(典型 agentic 单轮多步) | `assistant:600, assistant:600` → **users=0** |
| 4×user(50/100/150 字) + 4×assistant(600)交错 | users=2/4 |
| 4×user(5 字) + 2×assistant(600) | users=4/4(预算够,正常) |

即触发条件不是极端构造:**用户每轮粘 200 字以上的草稿**(提示词优化器的典型用法)+ 助手回长代码,就只剩最后一条用户消息;助手步骤再多一点就**一条用户消息都不剩**。

**为什么这是阻塞而不是"调参"**:本版新接通的事件窗口(`host-faces.ts:172-176` → `controller.ts:287-297`)让这条路径**第一次真正拿到数据**;而 `buildUserPayload`(`src/prompt.ts:195-222`)会把 context 放在草稿前面、并明确要求模型"不要回答、延续或引用"。只剩 assistant 片段时,模型拿到的是"没有提问的助手推理",比完全没有上下文更容易带偏 —— 直接反噬本版新增功能。同时它让 `controller.test.mjs` 里"用户消息优先"的设计意图在真实长度下失效(现有测试 `test/prompt.test.mjs:111-133` 只覆盖了"全是 user"和"全是超长 user",没有 user/assistant 混合长度场景,所以是绿的)。

**最小修复**(二选一,建议 A):

A. 按角色分预算,保证用户侧先落地:

```ts
// src/prompt.ts,替换 :176-187 的循环
const users = recent.filter((t) => t.role === 'user')
const assistants = recent.filter((t) => t.role === 'assistant')
const kept: ConversationTurn[] = []
let budget = CONTEXT_MAX_CHARS
// 1) 用户消息从新到旧,至少保证最新一条
for (let i = users.length - 1; i >= 0; i--) {
  const t = users[i]
  if (t.text.length <= budget) { kept.unshift(t); budget -= t.text.length; continue }
  if (kept.length === 0) { kept.push({ role: t.role, text: `${t.text.slice(0, budget)}…` }); budget = 0 }
  break
}
// 2) 剩余预算给助手,从新到旧,放不下就跳过(不是 break)
for (let i = assistants.length - 1; i >= 0; i--) {
  const t = assistants[i]
  if (t.text.length <= budget) { kept.unshift(t); budget -= t.text.length }
}
return kept
```

B. 只做最小改动:把 `:183` 的 `break` 改成 `continue`(放不下的那条跳过,继续看更早的小条目)。实测能把上表第 2 行从 `users=0` 变成 `users=1`,但**不能**恢复 4 条,属于缓解而非修复。

无论选哪个,**补一条回归测试**:`4×user(200 字) + 4×assistant(600 字)` 交错,断言 `turns.filter(t => t.role === 'user').length >= 1`(若采纳 A 则断言 `=== 4`),并断言总量 `<= 1600`。

> 附带小瑕疵(非阻塞):`prompt.ts:182` 的"最新一条超预算"分支产出 `slice(0, budget) + '…'` = **budget+1** 字符,严格说越界 1 字符;`test/prompt.test.mjs:121-123` 正是按 601 断言的,所以这是既有口径,不算新问题。

---

## 二、非阻塞观察(按建议修复优先级排序)

### N1.(高)事件窗口"有内容但无可用条目"时不回退 legacy,且无测试覆盖

**位置**:`src/client/controller.ts:289-292`

```ts
if (entries?.length) {
  const turns = extractContextTurns(entries)
  if (turns.length) return turns
  return undefined          // ← :292 直接返回,不再走下面的 legacy 分支
}
console.warn('... 当前会话没有可读的事件窗口,尝试旧查询面')
```

与同函数 `:283-284` 的注释("历史读取先走……再退回更早宿主的 legacy 查询面")、以及 `:161-164` 的 `getSessions` 文档("缺席时退回 legacy 查询面 / 按无上下文降级")不一致。窗口非空但**全部**是 `transient` / `system/message` / `developer/message` / `tool/result` / `source.kind === 'runtime-context'` 的 user 消息时(流式刚开始、或会话首条就是 agent 注入),会静默放弃上下文。

**为什么定为非阻塞**:上游 0.1.0-rc.7 → 0.2.1 全线**都没有** `connection.api.sessions.history`(`src/client/host-faces.ts:96-103` 自己也这么写),所以今天这两条路径的**可观测结果相同**(都是 undefined),只是"注释/文档承诺的三级回退"与代码实际行为不符,并把一段回退做成了死代码。**最小修**:删掉 `:292`,让 `turns.length === 0` 自然落到 legacy 分支;并在 `test/controller.test.mjs` 补一条 `entries: [{type:'transient', event:{type:'assistant/live-chunk'}}]` + legacy stub,断言 `legacyCalls === 1`(现有 c26 `:740-755` 只测 `binding() === undefined`,覆盖不到)。

### N2.(高)`test/slot-guard.test.mjs` 没有测到插件自己的注册代码

**位置**:`test/slot-guard.test.mjs:36-105`

s1–s4 全部用真实 `SlotCore` **重新实现**了守卫形状(`core.specDynamic(key)` 判断 + 各自 `core.register`),没有 import `src/client/index.tsx` / `lib/client.js`。因此:若有人把 `index.tsx:174-175` 的两行 inject 又合回一个回调、或把 `registerSettingsItem` 里的 `name` 写错,这四条测试**依然全绿**。它固化的是"上游 `register` 会抛错"和"正确写法长这样",不是"本插件当前是正确写法"。

**最小修**(不改运行时):把被测的注册逻辑抽成一个可注入 `slots` 的小函数(或在测试里 `import { apply } from '../lib/client.js'` 并用假 `ctx`/假 `slots` 驱动 `apply`),断言"只声明 tab 的宿主上 `register` 恰好被调用 1 次且 `name==='settings.plugins.tab'`";顺带能覆盖"两个都声明"的形态。

### N3.(中)`scripts/sync-types.mjs` 跳过已存在的 node_modules 目录,基线升级后不会替换旧类型

**位置**:`scripts/sync-types.mjs:59-61`

```js
const target = join(nmDir, shortName)
if (existsSync(target)) continue
```

本版把 `PACKAGES` 全部升到 `0.2.1-rc.2`,但只要 `node_modules/@deepseek-ai/<name>` 里还是 `0.2.0-rc.2` 就整包跳过。CI 里因为 `npm ci` 会装到 0.2.1 的传递依赖,影响有限;本地/已装环境则可能拿旧类型跑 `tsc`。本机实测仍有 3 个包停在旧版:`dsh-typert-protocol`、`dsh-util-crypto`、`dsh-util-values`(0.2.0-rc.2)。**最小修**:读出 `target/package.json` 的 `version`,与 `PACKAGES[shortName]` 不等就重新 `npm pack` 覆盖;或加 `--force` 开关。

### N4.(中)`slot-guard` 在包缺席时 `process.exit(0)`,CI 会静默丢掉这条测试

**位置**:`test/slot-guard.test.mjs:28-34`

`SKIP` + 成功退出对"只装 dependencies 的精简环境"是合理的,但该包是**已声明的 devDependency**(`package.json:66`),CI 里它必然存在;若某次装包损坏/被裁剪,`npm test` 仍会绿,守卫静默失效。**最小修**:区分 `process.env.CI === 'true'` 时 fail,本地仍 SKIP。

### N5.(低)`sessionEventEntries` 没有校验 `entry.type`,类型声明比实际使用更宽

**位置**:`src/client/host-faces.ts:128-136`(record 的 `type?`/`event?` 都可选)、`:150-156`、`:172-176`

上游窗口条目是判别联合 `{type:'event'} | {type:'transient'}`(`dsh-api-session-controller/lib/types/client/contract/events.d.ts`),插件把它结构化成"可选字段的普通对象",并把 `transient` 条目也交给 `extractContextTurns`。**当前是安全的**(`controller.ts:117-128` 只认 `event.type === 'user/message' | 'assistant/message'`,transient 的 `assistant/live-chunk` 天然被跳过,已实测),但类型名/注释让人以为已经过滤过。**最小修**:在 `sessionEventEntries` 里 `filter((e) => e?.type === 'event')` 并收窄返回类型;或把注释改成"调用方按 event.type 自行过滤"。

### N6.(低)上下文提取无提前退出,窗口满载时有一次性的字符串放大

**位置**:`src/client/controller.ts:114-131` + `src/prompt.ts:168-175`

`extractContextTurns` 对**全部**条目 `flattenText` 并 `join('\n')`,然后才由 `capConversationContext` 截到 600 字符/条。尾部页上限 500 条(`HISTORY_PAGE_OPTIONS.maxMessages = 500`),若会话里有超长单条消息,点击瞬间会构造出远大于最终 payload 的中间字符串。**最小修**:入队前就 `text.slice(0, CONTEXT_TURN_MAX_CHARS)`;或从窗口**尾部**反向扫描,收集到 4 user + 4 assistant 即停。一次性、点击时才发生,故非阻塞。

### N7.(低)若某个宿主同时声明两个设置槽位,会挂出两份设置卡

**位置**:`src/client/index.tsx:151-175`

两个 inject 各自 `createSettingsCard(...)` 并各自 `register`。已核对:副作用只有 `ensureStyles()`(`SettingsCard.tsx:260`,以 `document.getElementById` 幂等短路),订阅发生在组件内部 `useSyncExternalStore`(`:262-265`),所以**不会重复订阅/丢 disposer**;但真有两个槽位的宿主会渲染两个完整卡片。已知宿主都只声明其一(桌面端 `app.asar` 扫描:`settings.plugins.tab` 22 次命中,`settings.plugin.item` **0** 次),故仅记录,不必改。

### N8.(低)文档漂移,建议随本版一并订正

- `docs/dsh-021-diff.md:187-189`、`:213` 仍然把结论写成"上下文应改走 **`session/history` RPC**",而实际实现(且 `:213` 之后的设计)走的是**事件窗口**;`:219` 的示例区间还是 `>=0.2.0-rc.2 <0.3.0`,与 `package.json:27` 的 `>=0.1.0-rc.7 <0.3.0-0` 不一致;`:208` 还在提 `settings.memoryOnly` 这个已删除的 key;`:240` 写"`engines.dsh` 会拒绝安装"。
- `docs/release-v0.6.0.md:52` 的"启动期……不满足直接拒绝加载 bundle 层"经核对**属实**:`dsh-app-boot@0.2.1-rc.2` `loadProfileDirectory`(`lib/index.js:1025-1040`)在 `evaluatePluginCompatibility` 抛错后 `catch` 进 `skippedBundles`,该 bundle 层不参与装载;`:92`/"拒绝安装"也属实(`dsh plugin add` 的 preflight 命中 `preflight.length > 0` 后直接 `rejected(preflight, "nothing was installed")`,桌面端 `app.asar` 内可见同一实现)。**无需修改**,仅在此记录已核对。
- `docs/review-0.6.0.md`(本文件覆盖的旧版)结论为"Approve / 无阻塞",与本复核不一致;本文件即替代版本。

### N9.(低)`manifestVersion: 1` 与 `engines.dsh` 本身没有风险(核对结论)

- `manifestVersion: 1` 与 `dsh-package-manifest@0.2.1-rc.2` 的 `DshManifest.manifestVersion?: 1` 完全一致;`app.asar` 内文档亦明示"Current installers and loaders do **not** enforce `dsh.manifestVersion` or `engines.dsh`"(该措辞对应清单包文档),故不会阻断任何宿主。
- `engines.dsh` 只在 0.2.1 的 bundle 装载路径被读取,且**一旦存在就忽略 `peerDependencies`**(`0.2.1 lib/index.js:280-285`);`0.2.0` 只校验 `peerDependencies`(`0.2.0 lib/index.js:289-301`);`0.1.5` 完全不读该字段(三个 tarball 对 `engines.dsh` 的命中数:0.1.5 = 0,0.2.0 = 0,0.2.1 = 6)。区间 `>=0.1.0-rc.7 <0.3.0-0` 用 `semver.satisfies(..., {includePrerelease:true})` 实测:`0.1.0-rc.6` false,`0.1.0-rc.7`…`0.2.2` true,`0.3.0-0`/`0.3.0-rc.1`/`0.3.0` false(尾界写 `<0.3.0-0` 是对的,`<0.3.0` 会误放 `0.3.0-rc.1`)。**结论:不构成对 0.1.x 的阻塞。**

---

## 三、逐项核对结论(用户点名的 8 项)

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 槽位拆分正确性 / 双注册 / `createSettingsCard` 副作用 | ✅ 拆分正确:两槽位各自 `slots.inject`(`index.tsx:174-175`),未声明的那个只跳过自己;`register` 对未声明槽位同步抛错(`dsh-client-ui-slots/lib/index.js:163-165`),`slots.inject` 回调异常会 `queueMicrotask` 抛成页面级 uncaught(`dsh-client-ui-renderer/lib/client.js:1368-1418`),所以"必须拆"的判断成立。`createSettingsCard` 幂等,无双订阅/丢 disposer。双槽位宿主会双卡片(见 N7,现实不存在) |
| 2 | `ctx.inject(['sessions'])` 是否阻塞 | ✅ 不阻塞。独立于主 `inject: ['slots','connection','remote']`(`index.tsx:58,77-79`);`ctx.sessions` 由 `dsh-api-session-controller` 用 `rootCtx.reflect.provide('sessions', this)` 提供(`lib/client.js:3840`),0.1.x 无此服务时闭包变量保持 `undefined`,controller 走降级 |
| 3 | 事件窗口读取语义(binding 安全 / 陈旧代际 / 部分窗口) | ✅ `binding(id)` = `this.scopes.get(id)?.binding`(`lib/client.js:4056-4058`),`retireScope` 先删表再释放,拿不到陈旧代际;`getSnapshot()` 返回缓存快照(`events.d.ts` `MutableSessionEventSource`),只读、不 retain、不翻页,语义正确。窗口初始为 `entries: []`,`entries?.length` 判空正确。部分窗口(仅已装载尾部页)是本版有意接受的取舍(`hasMore` 未用,见 N6) |
| 4 | 上下文质量/性能/token 上限 | ❌ 见 **B2**:条数与总字符上限成立(≤8 条 / 1600 字符,实测 500 条满载窗口也只出 ≤8 条),但**用户消息会被挤光**;另有 N6 的一次性字符串放大 |
| 5 | 类型层强转 / `{type:'transient'}` 过滤 | ⚠️ 见 N5:`as unknown as` 的结构面偏宽,但运行期行为安全(transient 被 `event.type` 天然过滤,已实测);`flattenText` 对 `null`/`{}`/`data:null` 全部返回 `''` 不抛错 |
| 6 | i18n `memoryOnly` → `readOnly` 残留 | ✅ `src/`、`test/` 中已无 `memoryOnly`(仅文档提及,见 N8);zh/en 各 79 个 key,**完全对齐**;`SettingsCard.tsx:370` 的 `!writable` 与 `:268` 的 `writable = snap.writable !== false` 口径一致(未知按可写处理,不误报只读) |
| 7 | `manifestVersion: 1` / `engines.dsh` 对 0.1.x 阻塞风险 | ✅ 均不阻塞,见 N9 |
| 8 | 测试有效性 + CI 依赖可用性 | ⚠️ `npm test` / `typecheck` / `build` 本地全绿(c25/c26、s1–s4 均实际执行并通过);但 (a) CI 会卡在 `npm ci`(**B1**);(b) slot-guard 未测到插件自身代码(N2);(c) 包缺席时静默 SKIP(N4);(d) c26 未覆盖"窗口非空但无可用条目"(N1) |

---

## 四、实际跑过的命令与结果

| 命令 / 探针 | 结果 |
|---|---|
| `git --no-pager diff --stat HEAD~1 HEAD` | 15 files, +843/−90 |
| `npm test` | exit 0;`controller: all passed`(含 `✓ c25` / `✓ c26`)、`slot-guard: all passed`(`✓ s1`…`✓ s4`) |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0;`lib/{index,client,prompt,controller}.js` 4 个产物 |
| HEAD 干净副本 `npm ci --legacy-peer-deps --dry-run` | **exit 1,EUSAGE**(见 B1) |
| HEAD~1 干净副本 `npm ci --legacy-peer-deps --dry-run` | exit 0(证明是本版引入的) |
| HEAD 副本 `npm install --package-lock-only` → `npm ci --dry-run` | 0 → **0**(B1 修复已验证) |
| `node -e` 直调 `lib/prompt.js` / `lib/controller.js` 遍历 user/assistant 长度组合 | 见 B2 表格(user 200 字 + assistant 600 字 → users=1/4;1u+4×600a → users=0) |
| `semver.satisfies(runtime, '>=0.1.0-rc.7 <0.3.0-0', {includePrerelease:true})` | 0.1.0-rc.6 false;0.1.0-rc.7…0.2.2 true;0.3.0-0/-rc.1/0.3.0 false |
| `dsh-app-boot` 0.1.5 / 0.2.0 / 0.2.1 tarball 检索 `engines.dsh` | 0 / 0 / 6 命中(只有 0.2.1 读) |
| 桌面端 `app.asar` 字节扫描 `settings.plugin.item` / `settings.plugins.tab` / `manifestVersion` | 0 / 22 / 6(6 处均为文档性文本,无强制校验) |
| `app.asar` 扫描 `retain(` 且带 `mainView` | 命中 `this.sessions.retain(target, { source: "mainView" })`,证实 UI 打开会话即 retain,`binding()` 有窗口 |
| i18n key 比对(zh vs en) | 79 vs 79,无缺无多 |

---

## 五、验证过的 vs 假设的

**已对真实上游产物/真实执行验证**
槽位声明与未声明抛错行为、`slots.inject` 的回调触发条件与异常传播路径、`settings.plugins.tab` 存在而 `settings.plugin.item` 在 0.2.1 全库消失、`ctx.sessions` 的提供方与 `binding()` 语义、`eventSource` 初始态与填充时机、`Source: "mainView"` 的 retain 调用方、`retireScope` 的失效顺序、`{type:'event'} | {type:'transient'}` 判别联合、`source.kind` 取值与 `runtime-context` 过滤、`user/message` / `assistant/message` 的 `data` 形状(`dsh-session/lib/types/types.d.ts:295,331-339`)、`ConfigFormSnapshot` 无 `mode`、`engines.dsh` 的三代校验差异与 semver 区间、`manifestVersion` 无强制校验、`autoGenerate` 无客户端消费者、`npm ci` 同步性与修复效果、`capConversationContext` 的丢弃行为。

**未验证 / 属于假设**
1. **未在真实 0.2.1-rc.2 GUI 里点通全流程**(本机 `dsh web` 需要 launch token;桌面端未做 UIA 自动化)。因此"设置页在 0.2.1 上正确渲染一个 tab"、"发送栏按钮/结果面板"这类 UI 结论来自**代码路径 + 上游产物核对**,不是像素级实测。
2. **未接真实模型跑上下文质量对比**。B2 的结论是"用户消息被丢弃"这一可确定的行为事实,不是"输出质量下降多少"的量化结论。
3. 真实用户的 user/assistant 长度分布未统计;B2 的 200/600 字组合是**基于工程直觉的典型值**,不是采样结论(但触发门槛很低,见 B2 表格)。
4. `sync-types` 在 CI 全新环境下的最终类型集合未逐一验证(只验证了本机 `tsc` 通过,以及本机仍有 3 个包停在 0.2.0-rc.2)。
5. 0.1.x 宿主上的实际安装/启动未复跑(仅按 `dsh-app-boot@0.1.5-rc.2` 的代码确认它不读 `engines.dsh`)。

---

## 六、合入清单(给作者)

1. `npm install --legacy-peer-deps --package-lock-only` → 提交 `package-lock.json`(**必须**,B1)。
2. `src/prompt.ts` 预算循环按角色保底(至少保证最新一条用户消息不被挤掉),补 4×user(200) + 4×assistant(600) 回归测试(**必须**,B2)。
3. 删掉 `controller.ts:292` 的提前 `return undefined`,让"窗口有内容但无可用条目"落到 legacy 分支,并补一条 transient-only 窗口的测试(建议本版一并做,N1)。
4. slot-guard 改为驱动真实 `apply()`;`CI=true` 时不允许 SKIP(N2/N4)。
5. 订正 `docs/dsh-021-diff.md` 的 `session/history` 结论、示例区间与 `settings.memoryOnly` 提法(N8;release notes 的"拒绝加载/拒绝安装"已核对属实,不必改)。


---

## 七、修复结果(作者回填,2026-10-18)

上面 B1/B2 与 N1/N2/N3/N4 已全部修复并复验。

| 项 | 处置 | 复验 |
|---|---|---|
| **B1** lock 未同步 | 重新生成 `package-lock.json`(`npm install --legacy-peer-deps --package-lock-only`) | lock `version` = 0.6.0;含 `dsh-client-ui-slots@0.2.1-rc.2`;`npm ci --legacy-peer-deps --dry-run` **EXIT=0** |
| **B2** 用户消息被挤空 | `capConversationContext` 改为**按角色分预算**:用户消息优先(上限 800 字符,保底 ≥1 条),助手回复用剩余预算且装不下时 `continue` 而非 `break` | 交错 4×user200+4×asst600 → users **3**(原 1);agentic 1 user+4×600 asst → users **1**(原 0);全形态总量 ≤1600。新增 `p25` 回归 |
| **N1** legacy 回退是死代码 | 删掉 `controller.ts` 里 `return undefined`,窗口榨不出对话时继续降级 | 新增 `c27`:transient-only 窗口 → `legacyCalls === 1` 且用上了 legacy 上下文 |
| **N2** slot-guard 未驱动插件 | 新增 `s5`:铺 `window.__ModuleLoader__` 后 import **真实 `lib/client.js`**,调用真实 `apply()` | 已做**变异测试**:临时把两个 inject 合并回一个回调 → s5 **EXIT=1**(报 `slot "settings.plugin.item" is not declared`),还原后全绿 |
| **N3** sync-types 不升级已有目录 | 改为比较已装版本与钉版本,不一致则删除重装 | 本机 19 个钉版本包实测全部 0.2.1-rc.2 |
| **N4** CI 下静默 SKIP | `CI=true` 时缺 `dsh-client-ui-slots` 直接 `exit 1` | 已实现 |

N5–N9 未改(均评估为非阻塞,其中 N8 的文档措辞不影响运行时行为)。

**修复后全量验证**:`npm run typecheck` 零错误;`npm run build` 成功;`npm test` **94 项全绿**(原 91 + p25 + c27 + s5);四套件 smoke/prompt/controller/slot-guard 全部 `all passed`。
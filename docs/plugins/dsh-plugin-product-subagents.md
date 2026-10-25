# dsh-plugin-product-subagents（插件级 agent 说明）

> 从 `dsh-plugin-product-subagents/AGENTS.md`（上游英文版）完整重写迁移而来
> （2026-10-17，仓库统一治理 issue #1）。原本还有一份 `CLAUDE.md`——它唯一作用是
> `@AGENTS.md` 指针，已随源头一起删除。
> 仓库级约定见根 [`AGENTS.md`](../../AGENTS.md)；面向使用者的说明见
> [`README.md`](../../dsh-plugin-product-subagents/README.md)（英文）与
> [`README.zh.md`](../../dsh-plugin-product-subagents/README.zh.md)（中文）。
>
> **命名约定**：本文中文叙述，但**代码标识符、协议名、文件路径一律保持英文原文**。

- 目录：`dsh-plugin-product-subagents/`　包名：`dsh-plugin-product-subagents`
- 来源：fork 自 GitHub `shaokeyibb/dsh-plugin-product-subagents` v0.4.0
  （commit `e5a002db3b8d6df984fdb5e704e9321dca1723cd`，MIT）；上游历史见该 commit。

## 是什么

一个 DeepSeek Harness（Cordis）插件，把外部 agent CLI（Claude Code、Codex、任意 ACP agent）
变成**基于角色的、可续接的 subagent**：一次性同步调用或异步可续接，带持久会话恢复、
每角色 product 权限，以及受**权限天花板**约束的委派。

## 命令

```bash
pnpm install       # 装依赖
pnpm test          # node:test 套件（纯逻辑 + 假 bridge；不需要任何 CLI / key）
pnpm run lint      # 逐个模块语法检查（node --check）

# 针对某个真实 DSH 版本的一次性 profile 验收（一次性 $DSH_HOME）
node scripts/verify-dsh-profile.mjs --dsh 0.2.0-rc.2
```

- **永不**新增需要真实 product CLI 或 API key 的测试——`pnpm test` 必须在无凭据的 CI
  （macOS / Ubuntu / Windows × Node 18/20/22）上全绿。
- 一次性 profile 验收是**刻意的例外**，放在 `scripts/` 里，不属于 `pnpm test`。

## 目录结构

```
lib/
  index.js            # apply()：接线 providers / 生命周期 / tools
  tools/              # 每个面向模型的工具一个模块
  bridges/            # 每种 product 协议一个 bridge（claude / codex / acp）
  providers.js        # 配置驱动的 provider 注册表（+ 自定义 ACP agent）
  roles.js            # 角色库加载器
  config.js           # zod 配置校验
  registry.js         # 持久化 remote-session registry 文件
  run.js              # 跨平台进程启动（Windows .cmd shim）
  availability.js     # CLI 探测
  bindings.js         # child → remote 绑定表 + log-marker 恢复
  session-events.js   # sessionQuery 读事件 + 归一化（payload/timestamp）
  progress.js         # 会话日志折叠（progress / trace / token usage）
  relay-contract.js   # relay 输出契约：system 段 + product-session 标记 + fail-closed 校验
  children.js         # listChildren() 并集：身份行 vs 诊断行
  lossless.js         # stripUndefined()：工具结果必须是 lossless JSON
roles/                # 声明式角色文件（*.json）
test/                 # node:test 套件
scripts/              # lint + 一次性 profile 的 DSH 验收脚本
docs/ARCHITECTURE.md  # 桥接契约、权限模型、如何新增 product
docs/COMPATIBILITY.md # DSH 版本矩阵，以及每个 verdict 是怎么产生的
```

**`lib/` 各模块职责要点**：`index.js` 保持薄，只做接线，工具都放 `lib/tools/`；
一切 CLI 启动走 `lib/run.js`；一切可能缺失字段的工具结果走 `lib/lossless.js`；
会话 id 的捕获与恢复链在 `lib/bindings.js` → `lib/registry.js`（+ log marker）。

## 工具：`product_wait`（等价：等待一个后台子代理结算）

`product_wait` 阻塞到子代理结算，返回最终回答、stop reason 和最近 trace。

**唯一的权威唤醒信号是 activation 的结算 promise**（`lib/tools/product-wait.js`）：
`product_delegate` 调 `startActivation()` 时，返回对象里的 `result` 就是「这个 activation 何时结束」的
promise（`dsh-subagent/lib/index.js:2075`）；它被存进 binding（`record.settle`），`product_wait`
直接 `Promise.race([settle, timeout, abort])`。

> ⚠️ **别把事件或会话日志当唤醒信号**（0.4.4 试过，生产不可达，见 issue #40）：
> - `ctx.on('subagent/end')` 是**父级 scoped 的一次性广播**，插件在自身 ctx 上注册的监听
>   对真实 child 从未触发；
> - `sessions.get(id)` **只返回 live 会话**（settle 后已被移出 store）。
>
> 日志本身现在读得到（走 `sessionQuery`，见下节），但只用于 `answer` 兜底、`trace` 和超时时的
> `progress`，**永远不参与判断 child 是否结束**。
>
> 0.4.4 的 `detectedBy: 'session-log'` 分支属于死代码，已在 0.4.5 删除。
> `subagent/end` 监听仅保留为**无 settle 句柄时的兜底**（例如 child 由上一个进程创建）。

`detectedBy` 声明是哪条信号把调用唤醒的：

| `detectedBy` | 含义 |
|---|---|
| `activation` | **正常路径**：child 的 activation 结算，答案取自其 `output` |
| `already-settled` | 入口快照里 child 已 `inactive`，立即返回 `ready` |
| `event` | 无 settle 句柄时收到 `subagent/end`（兜底，可能不触发） |
| `timeout` | 以上都没命中；结果带 `progress`，其中 `waitingOn` 说明当时在等哪条信号 |
| `aborted` | `exec.signal` 已中止 |
| `unknown` | 该 child 不在当前 parent 下，且没有 settle 句柄 |

- 默认超时 **300000 ms（300s）**，上限 `600000`，可经 `timeout_ms` 覆盖。有了结算 promise，
  任务一结束就返回，超时只是安全网——不要把默认值调小，否则会掐断正常的长任务。
- activation **reject** 时返回 `status:'failed'` + `detectedBy:'activation'` + `failure`，
  **不会**把任何内容当作 `answer` 返回。
- `answer` 取自 activation 结算值的 `output`（文本块拼接）；`output` 缺失时回退到 child 日志里
  最后一条 `assistant/message` / `tool/result`（`lastAnswerFull()`，**不截断**）。`stopReason` 同源。
  `foldProgress.lastAnswer` 仍是 300 字符的**展示用**摘要（`subagent_progress` 的语义），两者不要混用。
- `finish` 会 `clearTimeout` + `clearInterval` + 取消 `subagent/end` 订阅与 abort 监听；轮询 interval
  额外 `unref()`，不会拖住进程。结果仍经 `stripUndefined()`，保持严格 lossless JSON。

## 会话事件读取走 `sessionQuery`（#41）

`subagent_progress` / `product_wait` 需要的「子代理日志」统一由 `lib/session-events.js`
的 `loadEvents(ctx, sessionId)` 提供：**会话 id → 归一化事件数组**，任何失败都退化为 `[]`，绝不抛。
调用方据此拼 `{ events }` 再交给 `progress.js` 的折叠函数（`foldProgress` / `foldTrace` /
`foldTokenUsage` / `lastAnswerFull` 的签名保持不变）。

**为什么不直接读真实 `Session` 对象**（issue #41 的两层病因）：

1. 真实 `Session` **没有 `events` 属性**，只有 `snapshotEvents(fromSeq, toSeqExclusive)`。
   `foldProgress(session)` 入口的 `Array.isArray(session.events)` 因此永远为 false → 返回 `null`
   → `subagent_progress` 恒为 `stepCount: 0` / `trace: []`。
2. `sessions.get(id)` **只服务 live 会话**（settle 后 `store.delete()`），子代理一结束就取不到。
3. 真实事件的正文在 **`data`** 里（信封是 `{ type, seq, time, data }`），不是 `payload`；
   旧折叠函数只读 `payload`，即使来源修好也提取不到 `lastTask` / `lastAnswer`。
   `progress.js` 现在按 `payload → data → body` 的顺序取正文，并兼容
   `tool/call.data.arguments`（JSON 字符串）与 `tool/result.data.message`。

**为什么是 `sessionQuery`**（`ctx.get('sessionQuery')`，可选服务，缺它不阻塞插件加载）：

| 通道 | 结论 |
|---|---|
| `sessionQuery.readSession(id)` | ✅ **首选**：完整原始日志，事件带 `data`；live 优先，冷读走 `persistence.open(id, 'read')`，**已 settle 的会话也读得到** |
| `sessionQuery.listEvents(id)` | ⚠️ 兜底：只返回轻量记录 `{ sessionId, seq, type, time, surface }`，**不含 payload**，只能算 turn/step；不同 DSH 版本形状可能变化，不能作为唯一来源 |
| `session.snapshotEvents()` | ❌ 只覆盖 live，且源码标注 deprecated（"new calls are prohibited"）；仅作最后兜底 |
| 自己解 `~/.dsh/sessions/**/session.v4.jsonl.zstd` | ❌ 多帧 zstd，重且易碎，不碰 |

实现要点：5s 超时（`AbortSignal` 之外的软超时，超时即退化为兜底/空）；**不做缓存**（运行中的日志会增长）；
告警只打一次（`warnOnce`），避免每轮 `subagent_progress` 刷日志。

## relay 输出契约：远端失败必须 fail-closed（#42）

**现象**：远端 product 挂了（例如额度耗尽），relay 子代理**把任务里「期望的输出」原样吐出来**
（实测 `WAIT_FIX_VERIFY`），看起来像成功——调用方无法分辨真假。有时又表现正常（如实报错），
说明是模型判断层面的不稳定行为。

**根因**：预设只限制了 **工具集**（只有 `product_submit`），没限制 **输出**；提示词也没规定
「远端失败必须失败结束」。所以 `product_submit` 报错后模型可以自己回答。

**修法 = 两道独立保障**（`lib/relay-contract.js`）：

1. **提示词层**：`RELAY_CONTRACT_TEXT`（唯一动作是 `product_submit`；失败原样报
   `RELAY_FAILED: <error>` 并停止；成功原样返回含尾部标记的返回值；别的一律不许出现）。
   - `lib/relay.js` 用 caller-bound 的 `ctx.systemPrompt.section(...)` 注册成 system 段
     `product-relay:contract`。注册发生在 `product-relay` preset 的 scope 里（preset tree 挂在
     `dsh-agent-preset-registry` 的 `createScope()` 下，child 以该 scope 为父加入）→
     **所有 relay child 都继承，根 agent 看不到**。不改 DSH 本体。
   - `buildRelayPrompt()` 在 relay prompt 里重复同一段：既是 `systemPrompt` 服务缺失时的兜底，
     也让规则和任务文本在同一条消息里。
2. **结构层**：`product_submit` 成功时在返回值末尾追加 `<!--product-session:<remoteId>-->`
   （bridge 还没暴露远端 id 时用 child session id；**不新增任何网络请求**，id 就是 binding 里已有的）。
   只有这个工具能生成标记 → relay 自己写的文本不可能带标记。
   `product_wait` 用 `verifyRelayAnswer()` 校验：`RELAY_FAILED:` 开头 → failed + 错误原文；
   无标记 → failed（`unverifiable origin`）且**不返回该文本**；有标记 → 剥离后返回正文。

**边界**：DSH 自己投递给父会话的 activation settlement notice（`delivery: 'parent'`）是
harness 产生的文本，插件改不了；本插件返回的每条答案都已校验。
`foldProgress().lastAnswer` 也会先剥离标记，所以 `subagent_progress` 里不会出现标记。

## 设计规则（不可协商）

1. **relay model 永远是只读管道。** child 的 `toolFilter` 只可能含 `product_submit`，
   以及在角色允许委派时加上 `product_delegate`。**绝不**给 child 添加任何有写能力的工具。
   工具集受限**不等于**输出受限：relay 的最终回答必须是 `product_submit` 的返回值，
   远端失败必须 `RELAY_FAILED:` 结束，无 product-session 标记的答案由 `product_wait` 判失败（#42）。
2. **权限是给远端 product 的。** `permissionMode`（`readonly` / `default` / `full`）
   映射到 product 自己的 CLI 参数。
3. **绝不把裸 product id 注册到 `ctx.subagents`。** 本插件的 provider key
   （`claude-code`、`codex`、`acp`）同时也是官方 `@deepseek-ai/dsh-subagent-*` 插件使用的 id。
   `registerProvider` 遇到重名会拒绝，而这个失败会让**整个 profile 的插件树在启动时挂掉**，
   所以每次注册都经 `runtimeProviderName()`，保持加性且插件自有。
   bridge、角色、绑定与 registry 仍继续使用裸 key。
4. **权限沿委派树向下继承。** child 不能生出比自己 `permissionMode` 更高的后代——
   在 `lib/tools/product-delegate.js`（`PERM_RANK`）中强制执行。
5. **桥接契约是固定的。** `lib/bridges/` 里每个 bridge 实现
   `create(cwd)`、`submit(remote, task, signal, cwd, settings)`、`reconnect(sessionId, cwd)`、
   `dispose(remote)`。新增一个 product = 一个 bridge + 一条 provider 条目；
   纯 ACP CLI 甚至不需要写代码（走 `config.providers`）。
6. **跨平台。** 所有 CLI 启动都走 `lib/run.js`（`spawnProduct` / `spawnSyncProduct`）——
   它们负责 Windows `.cmd` shim。路径一律用 `join()` 与 `fileURLToPath`，
   绝不用字符串拼接或 `URL.pathname`。
7. **会话续接是分层的。** 远端 session id 尽早捕获并持久化记录
   （binding → registry 文件 → log marker）。不要打断这条恢复链。

## 配置面（`config`）

`config.providers`（新增 / 覆盖 product CLI）、`providerNamespace`、`idleTimeoutMs`、
`maxConcurrentChildren`、`rolesDir`、`registryPath`。
角色存在 `roles/*.json`（`permissionMode`、`allowDelegation` 默认 ON、`provider`、
`instructions`、`description`）。非法配置经 `lib/config.js`（zod）**大声失败**。

> ⚠️ 配置覆盖会替换该行的**整个** `config` 对象——想保留的键要一并重述。

## 约定

- `lib/index.js` 保持薄；工具放 `lib/tools/`。
- 配置面变化时，`README.md` 与 `README.zh.md` **同时**改。
- 用户可见的变化要加 `CHANGELOG.md` 条目。
- **每个工具结果必须是严格 lossless JSON**——任意深度都不许出现 `undefined`。
  任何字段可能缺失时都要经 `stripUndefined()`（`lib/lossless.js`）返回；
  否则 harness 会拒绝整个调用。
- **树内不得有符号链接，也不得有 git submodule**：DSH STORE 的 fixed-Commit 契约要求
  普通文件，符号链接会让 store 的自动更新被推迟。（`CLAUDE.md` 当初正是为此不是符号链接；
  现按本仓库统一治理规则已删除，指引只留在 `docs/plugins/dsh-plugin-product-subagents.md`。）
- **提交身份**用 `HikariLan <i@hikarilan.life>`；仓库在首次发版前刻意只保留一个 squash commit。

## 发版纪律：声称支持某个 DSH 版本，必须有验收背书

**这是本插件最容易出错、也最不可省的一条纪律。**

一次性 profile 验收（`scripts/verify-dsh-profile.mjs`）对每个目标版本建一个临时 `$DSH_HOME`，
跑四步，任一步不成立就判该版本失败：

| 步骤 | 证明了什么 |
|---|---|
| `install` | `dsh plugin --profile headless add <tarball>` 成功，**且** profile manifest 的 `dsh.profile.bundles` 里出现了 `dsh-plugin-product-subagents`——该版本的 CLI 认了 `dsh.bundle.patch` 声明 |
| `compose` | `dsh --profile headless --dump-config` 组合出的树里含本插件的行——bundle patch 在该版本的 loader 下正确分层 |
| `start` | profile 真能**启动**（用 `scripts/verify-plugin.mjs` 经 `--patch` 叠加）：断言六个工具都注册了、subagent provider 到达真实 `SubagentRuntime`，且 `product_roles` / `product_agents` 能执行、通过其输出 schema 校验、渲染、且**不含 `undefined`**（严格 lossless JSON） |
| `uninstall` | `dsh plugin … remove` 成功，bundle 层从 manifest 中消失 |

- `--with <pkg>[,<pkg>]` 会在同一 profile 里共装其它 bundle；`start` 步骤会额外断言本插件注册的
  每个 id 都是命名空间化、插件自有的——这正是防止与官方 `@deepseek-ai/dsh-subagent-*` 的
  provider id 冲突的检查（0.4.0 之前这个冲突会让整个 profile 的插件树启动失败）。
- 临时 `$DSH_HOME` 跑完即删（`--keep` 可保留排查）。**绝不触碰用户真实的 `~/.dsh`。**
- 一次验收**不证明**什么：它不是安全审计，也不真的跑一次对 product CLI 的活体委派
  （那需要真实 `claude` / `codex` / ACP 会话及其凭据）；bridge 行为由 `pnpm test` 对假 bridge 覆盖。

### verdict 该写哪里（三处，缺一不可）

1. **跑**：`node scripts/verify-dsh-profile.mjs --dsh <新版本>`；
2. **记**：verdict 同时写进 `package.json` 的 `dsh.compatibility.dshReleases`
   **和** `docs/COMPATIBILITY.md` 的表；
3. **bump**：改插件 SemVer（矩阵只在新 pinned commit 生效）。

`dshReleases` 是**逐版本**的 verdict，不是范围：表里缺失的版本就是 `unknown`——
`unknown` 绝不在没有实跑的情况下被升格成 `compatible`。
`unknown` 永远是「拿不到 / 测不了」，绝不是「跑不通」。

### 与 DSH 兼容范围相关的三个坑

- **范围要扩声明**：DSH 启动时按插件自己声明的 peer 范围判兼容。没覆盖就跳过该 bundle
  （表现是「插件莫名其妙没加载」）。所以要在 `peerDependencies` 与 `dsh.compatibility.dsh`
  里同时加上目标版本线。
- **prerelease 陷阱（比看上去更细）**：预发布版本只满足 major.minor.patch **完全相同**的比较器。
  所以 `^0.2.0-rc.2` 不覆盖 `0.2.1-rc.1`；同理 **`^0.2.1-rc.1` 也不覆盖 `0.2.1-alpha.5`**
  （alpha 低于 rc）。规律是：**锚点要写在不高于你支持的最低预发布版本上** ——
  `^0.2.1-alpha.5` 会把整条 `0.2.1` 线（含 `rc.1`）都覆盖进去，一条锚点就够。
  仓库里 0.4.0 → 0.4.1 是「只补声明、未改业务代码」的例子；
  0.4.2 则是**声明 + 真实 API 迁移**。
- **验收脚本测不到「能不能真的起一个子代理」**：`scripts/verify-plugin.mjs` 的 `start` 步骤只断言
  「6 个工具已注册 + provider 已注册 + `product_roles`/`product_agents` 能执行」，**从不真正发起委派**。
  DSH `0.2.1` 把服务级 `startContinuable` 改名成 `startActivation` 时，插件照常加载、
  六个工具都在，**只有真起子代理才炸** —— 于是所有 verdict 依然是 `compatible`。
  现在这条由 **`test/delegate-start.test.js`** 在 CI 里守（免凭据），
  但**每次发版仍要人工做一次真实委派**（见 `docs/COMPATIBILITY.md` 的「What the run does not prove」）。

## 本仓库对它的适配记录（fork 后改了什么）

- 扩展 `peerDependencies` / `dsh.compatibility.dsh` 范围，补 `0.2.0-rc.2`、`0.2.1-rc.1` 的
  `dshReleases` verdict（均有一次性 profile 验收背书）；
- 版本 `0.4.0 → 0.4.1`，同步 `CHANGELOG.md` / `docs/COMPATIBILITY.md` / `README.md` + `README.zh.md`；
- **业务代码未改**；并入本仓库统一管理（其内层 `.git` 已删除，上游历史见上文 commit）。
- **`0.4.2`（适配 DSH `0.2.1` 线，本次唯一动业务代码的一次）**：
  - `lib/tools/product-delegate.js` 新增 `pickStart()`：`startActivation`（DSH >= 0.2.1，补
    `delivery: 'parent'`）与 `startContinuable`（0.2.0 线）**特征检测二选一**，两者都没有就**响亮报错**；
  - `0.2.1` 路径不再发送 `persona` / `toolFilter`（这两个字段已被 runtime 删除）——
    角色的 `instructions` 仍会拼在任务文本前面，那才是产品 CLI 真正读到的部分；
  - 新增 `test/delegate-start.test.js` 守住这次改名（CI 可跑、免凭据）；
  - 声明锚点从 `^0.2.1-rc.1` 改为 `^0.2.1-alpha.5`（见上文 prerelease 坑），
    补 `0.2.1-alpha.5` verdict，并用 0.4.2 **复跑**了 `0.2.1-rc.1`；
  - ~~**能力变化（必须知道）**：`0.2.1+` 上外部子代理是一次性的，`product_submit`、durable
    远端会话、续接在 `0.2.1+` 上不可用~~ —— **这段结论是错的，已在 0.4.3 撤销**：本 provider
    实现了 `prepareContinuable`，而「方法存在即选择本地 activation 执行」，所以 0.2.1 上子代理
    仍然是**本地 relay**。`0.2.1` 真正删掉的是 `persona` / `toolFilter` 这两个**约束字段**。
- **`0.4.3`（issue #8：把 relay 约束修回来）**：
  - **事故**：0.4.2 的 activation 分支只发 `prompt` + `parent`，既没 `agentPreset` 也没
    `toolFilter` → `applyChildComposition` 走 `composeFrom(childCtx, parent.ctx)` →
    子代理继承父级全套工具（bash/read/write/edit）→ 它自己把活干完，`product_submit` 0 次，
    实际跑在**继承来的会话模型**上，产品平面（opencode + 指定 model）从未启动；
  - **根因**：`SubagentStartRequest` 无 `persona`/`toolFilter`；本地子代理的 composition 在
    `dsh-subagent/lib/index.js` 里写死为 `composition: { agentPreset: request.agentPreset }`；
    `applyChildOverrides` 虽仍处理 `composition.toolFilter`，但全新 start 没有入口能塞进去
    （只有历史 descriptor / 冷恢复可以）——**一个无报错、无警告的迁移陷阱**；
  - **修法**：插件加载时用 `ctx.agentPresets.register()` 注册 **`product-relay`** 预设，其
    composition 只挂一个入口 `lib/relay.js`，后者只注册 `product_submit`；委派时传
    `agentPreset` + `maxDepth`。preset 是"从零挂载"，比旧的 toolFilter（继承后裁剪）更严；
  - **不能靠 toolFilter 加回来**：`grep request.toolFilter` 在 `dsh-subagent` 里**零命中**，
    请求里硬塞也不会被读；
  - **没有 preset 服务就拒绝**：后台委派会**明确报错**（`background:false` 不受影响，
    它根本不建本地子代理）；
  - **prompt 分离**：`role.instructions` 明确标注"给远端产品代理"，本地 relay 只被告知
    "把标记之间的文本原样交给 `product_submit`"（原来它会把"你有全部权限"当成给自己的）；
  - **`maxDepth`**：显式传（`config.maxDelegationDepth`，默认 2），并补 provider 能力声明
    `agentPreset: true` / `depthLimit: true`（DSH 对这两个请求字段做能力校验）；
  - **测试补缺口**：`test/delegate-request.test.js` 断言**请求内容**（`agentPreset`、
    `maxDepth`、prompt 分隔、无 preset 时拒绝）——0.4.2 的测试只验证"调了哪个方法"，
    所以这次回归是绿的。
- **`0.4.4`（issue #38：`product_wait` 漏检）**：
  - **事故**：39 秒跑完的子代理，`product_wait` 等满 300s 报 `timeout`；
  - **根因**：先 `listChildren` 快照、**后**订阅 `subagent/end`，结算落在空窗期时一次性事件被丢弃，
    且缺少第二信号兜底；
  - **修法**：订阅先于快照；日志兜底（每 2s + 首次立即读，判据 `foldProgress.endedAt` +
    `turnOpen === false` + `lastAnswer`）；新增 `detectedBy`；超时不再谎报；默认超时降到 120s；
    `foldProgress` 新增 `endedAt` / `turnOpen`；`lastAnswerFull()` 让日志路径返回**完整**答案
    （`foldProgress.lastAnswer` 的 300 字符只是展示摘要）；
  - **测试**：`test/product-wait.test.js` 八条时序用例（离网、假 ctx / 假 session），
    含「续接后新一轮仍打开不得回吐旧答案」「1000 字符答案不被截断」。
- **`0.4.6`（issue #41：`subagent_progress` 永远为空）**：
  - **事故**：一个日志里 25 条事件的子代理，`subagent_progress` 返回 `stepCount: 0`、`trace: []`、
    无 `lastAnswer`；
  - **根因（两层）**：① 真实 `Session` 没有 `events` 属性，`foldProgress` 首行即 `return null`；
    ② 真实事件正文在 `data`，折叠函数只读 `payload`；
  - **修法**：新增 `lib/session-events.js`（`loadEvents()`，`sessionQuery.readSession()` 优先、
    `listEvents()` 兜底、`snapshotEvents()` 最后兜底、5s 超时、告警一次、不缓存）；
    `progress.js` 改为 `payload → data → body` 取正文，并识别 `tool/call.data.arguments` /
    `tool/result.data.message`；`subagent_progress` / `product_wait` 的日志读取改走适配层
    （`product_wait` 只把它用于 trace 与答案兜底，唤醒仍看 activation settle）；
    `bindings.recoverRemoteSessionId` 同步接受 `data` 与 live `snapshotEvents()`；
  - **测试**：新增 `test/session-events.test.js`（真实事件信封、回退、抛错、超时）；
    `test/progress.test.js` 补 `data` 信封与 `data.message.usage` 用例；`product_wait` 八条时序用例不变全过。
- **`0.4.7`（issue #42：远端失败时 relay 伪造期望答案）**：
  - 新增 `lib/relay-contract.js`：`RELAY_CONTRACT_TEXT`（system 段内容）、
    `installRelayContract()`（caller-bound `ctx.systemPrompt.section()`，注册在 preset scope）、
    `productSessionTag()` / `stripProductSessionTag()`、`verifyRelayAnswer()`（fail-closed 判定）；
  - `lib/relay.js` 注入 `product-relay:contract`；`buildRelayPrompt()` 复述同一段（无 `systemPrompt`
    服务时的兜底）；`product_submit` 成功返回末尾追加 `<!--product-session:<id>-->`；
  - `product_wait` 对最终文本校验：`RELAY_FAILED:` → failed + 错误原文；无标记 → failed（`unverifiable
    origin`）且**不返回文本**；有标记 → 剥离后返回正文。被拒答案同时从返回的 `trace` 里抹掉
    （`assistant/message` 的 brief 改为 withheld，turn/step/tool 条目保留）；`foldProgress().lastAnswer`
    同步剥离标记；
  - **测试**：新增 `test/relay-contract.test.js`（9 条）；`test/product-wait.test.js` 补 6 条验收用例
    （共 14 条），成功夹具改为带标记；套件 74 → 89 全绿。


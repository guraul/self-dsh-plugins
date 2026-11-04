# dsh-subagent-policy-fallback（插件级 agent 说明）

> 仓库级约定见根 [`AGENTS.md`](../../AGENTS.md)；面向使用者的说明见
> [`../../dsh-subagent-policy-fallback/README.md`](../../dsh-subagent-policy-fallback/README.md)。
> 本文只写「改哪里、注意什么、怎么验证」，不重复用户手册。

- 目录：`dsh-subagent-policy-fallback/`　包名：`dsh-subagent-policy-fallback`　来源：**原创**　当前版本：`0.1.0`

## 术语表（先读这一节）

| 术语 | 含义 | 在本插件里的对应物 |
|---|---|---|
| **策略事件** | 会话日志里的 `subagent/model-selection-policy`，负载是 `{ allowedModels: [{provider, model}] }`。 | 本插件唯一追加的事件 |
| **种子 / 恢复会话** | 从已有日志恢复出来的会话，`firstLiveSeq !== 0`。上游采样只覆盖 `firstLiveSeq === 0` 的新会话。 | 本插件的主要目标 |
| **顶层会话** | `header.origin !== 'subagent'` 的会话。 | 本插件只碰这类 |
| **子会话** | `header.origin === 'subagent'`，继承父会话的策略。 | **跳过**，不二次注入 |
| **设置服务** | 宿主服务 `subagentModelSelection`，`current()` 返回 `{ enabled, allowedModels }`。 | 用 `ctx.get()` 软探测 |

## 目录与分工

| 路径 | 作用 |
|---|---|
| `lib/index.js` | 宿主入口：`name` / `inject = ['sessions']` / `apply` 注册 `agent/created` + 回填存活会话 + `enabled` 开关 |
| `lib/policy.js` | 纯逻辑：幂等检查、读设置、追加事件、审计日志、批量回填 |
| `test/policy.test.mjs` | 假 ctx / 假 session 的单测（10 条） |
| `scripts/lint.js` | 对 `lib/**`、`test/**` 逐个 `node --check` |
| `cordis.patch.yml` | 把本插件插进宿主组合 |

## 架构与数据流

```
apply(ctx, config)
  ├─ config.enabled === false ──► 直接返回（不注册、不回填）
  ├─ ctx.on('agent/created')  ──► backfillSession(agent.session)   （同步）
  └─ ctx.sessions.list()      ──► backfillSessions([...])          （apply 时已存活的）

backfillSession
  ├─ header.origin === 'subagent' ──► 跳过
  ├─ 日志已有策略事件 ──────────────► 跳过（幂等）
  ├─ 服务缺失 / current() 抛错 / enabled false / 列表空 ──► 跳过
  └─ session.append('subagent/model-selection-policy', { allowedModels })
       + ctx.logger.info('… 补齐 N 条 …')
```

## 改之前必须知道的五件事

1. **不要复制上游的 `firstLiveSeq === 0` 判据。** 复制了就等于什么都没做——本插件的全部价值是覆盖
   上游漏掉的种子 / 恢复会话。幂等靠第 3 条事件检查保证，不靠 `firstLiveSeq`。
2. **检查必须看完整日志，不能只看 `ownEvents()`。** fork 会话的策略事件可能落在继承前缀里；
   用 `session.snapshotEvents()` 全量扫描，否则会重复追加。
   （`snapshotEvents` / `eventAt` 在上游标注了 deprecated，但读全量日志目前没有替代入口；
   真到移除那天再换投影 API。）
3. **监听器保持同步。** 检查与 `append` 放在同一个同步段里，避免和上游监听器交错：
   两边都先检查、都后追加，就会给新会话写出两条策略事件。不要在中间 `await`。
4. **设置服务是软依赖。** 只 `inject = ['sessions']`；`subagentModelSelection` 用 `ctx.get()` 探测，
   缺失时静默跳过。上游 `current()` 在「enabled 但列表空」时会抛错，`readAllowedModels` 必须捕获并按空处理。
5. **子会话跳过是语义，不是 bug。** 子会话继承父会话；父会话若被补上，子会话自然拿到。
   不要给 `origin === 'subagent'` 的会话单独追加，否则会破坏继承关系。

## 验证

```sh
cd dsh-subagent-policy-fallback
pnpm test        # 10 条：注入 / 已有事件 / 子会话 / 服务缺失 / enabled=false / apply 回填 / 幂等
pnpm run lint    # lib/ + test/ 全量 node --check
```

单测不引入 cordis、不启动宿主：`createCtx` 只实现 `on` / `sessions.list` / `get` / `logger`，
`createSession` 把 `append` 写回 `snapshotEvents()`，所以「回填后再触发一次」能直接验证幂等。

真机验收（**重启 dsh web 会终止当前会话**，注意时机）：

1. 在设置里打开 subagent 模型选择并配置 ≥2 条路线；
2. 恢复一个旧会话，确认宿主日志出现
   `subagent-policy-fallback: 为会话 <id> 补齐 N 条 subagent 模型路由`；
3. 再恢复 / 重载一次，确认没有第二条策略事件；
4. 在子会话里确认 subagent 仍按父会话策略工作（本插件不会给它单独写事件）。

## 已知坑

- **上游服务形状是隐式契约**：`ctx.get('subagentModelSelection').current()` 在 `.d.ts` 里是 private。
  上游改形状时插件会静默失效（不崩），验收时要看日志里有没有审计行。
- **`allowedModels` 为空时上游 `current()` 会抛错**，不是返回空数组；捕获后按「跳过」处理，别把异常抛到事件派发里。
- **不要在 `apply` 里 `await` 之后再回填**：cordis 的 `apply` 可以是异步的，但本插件刻意同步，保证加载即完成。
- **不需要 `peerDependencies`**：只用 `ctx.on` / `ctx.get` / `ctx.logger` / `session.append` 这些稳定面，
  别为了类型声明把 DSH 版本范围写死，否则平台闸门可能整个跳过插件。
- 本插件没有 client 半：不要声明 `dsh.client`。但包名**仍要**进 profile 的 `dsh.profile.bundles`，
  `bundles` 控制宿主侧装配，不是浏览器插件清单。

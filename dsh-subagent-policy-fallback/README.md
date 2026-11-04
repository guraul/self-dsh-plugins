# dsh-subagent-policy-fallback

给 **种子 / 恢复 / fork 出来的 DSH 会话**补上 `subagent/model-selection-policy`
事件，让这些会话里的 subagent 也能按设置显式指定 `provider/model`。

纯宿主插件：**没有浏览器半边、没有路由、没有界面**。装上即生效。

## 它解决什么

DSH 的 subagent 模型选择有一处覆盖缺口：

- 你打开设置、允许 subagent 选择若干 `provider/model`；
- **新建的顶层会话**里，subagent 可以指定这些路线；
- **种子会话 / 恢复会话 / fork 出来的历史会话**里，subagent 拿不到可选路线，只能继承父会话。

原因是上游只在 `agent/created` 时、对 `firstLiveSeq === 0` 的顶层新会话采样设置并追加
`subagent/model-selection-policy`。恢复出来的会话 `firstLiveSeq !== 0`，永远等不到这条事件。

上游讨论：<https://github.com/deepseek-ai/deepseek-harness/discussions/8444>

## 它做什么

| 时机 | 行为 |
|---|---|
| 插件加载 / 重启 | 对 `ctx.sessions.list()` 里**已存活**的会话各跑一次 |
| `agent/created` | 对新出现的会话跑一次 |
| 会话 `origin === 'subagent'` | **跳过**：子会话继承父会话，不做二次分发 |
| 日志里已有 `subagent/model-selection-policy` | **跳过**：幂等，不会写第二条 |
| `subagentModelSelection` 服务不存在 | **跳过** |
| 服务 `enabled === false` 或 `allowedModels` 为空 | **跳过** |
| 其它情况 | `session.append('subagent/model-selection-policy', { allowedModels })`，并用 `ctx.logger.info` 记一行审计（写明补了几条路由） |

插件刻意**不复制**上游的 `firstLiveSeq === 0` 判据——本插件存在的意义正是覆盖它漏掉的会话。
重复追加由「日志里已有事件就跳过」兜住。

## 配置

```yaml
# cordis 组合里
dsh-subagent-policy-fallback:
  enabled: true   # 默认 true；改成 false 完全不注册监听、也不回填
```

插件只读 DSH 已有的 subagent 设置，不新增自己的模型配置：

```js
ctx.get('subagentModelSelection').current()
// → { enabled: boolean, allowedModels: [{ provider, model }, ...] }
```

## 安装

本仓库的插件统一以 `link:` 依赖挂进 profile，不走 npm 发布：

```sh
# 在 profile 目录（默认 ~/.dsh/profiles/web）里把本目录加进 dependencies，然后
pnpm install
```

装完**重启 dsh web** 才会加载新插件（重启会终止当前会话，注意时机）。
`dsh-subagent-policy-fallback` 没有 client 半，但**仍要把包名加进 `dsh.profile.bundles`**——
`bundles` 决定宿主侧装配哪些插件，不是浏览器插件清单；不需要声明 `dsh.client`。

## 自己验一下

```sh
cd dsh-subagent-policy-fallback
pnpm test        # 10 条：注入、幂等、子会话、服务缺失、enabled=false、apply 回填
pnpm run lint    # lib/ + test/ 全量 node --check
```

真机验收（需要重启 dsh web）：

1. 打开 subagent 模型选择，配置至少两条路线；
2. 恢复一个旧会话（或从历史会话 fork），让其中的 subagent 显式选模型；
3. 宿主日志里应出现
   `subagent-policy-fallback: 为会话 <id> 补齐 N 条 subagent 模型路由`；
4. 同一个会话再次恢复 / 插件重载，不应出现第二条策略事件。

## 已知限制

- 依赖 DSH 服务的**运行时形状**（`ctx.get('subagentModelSelection').current()`）。上游若改名或改返回结构，
  插件会退化成「什么都不做」——不会崩，但也不会补。
- 只补「当前宿主里存活」的会话；进程没跑起来的会话要等它恢复后再补。
- 子会话不单独补，继续继承父会话；这是上游语义，不是遗漏。
- 不修改任何上游文件，也不碰 `dsh-subagents` 或其它插件。

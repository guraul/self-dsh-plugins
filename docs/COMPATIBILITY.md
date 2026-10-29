# DSH 兼容矩阵（插件实测记录）

> 本表记录**插件 × dsh 版本**的实际验证结果。规则 6（见根 [`AGENTS.md`](../AGENTS.md)）要求：
> 插件的 `peerDependencies` 声明不覆盖当前 dsh 时，profile 会**跳过该 bundle**（表现是插件莫名其妙没加载）。
> 所以"放宽声明"必须先验证、再放宽，并把 verdict 同时写进插件的
> `package.json` → `dsh.compatibility.dshReleases` 与本文。
>
> **版本豁免（`dsh plugin allow-version --accept-risk`）不是本表的替代品**——那只是逃生舱，
> 用完必须撤销，且不能作为放宽 peer 声明的依据。
>
> `dsh-plugin-product-subagents` 另有一份更细的插件级记录：
> [`dsh-plugin-product-subagents/docs/COMPATIBILITY.md`](../dsh-plugin-product-subagents/docs/COMPATIBILITY.md)。
> 本文是**跨插件**的汇总表，逐个插件补行即可。

## 门禁的真实口径（`@deepseek-ai/dsh-app-boot` 实测）

`evaluatePluginCompatibility()` 的判定顺序：

1. 插件 `package.json` **有 `engines.dsh`** → **只**看它，`peerDependencies` 一律忽略；
2. 否则遍历 `peerDependencies`，**每一个** `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 都必须满足；
3. 判定用 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`。

由此得出两条实操结论：

- `dsh.compatibility.dsh` / `dshReleases` 是**纯记录**，门禁不读；真正起作用的是 `peerDependencies`。
  反之，**给插件加 `engines.dsh` 会让逐条 peer 检查整体失效**——别为了"让门禁过"而加。
- `includePrerelease: true` 下 `^0.2.1-rc.2` 已经覆盖 `0.2.1-rc.4` 甚至 `0.2.2-alpha.2`；
  之所以之前升不上去，是因为那些 peer 写的是**精确版本** `0.2.1-rc.2`，不是 range。
  仍然按"每个验过的 patch 线单独锚点"写，是为了让**验过哪些版本**在声明里一眼可见。

## 矩阵

| 插件 | 包版本 | 验过的 dsh 版本 | 结果 | 日期 | 怎么验的 |
|---|---|---|---|---|---|
| `dsh-im-bridge-workspaces` | `@mhfire/dsh-im-bridge@0.4.4-ws.2` | `0.2.1-rc.2` | ✅ 通过 | 2026-10-29 | 一次性 `DSH_HOME`：`plugin --profile headless add` + `--dump-config` grep + headless 启动看到插件自身日志 |
| `dsh-im-bridge-workspaces` | `@mhfire/dsh-im-bridge@0.4.4-ws.2` | `0.2.1-rc.4` | ✅ 通过 | 2026-10-29 | 同上（headless 启动输出 `[im-bridge] workspaceRegistry 不可用…` / `[im-bridge] 跳过启动: 缺少 botId/secret…`） |
| `dsh-im-bridge-workspaces` | `@mhfire/dsh-im-bridge@0.4.4-ws.2` | `0.2.2-alpha.2` | ✅ 通过（装配/加载）<br>⚠️ 降级：`reasoningEffort` | 2026-10-29 | 同上；语义差异见文末"已知差异" |

**未验证的版本不要写进表**。验不过的版本按下面"失败时怎么记"处理。

## 验证方法（可复现）

```sh
# 一次性 DSH_HOME，绝不碰真实 ~/.dsh
H=$(mktemp -d)
trap 'rm -rf "$H"' EXIT

DSH_HOME="$H" pnpm dlx @deepseek-ai/dsh@<V> plugin --profile headless add <插件绝对路径>
DSH_HOME="$H" pnpm dlx @deepseek-ai/dsh@<V> --profile headless --dump-config | grep -c '<包名>'
```

判定：`add` 退出码 0 **且** `grep -c` ≥ 1，两条都满足才算"装配成功"。

想再确认"不只是配置里有、而是真被加载"，可以再起一次 headless（`dsh --profile headless` 需要带 task
参数，裸跑会以 rc=1 退出，那是用法错误、不是插件错误）：

```sh
DSH_HOME="$H" pnpm dlx @deepseek-ai/dsh@<V> --profile headless 2>&1 | head -20
```

## 验证时看什么

装配通过 ≠ 行为正确。放宽声明前还要确认插件**实际用到的** API 在这些版本里还在：

| 检查项 | 做法 |
|---|---|
| 包目录是否存在该版本 | `pnpm view @deepseek-ai/<pkg>@<V> version` |
| 源码 import 的符号是否还在 | 解包 tarball，`grep` 对应 `lib/types/**/*.d.ts` |
| 整体改动面 | `diff -rq <pkg>@<旧> <pkg>@<新>`；只有 `package.json` 不同 = 纯版本号，零风险 |
| 签名/语义是否变了 | 光看 `.d.ts` 不够，**要读 `lib/index.js` 的实现**（`installModelSelection` 就是这样被发现的） |

## 失败时怎么记

- 装配失败 → **该版本不加锚点**，本表对应行结果写"❌ 失败"并附原始报错摘要。
- 装配通过但有语义降级 → 结果列写"✅ 通过（装配/加载）+ ⚠️ 降级：<具体项>"，并在文末"已知差异"写清影响面。
- **任何情况下都不许用版本豁免把失败版本"变绿"**；也不许为了让门禁过而加 `engines.dsh`。

## 已知差异（`@mhfire/dsh-im-bridge` vs `0.2.2-alpha.2`）

`@deepseek-ai/dsh-agent` 的 `installModelSelection` 在 `0.2.2-alpha.2` 改了签名：

| 版本 | 签名 | 行为 |
|---|---|---|
| `0.2.1-rc.2` / `0.2.1-rc.4` | `installModelSelection(agentCtx, selection: ModelSelectionRef)` | 第二个参数**驱动**每次请求的 `provider` / `model` / `reasoningEffort`（挂在 `agent/request` + `system-prompt/assemble` 上） |
| `0.2.2-alpha.2` | `installModelSelection(agentCtx)` | 第二个参数被移除，只剩"切换模型时插一条 notice"；路由改由 Session projection（`AgentModel`）决定 |

插件 `src/index.ts` 仍按旧签名调用 `installModelSelection(agentCtx, selected)`。在 `0.2.2-alpha.2` 上：

- 多传的参数被 JS 忽略，**不会报错、不会崩溃**，插件照常加载（已实测）；
- `provider` / `model` 仍然生效——插件同时把它们作为 `agentOptions` 传给了 `agents.create` / `resume`；
- **`reasoningEffort` 配置项会静默失效**（它只在那个被忽略的 selection 里传递）。
  只在用户显式填了非空 `reasoningEffort` 时才有影响；未填时行为不变。

要彻底对齐需要在插件侧按 dsh 版本分支（或改用 `AgentModel` 的投影路径），属独立任务，本次**只放宽声明不改编排逻辑**。

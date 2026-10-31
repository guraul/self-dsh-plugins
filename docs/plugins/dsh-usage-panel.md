# dsh-usage-panel（插件级 agent 说明）

> 面向 agent 的工作要点。目录：`dsh-usage-panel/`　包名：`dsh-usage-panel`
> 来源：**fork**（[`AlfredChaos/dsh-usage-panel`](https://github.com/AlfredChaos/dsh-usage-panel)，MIT）。
> 本仓版本 `0.2.3-fork.1`；面向使用者的说明见 [`../../dsh-usage-panel/README.md`](../../dsh-usage-panel/README.md)（上游原文），
> 上游自己的 agent 说明保留为 [`../../dsh-usage-panel/UPSTREAM-AGENTS.md`](../../dsh-usage-panel/UPSTREAM-AGENTS.md)。

## 一句话

设置页「消耗统计」：Token 用量 KPI、半年活跃热力图、按模型堆叠柱图 / 环形图、Top 会话表。
Host 半只读重算会话日志 + RPC 投影，**永不写回会话**。

## fork 基线（导入时的事实）

| 项 | 值 |
|---|---|
| 上游仓库 | `https://github.com/AlfredChaos/dsh-usage-panel` |
| 上游 commit | `f77e7f4a6f158d0869cc7924f70fa6837de0428a`（2026-09-15，`chore(package): declare dsh.engines.dsh minimum host floor`） |
| 上游版本 | `0.2.3` → 本仓 `0.2.3-fork.1` |
| 导入方式 | `git clone --depth 1`（HTTPS 在该网络下报 `HTTP2 framing layer` / `Empty reply from server`，改用 SSH）+ `tar` 复制，**不带 `.git`** |

## 本仓 fork 改了什么（相对上游 `f77e7f4`）

| 项 | 上游 | 本仓 |
|---|---|---|
| `package.json` `version` | `0.2.3` | `0.2.3-fork.1` |
| `package.json` `upstream` | 无 | 新增 `"upstream": "https://github.com/AlfredChaos/dsh-usage-panel"` |
| 包管理器 | npm（`package-lock.json`） | **pnpm**：删除 `package-lock.json`，`pnpm install` 生成 `pnpm-lock.yaml` |
| 构建脚本放行 | npm 默认跑 postinstall | 新增 `pnpm-workspace.yaml`：`allowBuilds: { esbuild: true }`（pnpm 11+ 用 `allowBuilds` 取代 `onlyBuiltDependencies`；设置不再读 `package.json` 的 `pnpm` 字段。不放行会 `ERR_PNPM_IGNORED_BUILDS`） |
| 子目录 `AGENTS.md` | 有 | 重命名为 `UPSTREAM-AGENTS.md`（本仓强制规定 1：全仓只允许根目录一份 `AGENTS.md`），内容未改 |
| `src/`、`tests/`、`scripts/` | — | **零改动**（`diff -rq` 与上游一致） |

> `pnpm build` 重建出的 `lib/` 与上游提交的产物**逐字节一致**（`diff -rq lib` 无输出），可放心把 `lib/` 当已打包状态。

## 基线（导入时实测，2026-10-31，node v24.21.0 / pnpm 12.6.0）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ exit 0 |
| `pnpm test` | ✅ exit 0（64 tests / 64 pass） |
| `pnpm build` | ✅ exit 0（`lib/index.js` 27.8kb、`lib/client.js` 56.7kb） |
| `pnpm check-pack` | ✅ exit 0（tarball 16 files，无静态资源） |

## 改哪里

| 路径 | 职责 |
|---|---|
| `src/host/index.ts` | 宿主入口：RPC 端点、投影注册、聚合（**子代理维度要接在这里**） |
| `src/host/scan.ts` | 只读扫描会话日志 |
| `src/host/aggregate.ts` | 按模型 / 按天聚合（当前**不分 depth**，主子混桶） |
| `src/host/projection.ts`、`projection-unit.ts` | 投影单元与缓存 |
| `src/client/StatsSection.tsx` | 「设置 → Usage」主区块 |
| `src/client/components/*` | KpiCards / Heatmap / BarChart / ModelDonut / SessionsCard / ProvidersCard / ExportMenu |
| `src/shared/` | 契约（`contract.ts`）、格式化（`format.ts`）、用量模型（`usage.ts`） |
| `lib/` | 构建产物（esbuild host ESM + client CJS factory + tsc d.ts），**已入库** |

## 注意

- 构建脚本里 `scripts/build.mjs` 用 `npx tsc`、`scripts/check-pack.mjs` 用 `npm pack --dry-run`：
  都是**上游脚本原文**，只调用本地 `node_modules/.bin`、不安装任何东西。要彻底 pnpm 化得改脚本（属功能改动，另开 issue）。
- 本插件目录**尚未**进 CI matrix（`.github/workflows/ci.yml` 的 `dir:` 列表）与根 `README.md` 插件索引，
  加进去之前 CI 会以 `::warning::` 跳过。
- 上游 `AGENTS.md`（现 `UPSTREAM-AGENTS.md`）里写的 `npm version` / `npm publish` 流程在本仓**不适用**：
  本仓通过 profile `link:` 挂载，没有发布流程。

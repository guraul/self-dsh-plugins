# AGENTS.md — self-dsh-plugins

给在本仓库工作的 AI agent 的说明。**每个子项目可能有自己的 `AGENTS.md`，它更具体、优先级更高** ——
改某个插件前先读那一个。

## 这是什么

自研 / 自维护的 [DeepSeek Harness](https://github.com/deepseek-ai)（`dsh`）插件集合。每个子目录是
一个独立插件，通过 profile 的 `link:` 依赖挂到本机 DSH 上，没有发布流程。

这个仓库同时是**本机 dsh web GUI 的工作目录** —— 你很可能正跑在这个进程里。

## 运行时事实（2026-10-17 实测）

| 项 | 值 |
|---|---|
| DSH | `0.2.0-rc.2`（npm `latest`），全局装在 nvm node `v24.21.0` 下 |
| Node / pnpm | `v24.21.0` / `12.6.0`（`dsh`、`pnpm` 都在 `~/.nvm/versions/node/v24.21.0/bin`） |
| `DSH_HOME` | `/Users/gubin/.dsh` |
| profile | `web` = `~/.dsh/profiles/web`，`patchReload: live` |
| GUI | <http://127.0.0.1:3080>（`dsh --profile web --no-open --port 3080`） |
| 进程管理 | LaunchAgent `com.deepseek.dsh-web.self-dsh-plugins`，plist 在 [`.dsh-web/`](./.dsh-web) |
| 运行日志 | [`.dsh-web/web.out.log`](./.dsh-web)、[`.dsh-web/web.err.log`](./.dsh-web) |

> ⚠️ **重启这个进程会终止当前会话。** 不要顺手重启；需要重启时用
> [`.dsh-web/restart-once.sh`](./.dsh-web/restart-once.sh)（它会延迟执行，让当前回复先发出去，并在重启后自检健康路由）。

## 目录

| 目录 | 包名 | 作用 | 自己的说明 |
|---|---|---|---|
| [`dsh-auto-upgrade/`](./dsh-auto-upgrade) | `dsh-plugin-auto-upgrade` | dsh Web UI 自升级：检测 → 兼容性预检 → 非阻塞浮层 → 备份/安装/校验/重启；本机插件兼容表 | [`README.md`](./dsh-auto-upgrade/README.md)、`docs/design/`、`docs/acceptance/` |
| [`dsh-external-discuss/`](./dsh-external-discuss) | `dsh-plugin-external-discuss` | 把 DSH 会话一键送到外部模型（清言网页版）继续讨论 | [`README.md`](./dsh-external-discuss/README.md) |
| [`dsh-im-bridge-workspaces/`](./dsh-im-bridge-workspaces) | `@mhfire/dsh-im-bridge` | 上游 `@mhfire/dsh-im-bridge@0.4.4` 的本地 fork，加多工作区 `/ws` 切换 | [`README.md`](./dsh-im-bridge-workspaces/README.md)、`README.upstream.md` |
| [`dsh-plugin-product-subagents/`](./dsh-plugin-product-subagents) | `dsh-plugin-product-subagents` | 把 Claude Code / Codex / 任意 ACP CLI 变成基于角色的可续接 subagent | [`AGENTS.md`](./dsh-plugin-product-subagents/AGENTS.md) |
| [`bb-browser-src/`](./bb-browser-src) | — | 上游快照，**带自己的 `.git`**，一般不动 | [`AGENTS.md`](./bb-browser-src/AGENTS.md) |

顶层其它文件：[`README.md`](./README.md)（对外说明）、[`upgrade-dsh.sh`](./upgrade-dsh.sh)（全局 dsh 升级/回滚/恢复）、
[`dsh-web-stop.sh`](./dsh-web-stop.sh)（停服）、[`dsh-upgrade-plan.md`](./dsh-upgrade-plan.md)、`docs/screenshots/`、`.tmp/`（临时草稿，不入库）。

## profile 是怎么接上去的

`~/.dsh/profiles/web/package.json` 里两处必须一致：

```jsonc
{
  "dependencies": {
    "dsh-plugin-auto-upgrade": "link:/Users/gubin/workspace/self-dsh-plugins/dsh-auto-upgrade"
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-plugin-auto-upgrade", /* … */] } }
}
```

- `dependencies` 用 `link:` 指向本仓库子目录 —— **不是**从 npm 下载的。
- `dsh.profile.bundles` 决定装配顺序；插件不在这个列表里就不会被加载。
- 新增插件：`dsh plugin --profile web add /Users/gubin/workspace/self-dsh-plugins/<dir>`
  （插件 `package.json` 声明了 `dsh.bundle.patch` 时会自动挂上 patch 层，无需手改 `cordis.patch.yml`）。
- 卸载：`dsh plugin --profile web remove <包名>`。
- `patchReload: live`：装完/改完通常**不用重启**，刷新页面即可。
- **改了 `link:` 目标路径后，必须在 `~/.dsh/profiles/web` 跑一次 `pnpm install`**，否则
  `node_modules/<包名>` 的软链会悬空（今天搬迁 `dsh-plugin-product-subagents` 时就遇到了）。

## 兼容性与版本豁免（最容易踩的坑）

DSH 启动时会检查每个 bundle **自己声明的** DSH peer 范围；不满足就把它变成 `disabled: true` 的行或
跳过该 bundle，并列入 `skippedBundles` —— 表现为"插件莫名其妙没加载"，而不是崩溃。

判定顺序是：**先看 `package.json` 的声明范围，再谈豁免**。

版本豁免（version exemption）是逃生舱，不是常规手段：

- 落在 `~/.dsh/profiles/web/compatibility.json`，是 `包名@版本 → 允许的 DSH 运行时版本` 的精确映射。
- **插件升版本、DSH 升版本都会让它自动失效**，于是插件会立刻重新变成"不兼容"。
- 写豁免等于明知未验证还强行加载，**只在拿到用户对具体版本组合的明确同意后**才用；CLI 需要 `--accept-risk`。

正确流程（2026-10-17 对 `dsh-plugin-product-subagents` 就是这么做的，可当模板）：

1. 先扩声明：`peerDependencies` + `dsh.compatibility.dsh` 加上目标版本；
2. 跑该插件自己的验收，拿到证据；
3. 把 verdict 写进 `dsh.compatibility.dshReleases`（该插件同时要求写进 `docs/COMPATIBILITY.md`），再 bump 插件版本；
4. 撤销豁免，确认 `version-exemptions` 为空。

⚠️ **prerelease 陷阱**：`^0.2.0-rc.2` **不覆盖** `0.2.1-rc.1`。预发布版本只满足
major.minor.patch 完全相同的比较器，所以每条 `0.2.x` 线都要单独写一个锚点。

常用命令：

```bash
dsh plugin --profile web version-exemptions
dsh plugin --profile web allow-version '<包名@版本>' --dsh-version <运行时版本> --accept-risk
dsh plugin --profile web revoke-version '<包名@版本>' --dsh-version <运行时版本>
```

## 怎么验证（别拿正在跑的服务器做实验）

一次性 `$DSH_HOME` 里验证 install + compose，完全不碰真实 `~/.dsh`：

```bash
V=$(dsh --version)
H=$(mktemp -d /tmp/dsh-check-XXXX)
DSH_HOME=$H npx -y @deepseek-ai/dsh@$V plugin --profile headless add \
  /Users/gubin/workspace/self-dsh-plugins/<dir>
DSH_HOME=$H npx -y @deepseek-ai/dsh@$V --profile headless --dump-config | grep '<包名>'
rm -rf "$H"
```

更完整的端到端验收（install → compose → boot → uninstall）：`dsh-plugin-product-subagents` 自带
`scripts/verify-dsh-profile.mjs`，直接照用或仿写。

各插件自己的检查：

| 目录 | 命令 |
|---|---|
| `dsh-auto-upgrade` | `npm test`、`npm run check` |
| `dsh-external-discuss` | `npm test`、`npm run check` |
| `dsh-im-bridge-workspaces` | `npm test`、`npm run typecheck`、`npm run build` |
| `dsh-plugin-product-subagents` | `npm test`、`npm run lint` |

## 运维

- **重启**：`.dsh-web/restart-once.sh [延迟秒]`（默认 30s；延迟是为了让当前回复先发出去），之后自检
  `/api/dsh-external-discuss/health` 并写 `.dsh-web/restart-once.log`。
- **停服**：`./dsh-web-stop.sh`（按 label bootout，覆盖本仓库与 `dshdiscussion` 两个 label）。
- **升级 dsh**：`./upgrade-dsh.sh`（交互式），或 UI 里的 `dsh-auto-upgrade` 插件。升级前会备份 `~/.dsh`，
  升级后校验版本号并做组合冒烟；日志在 `~/.dsh-upgrade-logs/`。
- **升级 dsh 之后的 checklist**：跑各插件测试/验收 → 看 `version-exemptions` 是否为空 →
  必要时补插件的版本声明（见上节流程）。

## 约定

- 目录名是插件短名，**包名以各自 `package.json` 为准**（如 `dsh-im-bridge-workspaces/` → `@mhfire/dsh-im-bridge`）。
- 多数插件**无构建步骤**（纯 ESM；浏览器半边手写在 `lib/client.js` 里，通过
  `window.__ModuleLoader__.load({ id, factory })` 注册）。`dsh-im-bridge-workspaces` 是例外，需要 build。
- 客户端半边改动：同 checkout 有 `pnpm run dev:web` 监听时走 HMR，否则重建产物 + 刷新页面。
- 每个插件在自己目录内维护 README、CHANGELOG，需要时加 `AGENTS.md`；
  面向用户的中英双语文档要**同时**改（如 `dsh-plugin-product-subagents` 的 `README.md` + `README.zh.md`）。
- 顶层 [`.gitignore`](./.gitignore) 是白名单（`/*` 加 `!` 例外），目前只收录 `dsh-auto-upgrade/`。
  **要把新插件纳入顶层版本管理，必须显式加例外**；带自己 `.git` 的子目录（`bb-browser-src/`、
  `dsh-plugin-product-subagents/`）按现状被顶层忽略，各自独立版本管理。
- `dsh-plugin-product-subagents/` 保留上游 git 仓库（origin = `shaokeyibb/dsh-plugin-product-subagents`），
  提交身份用 `HikariLan <i@hikarilan.life>`。

## 已知坑

- macOS 自带没有 `timeout`；用 `curl --max-time` 或后台任务 + `job_output` 控时。
- 长命令一律丢后台跑，别阻塞当前轮次。
- 改了 `link:` 目标后忘记 `pnpm install` → 软链悬空、插件加载失败。
- **不要 `rm -rf` 已装插件的目录**：正在运行的宿主已把模块载入内存，但任何重组合/重启都会失败。
- 仓库工作区里可能已有别人的未提交改动（例如 `dsh-auto-upgrade/`）；动手前先 `git status` 看清归属。

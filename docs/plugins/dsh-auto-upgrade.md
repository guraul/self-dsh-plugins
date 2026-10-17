# dsh-auto-upgrade（插件级 agent 说明）

> 从 `dsh-auto-upgrade/AGENTS.md` 迁移而来（2026-10-17，仓库统一治理 issue #1）。
> 仓库级约定见根 [`AGENTS.md`](../../AGENTS.md)；面向使用者的说明见 [`../../dsh-auto-upgrade/README.md`](../../dsh-auto-upgrade/README.md)。

- 目录：`dsh-auto-upgrade/`　包名：`dsh-plugin-auto-upgrade`　来源：原创

## 是什么

给 dsh Web UI 加「自升级」入口的双面插件：宿主半边注册路由族，浏览器半边注册浮层与设置页。
**无构建步骤**——浏览器半边手写在 `lib/client.js` 里，包在
`window.__ModuleLoader__.load({ id, factory })`。

## 目录

| 路径 | 作用 |
|---|---|
| `lib/index.js` | 宿主入口：14 条路由、两条门禁、交接调度 |
| `lib/client.js` | 浏览器半边：`shell.overlay` 浮层 + `settings.section` 设置页 + 重连 watchdog |
| `lib/host/*.js` | 纯逻辑：协议常量 / loopback 围栏 / HTTP 管道 / SemVer / 工具链 / registry / 兼容性 / 会话 / 状态 / 任务 / 备份 / helper |
| `docs/design/` | T1 设计：接口清单 + 数据流图 + 用户拍板结论 |
| `docs/acceptance/` | 验收报告：逐条证据 + **明确没验证什么** |
| `CHANGELOG.md` | 变更记录（含待办） |

## 动手前必读

1. **先看 `docs/acceptance/` 的「明确没有验证的部分」**：真机升级链路（备份 → `npm install -g` → 校验 →
   重启）从未执行过，只有假 npm/dsh 夹具下的证据。别把它当成「已经跑通了」。
2. **别自作主张执行这三件事**：`dsh plugin add/remove`（改 profile）、重启 dsh web（会杀掉当前会话）、
   `npm install -g`（替换正在运行的那棵树）。都要先拿到用户明确同意。
3. **改 UI 前读 `README.md` 的「UI 风格契约」**：尺寸/颜色/字重一律从 dsh 的设计 token 与官方实现里量出来，
   不要自己估；改完必须让 `test/client-register.test.mjs` 里的守卫通过。

## 命令

```sh
pnpm install                                  # 只有一个 react peer，复用共享 store
pnpm test                                     # = node --test "test/*.test.mjs"
pnpm run check                                # node --check
```

> 本插件是仓库内**唯一有 `.npmrc`、且只有 `pnpm-lock.yaml`** 的插件（`dsh-auto-upgrade/.npmrc` 指向共享 store）。

## 测试约定

- **关键路径不 mock**：路由跑真 `node:http` + 假 npm registry；兼容性判定跑**真官方 API**；
  升级 helper 用假 npm/dsh/launchctl 配**真 `/bin/sh`** 跑生成出来的脚本。
- **夹具必须自包含**：不要依赖其它仓库或外部插件的当前状态——它们会挪位置、会升级，
  就会让测试假失败（2026-10-17 就踩过一次，见 `CHANGELOG.md`）。
- 浏览器半边没有构建产物可验，只能靠 `client-register` / `client-protocol` 两条守卫 + 真浏览器冒烟。

## 两条门禁（改行为要同步测试与文档）

| 情况 | 行为 |
|---|---|
| 有会话在跑 | `409 E_SESSIONS_RUNNING`，`detail.bypassable = true` —— 前端弹警告，确认后可带 `force` 继续 |
| 已装插件与**目标版本**不兼容 | `409 E_PLUGIN_INCOMPATIBLE`，`detail.bypassable = false` —— 不可绕过 |

## 测试缝（不是公开配置）

`apply(ctx, { stateDir, registry, exit, scheduleHelper })` 里的 `exit` / `scheduleHelper` 只给单测用；
真机行为是「正常退出进程」与「fork 一个脱离进程的 helper」。别把它们接进 UI 或文档的配置说明。

## 状态目录

`$HOME/.dsh-auto-upgrade/`（`DSH_AUTO_UPGRADE_DIR` 可改写）：
`state.json`（当天检查记录）、`policy.json`、`settings.json`、`restart.log`、
`result.json`、`helper-payload.json`。

调试升级失败的现场顺序：`result.json`（哪一步失败）→ `restart.log`（helper 全量日志含 npm 输出）→
`helper-payload.json`（这次交接的完整输入：argv、目标版本、备份路径）。

## 另需注意的两条设计约束

- **本包故意不声明 `@deepseek-ai/dsh*` peerDependencies**（只声明 `react`）：否则升级之后，平台闸门会把
  「负责升级 dsh 的插件」自己判成不兼容（自锁）。官方模块用「运行时那份」动态 import
  （`lib/host/official.js` 经 `ctx.profileContext.installAnchor` 定位），不走 profile 的 `node_modules`。
- **交接必须脱离进程**：`npm install -g` 覆盖的正是宿主在跑的那棵树，而「停服」就是杀掉宿主自己；
  宿主只做「门禁 → 备份 → 落 payload → fork detached helper → `exit 0`」，其余在 helper 里跑。

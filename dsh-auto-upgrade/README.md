# dsh-plugin-auto-upgrade

给 dsh Web UI 加一个**自升级**入口：当天首次打开页面时自动检测 dsh 新版本 + 已装插件的兼容性，
用一个**不打断当前工作**的浮层提示，用户点「升级」后再走「会话门禁 → 体检 → 备份 → 安装 → 校验 → 重启」。

设计权威文档：[`docs/design/dsh-auto-upgrade-T1.md`](./docs/design/dsh-auto-upgrade-T1.md)（接口清单 + 数据流图 + 拍板结论）。
验收报告（含逐条证据与「没验证什么」）：[`docs/acceptance/dsh-auto-upgrade-acceptance.md`](./docs/acceptance/dsh-auto-upgrade-acceptance.md)。

## 当前状态（诚实清单）

| 能力 | 状态 |
|---|---|
| `GET /status`、`POST /check/auto`、`POST /check/run`、`GET /preflight`、`GET /plugins`、`GET|POST /policy`、`GET|POST /settings`、`GET /task`、`GET /restart/diagnostics` | ✅ 已实现并有单测 |
| 会话门禁（`ctx.agents.list()` → `status==='running'`，可强制） | ✅ |
| 插件兼容性门禁（对**目标版本**判定，不兼容则**不升级**，不可绕过） | ✅ |
| 备份 `~/.dsh` → 停服 → `npm install -g --allow-scripts=…` → 对版 + 组合冒烟 → 拉起 | ✅ helper 脚本，已用假 npm/dsh 跑通成功/失败/校验失败三条路径 |
| 回滚（重装指定旧版本） | ✅ |
| detached 重启交接（launchd 在管时用 `kickstart -k`，否则 detached spawn） | ✅ |
| 任务进度流（阶段 + 日志尾轮询）、页面重连 watchdog | ✅ |
| 浏览器半边：`shell.overlay` 浮层 + `settings.section` 设置页 | ✅ |
| `GET /notes`（release notes）、`POST /plugins/action`（写豁免/禁用插件） | ⛔ 未接线，如实返回 `501` |
| 静默自动升级 | ⛔ 按用户拍板暂不做（`policy.mode` 只接受 `notify`） |
| Windows | ⛔ 不支持（helper 是 POSIX sh），能力位已关闭 |

**真机安装、升级、重启尚未执行**——那三件事是用户授权闸门，见验收报告 §4。

## 安装（**属于用户授权闸门，需用户自己执行**）

```sh
dsh plugin --profile web add /Users/gubin/workspace/self-dsh-plugins/dsh-auto-upgrade
# 然后重启 dsh web（本机是 launchd 管理）
launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh-web.self-dsh-plugins
```

装到 profile 后，插件只是多一条路由族与两个 UI 座位；只有点「升级」才会改机器。

## 交接为什么必须脱离进程

`npm install -g` 覆盖的正是宿主此刻在跑的那棵树，而"停服"就是杀掉宿主自己。
所以宿主只做「门禁 → 备份 → 落 payload → fork detached helper → **exit 0**」，
停服 / 安装 / 对版 / 冒烟 / 拉起都在 helper（`lib/host/upgrade.js` 生成的 POSIX sh 脚本）里。
`exit 0` 是刻意的：本机 LaunchAgent 是 `KeepAlive{SuccessfulExit:false}`，非零退出会被 launchd 再拉一次。
helper 拉起新进程时，若检测到 `XPC_SERVICE_NAME` 指向的 launchd job 仍在，就用
`launchctl kickstart -k`，让服务继续留在 launchd 名下，而不是 fork 一个不受管理的孤儿进程。

## 为什么本包**不**声明 `@deepseek-ai/dsh*` 的 peerDependencies

平台用插件声明的 `@deepseek-ai/dsh*` peer 范围做**安装/启动兼容闸门**。
一个"负责升级 dsh 本体"的插件如果声明了 dsh peer，升级后就会把自己判成不兼容
（要么被闸门挡住，要么逼着自己写豁免）。所以本包只声明 `react`（浏览器半边需要），
宿主半边只用 Node 内置模块 + 运行时同源的官方模块（见下）。

官方模块（`evaluatePluginCompatibility` / `readProfilePlugins` / 豁免读写）**不用 `import` 拉**：
profile 的 node_modules 里没有官方包，pnpm 只会再装一份副本（版本未必等于运行时）。
`lib/host/official.js` 用 `ctx.profileContext.installAnchor`（正在运行的那份 dsh 安装的
package.json）推出**宿主此刻真正执行的** `dsh-app-boot` 绝对路径再动态 import。

## 开发

```sh
node --check lib/index.js lib/client.js          # 语法
node --test "test/*.test.mjs"                    # 14+ 用例，含真 http 服务与假 registry
node --test test/official-compat.test.mjs        # 需要本机装有 @deepseek-ai/dsh
```

测试要点：路由表靠真 `node:http` 起服务 + 假 npm registry（不联网）；
「不兼容插件」用真插件 manifest 跑真 `evaluatePluginCompatibility`；
浏览器半边与宿主的路由图由 `test/client-protocol.test.mjs` 强制一致（无构建步骤，只能靠测试）。

## UI 风格契约（别自造数值）

界面必须吃 dsh 自己的设计 token，数值逐条对齐官方实现，**不要自己估**：

| 用途 | 依据 | 取值 |
|---|---|---|
| 正文 / 强调 / 描述 | `--dsw-font-s-14` / `--dsw-font-s-strong-14` / `--dsw-font-xxs-12` | 14/22 · **500** 14/22 · 12/18 |
| 设置行 | 官方 `Pt1bsG_row` | `space-between` + `gap:24px` + `padding:16px 0` + `0.5px solid var(--dsw-alias-border-l2)` |
| 设置页按钮 / 下拉 | 官方模块平台按钮规则 | `height:36px` + `padding:0 14px` + `--dsw-radius-md` + `--dsw-alias-bg-module-platform`，**无边框** |
| **浮层卡片** | 官方浮层 `MenuSurface` + `Menu.list` | `--dsw-menu-surface-fill` + `blur(40px) saturate(150%)` + `--dsw-elevation-prominent`（描边走 `border-l1`）+ `--dsw-radius-lg` + `padding:12px 16px` |
| **浮层动作按钮** | primitives `Button.module.css` 的 `sm` + `outline` | `28px` + `padding:0 10px` + `--dsw-radius-sm` + `0.5px solid var(--dsw-alias-border-l3)`；主操作同尺寸 `primary` 实心 |
| 文本输入 | primitives `Input.module.css` | `32px` + `0.5px solid var(--dsw-alias-border-l4)` + `--dsw-alias-bg-layer-1` |
| 开关 | primitives `Switch.module.css` | `36x20` 胶囊 + `aria-checked` 驱动 + `--dsw-alias-brand-primary` |
| 颜色 | 语义 token | `label-primary/secondary/tertiary`、`state-warn-label`、`state-error-primary`、`state-success-primary` |

`test/client-register.test.mjs` 里有守卫：根规则必须用 `--dsw-font-s-14`、设置页按钮必须是 36px/`0 14px`、
浮层卡片必须用 `menu-surface-fill` + `backdrop-filter` + `elevation-prominent`、浮层按钮必须是 28px 的 outline、
开关必须是 36x20、用到的每个 `var(--dsw-*)` 必须在主题里真实存在（或自带 fallback）。

## 状态目录

`$HOME/.dsh-auto-upgrade/`（可用环境变量 `DSH_AUTO_UPGRADE_DIR` 改写）：

- `state.json` — 当天检查记录、上次检测结果
- `policy.json` — `{channel, exactVersion, mode, dailyCheck}`
- `settings.json` — `{overlay, dismissed, locale}`
- `restart.log` — 重启交接日志（变更半边接线后写入）

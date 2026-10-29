# dsh-plugin-auto-upgrade

给 dsh Web UI 加一个**自升级**入口：当天首次打开页面时自动检测 dsh 新版本 + 已装插件的兼容性，
用一个**不打断当前工作**的浮层提示，用户点「升级」后再走「会话门禁 → 体检 → 备份 → 安装 → 校验 → 重启」。
升级入口有**两处**：右下角浮层，以及设置页「自动升级」里的常驻入口（浮层被「不再提示」关掉也照样能发起）；
两处共用同一份计划卡与提交流程，两条门禁行为一致。

浮层上只有三个动作：**升级**（主操作）、**不再提示**、以及右上角的 **`×`**。`×` 就是「本次隐藏」，
与「稍后」完全等价，所以**不再单列「稍后」**；手动重检的正式入口是设置页的「**立即检查**」，
因此浮层在**所有状态（含错误态）**都不提供「重新检查」，避免两处入口漂移。

设计权威文档：[`docs/design/dsh-auto-upgrade-T1.md`](./docs/design/dsh-auto-upgrade-T1.md)（接口清单 + 数据流图 + 拍板结论）。
验收报告（含逐条证据与「没验证什么」）：[`docs/acceptance/dsh-auto-upgrade-acceptance.md`](./docs/acceptance/dsh-auto-upgrade-acceptance.md)。
变更记录：[`CHANGELOG.md`](./CHANGELOG.md)（含待办）。面向 agent 的工作约定：[`../docs/plugins/dsh-auto-upgrade.md`](../docs/plugins/dsh-auto-upgrade.md)。

## 当前状态（诚实清单）

| 能力 | 状态 |
|---|---|
| `GET /status`、`POST /check/auto`、`POST /check/run`、`GET /preflight`、`GET /plugins`、`GET|POST /policy`、`GET|POST /settings`、`GET /task`、`GET /restart/diagnostics` | ✅ 已实现并有单测 |
| `POST /report-issue`（门禁拒绝时一键把阻塞插件与要求记录成 GitHub issue，幂等） | ✅ 已实现并有单测（只接受 `{target}`，标题/正文由宿主生成） |
| `GET /notes`（release notes，确认卡折叠显示 + 在 GitHub 上看完整说明） | ✅ 已实现并有单测；拿不到时如实显示原因，不影响升级 |
| 会话门禁（`ctx.agents.list()` → `status==='running'`，可强制） | ✅ |
| 插件兼容性门禁（对**目标版本**判定，不兼容则**不升级**，不可绕过） | ✅ |
| 备份 `~/.dsh` → 停服 → `npm install -g --allow-scripts=…` → 对版 + 组合冒烟 → 拉起 | ✅ helper 脚本，已用假 npm/dsh 跑通成功/失败/校验失败三条路径 |
| 回滚（重装指定旧版本） | ✅ |
| detached 重启交接（launchd 在管时用 `kickstart -k`，否则 detached spawn） | ✅ |
| **真机**升级链路（备份 → 停服 → `npm install -g` → 对版 + 冒烟 → `kickstart` 拉起） | ✅ 2026-10-17 真机成功两次（见验收报告 §3.1） |
| 任务进度流（阶段 + 日志尾轮询）、页面重连 watchdog | ✅ |
| 浏览器半边：`shell.overlay` 浮层 + `settings.section` 设置页 | ✅ |
| 客户端注入声明 `dsh.client.inject` 对齐 DSH 0.2.1（旧 `@deepseek-ai/dsh-client-ui-slots` 已不存在） | ✅ 有守卫测试（声明包必须真实存在）；改声明需重启 dsh web 才生效，重启后要确认浮层/设置页仍挂载 |
| **设置页常驻升级入口**（浮层被「不再提示」关掉也有地方升级；与浮层同一份计划卡/流程） | ✅ |
| **降级护栏出路**（`downgrade-guard` 时点名建议渠道 + 「切到 `<渠道>`」按钮） | ✅ |
| **门禁拒绝点名**（列出阻塞插件与未满足要求，最多 3 条 + 等 N 项 + 修法；浮层/设置页共用一份渲染） | ✅ |
| **设置页插件表按判定目标版本评估**（`GET /plugins?version=<target>`，表头写明评估版本） | ✅ |
| `POST /plugins/action`（写豁免/禁用插件） | ⛔ 未接线，如实返回 `501`（写豁免按仓库约定必须先拿到用户对具体版本组合的同意） |
| 静默自动升级 | ⛔ 按用户拍板暂不做（`policy.mode` 只接受 `notify`） |
| Windows | ⛔ 不支持（helper 是 POSIX sh），能力位已关闭 |

**真机安装、升级、重启已执行**：2026-10-17 两次走完全链（`0.2.0-rc.2 → 0.2.1-alpha.5`、
`0.2.1-alpha.5 → 0.2.1-rc.2`），证据见 [`docs/acceptance/dsh-auto-upgrade-acceptance.md`](./docs/acceptance/dsh-auto-upgrade-acceptance.md) §3.1；
其余「明确没有验证的部分」见同一文件 §3。

## 一键开 issue 依赖本机 `gh`

升级被插件门禁挡住时，浮层与设置页的「开 issue 记录这个不兼容」会调宿主
`POST /api/dsh-auto-upgrade/report-issue`，由宿主用**本机已登录的 `gh`** 在
`package.json` 的 `repository.url` 指向的仓库建一条 issue（标题/正文由宿主生成，幂等：同名 open issue
存在时直接返回）。没装 `gh` 或未登录时接口 500 并给出原因；插件不会读取、也不会回显任何 token。

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
node --test "test/*.test.mjs"                    # 66 用例，含真 http 服务与假 registry
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
| **浮层卡片** | 官方账号通知卡 `AccountNotice.module.css`（`ui-settings-account`） | `280px` 宽 + `--dsw-specific-input-major` 白卡 + `--dsw-elevation-panel` + `16px` 圆角 + `padding:20px` + `14/22` 正文 + 标题 `500/20`（图标 `14×14`）+ 右上 `18×18` 关闭（`--dsw-alias-label-caption`，`top/right:6px`）+ `transform .25s ease-out`；**没有** `backdrop-filter` |
| **浮层定位** | 官方 `AccountNoticeStack` | 锚侧栏底部账号按钮：`left=max(8,min(anchor.left,innerWidth-288))`、`bottom=max(8,innerHeight-anchor.top+4)`；量到之前 `visibility:hidden`；锚点 `button[aria-haspopup="menu"][data-signed-out]` → `button[aria-label="账号菜单"]` → `left:8px;bottom:16px` |
| **浮层按钮区** | 正文下方的动作行 | `margin-top:12px` + `gap:8px` + `flex-wrap`；按钮仍是 28px 的 `.dsh-au-btn`（见下一行） |
| **浮层动作按钮** | primitives `Button.module.css` 的 `sm` + `outline` | `28px` + `padding:0 10px` + `--dsw-radius-sm` + `0.5px solid var(--dsw-alias-border-l3)`；主操作同尺寸 `primary` 实心 |
| 文本输入 | primitives `Input.module.css` | `32px` + `0.5px solid var(--dsw-alias-border-l4)` + `--dsw-alias-bg-layer-1` |
| 开关 | primitives `Switch.module.css` | `36x20` 胶囊 + `aria-checked` 驱动 + `--dsw-alias-brand-primary` |
| 颜色 | 语义 token | `label-primary/secondary/tertiary`、`state-warn-label`、`state-error-primary`、`state-success-primary` |

`test/client-register.test.mjs` 里有守卫：根规则必须用 `--dsw-font-s-14`、设置页按钮必须是 36px/`0 14px`、
浮层必须逐字照抄官方 `AccountNotice`（`280px` / `--dsw-specific-input-major` / `--dsw-elevation-panel` /
`16px` 圆角 / `20px` 内边距 / `14-22` 正文 / `transform .25s` / 右上 `18×18` 关闭 / **不许出现 `backdrop-filter`** /
不许自创 `@keyframes`）、官方标题那套必须限定在 `.dsh-au-card .dsh-au-title`（设置页复用了 `.dsh-au-title`，
不许被带偏）、`data-front` + `role="status"` + 关闭按钮 `aria-label` 齐全、浮层按钮必须是 28px 的 outline、
开关必须是 36x20、用到的每个 `var(--dsw-*)` 必须在主题里真实存在（或自带 fallback）。

视觉验收（本机）在 `test/visual/`：`probe-gui.mjs` 从**正在运行的 GUI** 抓 token / 锚点 rect / 官方 `AccountNotice`
已注入的 CSS 原文；`render-cards.mjs` 用真 React + worktree 里的真组件渲染浮层，并把**按官方 CSS/DOM 逐字注入的
复刻**并排摆出来，量两边 computed style + 出截图（`docs/screenshots/overlay*.png`）。官方卡本机**不可真实触发**
（`notices` 由服务端下发，`[data-front]` 为 0），复刻会明确标注。

## 状态目录

`$HOME/.dsh-auto-upgrade/`（可用环境变量 `DSH_AUTO_UPGRADE_DIR` 改写）：

- `state.json` — 当天检查记录、上次检测结果
- `policy.json` — `{channel, exactVersion, mode, dailyCheck}`
- `settings.json` — `{overlay, dismissed, locale}`
- `restart.log` — 重启交接日志（变更半边接线后写入）

另：重启交接成功后，helper 会把 **dsh web 的 token URL** 写回该实例日志目录下的 `url.txt`
（本机是 `<repo>/.dsh-web/url.txt`）。token 是进程级的、每次启动都变，只打印到 stdout，
所以只能从日志里取（`launchctl print` 的 `stdout path` → 最后一条 `?token=…`）。

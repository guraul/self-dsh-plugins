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
| `lib/client.js` | 浏览器半边：`shell.overlay` 浮层 + `settings.section` 设置页（含常驻升级入口与降级护栏出路）+ 重连 watchdog |
| `lib/host/*.js` | 纯逻辑：协议常量 / loopback 围栏 / HTTP 管道 / SemVer / 工具链 / registry / 兼容性 / 会话 / 状态 / 任务 / 备份 / helper |
| `docs/design/` | T1 设计：接口清单 + 数据流图 + 用户拍板结论 |
| `docs/acceptance/` | 验收报告：逐条证据 + **明确没验证什么** |
| `CHANGELOG.md` | 变更记录（含待办） |

## 浮层外观（官方账号通知卡同款）

浮层卡片的**呈现层**逐字照抄官方账号通知卡，差异只允许出现在「内容」与「按钮区」（检测/升级/备份/校验/重启/
Host API/设置页行为都不受影响）。

- 基准：`@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js` 里的
  `AccountNotice.module.css` / `NoticeCard` / `AccountNoticeStack`（包内私有，**拿不到组件，不许 import**，
  只能手抄 CSS 与 DOM 结构；前缀 `zwW4-W_` → `dsh-au-`）。
- 定位：锚侧栏底部账号按钮 `button[aria-haspopup="menu"][data-signed-out]` → `button[aria-label="账号菜单"]` →
  `left:8px;bottom:16px`；公式 `left=max(8,min(anchor.left,innerWidth-288))`、
  `bottom=max(8,innerHeight-anchor.top+4)`；算出前 `visibility:hidden`。
- 关闭按钮：`×` 只隐藏本次（等价 `setHidden(true)`）；「不再提示」仍是正文下方的按钮。
- 浮层动作只有三个：**升级**（`primary`）/ **不再提示** / 右上角 **`×`**。**没有「稍后」**——`×` 与它等价，
  重复显示只会让人以为两者不同；**没有「重新检查」**——手动重检的正式入口是设置页的「**立即检查**」，
  浮层**所有状态（含错误态）**都不给，避免两处入口漂移。`test/client-upgrade-entry.test.mjs` 会渲染浮层
  并断言动作区**恰好**只剩「升级 + 不再提示」（多一个按钮即红）。
- 本机浅色主题实测 token：`--dsw-specific-input-major` `#fff`、
  `--dsw-alias-brand-primary-new-colorprimary-new-color` `#4176e6`（名字很怪但真实存在，别改名别回退）、
  `--dsw-alias-label-caption` `#adb2b8`、`--dsw-alias-label-secondary` `#61666b`、
  `--dsw-elevation-panel` `0 0 0 .5px #00000029, 0 3px 8px 0 #00000008, 0 0 16px 0 #00000005`；
  `--dsw-focus-ring-color` 为空 → 官方 focus 规则会走 fallback `--dsw-alias-state-business-primary`（照抄即可）。

**官方卡在本机不可真实触发**：只在 `signedIn && !account.desktopOnboardingVisible && !account.onboarding &&
account.notices` 时渲染，`notices` 由服务端下发，DOM 里 `[data-front]` 恒为 0。所以视觉验收用
`test/visual/render-cards.mjs`：真 React + worktree 里的真组件渲染本插件，旁边摆一份「按官方 CSS/DOM 逐字注入的
复刻」，两边量 computed style + 出图（交付时会明确标注哪边是复刻）。

三个已知坑：

- `@deepseek-ai/dsh-client-ui-primitives` 在 dsh 0.2.1 的安装树里**已不存在**（实现被内联进各 bundle），
  官方关闭图标 `IconCloseOutlineRegular`（size 10）拿不到 → 按同尺寸内联等价 `10×10` ×。
- `.dsh-au-card` 只比官方多一条 `pointer-events:auto`（宿主的 `overlayLayer` 是 `pointer-events:none`），
  `.dsh-au-copy` 多一条 `max-height:calc(100vh - 200px);overflow:auto`（内容可能比一条通知长）；
  其余声明与官方原文逐字一致，`test/client-register.test.mjs` 会守住这一点。
- 官方标题那条（`500` / `line-height:20px` / `display:flex`）**必须加 `.dsh-au-card` 后代限定**：
  `.dsh-au-title` 同时被设置页的分组标题复用，不加限定会把设置页标题从 `500 14/22` 块级悄悄变成
  `flex + 20px`。所以是 `.dsh-au-title{font:var(--dsw-font-s-strong-14…)}` +
  `.dsh-au-card .dsh-au-title{…官方那套…}`，设置页保持原样。

## 动手前必读

1. **先看 `docs/acceptance/`**：真机升级链路（备份 → `npm install -g` → 对版/冒烟 → 重启交接）**已经真实跑通**
   （2026-10-17 两次，证据见验收报告 §3.1），但验收报告里其余「明确没有验证的部分」仍然成立，别把没验的当成跑通了。
2. **升级入口有两处**：右下角浮层（`shell.overlay`）与设置页（`settings.section`）。设置页的入口**常驻**，
   不受浮层 `dismissed` / `hidden` 影响；两处的**计划卡渲染与升级流程是同一份代码**
   （`renderPlanPanel` / `createUpgradeFlow` / `renderDowngradeExit`），改一处即改两处——**不要再抄一份**，
   `test/client-upgrade-entry.test.mjs` 有计数守卫盯着。
3. **`downgrade-guard` 是设计里的护栏，不要拆**：本机版本高于发布源时不给升级按钮；
   插件要做的是**给出路**（点出建议渠道 + 「切到」按钮，`POST /policy` → `POST /check/run`），
   而不是绕过护栏。宿主侧判定在 `lib/index.js`，改行为要同步门禁测试。
4. **别自作主张执行这三件事**：`dsh plugin add/remove`（改 profile）、重启 dsh web（会杀掉当前会话）、
   `npm install -g`（替换正在运行的那棵树）。都要先拿到用户明确同意。
5. **改 UI 前读 `README.md` 的「UI 风格契约」**：尺寸/颜色/字重一律从 dsh 的设计 token 与官方实现里量出来，
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
- 浏览器半边没有构建产物可验，只能靠 `client-register` / `client-protocol` / `client-upgrade-entry`
  三条守卫 + 真浏览器冒烟；其中 `client-upgrade-entry` 用一个迷你 react 替身**真渲染**成文本，
  断言「有更新才出现升级入口」「降级护栏要点名建议渠道」这类行为，而不只是源码里有没有字符串。

## 两条门禁（改行为要同步测试与文档）

| 情况 | 行为 |
|---|---|
| 有会话在跑 | `409 E_SESSIONS_RUNNING`，`detail.bypassable = true` —— 前端弹警告，确认后可带 `force` 继续 |
| 已装插件与**目标版本**不兼容 | `409 E_PLUGIN_INCOMPATIBLE`，`detail.bypassable = false` —— 不可绕过 |

## `/plugins` 响应的 `peers` 字段

`GET /api/dsh-auto-upgrade/plugins` 里每个插件带的 `peers` 是「未满足的 peer 明细」，取自官方
`evaluatePluginCompatibility()` 的返回。**0.2.1 起官方把该字段从 `peers` 改名成 `requirements`**，
所以 `lib/host/compat.js` 取值时**两个名字都认**（`issue.requirements ?? issue.peers ?? {}`）。
本插件对外的字段名**仍是 `peers`**（客户端契约不变）；改这里要同步 `test/official-compat.test.mjs`
的「映射保真」守卫——官方将来再改字段名，那条用例会红。

## 测试缝（不是公开配置）

`apply(ctx, { stateDir, registry, exit, scheduleHelper })` 里的 `exit` / `scheduleHelper` 只给单测用；
真机行为是「正常退出进程」与「fork 一个脱离进程的 helper」。别把它们接进 UI 或文档的配置说明。

## 状态目录

`$HOME/.dsh-auto-upgrade/`（`DSH_AUTO_UPGRADE_DIR` 可改写）：
`state.json`（当天检查记录）、`policy.json`、`settings.json`、`restart.log`、
`result.json`、`helper-payload.json`。

调试升级失败的现场顺序：`result.json`（哪一步失败）→ `restart.log`（helper 全量日志含 npm 输出）→
`helper-payload.json`（这次交接的完整输入：argv、目标版本、备份路径）。

**另有两处不在状态目录里、但重启链路会碰的文件**：

- dsh web 实例日志目录下的 `url.txt`（本机 `<repo>/.dsh-web/url.txt`）：helper 拉起新宿主后，
  从 `launchctl print` 给出的 `stdout path` 里取**最后一条** `?token=…` 写回；拿不到 launchd
  路径时退回 helper 自己的 `$OUT`。token 是进程级的，别指望它跨重启不变。
- 抓取逻辑在 `lib/host/token-url.js`（纯函数）+ `lib/host/refresh-url.mjs`（CLI），
  单测见 `test/token-url.test.mjs`。**别在 shell 里重新实现一份**。

## 另需注意的两条设计约束

- **本包故意不声明 `@deepseek-ai/dsh*` peerDependencies**（只声明 `react`）：否则升级之后，平台闸门会把
  「负责升级 dsh 的插件」自己判成不兼容（自锁）。官方模块用「运行时那份」动态 import
  （`lib/host/official.js` 经 `ctx.profileContext.installAnchor` 定位），不走 profile 的 `node_modules`。
- **交接必须脱离进程**：`npm install -g` 覆盖的正是宿主在跑的那棵树，而「停服」就是杀掉宿主自己；
  宿主只做「门禁 → 备份 → 落 payload → fork detached helper → `exit 0`」，其余在 helper 里跑。

## 客户端注入声明（`dsh.client.inject`）

`package.json` 的 `dsh.client.inject` 是**加载器声明**（告诉 loader 先把哪几个客户端包注册/激活），
不是服务注入——真正的服务注入是客户端里的 `exports.inject = ['slots']`（cordis 服务名）。别把两者混为一谈。

- **生效时机**：加载器在挂载时**缓存 manifest**，改这个声明**不会**热生效（页面刷新也不行），
  **必须重启 dsh web**。重启是**会终止当前会话**的操作，用仓库约定的 `.dsh-web/restart-once.sh`
  （见根 `AGENTS.md`），**不许随手重启**。
- **重启后必须确认**浮层与设置页仍正常挂载：该声明决定客户端加载顺序，写错会**静默不挂载而不报错**。
  核对手法：浏览器里 `window.__DSH_BOOT__.entries` 中该插件条目的 `inject` 字段，看是否已用上新声明。
- 0.2.1 起 `@deepseek-ai/dsh-client-ui-slots` **已不存在**（旧的 slots 包被拆开）。当前声明对齐 0.2.1：
  `dsh-client-ui-renderer`（提供 `slots` 服务）、`dsh-client-ui-layout`（声明 `shell.overlay`）、
  `dsh-client-ui-settings-general`（声明 `settings.section`）、`dsh-client-locale`（locale 注册）。
- `test/official-compat.test.mjs` 有守卫：**声明的每个包都必须在「正在运行的那份 dsh」安装树里真实存在**。
  改这里就必须同步改声明，否则测试会红（这正是它抓到本次漂移的方式）。
- 判定依据与官方对照表见 `CHANGELOG.md` 的 `[0.2.1]`。

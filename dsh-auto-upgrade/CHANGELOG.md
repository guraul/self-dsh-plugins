# CHANGELOG

记录 `dsh-plugin-auto-upgrade` 的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.2.0] — 2026-10-18

### 新增

- **设置页新增常驻升级入口**：检测结论是「有更新」（`update-available` / `update-with-plugin-risk`）时，
  设置页出现一行「发现新版本 `<target>`（当前 `<installed>`）」+「升级」按钮；点击走**与浮层完全相同**的流程
  （`GET /preflight` → 内联计划卡 → 「确认升级」/「取消」）。浮层被「不再提示」关掉、或浮层开关关掉，
  都不影响这个入口；会话门禁（可强制）与插件不兼容门禁（不可绕过）两处行为一致。
- **降级护栏给出路 + 点名跨线**：`decision === 'downgrade-guard'` 时，浮层与设置页都显示本机版本、
  当前渠道最新版，以及「把发布渠道改成 `<建议渠道>` 就能继续升级」；建议渠道取 `tags` 里版本号最高的渠道
  （`{latest:'0.2.0-rc.2',alpha:'0.2.1-alpha.5',next:'0.2.1-rc.2'}` → `next`；全相等或缺失时不给误导性建议），
  并提供「切到 `<建议渠道>`」按钮：`POST /policy {channel}` 成功后立即 `POST /check/run` 刷新结论。

### 修复

- **升级入口曾经完全不可达。** 装了 alpha/next 线而策略渠道是 `latest` → 宿主判 `downgrade-guard`，
  浮层按设计**不给**升级按钮；同时浮层被「不再提示」关掉（`settings.dismissed === true`），
  而设置页**原本没有任何升级入口**——没有任何地方能发起升级。现在设置页常驻入口 + 降级护栏点名出路，
  两个叠加原因都堵上。（插件链路本身没坏：真机升级已在 2026-10-17 成功跑通两次，
  见 `docs/acceptance/dsh-auto-upgrade-acceptance.md` §3.1。）

### 内部

- 计划卡渲染 / 降级出路渲染 / 升级流程（预检 → 提交 → 两条门禁 → 交接 watchdog）抽成
  `renderPlanPanel` / `renderDowngradeExit` / `createUpgradeFlow` 各一份，浮层与设置页共用，避免两处漂移。
- `suggestChannel(tags)` 作为可导出纯函数；浏览器半边没有构建步骤、无法 import 宿主模块，
  因而本地复刻了同语义的最小 SemVer 比较，并由测试与宿主 `compareVersions` 逐对比对防漂移。
- 宿主半边**一行未改**（门禁与交接逻辑不动），所以本次不需要重启 dsh web。

## [Unreleased]

### 待办（尚未做，不是"已完成"）

- `POST /plugins/action`（写精确版本豁免 / 禁用插件）仍返回 `501`——写豁免按仓库约定必须先拿到用户对具体版本组合的明确同意。
- Windows 不支持（helper 是 POSIX sh 脚本）。
- `test/official-compat.test.mjs` 有 2 条用例在本机 dsh 升到 `0.2.1-rc.2` 后失败：它硬依赖「运行时那份 dsh
  的客户端包名」，而 `@deepseek-ai/dsh-client-ui-slots` 已不在安装树里。与本次改动无关、在未改动的 main 上同样失败，
  本次未处理、也未放宽断言。
- 设置页升级入口的**真机点击**尚未验收（本轮只到「真渲染 + 假 fetch」的单测）。

## [0.1.1] — 2026-10-17

### 修复

- **重启后 `.dsh-web/url.txt` 仍是旧 token。** 访问 token 是**进程级**的、每次启动都变，且只打印到
  stdout；`url.txt` 因此永远停在历史值（本机停在 10-14 那次）。现在 helper 拉起新宿主后，从
  launchd job 的 stdout 日志里取**最后一条** `?token=…` 写回 `url.txt`（日志路径通过
  `launchctl print` 的 `stdout path` 取得，拿不到时退回 helper 自己的 `$OUT`），最多重试 30 秒。
- 抓取逻辑抽成纯函数 `lib/host/token-url.js` + CLI 包装 `lib/host/refresh-url.mjs`，由
  `test/token-url.test.mjs` 覆盖（多条历史 token 取最后一条、按端口过滤、无命中返回 undefined）。

### 说明

- **没有新增任何 UI**：设置页的「重启服务」本来就是完整重启链路
  （`POST /api/dsh-auto-upgrade/restart` → 门禁 → detached helper → `launchctl kickstart -k`），
  本次只补了它的一个副作用缺陷。

## [0.1.0] — 2026-10-12

### Added

- **双面插件骨架**：宿主半边注册路由族 `/api/dsh-auto-upgrade/*`（14 个端点，全部 loopback-only，
  有副作用的一律 POST）；浏览器半边手写注册 `shell.overlay` 浮层与 `settings.section` 设置页，无构建步骤。
- **只读半边**：`status` / `check/auto` / `check/run` / `preflight` / `plugins` / `policy` / `settings` /
  `task` / `restart/diagnostics`。
- **变更半边**：门禁 → 备份 `~/.dsh` → 落 payload → fork 脱离进程的 helper → 宿主 `exit 0`；
  helper 负责停服 / `npm install -g --allow-scripts=…` / 对版 + `--dump-default-config` 冒烟 / 拉起
  （被 launchd 管理时用 `launchctl kickstart -k`，否则 detached spawn）。
- **两条门禁**：有会话在跑 → `409`（`bypassable: true`，前端确认后可强制）；已装插件与**目标版本**不兼容
  → `409`（`bypassable: false`，不可绕过）。
- **用官方 API 判定兼容性**：`evaluatePluginCompatibility` / `readProfileVersionExemptions` /
  `readProfilePlugins`，且用 `ctx.profileContext.installAnchor` 定位**运行时那一份** `dsh-app-boot`。
- **35 个用例**：真 `node:http` 路由 + 假 npm registry；真官方 API；假 npm/dsh/launchctl + 真 `/bin/sh`
  跑生成的 helper；假 `ModuleLoader` + 假 react 装载浏览器半边。

### Changed

- 2026-10-17 — **接线 `GET /notes`**：从运行时那份 dsh manifest 推出 GitHub slug，按 `dsh-v<版本>` /
  `v<版本>` / `<版本>` 依次取 release，`plainNotes()` 把正文的 HTML 与锚点链接压成纯文本，
  确认卡上折叠显示「更新说明」并给出「在 GitHub 上查看完整说明」；拿不到时如实显示 `reason`，不影响升级。
  注意：宿主半边改文件不会热重载，运行中的进程要等重启才提供这个端点。

- 2026-10-16 — 包管理转为 **pnpm**：`.npmrc` 指向共享 store（`store-dir=/Users/gubin/workspace/global_node_modules`），
  `pnpm-lock.yaml` 只含 react（peer 自动安装）。
- 2026-10-16 — 设置页样式全部改用 dsh 设计 token，数值逐条对齐官方设置页实测（字体 `--dsw-font-*`、
  行布局照官方 `Pt1bsG_row`、按钮 36px / `0 14px` / `--dsw-alias-bg-module-platform`、开关逐字照
  primitives `Switch.module.css`）。详见 `README.md` 的「UI 风格契约」。
- 2026-10-17 — 浮层卡片对齐官方**浮层**语言：`--dsw-menu-surface-fill` + `blur(40px) saturate(150%)` +
  `--dsw-elevation-prominent`（照 `MenuSurface` / `Menu.list`），动作按钮改用官方 `Button` 的 `sm` + `outline`。

### Fixed

- 2026-10-16 — 当天已检测过时，浮层永远停在「正在检查…」；现在直接用上次结论并标注「今天已检查过」。
- 2026-10-16 — 点过「不再提示」后没有任何入口能恢复浮层；设置页新增「重新启用提示」。
- 2026-10-16 — 豁免态误用错误红（改为警告琥珀）；那段官方英文诊断折进「不兼容详情」。
- 2026-10-16 — 样式里三个**不存在**的 token（`--dsw-alias-label-warning/danger/success`）导致颜色静默退回硬编码。
- 2026-10-17 — `official-compat` 用例原先读外部插件仓库的 manifest，对方挪位置/升级就会挂；
  改为内联夹具（仍跑官方 API），并补了「同一插件在它自己声明的世代里必须判为兼容」的反向断言。

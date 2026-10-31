# CHANGELOG

记录 `dsh-plugin-auto-upgrade` 的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.2.5] — 2026-10-31

### 新增

- **把插件的自述兼容矩阵接进点名与开 issue（issue #106）。** `@mhfire/dsh-im-bridge@0.5.0-ws.1` 在
  `package.json` → `dsh.compatibility.dshReleases` 里记着 `"0.2.2-alpha.2": "incompatible"`（人工实测：
  `tsc` 报 TS2554、`reasoningEffort` 静默失效），但官方门禁 `evaluatePluginCompatibility()` **不读**这个字段；
  它的 peer 范围 `^0.2.1-rc.2 || ^0.2.1-rc.4` 在 `includePrerelease: true` 下覆盖 alpha.2 → 门禁判「兼容」→
  界面什么都不显示。现在：
  - **三态读取**：`lib/host/compat.js` 新增 `declaredVerdict(manifest, targetVersion)` ——
    `compatible` / `incompatible` / **缺失即 `unverified`（从未验证）**；非法记录值同样按 `unverified`。
  - **响应形状**：`GET /plugins` 与检测结果里每个插件都带 `declared: { verdict, source: 'self-declared' }`；
    新增 `flagged` 列表把**门禁阻塞（`gate`）**与**自述有问题（`self-declared`，含 `unverified`）**合并，
    每条带 `sources`（可能是两者）。**`incompatible` 数组与 `decision` 的判定逻辑一行未动**——
    自述矩阵只「提出」，不「阻断」。
  - **UI**（`renderPluginBlock`，浮层/设置页共用）：门禁放行时标题是「门禁已放行，但插件自述有问题」；
    `self-declared` 的 `incompatible` 显示「插件自述已知不兼容」+ 矩阵原文 + 修法 + 开 issue 按钮。
    **升级按钮保持可用**，卡片动作区仍只有「升级 + 不再提示」。
  - **`unverified` 不逐条占位**（同版本内收敛口径）：只折叠成一行「另有 N 个插件未验证该版本」，
    展开（`<details>`）才看名单；这一行**没有**开 issue 入口、也不渲染自述矩阵的修法。
    「我没测过」不是「已知不兼容」——否则任何没写矩阵的插件都会变成一条假阻塞。
  - **`/report-issue`**：点名列表只取**实时判定里的已知不兼容**（门禁 `gate` 或自述 `incompatible`），
    正文固定带「自述兼容矩阵证据」表（插件 / 来源 / 目标版本 / 矩阵记录 / verdict）；
    `unverified` 只作一行背景（「另有 N 个插件未验证该版本」），不进表格、不点名。
    门禁放行、只有自述 `incompatible` 时标题是「… N 个插件自述兼容性有问题」，不诬陷成「阻塞」；
    **只有 `unverified` 时返回 `400`**（「只有 N 个未验证的插件，没有已知不兼容，无需开 issue」），
    不调用 `gh`。

### 内部

- 新增 `test/declared.test.mjs`（3 条：三态、非法值、`flagged` 来源合并）；`test/routes.test.mjs`
  覆盖自述 `incompatible` 进点名且 `/update` 仍 202、正文带矩阵证据；只有 `unverified` 时
  `/report-issue` 回 400 且不调 `gh`；混合现场只把 `incompatible` 写进 issue、`unverified` 只作背景。
  `test/client-upgrade-entry.test.mjs` 覆盖浮层/设置页逐条点名 + 折叠行、
  **只有 `unverified` 时两处都没有开 issue 按钮**、过期快照不铺自述结论，另加共用渲染计数守卫。
  用例总数 77 → 87。把 `declaredVerdict` 改成恒 `compatible`、或把开 issue 的判据放宽到
  「`flagged` 非空」，这些用例都会红（非空转反证）。

## [0.2.4] — 2026-10-31

### 修复

- **过期缓存不再当结论：升级成功后界面不再显示旧的「当前版本」（issue #100）。** 用 `alpha` 渠道升到
  `0.2.2-alpha.2` 后，界面仍显示「发现新版本 0.2.2-alpha.2（当前 0.2.1-rc.5）」——`/status` 的
  `dsh.installed` 是实时的正确值，但客户端优先读了 `lastCheck.installed`（升级前那次检测的缓存），
  而「当天只检测一次」的幂等又把这份过期结论锁了一整天。`next` / `latest` 渠道看不出问题，只是因为
  缓存里 `installed == target`，错得恰好正确。三处一起修：
  - **宿主判定过期**：新增 `lib/host/staleness.js`（纯函数，不联网），`GET /status` 的 `lastCheck`
    补 `stale` 与 `staleReason`：`lastCheck.installed !== 实时已装版本` → `installed-changed`；
    否则 `lastCheck.channel !== policy.channel` → `channel-changed`；两项同时变时优先 `installed-changed`。
    `/status` **只标过期，不重算**。
  - **`POST /check/auto` 遇过期必须重算**：当天的幂等只在「前提仍然成立」时回放缓存，升级成功或换渠道
    之后按新事实重新检测；前提没变时仍然走缓存（原幂等不受影响）。
  - **客户端**：「当前版本」一律用实时的 `status.dsh.installed`，缓存里的 `installed` 只用于一行
    「上次检查时是 `<X>`」；`lastCheck.stale === true` 时不采用过期 `decision`（不给升级按钮），
    转而触发一次 `POST /check/run` 并显示「正在重新检测…」。补检由浮层与设置页**共用一个 promise**，
    **每次页面加载最多一次**，避免两个面板同时打开时反复打 registry。

### 内部

- 新增 `lib/host/staleness.js` 与 `test/staleness.test.mjs`（7 条纯函数用例）；`test/routes.test.mjs`
  新增「installed 变了 / 换渠道 / 两者都变 / 前提一致仍走缓存」一条多段用例；`test/client-upgrade-entry.test.mjs`
  新增 3 条渲染用例（stale 不铺旧结论且只补检一次、补检替换结论、当前版本取实时值）。
  用例总数 66 → 77。门禁语义（`compatible` / `exempted` / `incompatible`）、升级链路与 `/report-issue` 未改动。

## [0.2.3] — 2026-10-29

### 新增

- **门禁拒绝时点名不兼容插件 + 给出路。** 浮层与设置页改用同一份 `renderPluginBlock`：标题「不能升级到
  `<target>`：」，逐条列出 `插件@版本 要求 <依赖>`（精确范围写成「精确 `<版本>`」），要求明细放在
  `<details>` 里且每个插件**最多列 3 条**，其余折叠成「等 N 项」；下面固定给「→ 修法：放宽该插件的 peer
  声明后重跑其装配验收（`scripts/pipeline/install-check.sh <插件目录>`）；或为该版本组合申请版本豁免」。
  数据全部来自官方 `evaluatePluginCompatibility()` 返回的 `requirements`（经 `lib/host/compat.js` 映射到
  `/plugins` 与 409 `detail.plugins` 的 `peers`），**不自算范围**。
- **一键开 issue（`POST /api/dsh-auto-upgrade/report-issue`）。** 请求体只接受 `{target}`（精确版本号）；
  标题与正文由宿主根据当前检测结果生成（不接受任意文本），用 `gh issue create` 在 `package.json`
  `repository.url` 指向的仓库创建。创建前先 `gh issue list --search <标题> --state open`，同名 open issue
  存在则直接返回 `created:false`。返回 `{ok, number, url, created}`；`gh` 不存在/未登录 → 500 + 原因；
  仓库解析不到 → 400。**不调用 `gh auth token`，不回显任何 token。** 前端两处（浮层/设置页）都有
  「开 issue 记录这个不兼容」，成功后在同一块内保持显示 `#N` 链接。

### 修复

- **设置页插件表按判定目标版本取数。** 原先调 `GET /plugins` 不带 `version`，宿主默认用**已装版本**判定，
  于是表里全「兼容」，与同屏的「目标版本 X 被插件阻塞」自相矛盾。现在按 `lastCheck.target` 取
  `GET /plugins?version=<target>`，表头写明「已装插件兼容性（按 `<target>` 评估）」；没有检测目标时
  如实写「按本机已装版本评估」。

### 内部

- 新增 `lib/host/report-issue.js`：标题/正文生成、`gh issue list --json` 解析、issue URL 解析、
  幂等创建；`apply(ctx, { runGh })` 新增测试缝（与 `exit` / `scheduleHelper` 同级，仅单测使用）。
- 新增 7 条用例（总计 66）：浮层点名/折叠/修法、设置页按目标版本取数、点按钮开 issue 并显示 `#N`、
  宿主创建成功 / 同名已存在 `created:false` / `gh` 报错 500 / 参数与空阻塞校验。

## [0.2.2] — 2026-10-18

### 修复

- **`/plugins` 响应里不兼容插件的 `peers` 恒为空（官方 0.2.1 字段改名）。** 官方
  `evaluatePluginCompatibility()` 返回对象里的「未满足项」字段在 0.2.1 从 `peers` 改名为 `requirements`，
  而 `lib/host/compat.js` 仍读 `issue.peers ?? {}`，于是每个**不兼容**插件在
  `GET /api/dsh-auto-upgrade/plugins` 的 `peers` 都成了 `{}`。现在取值时**两个官方名字都认**
  （`issue.requirements ?? issue.peers ?? {}`）；**本插件对外的响应字段名仍是 `peers`**（不随官方改名，
  客户端契约不变），**判定逻辑一行未动**（`compatible` / `exempted` / `incompatible` 均不受影响）。
  影响面仅限「接口保真 / 信息缺失」——不崩溃、不影响门禁判定，客户端今天也还没读这个字段。

### 内部

- `test/official-compat.test.mjs` 新增一条守卫：用真官方 API + 内联不兼容夹具，让**本插件的映射**
  （`evaluatePlugins`）走一遍，断言响应里的 `peers` 非空且**等于**官方未满足项；并断言官方返回对象里
  **至少存在 `requirements` 或 `peers` 之一**，两者都没有就当场清晰失败（说明官方 API 契约又变了），
  而不是让断言静默空转。**官方将来再改字段名，这条用例必须红。**

## [0.2.1] — 2026-10-18

### 修复

- **移除已不存在的客户端注入声明。** dsh 升到 `0.2.1-rc.2` 后，安装树里 `@deepseek-ai/dsh-client-ui-slots`
  已被拆掉；`dsh.client.inject` 改为对齐 0.2.1 的最小且正确列表：
  `@deepseek-ai/dsh-client-ui-renderer`（提供 `slots` 服务）、`@deepseek-ai/dsh-client-ui-layout`
  （声明 `shell.overlay`）、`@deepseek-ai/dsh-client-ui-settings-general`（声明 `settings.section`）、
  `@deepseek-ai/dsh-client-locale`（`locale` 注册）。这是**加载器声明**，不是服务注入
  （服务注入仍是客户端里的 `exports.inject = ['slots']`）；写错会让守卫测试红、也会让加载顺序失去保障。
- **修掉 `test/official-compat.test.mjs` 的连锁抛错。** 官方 `evaluatePluginCompatibility` 返回里的
  「未满足项」字段在 0.2.1 从 `peers` 改名为 `requirements`，旧用例读 `bare.peers` 时
  `Object.keys(undefined)` 直接抛 `TypeError`，把真因糊掉。现在取不到字段会给出「官方 API 契约已变、
  前置条件缺失」的清晰失败，**没有放宽任何断言**（仍要求未满足项非空）。

### 说明

- 功能未受影响：0.2.1-rc.2 上设置页「自动升级」section 正常渲染、浮层可正常挂载、页面无 JS 错误。
- 已知遗留（不在本次范围）：`lib/host/compat.js` 仍读 `issue.peers ?? {}`，在 0.2.1 上该字段已改名
  `requirements`，所以「不兼容插件」明细里的 peers 列表恒为空（不崩溃，仅信息缺失）。

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

### 变更

- **浮层卡片改成官方账号通知卡（AccountNotice）同款外观。** 位置/宽度/圆角/阴影/内边距/正文排版/标题行
  （铃铛图标 + 标题）/右上角关闭按钮/过渡动画逐条对齐官方 `AccountNotice.module.css`（前缀 `zwW4-W_` →
  `dsh-au-`），差异只在内容与按钮区；定位改锚侧栏底部账号按钮（`button[aria-haspopup="menu"][data-signed-out]`
  → `button[aria-label="账号菜单"]` → 左下角兜底）。`×` 只隐藏本次，「不再提示」仍是按钮。
  检测/升级/备份/校验/重启/Host API/设置页行为零改动（官方标题那套限定在 `.dsh-au-card .dsh-au-title`，
  避免波及设置页复用的 `.dsh-au-title`）。
- 视觉验收脚本 `test/visual/`（probe-gui / render-cards）：真 GUI 抓 token 与锚点，真 React 渲染本插件 +
  官方 CSS/DOM 复刻并排量 computed style；截图见 `docs/screenshots/overlay*.png`。
- **浮层去掉「稍后」与「重新检查」两个按钮。** 右上角 `×` 就是「本次隐藏」（等价 `setHidden(true)`），
  与「稍后」完全等价，所以不再重复显示「稍后」。手动重检的正式入口是**设置页的「立即检查」**，
  因此浮层里**所有状态（含错误态）**都不再提供「重新检查」按钮——避免两处入口漂移。
  随之删除不再被引用的字典键 `overlay.later` / `overlay.recheck`（中英两套）。
  保留：升级（primary）、不再提示、右上角 `×`，以及升级计划卡的「确认升级 / 取消」。

### 待办（尚未做，不是"已完成"）

- `POST /plugins/action`（写精确版本豁免 / 禁用插件）仍返回 `501`——写豁免按仓库约定必须先拿到用户对具体版本组合的明确同意。
- Windows 不支持（helper 是 POSIX sh 脚本）。
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

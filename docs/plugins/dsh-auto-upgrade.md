# dsh-auto-upgrade（插件级 agent 说明）

> 从 `dsh-auto-upgrade/AGENTS.md` 迁移而来（2026-10-17，仓库统一治理 issue #1）。
> 仓库级约定见根 [`AGENTS.md`](../../AGENTS.md)；面向使用者的说明见 [`../../dsh-auto-upgrade/README.md`](../../dsh-auto-upgrade/README.md)。

- 目录：`dsh-auto-upgrade/`　包名：`dsh-plugin-auto-upgrade`　来源：原创

## 是什么

给 dsh Web UI 加「自升级」入口的双面插件：宿主半边注册路由族，浏览器半边注册浮层与设置页。
设置页里能直接看到升级确认卡的**预检分项与逐插件待处理**，页底还有一行可展开的预检摘要
（#422 起把试装 / 冒烟 / 兼容性三块独立面板收进这两处）。
**无构建步骤**——浏览器半边手写在 `lib/client.js` 里，包在
`window.__ModuleLoader__.load({ id, factory })`。

## 目录

| 路径 | 作用 |
|---|---|
| `lib/index.js` | 宿主入口：15 条路由、三条门禁、交接调度、一键开 issue |
| `lib/client.js` | 浏览器半边：`shell.overlay` 浮层 + `settings.section` 设置页（含常驻升级入口、两段式升级确认卡与页底预检摘要）+ 重连 watchdog（连续失败约 30s 后切「令牌已更换」指引，不再承诺「会自动重新连接」，issue #293） |
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

## 三条门禁（改行为要同步测试与文档）

| 情况 | 行为 |
|---|---|
| 有会话在跑 | `409 E_SESSIONS_RUNNING`，`detail.bypassable = true` —— 前端弹警告，确认后可带 `force` 继续 |
| 已装插件与**目标版本**不兼容 | `409 E_PLUGIN_INCOMPATIBLE`，`detail.bypassable = false` —— 不可绕过 |
| 预检结果缺失或 `blocked` | `409 E_PREFLIGHT`，`detail.bypassable = true` —— `force` 跳过并写 `force-audit.jsonl` 留痕 |

## 升级预检管线（P1 兼容 + P2 试装 + P3 启动预演，#421 / #425）

把「P1 兼容性判定 + P2 试装 + P3 启动预演」收进一次可落盘的预检，`/update` 以结果文件为前置门禁
（门禁只看 P1 / P2；P3 只警告）。

- **`POST /api/dsh-auto-upgrade/preflight`**：body 可带 `{version}`（精确版本号）。
  不给时依次取 `state.lastCheck.target` → `policy.channel === 'exact'` 的 `exactVersion` →
  当前渠道的 registry `dist-tag`；都取不到回 `400`。后台跑，**`202` + `{startedAt, target, taskId}`**；
  phase 先 `preflight`，P3 阶段切到 `rehearse`。并发 `409 E_BUSY`。
- **`GET /api/dsh-auto-upgrade/preflight`**：`{ok, preflight: <既有工具链体检>, runner: {running, startedAt, target, error}, result}`。
  `preflight` 键名保持不变（浏览器半边一直读它）；`result` 是落盘的预检结果，缺失时为 `null`。
- **结果文件** `$STATE_DIR/preflight.json`（原子写，`stateDir` 默认 `~/.dsh-auto-upgrade`）：

```json
{
  "schema": 2,
  "at": 1763100000000,
  "target": "0.2.2-rc.2",
  "plugins": [
    {
      "name": "dsh-awake",
      "version": "0.1.4",
      "enabled": true,
      "p1": {
        "ok": true,
        "verdict": "ok",
        "requirements": {},
        "declared": "compatible",
        "depth": "L2"
      },
      "p2": { "ok": true, "reason": "装配通过（新增 dsh-awake）" }
    }
  ],
  "p3": {
    "ok": false,
    "launch": "ok",
    "entries": { "dsh-awake": "active", "dsh-usage-panel": "inactive" }
  },
  "blocked": false,
  "warnings": [
    { "plugin": "dsh-usage-panel", "kind": "p3-inactive", "reason": "启动预演中条目未激活" }
  ]
}
```

  - `p1.verdict`：`ok` / `pending` / `requirements`（官方门禁要求未满足，**阻断**）/ `unverified`
    （manifest 读不到或插件自述从未验证，**只警告**）。
    - **`ok` 只给 L2 及以上**（`dshDepth` 记录到 L2 / L3 / L4）；门禁放行但只到 `L1`、或压根没记
      深度时降级为 `pending`——「可装配 · 未验证行为」不是兼容，GUI 把它计入待处理而不是通过。
    - `p1.depth` 原样取自 `dsh.compatibility.dshDepth[<目标版本>]`，没记录 / 非法值就**不写这个字段**
      （旧消费方看不到它也不影响判定）。
    - `p1.requirements` 原样取自官方 `evaluatePluginCompatibility()` 的未满足项；`p1.declared` 是
      自述矩阵三态，不改变门禁结论。`enabled: false` 的插件不阻断，也不进待处理。
  - `p2`：只对 `link:` / `file:` 依赖做一次性 `DSH_HOME` 真装；装不上即 `ok: false` 并阻断。
    其余插件为 `{ok: true, skipped: true, reason}`。**预检的 P2 不复用 `/probe` 的结论缓存**
    （`useCache: false` 强制真装）：缓存对应的是别的一次性 HOME，`plugin add` 被跳过时当前
    HOME 的 profile 仍是空的，P3 会把所有预期条目误报成 `inactive`。
  - `p3`：P3 启动预演结果，**永远不参与 `blocked`**。
    - `launch`：`'ok'`（目标版本 dsh 的 web 真的起来、探针跑完且日志无 `StartupError`）、
      `'skipped'`（没有 `link:` / `file:` 目标，没有 profile 可预演；`entries` 为空对象）
      或 `'failed'`（目标版本装不上 / 启动器抛错 / 退出码非 0 / 进程以 0 退出但探针没打印 `done` /
      90s 内 web 端口不可访问或探针没跑完 / 日志出现 `StartupError`，原因在 `error` 里）。
    - `entries`：`{插件包名: 'active' | 'inactive'}`。`active` 来自真实启动后 Loader 条目状态
      （预演时通过 `--patch` 注入一个极小探针，等 `appReady` 后遍历 `ctx.loader.entries()`）；
      启动失败时所有预期条目均为 `inactive`；`launch: 'skipped'` 时为空对象。
    - `ok`：`launch !== 'failed'` 且所有条目 `active`（`launch: 'skipped'` 时为 `true`）；仅供界面展示，**不是门禁**。
    - `error?`：仅在 `launch === 'failed'` 时出现。
  - `blocked`：任一启用插件 P1=`requirements` 或 P2 失败时为 `true`；`pending` / `unverified` 不置位，
    P3 也不改变它。
  - `warnings[]`：`kind` ∈ `inventory`（清单读取失败）/ `p1-unverified` / `declared-incompatible` /
    `p3-failed`（整个启动失败，`plugin: null`）/ `p3-inactive`（单个条目没起来），
    **只放不阻断的信息**（`plugin: null` 表示整个清单 / 整个启动的问题）。
  - `schema` 在判定口径变化时 +1；GUI / 进度页应拒绝未知大版本的 `schema`。2 = 新增 `p3`；
    `schema: 1` 的旧文件没有 `p3`，按 `null` 处理。`p1.depth` 与 `verdict: 'pending'` 是**新增可选
    字段与枚举值**（旧消费方按「不是 ok 就不算通过」读仍然正确），所以版本号不再动。
- **`/update` 门禁**：结果文件缺失 → `409 E_PREFLIGHT`（`detail.reason='missing'`）；
  `blocked === true` → `409 E_PREFLIGHT`（`detail.reason='blocked'`, `detail.blocked=[插件名]`）；
  两者 `detail.bypassable = true`。body 带 `force: true` 时跳过本门禁，并往
  `$STATE_DIR/force-audit.jsonl` 追加一行：

```json
{"at":"2026-11-14T08:00:00.000Z","from":"0.2.1-rc.5","to":"0.2.2-rc.2","blocked":["dsh-awake"],"reason":"blocked"}
```

  ⚠️ `force` **只**跳过预检门禁，不改变上表里 P1 硬门禁的行为：目标版本与已装插件不兼容时仍然
  `409 E_PLUGIN_INCOMPATIBLE`。
- **P3 的范围**：同一个一次性 `DSH_HOME` 里真启动一次，不启动 3080、不碰全局安装；超时上限 90s。
  - 目标版本二进制单独落盘：`npm install --prefix <一次性 HOME>/.dsh-rehearsal-target
    @deepseek-ai/dsh@<target>`（安装上限 180s），用装出来的 `node_modules/.bin/dsh` 启动。
    **装不上就是 `launch: 'failed'`，不回退到当前宿主二进制**（否则会把「目标版本起不来」伪装成
    「起得来」）。
  - 启动形态：`dsh --profile <probe> --patch <overlay> --port 0 --no-open`。预演会把一次性
    profile 的 `dsh.profile.bundles` 前面补 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，
    否则 profile 挂完插件就退出、永远不打印 URL。⚠️ 不能写 `dsh web --profile <probe>`：
    `dsh web` 会展开成 `--profile web`，再加 `--profile` 会报
    `select a profile only once`（0.2.2-rc.3 实测）；`dsh --profile <probe> … --port 0` 是等价形态。
  - 端口从 stdout 的 `dsh web: http://127.0.0.1:<port>/?token=…` 解析（只取 origin + port，
    **token 不落日志、不进错误文案**），轮询 `/` 直到有响应（401 也算起来）。
  - 插件自身的外部连接不由预演拦截。
  ⚠️ 已知欠账（#428）：GUI 的「有会话正在跑」确认框目前仍复用 `force: true`，因此会**顺带**跳过
  预检门禁并写一条 `force-audit`。宿主补上 `confirmSessions: true` 后客户端再改成只带该字段。
- **未实现**：逐插件处置动作（升级 / 应用声明 / 临时禁用 / 自愈）与进度页接入留给后续 PR；
  GUI 的升级卡已在 #422 接入，但**尚未展示 P3 结论**（界面仍写「启动预演 未接入（P3）」，见下节）。

## GUI 收口：两段式升级卡 + 页底预检摘要（#422）

只动浏览器半边（`lib/client.js`），宿主路由与门禁不变。

- **删掉三块独立面板**：「试装结论」+「跑一次试装」、「冒烟结论」+「跑一次冒烟」、
  「已装插件兼容性」清单。对应的字典键、`API.probe` / `API.smoke` / `API.plugins` 常量、
  `passState` / `behaviourUnverified` 一并删除；路由仍在宿主侧（`test/client-protocol.test.mjs`
  把它们列进 `HOST_ONLY`）。
- **保留**：发布渠道、当天首次自动检测、显示浮层、重新启用提示、立即检查、本机体检、重启服务、回滚。
- **升级确认卡（两段式）**：`renderPlanPanel` 第一段是目标版本（含当前版本）与备份路径；第二段读
  `GET /preflight` 的 `result`：
  - `兼容判定 N/M · K 个待处理`（N = `p1.verdict === 'ok'`，即 **L2+**；`pending`（只到 L1 / 没记深度）
    与 `unverified` 都算待处理，**不看 `p1.ok`**——它只表示「不阻断」）；
  - `试装 N/M`（分母只算 `p2.skipped !== true` 的插件；没有可试装项时显示「无 link:/file: 项」）；
  - `启动预演 未接入（P3）`——宿主侧的 P3 已由 #425 实现并写进 `result.p3`，但 GUI 还没展示；
    **没接入就写没接入**，不拿试装冒充启动检查。
  - 逐插件一行 `⚠ <name> <未验证|可装配 · 未验证行为|装不上|装配失败>：<原因>`，一个插件只出一行
    （优先级：P1 要求未满足 → P2 装不上 → P1 未验证 → P1 仅装配）。
  - 按钮 `[取消] [重新预检] [开始升级] [仍要升级]`。`开始升级` 在 `result === null`、
    **`result.blocked !== false`**（缺字段 / 旧 schema 同样禁用）、预检正在跑或 `busy` 时禁用；
    `仍要升级` 调 `POST /update` 带 `force: true`（宿主跳过预检门禁并写 `force-audit.jsonl`）。
    `重新预检` = `POST /preflight`（202）→ 按 `PREFLIGHT_POLL_MS` 轮询 `GET` 到 `runner.running === false`，
    再用新快照替换卡片；轮询间隔与上限见 `PREFLIGHT_POLL_MS` / `PREFLIGHT_POLL_MAX`。
- **页底摘要**：`<details>` 一行
  `最近一次预检：N 个问题 · M 个插件（K 个未验证）`（K 含 `pending`），展开是目标/结论时间、
  逐插件原因与清单读取告警。
  进设置页时 GET 一次，`重新预检` 成功后通过 `onPreflight` 写回同一份 state。
  ⚠️ **boot-check 仍是占位**：`stateDir/boot-check.json` 还没有端点，`renderPreflightSummary` 里留了
  `TODO(#422/boot-check)`；在宿主提供接口前**不要**编「本次已临时禁用 X 个」这类数字。
- **稳定口径**：分项计数与逐插件行是纯函数 `preflightCounts()` / `preflightIssues()`（已导出给单测）；
  浮层与设置页仍共用同一份 `renderPlanPanel`，`test/client-upgrade-entry.test.mjs` 有计数守卫。

## 过期缓存不算结论（0.2.4，issue #100）

**一句话**：`state.lastCheck` 只是一份**有前提的快照**（当时的已装版本 + 当时的渠道），前提变了就不许再当结论。

- **判定只有一处**：`lib/host/staleness.js` 的 `checkStaleness(lastCheck, { installed, channel })`，纯函数、不联网。
  顺序即优先级：`lastCheck.installed !== 实时已装版本` → `installed-changed`；否则
  `lastCheck.channel !== policy.channel` → `channel-changed`；都一致 → `{stale:false, staleReason:null}`。
  实时已装版本取不到（安装树解析失败）时**不做已装版本比较**（否则每次都会虚报过期、白重算）。
- **`GET /status` 只标过期，不重算**：返回的 `lastCheck` = 原快照 + `{stale, staleReason}`。
  缓存里的 `installed` 刻意保留原值——它的唯一用途是让界面说「上次检查时是 `<X>`」。
- **`POST /check/auto` 遇过期必须重算**：「当天只检测一次」的幂等只对**前提仍成立**的快照生效，
  否则升级成功 / 换渠道之后会被锁死一整天（0.2.3 的真实故障）。前提没变时仍走缓存（`cached:true`）。
- **客户端**（`lib/client.js`，浮层与设置页同一口径）：
  - 「当前版本」**一律**用 `status.dsh.installed`；缓存里的 `installed` 只写一行
    `overlay.staleInstalled`（「上次检查时是 `<X>`」）。**不要再写回 `check?.installed ?? …` 那种回落。**
  - `lastCheck.stale === true` 时 `decision` 一律不用（不出升级按钮、不铺降级护栏、不点名插件），
    显示「正在重新检测…」（`overlay.staleChecking`）并补检一次。
  - 补检 = `POST /check/run`，由 `recheckStaleOnce()` 里的**模块级 promise** 承担：
    浮层与设置页共用同一个请求，**每次页面加载最多一次**（模块一次页面加载只加载一次）。
    单测用 `exports.resetStaleRecheck()` 复位这道闸门。
- **守卫**：`test/staleness.test.mjs`（判定矩阵）、`test/routes.test.mjs` 的「过期缓存：…」
  （四种现场 + 前提一致仍走缓存）、`test/client-upgrade-entry.test.mjs` 的 3 条渲染用例
  （stale 不铺旧结论 / 只补检一次 / 当前版本取实时值）。把 `checkStaleness` 改成恒 `false` 时这些用例必须红。

## `/plugins` 响应的 `peers` 字段

`GET /api/dsh-auto-upgrade/plugins` 里每个插件带的 `peers` 是「未满足的 peer 明细」，取自官方
`evaluatePluginCompatibility()` 的返回。**0.2.1 起官方把该字段从 `peers` 改名成 `requirements`**，
所以 `lib/host/compat.js` 取值时**两个名字都认**（`issue.requirements ?? issue.peers ?? {}`）。
本插件对外的字段名**仍是 `peers`**（客户端契约不变）；改这里要同步 `test/official-compat.test.mjs`
的「映射保真」守卫——官方将来再改字段名，那条用例会红。

`?version=<精确版本>` 决定判定目标；缺省时宿主退回**已装版本**。#422 起设置页**不再消费**这条路由
（兼容性清单已删，结论统一走预检）；脚本 / 后续 PR 要用它时必须带 `version=<check.target>`，
否则会按已装版本判成全「兼容」，与同屏的升级结论自相矛盾（0.2.3 就是这么修的）。

## 门禁拒绝时点名 + 一键开 issue（0.2.3）

- **只读数据源**：被点名的插件与要求都来自官方 `evaluatePluginCompatibility()` 的 `requirements`
  （经 `compat.js` 映射成 `/plugins` 与 409 `detail.plugins` 里的 `peers`）。**不要在前端自己算范围**。
- **共用一份渲染**：`lib/client.js` 的 `renderPluginBlock` 同时被浮层与设置页调用（`client-upgrade-entry`
  有计数守卫）。每个插件最多列 3 条 `名字 精确 版本`，其余折叠成「等 N 项」，明细放在 `<details>` 里
  （浮层卡片只有 280px）。
- **开 issue**：`POST /api/dsh-auto-upgrade/report-issue`，body 只接受 `{target}`（精确版本号）。
  标题与正文由宿主根据当前检测结果生成（**不接受任意文本**），repo 从本包 `package.json` 的
  `repository.url` 经 `repositorySlug()` 解析；解析不到 → 400。先
  `gh issue list --search <标题> --state open` 精确比对标题，命中同名 open issue 则 `created:false`。
  `gh` 不存在/未登录 → 500 + 原始原因。**绝不调用 `gh auth token`，绝不回显 token。**
- 前端两处按钮都在同一个块内；成功后同一块显示保持可见的 `#N` 链接。

## 插件自述兼容矩阵（0.2.5，issue #106）

**一句话**：插件 `package.json` 的 `dsh.compatibility.dshReleases` 是**人工实测记录**，官方门禁不读它；
本插件把它作为「提出」信息接进点名与开 issue，**绝不**让它阻断升级。

- **三态读取**：`lib/host/compat.js` 的 `declaredVerdict(manifest, targetVersion)` ——
  `compatible` / `incompatible` / **缺失即 `unverified`（从未验证）**。非法记录值（拼错、写成对象等）
  同样按 `unverified` 处理：没有可用结论就不许假装验证过。
- **响应形状**：`GET /plugins` 与检测结果里每个插件带 `declared: { verdict, source: 'self-declared' }`；
  另有 `flagged` 列表把**门禁阻塞（`gate`）**与**自述有问题（`self-declared`，含 `unverified`）**合并，
  每条带 `sources`（可能是两者）。`incompatible` 数组与 `decision` 仍**只**由门禁决定——
  `/update` 的阻断行为一行未动。
- **UI**：`renderPluginBlock`（浮层/设置页共用）里，门禁放行时标题改成「门禁已放行，但插件自述有问题」；
  **已知不兼容**（门禁 `gate` 或自述 `incompatible`）逐条点名：`incompatible` 显示「插件自述已知不兼容」+
  矩阵原文 + 修法 + 开 issue 按钮。`unverified` **不逐条占位**，只折叠成一行
  「另有 N 个插件未验证该版本」（`<details>` 展开看名单），这一行**没有**按钮、也不渲染自述矩阵修法。
  **升级按钮保持可用**（自述矩阵不是门禁）。
- **`/report-issue`**：点名列表取实时判定（只读本地 manifest，不联网），但**只取已知不兼容**——
  门禁阻塞（`gate`）或自述 `incompatible`。正文固定带「自述兼容矩阵证据」表
  （插件 / 来源 / 目标版本 / 矩阵记录 / verdict）；`unverified` 只作一行背景
  「另有 N 个插件未验证该版本」，不进表格、不点名。只有自述 `incompatible` 时标题是
  「… N 个插件自述兼容性有问题」，不诬陷成「阻塞」。**只有 `unverified` 时端点返回 `400`**
  （「只有 N 个未验证的插件，没有已知不兼容，无需开 issue」），且不调用 `gh`——
  「我没测过」不是「已知不兼容」，不该被开成 issue。

⚠️ **这份矩阵可能过期 / 漏记**。它只代表某次人工实测的结论，不是门禁语义，也不保证门禁会拦；
上游插件改了矩阵又没同步 `docs/COMPATIBILITY.md` 时，界面会如实照抄插件自述——所以要改这里时，
必须保住 `test/declared.test.mjs` 的三态用例与 `test/routes.test.mjs` 的「自述矩阵：…」三条线
（含「只有 `unverified` → `/report-issue` 400」）；把 `declaredVerdict` 改成恒 `compatible`、
或把开 issue 的判据放宽到「`flagged` 非空」时它们必须红（非空转反证）。

## 测试缝（不是公开配置）

`apply(ctx, { stateDir, registry, exit, scheduleHelper, runGh })` 里的 `exit` / `scheduleHelper` / `runGh`
只给单测用；真机行为是「正常退出进程」「fork 一个脱离进程的 helper」「执行本机 `gh`」。
别把它们接进 UI 或文档的配置说明。`runGh(args)` 返回 `{ok, stdout, error}`，单测用它断言
「创建成功 / 同名已存在 / gh 报错」三条路径，**不需要真的在仓库里开 issue**。

## 状态目录

`$HOME/.dsh-auto-upgrade/`（`DSH_AUTO_UPGRADE_DIR` 可改写）：
`state.json`（当天检查记录）、`policy.json`、`settings.json`、`restart.log`、
`result.json`、`helper-payload.json`。

调试升级失败的现场顺序：`result.json`（哪一步失败）→ `restart.log`（helper 全量日志含 npm 输出）→
`helper-payload.json`（这次交接的完整输入：argv、目标版本、备份路径）。

**另有两处不在状态目录里、但重启链路会碰的文件**：

- dsh web 实例日志目录下的 `url.txt`（本机 `<repo>/.dsh-web/url.txt`）：helper 拉起新宿主后，
  从 `launchctl print` 给出的 `stdout path` 里取**最后一条** `?token=…` 写回；拿不到 launchd
  路径时退回 helper 自己的 `$OUT`。token 是进程级的，重启会换；**启动后 10 分钟内也接受上一个令牌**（旧标签页不必立刻重开，0.9.9 起）。
  **注意：浏览器根本不带这个令牌**——宿主把带令牌的地址 **303** 重定向到干净地址，并下发
  `HttpOnly + SameSite=Strict` 的 cookie。所以写接口按 `Sec-Fetch-Site` 判定：**只有 `same-origin` 放行，
  其余值（`cross-site` / `same-site` / `none`）一律拒绝**；**没有该头（curl / 脚本）才要令牌**（令牌校验是 0.9.6 引入的，按来源判定是 0.9.10）。
  已知限制两条：① Safari < 16.4 等不发 `Sec-Fetch-*` 的老浏览器会被当脚本，写操作要令牌 → 会 401；
  ② 本机进程可以自己带 `Sec-Fetch-Site: same-origin` 绕过——这道防线**只挡跨站网页**，不挡本机进程
  （同用户的进程本来就能直接读 `url.txt`）。
  **写入前两判据缺一不可**（issue #293 的竞态修复）：① 只认重启后新出现的 URL——helper 在
  `relaunch` **之前**用 `refresh-url.mjs --print-latest` 抓 baseline，刷新时 `--previous` 传回，
  与 baseline 相同就 `exit 1` 继续重试；② 候选 URL 必须真能认证——`fetch(url, { redirect: 'manual',
  signal: AbortSignal.timeout(3000) })` 状态 ∈ {200, 302, 303} 才写，401 / 连不上一律 `exit 1`。
  重试上限 60 次；耗尽时 helper 日志写 `WARNING: url.txt was NOT refreshed …`（含 grep 最新 URL 的
  指引），**绝不静默当成功**（`say "url.txt refreshed"` 只在真刷新成功后出现）。
- 抓取逻辑在 `lib/host/token-url.js`（纯函数）+ `lib/host/refresh-url.mjs`（CLI），
  单测见 `test/token-url.test.mjs` 与 `test/refresh-url.test.mjs`（含端到端 helper 用例）。
  **别在 shell 里重新实现一份**。

## 升级前「试装」探针（#300 P1）

`GET /probe` 读缓存/进度，`POST` 后台开跑（不阻断、并发 `409`）。一次性 `DSH_HOME` 里把每个
`link:` / `file:` 插件真装一遍，判据见 `lib/host/probe.js`；**`/probe` 本身仍只作警告，不进阻断判定**。
（#421 的预检复用同一执行器，但会把 P2 失败计入 `preflight.json` 的 `blocked`——差别在调用方，不在探测器。）

## 升级后「逐插件冒烟」（#300 P2）

`GET /smoke` 读结论，`POST` 后台开跑。宿主兜底三项（Loader 启用（取不到时回退 profile 的
`dsh.profile.bundles`）/ 插件目录 / `dsh.client.inject` 可解析）+ 插件自报断言（`dsh.smoke = { module, timeoutMs }`，模块导出 `run()`）。没写 `dsh.smoke`
的插件只跑兜底三项并标 `partial`——不假装验过行为。`run(context)` 会收到宿主的
`dshVersion` / `dshDir`：断言要验**宿主实际加载的那份**，别 import 到插件自己 node_modules 的旧副本。
目前声明了 `dsh.smoke` 的有 `dsh-im-bridge-workspaces` 与 `dsh-subagents`。

兜底三项的判据（#413 修正）：

- **启用** = **运行中 Loader 的未禁用条目**（`loader.entries()` 的 `options.name`）；取不到 Loader
  时才回退 profile 的 `dsh.profile.bundles`。`cordis.patch.yml` 用 insert 声明的行不在 bundles 里，
  只看 bundles 会误报。
- **注入包** = 启动图行 ∪ 安装树/profile 里能解析的包 ∪ **平台种子表**。平台种子表有两个来源：
  dsh 安装树里 `dsh-web-frontend/dist/assets/index-*.js` 的 `staticModules` 表（`ui-slots` /
  `ui-primitives` 这类平台内置模块只在这里），以及启动图里**官方行** inject 的、既非图行也非包名的名字。
- **种子表不可读**时，解析不到的注入包降级为「未判定」（按通过算，detail 写明原因），
  **只有确定缺失才判红**——升级工具自己不许因为读不到名单而制造假失败。

冒烟失败会自动开 issue（按标题去重；开单失败只记日志）。`GET /refill` 是只读预览；`POST /refill/pr` 才动手：在**临时 git worktree**（从 `origin/main` 切）里改
`package.json` → 提交 → 推分支 → 开 PR，跑完清场，**绝不碰你当前工作区**。`partial` 只在兜底三项全过时才算「通过」，兜底本身失败照样开单。

## 重启/升级期间的进度页（#300）

交接前宿主 detached 拉起 `lib/host/progress-server.mjs`（随机端口，写 `progress-port.json`），
前端跳过去、完成后自动跳新令牌地址。只监听 `127.0.0.1`、只读本机、完成 15s / 最多 20 分钟后自退；
起不来退回 watchdog。**它在 done 阶段返回带令牌的地址（仅本机回环），别把这个端口转发到外网。**

冒烟检查一行（#423）：新地址可达**且**本轮 `$STATE_DIR/boot-check.json` 落盘才算 `done`；
结果文件缺失时最多再等 **20s**（从首次观察到新地址可达起算），到点标 `check.state='timeout'`，
**照常跳转**、不阻塞。`/state` 的 `check` 字段为
`{state:'pending'|'done'|'timeout', problems, disabled, unverified}`（后三者为计数），
`boot-check.json` 契约为 `{schema:1, at, problems, disabled:[], unverified:[], results:[]}`；
`schema !== 1` 或 mtime 早于本轮启动的文件都当「还没有结果」。结果文件由后续 PR 落盘。
进度页在跳转前渲染 `冒烟检查：N 个问题 / 已临时禁用 X 个 / M 个未验证`，超时显示「检查未完成」。

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

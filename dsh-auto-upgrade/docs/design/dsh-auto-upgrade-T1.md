# T1 — dsh 自升级插件：接口清单 + 数据流图（待用户拍板）

- 产出时间：2026-10-12（接手会话）
- 依据：`handoff.md`（上一轮调查会话）+ 本机 `dsh@0.2.0-rc.2` 实机 API + `upgrade-dsh.sh`（用户手写脚本）
- 状态：**已按本设计实现完毕（T3–T10）**，验收证据见 [`docs/acceptance/dsh-auto-upgrade-acceptance.md`](../acceptance/dsh-auto-upgrade-acceptance.md)；
  真机安装/升级/重启属用户授权闸门，尚未执行
- 暂定包名：`dsh-plugin-auto-upgrade`（§8.1 待定）
- 路由族：`/api/dsh-auto-upgrade`（全部 loopback-only）

---

## 1. 目标与 5 条需求的落点

| # | 用户需求 | 落点 |
|---|---|---|
| 1 | 当天首次使用 Web UI 时自动检测 | 浏览器半边在 `shell.overlay` 挂载时调一次 `POST /check/auto`；宿主半边用 `state.json.lastCheckDate`（宿主本地日期）保证**当天只真正检测一次**，多标签页/刷新复用结果 |
| 2 | 检测 dsh 版本 + 已装插件与新版本的兼容性 | `GET /preflight` + `POST /check/*`：npm registry 查版本；`readProfilePlugins()` 取插件清单；`evaluatePluginCompatibility(manifest, exemptions, 目标版本)` 逐插件预检 |
| 3 | 小弹窗显示过程，不影响当前工作 | `shell.overlay` 浮层（`kind: list`，`scope: root`）：卡片自身 `pointer-events: auto`，其余区域不拦截；检测与安装都在宿主异步跑，浮层只轮询 |
| 4 | 适合升级 → 弹窗提醒 + 升级按钮 | `POST /check/auto` 返回 `decision`；浮层按 `decision` 渲染（可升级 / 可升级但有插件风险 / 已最新 / 无法确认） |
| 5 | 点升级先查在跑的会话 | `POST /update` 内的门禁：`ctx.agents.list().filter(a => a.status === 'running')`，非空则 `409` + 会话名单（§8.5 待定硬拦还是可强制） |

---

## 2. 形态

**双面插件**（与 `dsh-plugin-product-subagents`、参考实现一致）：

```
dsh-plugin-auto-upgrade/
├─ package.json          # exports {".": 宿主, "./client": 浏览器}; dsh.bundle.patch; dsh.client.inject; peerDependencies
├─ cordis.patch.yml      # insert: [{ id: dsh-auto-upgrade, name: dsh-plugin-auto-upgrade }]
├─ lib/index.js          # 宿主半边：路由族 / 状态机 / npm 操作 / 重启交接
└─ lib/client.js         # 浏览器半边：window.__ModuleLoader__.load({ id, factory })
```

- 工具链：纯 ESM、**无构建步骤**（浏览器半边手写，与生态一致）。
- 状态目录：`~/.dsh-auto-upgrade/`（`policy.json` / `state.json` / `history.json` / `tasks/` / `logs/`），可被 `Config.dataDir` 改写。
- 安装方式：`dsh plugin --profile web add <本包路径或 git 地址>` → 重启 `dsh web`。

---

## 3. 宿主半边接口清单（HTTP）

> 平台事实：`webServer.register({ kind, path, handler })` 以 **(kind, path)** 为键，重复注册直接抛错 → **一条路径只注册一次**，同一路径的 GET/POST 在 handler 内部分派（SuCriss 的 `fenced()` 就是这个形状）。
> 每条路由统一套：loopback 围栏（socket 地址 + Host 头 + `sec-fetch-site`）→ 方法围栏（非声明方法 `405`）→ 错误信封（客户端错 `4xx`，自身错 `500`）。

| 优先级 | 方法 | 路径 | 入参 | 出参（要点） | 副作用 | 说明 |
|---|---|---|---|---|---|---|
| P0 | GET | `/api/dsh-auto-upgrade/status` | — | `{installed, running, channels, lastCheck, task, sessions{running[]}, plugins{summary}}` | 无 | 浮层首屏；**不联网** |
| P0 | POST | `/api/dsh-auto-upgrade/check/auto` | `{force?:boolean}` | `{checkedAt, decision, target, channels, compat[], preflight}` | **联网 + 写 `state.json`** | 需求 1 的唯一入口；**必须 POST**（能改机器的判定不允许挂在 GET 上，否则预取/第二个标签页会顺手触发） |
| P0 | POST | `/api/dsh-auto-upgrade/check/run` | `{version?}` | 同上 | 联网 + 更新当日记录 | 面板"重新检查"：只观察，不安装 |
| P0 | GET | `/api/dsh-auto-upgrade/preflight` | — | `{dshBin, dshReal, node, npm, npmRootG, installDirInNpmRoot, writable, diskFreeBytes, dshHomeBytes}` | 无（只探测本机） | 升级前体检；升级时会再跑一次，不信客户端 |
| P0 | POST | `/api/dsh-auto-upgrade/update` | `{version, acceptPluginRisk?, force?}` | `202 {taskId}` / `409 {code:'sessions-running', sessions[]}` / `409 {code:'plugin-incompatible', ...}` | **备份 `~/.dsh` → 停服 → `npm install -g` → 校验 → 重启** | 重副作用；单飞（进行中重复调用 → `409 busy`） |
| P0 | GET | `/api/dsh-auto-upgrade/task` | `?taskId=&since=N` | `{phase, percent, logTail[], startedAt, finishedAt, ok, error, rollbackOf?}` | 无 | 轮询：`preflight → backup → stop → install → verify → restart` |
| P1 | POST | `/api/dsh-auto-upgrade/rollback` | `{version}` | `202 {taskId}` | 重装旧版本（可选再恢复 `~/.dsh` 备份） | 失败路径的兜底 |
| P0 | GET | `/api/dsh-auto-upgrade/plugins` | — | `{plugins:[{name, version, enabled, bundle, peers, compat:{target, ok, exempted, detail}}], exemptions}` | 无 | 需求 2 的第二半 |
| P1 | POST | `/api/dsh-auto-upgrade/plugins/action` | `{name, action:'disable'\|'enable'\|'exempt', packageVersion?, runtimeVersion?, acceptRisk?}` | `{ok, exemptions, plugins}` | 改 profile `package.json` 的 bundles / `compatibility.json` | 处置不兼容插件（§8.4） |
| P1 | GET+POST | `/api/dsh-auto-upgrade/policy` | GET 无 / POST 部分对象 | 策略全文 | POST 写 `policy.json` | `{channel, mode, executionWindow, dailyCheck}`（§8.2、§8.6） |
| P1 | GET+POST | `/api/dsh-auto-upgrade/settings` | GET 无 / POST 部分对象 | 面板偏好 | 写 `settings` | 悬浮窗开关、"不再提示" |
| P1 | POST | `/api/dsh-auto-upgrade/restart` | `{}` | `202 {scheduled}` | **detached 助手：等旧 pid 退出 + 端口释放 → 原样 argv 拉起新进程** | §8.8 |
| P2 | GET | `/api/dsh-auto-upgrade/restart/diagnostics` | — | `{logTail[], lastResult}` | 无 | 重启失败排障 |
| P2 | GET | `/api/dsh-auto-upgrade/notes` | `?version=` | `{version, notes}` | 联网（GitHub release） | 确认卡上显示更新说明 |

**统一错误码形状**：`{ ok:false, code:'E_…', error:'人话', detail? }`；"检测失败" 一律 `decision:'unknown'`，**绝不伪装成"已是最新"**。

---

## 4. 浏览器半边接口清单

平台事实（本机 `dsh-client-ui-slots`）：`window.__ModuleLoader__.load({ id, factory })`；`factory(require)` 返回 `module.exports`，其中 `exports.apply(ctx)` + `exports.inject = ['slots']`。
可用 slot（本机实测的完整名字）：`shell.overlay`（`list`/`root`）、`shell.leading`、`settings.section`、`settings.plugins.tab`、`settings.action`、`settings.header`、`settings.launcher`、`settings.general.item`、`settings.models.footer`、`settings.onboarding`、`settings.trigger`、`settings.yaml`、`settings.close`。

| 优先级 | slot | 注册 | 组件职责 |
|---|---|---|---|
| P0 | `shell.overlay` | `{name:'shell.overlay', id:'dsh-auto-upgrade', order:1000, locale:'dsh-auto-upgrade'}` | 检测/升级浮层：进度、判定、升级按钮、重启后自动重连提示；可拖动、可最小化、可"不再提示" |
| P0 | `settings.section` | `{name:'settings.section', id:'dsh-auto-upgrade', order:40, label:()=>t('settings.label')}` | 设置页：渠道、检查、预检详情、插件兼容表、快照/回滚、重启按钮、日志尾 |
| P1 | `settings.plugins.tab` | `{name:'settings.plugins.tab', …}` | 与官方插件管理并列的"兼容性体检"页（可选） |
| P1 | locale | `locale.register('dsh-auto-upgrade', { zh, en })` | 中英字典，`t` 由框架注入 |

客户端行为：

1. 挂载 → `GET /status` 渲染当前状态；若 `lastCheck.date !== 今天` → `POST /check/auto`（**当天首次**）。
2. 轮询：检测中 `GET /task`（1s 退避到 3s）；空闲时不轮询（或 30s 一次轻量 `GET /status`）。
3. "升级" → 先 `GET /preflight` 展示落点清单（node/npm/安装目录/`~/.dsh` 体积/备份路径）→ 用户确认 → `POST /update`。
4. 安装期间页面**保持可用**：浮层只显示进度（需求 3）；升级到 `restart` 阶段时启动 watchdog（轮询 `GET /status`），新进程应答后 `location.reload()`。

---

## 5. 数据流图

```
┌─ 浏览器（shell.overlay 浮层） ────────────────────────────────────────────────┐
│  挂载                                                                        │
│   ├─ GET /status ─────────────────────────────► 只读快照                      │
│   └─ 今天还没检测过? ──► POST /check/auto                                    │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                ▼
                 ┌─ 宿主：检测（只读，可联网）──────────────────────┐
                 │ 1. policy.json → channel(latest/next/alpha/exact)│
                 │ 2. npm registry: dist-tags + versions     [网络] │
                 │ 3. readProfilePlugins({binName,profileDir,…})    │
                 │ 4. evaluatePluginCompatibility(manifest,         │
                 │      readProfileVersionExemptions(), 目标版本)   │
                 │ 5. preflight(): node/npm/安装目录/可写/磁盘      │
                 │ 6. 写 state.json.lastCheck（当日幂等）           │
                 └───────────────────────┬──────────────────────────┘
                                         ▼
        decision ∈ {up-to-date | update-available | update-with-plugin-risk
                    | unknown(无法确认) | downgrade-guard(本机高于发布源)}
                                         │
                                         ▼
                   浮层提醒（不阻塞工作）＋「升级」按钮
                                         │ 用户点击
                                         ▼
                 ┌─ 宿主：安装（重副作用）──────────────────────────┐
                 │ 门禁① 会话：ctx.agents.list() → status==='running'│
                 │       非空 ⇒ 409（前端警告，确认后 force 继续）   │  ← 需求 5
                 │ 门禁② 插件：目标版本不兼容 ⇒ 409，**不可绕过**    │
                 │ 门禁③ 预检：npm 不可用/磁盘不足 ⇒ 4xx             │
                 │ 备份:   cp -a ~/.dsh ~/.dsh.bak-<ts>（~11MB）     │
                 │ 停服:   探测 3080 → SIGTERM(15s) → SIGKILL        │
                 │ 安装:   <dsh同源 npm> install -g --allow-scripts=…│
                 │         @deepseek-ai/dsh@<精确版本>               │
                 │ 校验:   dsh --version == target                   │
                 │         dsh --profile web --dump-default-config   │
                 │ 失败:   重装旧版本 / 恢复备份，如实报错           │
                 └───────────────────────┬──────────────────────────┘
                                         ▼
                 detached 重启助手：等旧 pid 退出 + 端口释放
                        → 用挂载时捕获的 (execPath, argv, cwd) 原样拉起
                                         │
                                         ▼
                 浏览器 watchdog：轮询 GET /status → 新进程应答 → reload
```

---

## 6. 官方 API 对接点（本机 `dsh@0.2.0-rc.2` 实测）

| 用途 | API | 出处（本机路径，均在 `…/@deepseek-ai/dsh/node_modules/@deepseek-ai/`） |
|---|---|---|
| 当前运行时版本 | `getDshRuntimeVersion()` | `dsh-app-boot/lib/types/plugin-compatibility.d.ts` |
| 插件兼容性预检 | `evaluatePluginCompatibility(manifest, exemptions?, runtimeVersion?)` | 同上 |
| 兼容性诊断文案 | `pluginCompatibilityWarning(issue)` | 同上 |
| 读豁免 | `readProfileVersionExemptions(profileDir)` / `readProfileCompatibility(profileDir)` | `dsh-app-boot/lib/types/profile-compatibility.d.ts` |
| 写/撤豁免 | `setProfileVersionExemption(profileDir, pkgVer, runtimeVer, enabled, acceptRisk)` | 同上 |
| profile 插件清单 | `readProfilePlugins({binName, profileDir, installAnchor})` | `dsh-app-boot/lib/types/profile-plugins.d.ts` |
| 在跑会话门禁 | `ctx.agents.list()` / `ctx.agents.get(id)`，`status === 'running'` | `dsh-agent/lib/index.js`（服务名 `agents`）；官方用法见 `dsh-api-session-controller/lib/types/list.js:92-93` |
| HTTP 路由 | `ctx.inject(['webServer'], c => c.webServer.register({kind:'exact'\|'prefix', path, handler}) → disposer)`；`webServer.port` | `dsh-host-webserver/lib/types/index.d.ts` |
| 浏览器插件装载 | `window.__ModuleLoader__.load({id, factory})`；`exports.apply/inject=['slots']` | `dsh-client-modules/lib/index.js`；参考实现 `Airmetro/dsh-update-checker/lib/client.js:7,2169` |
| 浮层 / 设置页 | `scope.slots.inject('shell.overlay'\|'settings.section', () => scope.slots.register(opts, Component))` | `dsh-client-ui-layout/lib/types/client/index.d.ts:85`（`shell.overlay`: kind `list`, scope `root`）；同上参考实现 `:2137-2166` |
| 中间件/补丁层 | `cordis.patch.yml` 的 `insert:` 段 | 本机 profile `~/.dsh/profiles/web/cordis.patch.yml` |

**本机现状（预检的真实素材）**

```jsonc
// ~/.dsh/profiles/web/package.json
"dependencies": { "dsh-plugin-product-subagents": "link:/Users/gubin/workspace/dsh-plugin-product-subagents" }
// ~/.dsh/profiles/web/compatibility.json —— 一条精确版本豁免，升级后立即失效
{ "dsh-plugin-product-subagents@0.4.0": ["0.2.0-rc.2"] }
```

---

## 7. `upgrade-dsh.sh` → 宿主半边模块映射

用户脚本（`upgrade-dsh.sh`，392 行）的 7 段逻辑**整体移植**，不重写：

| 脚本函数 | 插件落点 | 变化 |
|---|---|---|
| `preflight()` | `lib/host/toolchain.js` | 保留"从 `which dsh` 解符号链接 → 同目录取 node/npm → `npm root -g` 校验"，剔除交互输出 |
| `detect_versions()` | `lib/host/registry.js` | 直接读 registry HTTP（`fetch`），不再依赖 `npm view` 子进程 |
| `do_backup()` | `lib/host/backup.js` | 保留 `cp -a ~/.dsh ~/.dsh.bak-<ts>` + `UPGRADE-INFO.txt` |
| `install_version()` | `lib/host/install.js` | `npm install -g --allow-scripts=<白名单>`，失败降级重试 |
| `verify_install()` | 同上 | `dsh --version` 对版 + `--profile web --dump-default-config` 冒烟 |
| `stop_server()` / `start_server()` | `lib/host/restart.js` | 交互确认 → HTTP 门禁；前台 `nohup` → detached 助手（等 pid 退 + 端口释放 + 原样 argv） |
| `find_port_pids()` | `lib/host/port.js` | `lsof -tiTCP:<port> -sTCP:LISTEN`（macOS）/ `ss`（Linux） |
| 回滚 / 恢复备份 | `lib/host/rollback.js` | `--rollback`、`--restore-backup` 两条路径保留 |

---

## 8. 状态、幂等与信任边界

**状态文件**（`~/.dsh-auto-upgrade/`）

```jsonc
// state.json
{ "lastCheckDate": "2026-10-12", "lastCheck": { /* decision, target, compat */ },
  "installed": "0.2.0-rc.2", "pendingRestart": null }
// policy.json
{ "channel": "latest", "mode": "notify", "executionWindow": null, "dailyCheck": true }
```

- **当日首次**：以**宿主本地日期**为准（§8.3）；同日再次 `POST /check/auto` 直接回缓存，`force:true` 才重查。
- **多标签页**：同一份 `state.json` + 进程内 Promise 去重。
- **单飞**：`update`/`rollback` 进行中 → 新的写请求 `409 busy`；跨进程再加机器级锁文件（同一台机器多个 `dsh web` 进程会撞车）。
- **信任边界**：路由族能读 npm、重写全局安装树、覆盖 `~/.dsh`、结束本进程 → 一律 loopback-only（socket 地址为准，不信任 `X-Forwarded-For`），并且**有副作用的一律 POST**。
- **面板保持可用**：安装期间不阻塞事件循环（npm 走 detached 子进程 + 流式日志），浮层只轮询。

---

## 9. 本轮明确不做

- 不写实现代码（等 §10 拍板）。
- 不改 `~/.dsh/profiles/web`、不装插件、不重启服务、不跑 `npm install -g`。
- 不顺手修 `dsh-plugin-product-subagents` 的兼容性问题（记下来汇报）。
- 不做桌面（Desktop/Electron）分支。

---

## 10. 待拍板（含建议默认值）

**拍板结论（2026-10-12，已确认）**

| # | 问题 | 结论 |
|---|---|---|
| 1 | 仓库/落盘位置 | **本工作区新建独立包** `dsh-auto-upgrade/`（包名 `dsh-plugin-auto-upgrade`） |
| 2 | 升级渠道默认 | **`latest`**（设置页可切 `next`/`alpha`/精确版本） |
| 3 | "当天首次"日期口径 | 宿主本地日期 |
| 4 | 不兼容插件处置 | **不升级 + 警告风险**：`POST /update` 返回 `409 E_PLUGIN_INCOMPATIBLE`，`bypassable:false`，不提供绕过入口 |
| 5 | 有会话在跑 | **仅警告**：`409 E_SESSIONS_RUNNING`（`bypassable:true`），前端确认后带 `force:true` 继续 |
| 6 | 静默自动升级 | **暂不做**：`policy.mode` 只接受 `notify`，其它值 400 |
| 7 | UI 语言 | 中英双语（`locale.register`） |
| 8 | 升级后自动重启 | 自动重启（安装前明确告知会断线）——属变更半边，待接线 |
| 9 | 验收场景 | `product-subagents` 兼容性预检必须报不兼容（已用真实 API 单测固定） |

原始问题清单（保留以便追溯）：

| # | 问题 | 建议默认 |
|---|---|---|
| 1 | 仓库/落盘位置？`self-dsh-plugins` 工作区下新建 `dsh-auto-upgrade/`，还是 fork `Airmetro/dsh-update-checker`？ | **本工作区新建独立包** |
| 2 | 升级渠道默认跟哪个 tag？ | `latest`（可切 `next`/`alpha`/精确版本） |
| 3 | "当天首次"按谁的日期？ | 宿主本地日期 |
| 4 | 不兼容插件怎么处置？ | **只警告 + 一键写精确版本豁免**（不自动禁用） |
| 5 | 有会话在跑时？ | **硬拦**（可勾选"仍要继续"） |
| 6 | 要不要"静默自动升级"模式？ | **暂不做**，永远人工确认（先留 `policy.mode` 字段） |
| 7 | UI 语言？ | 中英双语（`locale.register`） |
| 8 | 升级后自动重启？ | 升级成功后自动重启（安装前明确告知会断线） |
| 9 | 验收场景？ | `product-subagents` 的兼容性预检**必须报不兼容** + 会话门禁空/非空两条 |

---

## 11. 验证计划（T10 起点）

1. 组合自检：`dsh --profile web --dump-config` 含本插件 entry（不挂载、无副作用）。
2. 语法：`node --check lib/index.js lib/client.js`。
3. 假 `ctx` 单测：拿路由表 → 真 `node:http` 起服务 → `curl` 各端点（含 403 非 loopback、405 方法、409 门禁）。
4. 兼容性直测：`evaluatePluginCompatibility(product-subagents 的 manifest, {}, '0.2.0')` **必须返回不兼容**。
5. 门禁直测：空闲时 `ctx.agents.list().filter(a=>a.status==='running')` 为空数组。
6. 端到端（需用户授权 + 一次重启窗口）：装插件 → 重启 → 浮层出现 → 检测 → 点升级 → 会话门禁命中/放行。

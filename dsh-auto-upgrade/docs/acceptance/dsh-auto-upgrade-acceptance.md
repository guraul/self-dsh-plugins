# 验收报告 — dsh-plugin-auto-upgrade 0.1.0

- 时间：2026-10-12（2026-10-16 / 10-17 / 10-18 多次追加，见文末更新记录）
- 依据：`../design/dsh-auto-upgrade-T1.md`（T1 设计 + 用户拍板 §10）
- 代码：`lib/` 3487 行 + `test/` 1598 行（2026-10-18 复核）
- 结论：**只读半边 + 变更半边均已实现并逐一验证；真机升级链路已于 2026-10-17 真实跑通两次（见 §3）**

---

## 1. 交付物

| 文件 | 行 | 职责 |
|---|---|---|
| `lib/index.js` | 732 | 宿主入口：14 条路由、门禁、交接调度 |
| `lib/client.js` | 1084 | 浏览器半边：`shell.overlay` 浮层 + `settings.section` 设置页 + 重连 watchdog |
| `lib/host/protocol.js` | 94 | 路由表 / 决策枚举 / 错误码 / 常量（纯数据） |
| `lib/host/loopback.js` | 71 | loopback 信任围栏（socket 地址为准） |
| `lib/host/http.js` | 103 | JSON 响应、有界 body、方法分发、错误信封 |
| `lib/host/semver.js` | 91 | SemVer 比较（§11 语义） |
| `lib/host/toolchain.js` | 218 | 工具链定位 + 体检（移植 `upgrade-dsh.sh` 的 `preflight()`） |
| `lib/host/registry.js` | 48 | npm registry 只读查询 |
| `lib/host/notes.js` | 110 | release notes：从 manifest 推 GitHub slug + 取 release + 压纯文本 |
| `lib/host/official.js` | 42 | 载入**运行时那份** `dsh-app-boot` |
| `lib/host/compat.js` | 137 | profile 插件清单 + 目标版本兼容性判定 |
| `lib/host/sessions.js` | 36 | `ctx.agents.list()` 运行中会话门禁 |
| `lib/host/state.js` | 122 | `state/policy/settings` 原子读写 |
| `lib/host/tasks.js` | 151 | 任务进度、日志尾、单飞 |
| `lib/host/backup.js` | 142 | `~/.dsh` 备份 / 恢复 |
| `lib/host/upgrade.js` | 274 | 安装参数、helper 脚本生成、调度、结果读取 |
| `lib/host/token-url.js` | 32 | 从日志里抓最后一条 `?token=…`（纯函数） |

（行数为 2026-10-18 复核值；`lib/host/*.js` 合计 1671 行。）

---

## 2. 验证矩阵（可复现）

复现命令（全部）

```sh
cd dsh-auto-upgrade
node --check lib/index.js lib/client.js          # 语法
node --test "test/*.test.mjs"                    # 56 用例
```

最近一次结果（2026-10-18）：**56 用例 / 54 passed / 2 failed**（`node --test`，约 12s）。
那 2 条失败**与本次改动无关、也不是回归**：`test/official-compat.test.mjs` 依赖「运行时那份 dsh 的
客户端包名」，而本机 dsh 已升到 `0.2.1-rc.2`（`@deepseek-ai/dsh-client-ui-slots` 不再出现在安装树里）。
在**未改动的 main 副本**上复跑同样是这 2 条失败（50 用例 / 48 passed / 2 failed），因此记为
环境性失败，交由插件兼容性问题单独处理，本次不动它、也不放宽断言。

| # | 声明 | 证据（用例） | 结果 |
|---|---|---|---|
| 1 | 路由族只在 loopback 上服务 | `test/loopback.test.mjs`：127/8、::1、IPv4 映射、Host 头、`sec-fetch-site`、`Origin`；403/405/500 信封 | ✅ |
| 2 | 同路径多方法在一条路由内分派 | `test/routes.test.mjs`：`GET/POST /policy`、`GET/POST /settings`；`POST /status` → 405 | ✅ |
| 3 | 浏览器半边与宿主路由表一致 | `test/client-protocol.test.mjs` | ✅ |
| 4 | 浏览器半边真的注册两个座位 | `test/client-register.test.mjs`：假 ModuleLoader + 假 react，断言 `shell.overlay`(order 1000) / `settings.section`(order 40) 的 id、locale、字典键中英对齐 | ✅ |
| 5 | 客户端入口契约正确 | 同上 + `test/client-protocol.test.mjs`（`exports.apply` / `inject=['slots']` / watchdog / 任务日志跟随） | ✅ |
| 6 | 检测判定：有更新 / 当天缓存 / 无法确认 | `test/routes.test.mjs`（假 registry 是真 http 服务） | ✅ |
| 7 | 兼容性预检用**官方 API**对**目标版本**判定 | `test/official-compat.test.mjs`：`product-subagents` 的 peer 范围在 `0.2.0` 上判不兼容，写精确版本豁免后 `exempted:true` | ✅ |
| 8 | 插件不兼容 ⇒ 不升级且不可绕过 | `test/routes.test.mjs`：三种 body（含 `force`/`acceptPluginRisk`）都是 409 `E_PLUGIN_INCOMPATIBLE`、`bypassable:false` | ✅ |
| 9 | 会话在跑 ⇒ 409（可强制） | `test/routes.test.mjs`：`status==='running'` 计数、`bypassable:true`、`force:true` 后 202 | ✅ |
| 10 | 交接后宿主正常退出（exit 0，避免 KeepAlive 再拉一次） | 同上：断言 `exits == [0]` | ✅ |
| 11 | 交接 payload 完整（argv 原样、pid、端口、profile、launchd label） | 同上：逐字段断言 | ✅ |
| 12 | 回滚：无目标 400 / 有目标 202 | `test/routes.test.mjs` | ✅ |
| 13 | 只重启：不装任何东西 + 诊断接口回显 payload | `test/routes.test.mjs` | ✅ |
| 14 | 备份 = 整棵拷贝 + `UPGRADE-INFO.txt` + 拒绝覆盖同名 | `test/backup.test.mjs` | ✅ |
| 15 | 恢复 = 现场让路再覆盖（现场不删） | `test/backup.test.mjs` | ✅ |
| 16 | 升级助手：装 → 对版 → 冒烟 → 拉起 → `result.json ok:true` | `test/helper.test.mjs`（假 npm/dsh 夹具，真 `/bin/sh` 跑生成的脚本） | ✅ |
| 17 | 安装失败且旧树还在 ⇒ 拉起旧树，结果如实报 `install` 失败 | 同上 | ✅ |
| 18 | 对版失败 ⇒ **绝不拉起带病的树** | 同上 | ✅ |
| 19 | launchd 管理下用 `kickstart -k`（不是 fork 孤儿进程） | 同上（假 `launchctl`，断言 `print` + `kickstart -k` 调用且不 spawn） | ✅ |
| 20 | `kickstart` 失败 / 无此 job ⇒ 退回 detached spawn | 同上 | ✅ |
| 21 | `profileContext` 缺失时优雅降级 | `test/routes.test.mjs`：`/status` 200 + 能力全关，`/preflight`、`/update` → 500 `E_PRECONDITION` | ✅ |
| 22 | 平台不支持时不假装能做 | `lib/index.js`：非 POSIX 平台能力位为 false、端点 501 | ✅（代码路径） |

**本机实测补充**（一次性、非测试）：

- `XPC_SERVICE_NAME=com.deepseek.dsh-web.self-dsh-plugins`，`launchctl print gui/501/<label>` 显示 job 在跑 → 交接走 `kickstart` 是**本机真实形态**，不是臆测。
- `npm root -g` = `/Users/gubin/.nvm/versions/node/v24.21.0/lib/node_modules`，`installAnchor` 推出的全局根与之一致（`preflight.npm.matchesInstall`）。

---

## 3. 明确**没有**验证的部分（诚实清单）

> 更新（2026-10-18）：**真机安装 / 停服 / 升级 / 重启交接 / 页面重连这一整链已经真的跑通过**，
> 而且不止一次——证据见下面的 §3.1。原先记在这里的那几条已随之作废，剩下的才还成立。

| 项 | 为什么没做 | 谁能做 |
|---|---|---|
| `POST /plugins/action`（豁免/禁用插件） | 本轮未接线，如实返回 501（写豁免按仓库约定需先拿到用户对具体版本组合的同意） | 下一轮或用户点单 |
| `GET /notes` 的**真机** HTTP 响应复测 | 已实现并有 7 条用例（含真 http 路由 + 假 GitHub）、也对**真 GitHub API** 单独验过；宿主自 2026-10-17 起已重启两次（新代码已随新进程加载），但本次验收**没有**再 curl 一次确认响应体 | 下次重启后 curl 一次 |
| Windows | helper 是 POSIX sh 脚本 | 未支持，能力位已关闭 |
| 设置页升级入口的**真机**点击 | 本次只做到「真渲染 + 假 fetch」的单测（`test/client-upgrade-entry.test.mjs`），点下去之后的端到端由控制面在页面上验收 | 控制面 / 用户 |

### 3.1 真机升级证据（2026-10-17，两次）

两次都走完「备份 → 停服 → `npm install -g` → 对版 → profile 冒烟 → `launchctl kickstart -k`」。

**第二次（`0.2.1-alpha.5` → `0.2.1-rc.2`）**——`~/.dsh-auto-upgrade/result.json` 当前内容：

```json
{"ok":true,"mode":"update","from":"0.2.1-alpha.5","to":"0.2.1-rc.2","failedStep":null,"finishedAt":"2026-10-17T14:00:23Z","backup":"/Users/gubin/.dsh.bak-20261017-215904"}
```

`~/.dsh-auto-upgrade/restart.log` 关键行：

```
[2026-10-17 21:59:06] helper start (mode=update current=0.2.1-alpha.5 target=0.2.1-rc.2 pid=57169)
[2026-10-17 21:59:07] host is gone
[2026-10-17 21:59:07] port 3080 is free
[2026-10-17 22:00:22] install finished
[2026-10-17 22:00:22] dsh --version -> 0.2.1-rc.2 (expected 0.2.1-rc.2)
[2026-10-17 22:00:23] profile smoke test passed
[2026-10-17 22:00:23] relaunching through launchd: com.deepseek.dsh-web.self-dsh-plugins
[2026-10-17 22:00:23] kickstart ok
[2026-10-17 22:00:23] done
```

**第一次（`0.2.0-rc.2` → `0.2.1-alpha.5`，备份 `~/.dsh.bak-20261017-173124`）**：

```
[2026-10-17 17:31:26] helper start (mode=update current=0.2.0-rc.2 target=0.2.1-alpha.5 pid=36949)
[2026-10-17 17:32:28] dsh --version -> 0.2.1-alpha.5 (expected 0.2.1-alpha.5)
[2026-10-17 17:32:29] profile smoke test passed
[2026-10-17 17:32:29] kickstart ok
[2026-10-17 17:32:29] done
```

备份目录 `~/.dsh.bak-20261017-173124` 与 `~/.dsh.bak-20261017-215904` 都还在盘上。

---

## 4. 安装与真机验收（**属于用户授权闸门**；安装与升级已在 2026-10-17 真机执行成功，见 §3.1）

```sh
# 1) 装进 web profile（改 ~/.dsh/profiles/web，属闸门）
dsh plugin --profile web add <仓库路径>/dsh-auto-upgrade

# 2) 重启 dsh web（会断开当前页面；本机是 launchd 管理）
launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh-web.self-dsh-plugins

# 3) 打开页面后应看到右下角浮层；设置 → 自动升级 里有渠道/体检/插件兼容/日志
```

首次真机验收建议顺序（每步都有可见证据，失败可停）：

1. **只看不动**：浮层检测 + 设置页「本机体检」 → 对照 `dsh --version`、`npm root -g`。
2. **插件兼容性**：插件表格里 `dsh-plugin-product-subagents@0.4.0` 应为**不兼容**（它靠 `compatibility.json` 豁免活着）→ 验证第 7 条在真机上同样成立。
3. **门禁**：随便开一个会让 agent 忙起来的会话，点升级 → 出现会话警告；确认后才继续。
4. **真升级**（可选）：装一个**明确更高**的版本（例如 `0.2.1-alpha.2`）→ 观察 `restart.log`、`result.json`、页面自动重连。
5. **回滚**：设置页「回滚到 0.2.0-rc.2」→ 同样走交接。

失败时的现场（都在 `~/.dsh-auto-upgrade/`）：

- `restart.log` — helper 全量日志（含 npm 输出）
- `result.json` — `{ok, failedStep: install|verify|smoke, ...}`
- `helper-payload.json` — 这次交接的完整输入（argv、目标版本、备份路径）

---

## 5. 风险与已知取舍

1. **数据备份 ≠ 自动恢复**：`~/.dsh` 备份每次都做，但恢复是显式动作（界面上的回滚按钮 / `restoreBackup`），不做隐式覆盖——避免把用户在升级后产生的会话数据悄悄盖掉。
2. **安装树不做快照**：510 MB 整棵拷贝实测约 88 秒（SuCriss 的数据），本插件选择「重装旧版本」这条更便宜的回滚路径，与用户手写脚本一致。
3. **verify 失败不重启**：宁可让服务停着等人，也不让可能损坏的树对外服务（沿用用户脚本的判断）。
4. **helper 是 POSIX sh**：macOS/Linux 可用；Windows 明确不支持。
5. **不声明 `@deepseek-ai/dsh*` peerDependencies**：否则升级后闸门会把本插件自己判成不兼容（自锁）。
6. **当天只检测一次**以宿主本地日期 + `state.json` 为准；`force` 可绕过。

---

## 6. 更新记录

### 2026-10-18 — 升级入口补进设置页 + 降级护栏给出路（issue #13）

起因：用户反馈「升级功能好像失效了」。实测是**入口不可达**，不是链路坏了——插件当天已经真机升级成功两次
（§3.1）。两个原因叠加：

1. 装了 alpha/next 线而策略渠道被设回 `latest`（更低）→ 宿主判 `downgrade-guard`，浮层按设计**不给**升级按钮；
2. 浮层先前被点过「不再提示」（`settings.dismissed === true`）→ 浮层不显示，而设置页**原本没有任何升级入口**。

修法（只加「入口 + 文案 + 出路」，宿主门禁与交接逻辑一行不动）：

- **A. 设置页升级入口**：`hasUpdate`（`update-available` / `update-with-plugin-risk`）时常驻一行
  「发现新版本 `<target>`（当前 `<installed>`）」+「升级」；点击走与浮层**完全相同**的流程
  （`GET /preflight` → 内联计划卡 → 确认/取消），会话门禁可强制、插件不兼容门禁不可绕过。
  浮层是否 `dismissed` / `hidden` **不影响**该入口。
- **B. 降级护栏给出路**：`downgrade-guard` 时浮层与设置页都显示本机版本、当前渠道最新版与
  「把发布渠道改成 `<建议渠道>` 就能继续升级」，并给「切到 `<建议渠道>`」按钮（`POST /policy` → `POST /check/run`）。
  建议渠道 = `tags` 里版本号最高的渠道（`{latest,alpha,next}` → `next`）；全相等/缺失时不给误导性建议。
  宿主侧 `downgrade-guard` 的判定**未改**。
- 计划卡渲染 / 降级出路渲染 / 升级流程控制器抽成 `renderPlanPanel` / `renderDowngradeExit` /
  `createUpgradeFlow` 各一份，浮层与设置页共用（`test/client-upgrade-entry.test.mjs` 用计数守卫防止有人再抄一份）。
- 新增 6 条用例：设置页有/无更新的入口渲染、设置页与浮层的降级出路文案、`suggestChannel` 真值 +
  与宿主 `compareVersions` 的语义一致性（防浏览器半边那份比较器漂移）、共用渲染的计数守卫。
- 浏览器半边没有构建产物，改完刷新页面即生效；**宿主半边没改**，不需要重启。

顺带把本文件里已经过时的说法改掉：§3 的「真机安装/升级/重启未执行」、§1/§2 的行数与用例数。

### 2026-10-17 — 接线 `GET /notes`（确认卡显示更新说明）

- 新增 `lib/host/notes.js`：从**运行时那份** `dsh` manifest 的 `repository.url` 推出 `owner/repo`，
  按 `dsh-v<版本>` / `v<版本>` / `<版本>` 依次试 GitHub release；只读、可失败、绝不抛给路由。
- 正文里混着 `<h3 id=…>` 与 `[中文](#…)` 这类 HTML/锚点，`plainNotes()` 压成纯文本（去标签、
  链接留文字、压空行、截断 1200 字），浮层显示 `plain` 并给一个「在 GitHub 上查看完整说明」的出口。
- 拿不到就说拿不到：`{available:false, reason}` 直接显示在确认卡上，**不影响能不能升级**；10 分钟内走内存缓存。
- 验证：7 条新用例（`repositorySlug` 各种写法 / 命中 `dsh-v` 前缀 / 三个候选都 404 / 503 / 网络不可达 /
  真 http 路由 + 假 GitHub + 缓存命中 + 版本号 400）；另外单独对**真 GitHub API** 跑过
  `0.2.1-alpha.5`（命中 `dsh-v0.2.1-alpha.5`，压出 1135 字）与 `9.9.9`（如实报没有）。
- ⚠️ 宿主半边改文件**不会热重载**：运行中的进程仍返回 501，重启后才生效。

### 2026-10-17 — 右下角浮层对齐官方浮层语言

设置页改完后又把浮层（`shell.overlay` 卡片）按官方**浮层**而不是官方设置页的规格重做了一遍：

| 项 | 改前 | 改后（依据） |
|---|---|---|
| 卡片表面 | `--dsw-alias-bg-overlay` + 0.5px `border-l2` | `--dsw-menu-surface-fill`（半透明）+ `blur(40px) saturate(150%)` + `--dsw-elevation-prominent`（描边走 `border-l1`）—— 照官方 `MenuSurface` + `Menu.list` |
| 内边距 / 圆角 | `14px 16px` | `12px 16px` + `--dsw-radius-lg`（照 Toast / HoverCard） |
| 主信息字号 | 12/18 tertiary（太弱） | 14/22 `label-primary`（全对比度） |
| 动作按钮 | 36px 实心块 / 自造描边类名 | 官方 `Button` 的 `sm` + `outline`：28px / `0 10px` / `--dsw-radius-sm` / `0.5px border-l3`；主操作同尺寸 `primary` |

中途试过「模块平台灰底」（和设置页按钮同款）：`#f5f6f7` 落在浮层的 `#f8f9fa` 卡片上几乎看不见，于是改用官方描边变体。

另外把 `official-compat` 用例的夹具从「外部仓库 `dsh-plugin-product-subagents` 的 manifest」
换成内联夹具——该仓库会挪位置、会升级，测试不该依赖它的当前状态；换成内联后仍然跑的是**官方 API**，
并补了一条「同一插件在它自己声明的世代里必须判为兼容」的反向断言。

### 2026-10-16 — UI 风格对齐 dsh 设计系统

原先的设置页/浮层样式是"照着感觉写"的近似值，实测后逐项改为官方实现的值：

| 项 | 改前 | 改后（依据） |
|---|---|---|
| 字体 | 未声明 `font-family`，落到浏览器默认 | `font: var(--dsw-font-s-14)`（14/22 + `--dsw-font-family`） |
| 描述文字 | 13/20 + `label-secondary` | `--dsw-font-xxs-12`（12/18）+ `label-tertiary` |
| 标题字重 | 600（自造） | 行标题 400；卡片标题 `--dsw-font-s-strong-14`（500） |
| 按钮 | 32px、透明底 + 0.5px 边框 | 36px / `0 14px` / `--dsw-radius-md` / `--dsw-alias-bg-module-platform`（官方设置页按钮规则） |
| 布尔控件 | 16px 原生 checkbox | 36×20 胶囊 + `aria-checked`（逐字照 primitives `Switch.module.css`） |
| 行布局 | 标题在上、控件在下 | `space-between` + `gap:24px` + `padding:16px 0` + `0.5px var(--dsw-alias-border-l2)`（官方 `Pt1bsG_row`） |
| 颜色 | 3 个不存在的 token（静默退回硬编码） | `label-*` / `state-*` 真实 token |

同时修掉三个真问题：当天已检测过时浮层永远停在「正在检查…」；点过「不再提示」后无法恢复浮层（新增「重新启用提示」）；豁免态误用错误红。

验证：headless Chrome 量计算样式（我的分区与设置壳原生元素逐项相同）+ 截图；测试 33 → 35，新增守卫用例强制
「根规则用 `--dsw-font-s-14`」「按钮 36px/`0 14px`」「开关 36×20」「用到的每个 `var(--dsw-*)` 必须在主题里存在或有 fallback」。

### 2026-10-16 — 包管理转为 pnpm

- 新增 `pnpm-lock.yaml`（lockfileVersion 9.0，react peer 自动安装，共 3 个包）与 `.npmrc`（`store-dir=/Users/gubin/workspace/global_node_modules`）。
- 实测 `pnpm install` 复用共享 store（`pnpm store path` = `…/global_node_modules/v11`，`reused 3 / downloaded 0`）。
- 包本身零运行时依赖：宿主半边只用 Node 内置模块，浏览器半边从模块加载器拿 `react`。

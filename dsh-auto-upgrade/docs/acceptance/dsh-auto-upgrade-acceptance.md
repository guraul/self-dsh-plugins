# 验收报告 — dsh-plugin-auto-upgrade 0.1.0

- 时间：2026-10-12（2026-10-16 追加 UI 风格对齐与 pnpm 化，见文末更新记录）
- 依据：`../design/dsh-auto-upgrade-T1.md`（T1 设计 + 用户拍板 §10）
- 代码：`lib/` 2964 行 + `test/` 1040 行
- 结论：**只读半边 + 变更半边均已实现并逐一验证；真机安装/升级/重启未执行（属于用户授权闸门）**

---

## 1. 交付物

| 文件 | 行 | 职责 |
|---|---|---|
| `lib/index.js` | 678 | 宿主入口：14 条路由、门禁、交接调度 |
| `lib/client.js` | 783 | 浏览器半边：`shell.overlay` 浮层 + `settings.section` 设置页 + 重连 watchdog |
| `lib/host/protocol.js` | 94 | 路由表 / 决策枚举 / 错误码 / 常量（纯数据） |
| `lib/host/loopback.js` | 71 | loopback 信任围栏（socket 地址为准） |
| `lib/host/http.js` | 103 | JSON 响应、有界 body、方法分发、错误信封 |
| `lib/host/semver.js` | 91 | SemVer 比较（§11 语义） |
| `lib/host/toolchain.js` | 218 | 工具链定位 + 体检（移植 `upgrade-dsh.sh` 的 `preflight()`） |
| `lib/host/registry.js` | 48 | npm registry 只读查询 |
| `lib/host/official.js` | 42 | 载入**运行时那份** `dsh-app-boot` |
| `lib/host/compat.js` | 137 | profile 插件清单 + 目标版本兼容性判定 |
| `lib/host/sessions.js` | 36 | `ctx.agents.list()` 运行中会话门禁 |
| `lib/host/state.js` | 122 | `state/policy/settings` 原子读写 |
| `lib/host/tasks.js` | 151 | 任务进度、日志尾、单飞 |
| `lib/host/backup.js` | 142 | `~/.dsh` 备份 / 恢复 |
| `lib/host/upgrade.js` | 248 | 安装参数、helper 脚本生成、调度、结果读取 |

---

## 2. 验证矩阵（可复现）

复现命令（全部）

```sh
cd dsh-auto-upgrade
node --check lib/index.js lib/client.js          # 语法
node --test "test/*.test.mjs"                    # 35 用例
```

最近一次结果：**35 passed / 0 failed**（`node --test`，约 12s）。

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

| 项 | 为什么没做 | 谁能做 |
|---|---|---|
| 真机 `npm install -g @deepseek-ai/dsh@<版本>` | 会替换正在运行的 dsh 安装树，属用户授权闸门 | 用户点头后我陪同执行 |
| 真机停服 / 重启交接 / 页面重连 | 会断开当前 Web 会话 | 同上 |
| 插件真的被 profile 挂载（`dsh plugin add` + 重启） | 会改 `~/.dsh/profiles/web` | 同上 |
| 端到端「检测 → 点升级 → 新版起来」全链 | 依赖上面三条 | 同上 |
| `GET /notes`（release notes）、`POST /plugins/action`（豁免/禁用插件） | 本轮未接线，如实返回 501 | 下一轮或用户点单 |
| Windows | helper 是 POSIX sh 脚本 | 未支持，能力位已关闭 |

---

## 4. 安装与首次真机验收（**需用户执行/授权**）

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

# self-dsh-plugins

Self-built plugins for [DeepSeek Harness](https://github.com/deepseek-ai) (`dsh`) — 自研 dsh 插件集合。

Currently one plugin is included / 目前收录 1 个插件。

| 插件 | 说明 | 状态 |
|---|---|---|
| [dsh-auto-upgrade](./dsh-auto-upgrade) | dsh Web UI 自升级：检测 → 兼容性预检 → 非阻塞浮层 → 一键备份 / 安装 / 校验 / 重启 | 可用（真机升级链路待验证） |

---

## dsh-auto-upgrade

给 dsh 的 Web UI 加一个**自升级**入口：当天首次打开页面时自动检测 dsh 新版本与已装插件的兼容性，
用一个**不打断当前工作**的浮层提示；用户点「升级」后才走完整链路。

![设置页](./dsh-auto-upgrade/docs/screenshots/settings.png)

![浮层](./dsh-auto-upgrade/docs/screenshots/overlay.png)

### 它做什么

1. **当天首次打开自动检测**：宿主按本地日期幂等，同一天多标签页/刷新只真正检测一次。
2. **检测两件事**：npm 上的 dsh 新版本；已装插件对**目标版本**的兼容性（用官方 `evaluatePluginCompatibility`，不是自己写范围匹配）。
3. **不打断工作的浮层**：右下角卡片，只占自己的位置；可「稍后」「不再提示」。
4. **点升级才动手**：会话门禁 → 插件门禁 → 备份 `~/.dsh` → 停服 → `npm install -g` → 对版 + 组合冒烟 → 重启交接。
5. **回滚与重启**：重装指定旧版本；或只重启服务。设置页还有本机体检、插件兼容表、升级/重启日志。

### 安装

```sh
dsh plugin --profile web add <本仓库路径>/dsh-auto-upgrade
```

本机 profile 是 `patchReload: live`，装完**不用重启** dsh web；刷新页面即可看到浮层与设置页。
卸载：`dsh plugin --profile web remove dsh-plugin-auto-upgrade`。

### 两条门禁（默认策略）

| 情况 | 行为 |
|---|---|
| 有会话正在执行 | `409`，前端弹警告；用户确认后可带 `force` 继续（**仅警告**） |
| 目标版本与已装插件不兼容 | `409`，**拒绝升级且不可绕过**——先升级/移除那个插件，或为它写精确版本豁免 |

豁免是按「插件@版本 → dsh 版本」精确匹配的：`compatibility.json` 里为 `0.2.0-rc.2` 写的豁免，
在升级到别的版本时**自动失效**，于是那个插件会立刻出现在「不兼容」里。这正是本插件要提前告诉你的信息。

### 关键设计

- **双面插件，无构建步骤**：宿主半边 `lib/index.js` 用 cordis 注册 `/api/dsh-auto-upgrade/*` 路由族；
  浏览器半边 `lib/client.js` 手写并包在 `window.__ModuleLoader__.load({id, factory})` 里，注册
  `shell.overlay` 浮层与 `settings.section` 设置页。
- **变更必须脱离进程**：`npm install -g` 覆盖的正是宿主此刻在运行的那棵树，而「停服」就是杀掉宿主自己。
  所以宿主只做「门禁 → 备份 → 落 payload → fork detached helper → `exit 0`」，停服/安装/对版/冒烟/拉起
  都在生成的 POSIX sh helper 里。`exit 0` 是刻意的：LaunchAgent 是 `KeepAlive{SuccessfulExit:false}`，
  非零退出会被 launchd 再拉一次；helper 拉起时若发现 `XPC_SERVICE_NAME` 对应的 job 仍在，就用
  `launchctl kickstart -k`，让服务继续留在 launchd 名下。
- **用「运行时那份」官方 API**：`@deepseek-ai/dsh-app-boot` 不在 profile 的解析范围里，pnpm 只会再装一份
  副本。插件用 `ctx.profileContext.installAnchor` 推出宿主**此刻真正执行**的模块绝对路径再动态 import。
- **故意不声明 `@deepseek-ai/dsh*` peerDependencies**：否则升级之后，平台闸门会把「负责升级 dsh 的插件」
  自己判成不兼容（自锁）。本包只声明 `react`（浏览器半边需要）。
- **安全边界**：路由族能读 npm、重写全局安装树、覆盖 `~/.dsh`、结束本进程，所以一律 loopback-only
  （socket 地址为准，不信任 `X-Forwarded-For`），并且**有副作用的一律 POST**。
- **UI 吃 dsh 的设计 token**：字体 `--dsw-font-*`、圆角 `--dsw-radius-*`、语义色 `--dsw-alias-state-*`、
  开关逐字照 primitives `Switch.module.css`，按钮尺寸照官方设置页规则（36px / `0 14px` / `bg-module-platform`）。
  详见包内 README 的「UI 风格契约」。

### 状态目录

`$HOME/.dsh-auto-upgrade/`（可用 `DSH_AUTO_UPGRADE_DIR` 改写）：

- `state.json` — 当天检查记录、上次检测结果
- `policy.json` — `{channel, exactVersion, mode, dailyCheck}`
- `settings.json` — `{overlay, dismissed, locale}`
- `restart.log` / `result.json` / `helper-payload.json` — 升级交接的日志、结果与完整输入

### 开发

包由 **pnpm** 管理（`.npmrc` 指向共享 store）：

```sh
cd dsh-auto-upgrade
pnpm install                 # 只有 react 一个 peer，会复用共享 store
node --check lib/index.js lib/client.js
node --test "test/*.test.mjs"   # 35 用例
```

测试里没有 mock 掉关键路径：路由跑真 `node:http` + 假 npm registry；兼容性判定跑真官方 API；
升级 helper 用假 npm/dsh/launchctl + 真 `/bin/sh` 跑生成的脚本；浏览器半边用假 `ModuleLoader` + 假 react 装载。

### 文档

- [设计：接口清单 + 数据流图 + 拍板结论](./dsh-auto-upgrade/docs/design/dsh-auto-upgrade-T1.md)
- [验收报告：逐条证据 + 明确没验证什么](./dsh-auto-upgrade/docs/acceptance/dsh-auto-upgrade-acceptance.md)
- [包内 README](./dsh-auto-upgrade/README.md)

### 已知限制（诚实清单）

- **真机的安装/升级/重启链路尚未执行**（属于需要用户点头的闸门）；只读半边与门禁已在真机验证。
- 只支持 macOS / Linux：helper 是 POSIX sh 脚本。
- `GET /notes`（release notes）与 `POST /plugins/action`（写豁免/禁用插件）尚未接线，如实返回 `501`。
- 暂不做「静默自动升级」：`policy.mode` 只接受 `notify`。

## License

MIT

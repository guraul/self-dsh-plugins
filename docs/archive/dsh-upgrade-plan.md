# 当前 dsh 升级方案（调查结论 + 操作手册）

调查时间：2026-10-10

## 1. 现状（实测）

| 项 | 值 | 证据 |
|---|---|---|
| 已装版本 | `0.1.5-rc.3` | `dsh --version`、`package.json` |
| 安装方式 | npm 全局安装（nvm 管理的 Node） | `which dsh` → `/Users/gubin/.nvm/versions/node/v24.21.0/bin/dsh`；`npm ls -g --depth=0` 显示 `@deepseek-ai/dsh@0.1.5-rc.3` |
| Node / npm | v24.21.0 / 11.19.0 | `node -v`、`npm -v` |
| 数据目录 | `DSH_HOME=/Users/gubin/.dsh` | 环境变量；含 `profiles/`、`sessions/`、`storages/`、`settings.yaml` |
| Profile | 仅 `web`；`dependencies: {}`，bundles 为内置 `dsh-base` + `dsh-web-app` | `~/.dsh/profiles/web/package.json` |
| 第三方插件 | 无（无需重装插件） | 同上；`profiles/web/node_modules` 为空 |
| 正在运行的服务 | 就是这份全局安装：PID 2835，cwd `/Users/gubin/workspace`，监听 `127.0.0.1:3080` | `lsof -nP -iTCP:3080 -sTCP:LISTEN`、`lsof -p 2835` |
| 会话日志格式 | `session.v3.jsonl.zstd`（V3） | `~/.dsh/sessions/<ws>/<session>/` |

官方 README 只写了两种运行方式（`npx @deepseek-ai/dsh web` 与源码 `pnpm dsh web`），**没有专门的升级章节**；本项目处于 developer preview，官方明确会持续引入破坏性变更。

## 2. 可升级到的版本（npm registry 实测）

`@deepseek-ai/dsh` dist-tags（npmjs 与 npmmirror 一致）：

- `latest` = `0.2.0-rc.2` ← 推荐目标
- `next` = `0.2.0-rc.2`
- `alpha` = `0.2.1-alpha.2`（更新的实验版，不建议日常用）

介于两者之间的 `0.1.7-rc.2` 是 0.1.x 线最后一版，可作为「小步升级 / 过渡」选项。

`npm outdated -g` 的判定：

```
@deepseek-ai/dsh  current 0.1.5-rc.3  wanted 0.2.0-rc.2  latest 0.2.0-rc.2
```

即本机 npm 认为 `update` 的目标就是 `0.2.0-rc.2`。

## 3. 升级步骤（必须在 DSH 之外的普通终端执行）

```sh
# 0) 确认版本
which dsh && dsh --version

# 1) 备份数据目录（配置 / 会话 / 凭据）
cp -a ~/.dsh ~/.dsh.bak-$(date +%Y%m%d-%H%M)

# 2) 停掉占用 3080 的 dsh 进程（前台启动的直接 Ctrl-C）
kill 2835          # 或 lsof -nP -iTCP:3080 -sTCP:LISTEN 查到的新 PID

# 3) 升级（显式锁版本，可复现）
npm install -g @deepseek-ai/dsh@0.2.0-rc.2
#   或跟随 latest 标签
# npm install -g @deepseek-ai/dsh@latest
#   或 0.1.x 过渡版
# npm install -g @deepseek-ai/dsh@0.1.7-rc.2

# 4) 验证（先不启服务，确认 profile 能组合）
dsh --version                      # 期望 0.2.0-rc.2
dsh --dump-default-config | head   # 能打印即表示 bundle 解析正常
dsh web                            # 重启；刷新 http://127.0.0.1:3080
```

要点：

- **不需要重装 profile / 插件**。内置 bundle 优先从 dsh 安装目录解析，其次才是 profile 的 `node_modules`（`resolveBundleDir()` 实测代码顺序）；本机 profile 没有任何第三方插件，升级 CLI 即可。插件升级是另一条路径（设置 → 插件管理）。
- **不要在当前这个 Web 会话的 shell 里执行**：本会话文件沙箱为 `workspace-write`，写 `~/.npm` 和 nvm 全局目录会被拒（实测 `touch ~/.npm/x` → `Operation not permitted`，`npm view` 也因缓存写入报 EPERM）。这是沙箱限制，不是 npm 缓存损坏（`find ~/.npm ! -user gubin` 结果为 0）。在普通终端里 npm 缓存是可写的。
- **npm 11.19 的 allowScripts 警告不是错误**。dry-run 会提示 5 个包（`dsh-subprocess-local`、`koffi`、`node-pty`、`@google/genai`、`protobufjs`）的安装脚本未在允许列表中；实测 npm 源码中只有「显式 deny」才会跳过脚本（`isScriptAllowed() === false`），`strict-allow-scripts` 默认为 false，所以脚本照常执行，警告可忽略（介意可加 `--allow-scripts=<逗号列表>`）。
- 依赖解析实测通过：`npm install -g --dry-run @deepseek-ai/dsh@0.2.0-rc.2` → `added 538 packages in 25s`，无 peer / engine 报错；新版本未声明 `engines`，Node 24.21.0 可用。
- 升级前请先停服务：覆盖安装正在使用的 `node_modules` 时进程仍在运行，重启前页面不可靠。

## 4. 升级后的迁移点（0.1.5 → 0.2.0 跨度大，来自官方 release notes）

- **会话日志 V3 → V4**：`session.v3.jsonl.zstd` 需要迁移，官方提供面向开发者的批量迁移工具，对部分缺失 turn-end 记录的 V3 历史有限支持 → 升级后先打开一个旧会话验证，**备份先别删**。
- **设置存储迁移**：设置从 `~/.dsh/settings.yaml` 迁到「当前 Profile 的插件配置」，旧文件只导入一次（本机 `settings.yaml` 目前只有主题/语言/onboarding 三项，风险低）。
- **协议与 API**：官方 DeepSeek 适配器只保留 Messages API（自定义旧官方根地址需改为 `https://api.deepseek.com/anthropic`）；`pi-ai` 升级后部分旧模型 ID 被移除，已保存的模型选择可能需要重选。
- **插件/扩展破坏性变更**：PTC 包名统一为 `ptc-runtime`、移除 `./invariant` 导出、工具展示移除 `both` 模式、Agent 预设改由 bundle 声明、插件依赖改为运行时解析。本机没有自研插件，基本不受影响；若以后装了第三方插件，需确认其兼容 0.2.x。
- 自动化任务（Schedule）在 0.2.x 改为可选插件包提供。

## 5. 回滚

```sh
npm install -g @deepseek-ai/dsh@0.1.5-rc.3

# 仅当新版已迁移过 ~/.dsh（settings.yaml 导入 / 会话 V4）且需要彻底回退时：
rm -rf ~/.dsh && cp -a ~/.dsh.bak-<时间戳> ~/.dsh
```

建议先用备份副本 + 一个旧会话验证「旧版还能读回滚后的数据」，再删除备份。

## 6. 一句话结论

当前 dsh 是 nvm 下的 npm 全局安装（0.1.5-rc.3），升级方式就是**在 DSH 之外的终端** `npm install -g @deepseek-ai/dsh@0.2.0-rc.2`，随后重启 `dsh web`；升级前备份 `~/.dsh`、停止 3080 进程，升级后重点验证旧会话迁移与设置迁移。本会话内部的沙箱禁止写 `~/.npm` 与全局 node_modules，所以不能由 agent 在当前会话里直接完成。

## 7. GitHub 上的「dsh 升级插件」（2026-10-10 调查）

官方没有内置更新器：在已装 `@deepseek-ai/dsh@0.1.5-rc.3` 的整棵包里检索 `check-for-updates` / `perform-update` 无命中；官方 README 也只给 npx 与源码两种运行方式。以下全是**社区插件**（非 DeepSeek 官方产品），安装方式统一是 `dsh plugin --profile web add <包名或 git 地址>` 后重启。

### 7.1 能真正执行「升级 dsh 本体」的

| 插件 | 安装 | 能否在 0.1.5-rc.3 上装 | 机制与要点 |
|---|---|---|---|
| [ShanHaiFish/dsh-check-for-updates](https://github.com/ShanHaiFish/dsh-check-for-updates)（npm `dsh-check-for-updates` v1.14.0） | `dsh plugin --profile web add dsh-check-for-updates` | ✅ 声明 `peerDependencies: ^0.1.0-rc.6 \|\| ^0.2.0-rc.1`，明确「兼容 DSH 0.1.x / 0.2.x 双世代」 | 分离式两阶段：UI 只「安排更新」，退出 DSH 后由 detached 子进程执行 `npm install -g @deepseek-ai/dsh@<精确版本>`，再做 npm 退出码 / 对盘版本 / koffi 三重校验与断链自愈；运行时探测 DSH 安装根与 node/npm，无硬编码路径；左下弹窗 + 设置入口 |
| [YannZhou/dsh-about](https://github.com/YannZhou/dsh-about)（npm `@yannzhou/dsh-about`） | `dsh plugin --profile web add @yannzhou/dsh-about`（或 `git+https://github.com/YannZhou/dsh-about.git`） | 针对 `npm i -g @deepseek-ai/dsh` 场景设计，Node ≥ 18 | 设置中心「关于」分区：版本信息、检查更新（区分稳定/预发布）、一键更新 + 自动重启（Win/macOS/Linux）、更新源可切国内镜像、GitHub release 记录；**内置 npm `allow-scripts` 白名单**（自动把 dsh 的原生模块追加进 `~/.npmrc`，正好覆盖 npm 12 默认拦截安装脚本的坑）；升级期白屏自救；更新结果用进程 nonce 校验，不会被旧进程冒充 |
| [Airmetro/dsh-update-checker](https://github.com/Airmetro/dsh-update-checker)（npm `dsh-update-checker` v1.7.1，20★） | 需按 README 手动放入 `$DSH_HOME/profiles/node_modules/` 并改 `cordis.patch.yml`（步骤较繁琐） | 记录里明确支持 `npm -g` 布局与 nvm/mise/asdf shim 的 node/npm 解析 | 全生命周期：检查 → dry-run 守卫 → 快照备份（含 `main-snapshot`）→ 原地或 `-g` 安装 → 验证 → 一键**回滚** → 重启看门狗；macOS/Linux 用 `lsof`/`ss` 探端口，需装 `lsof`；同时管第三方插件更新并写回 profile `package.json` + lockfile |
| [mervin1944/dsh-version-badge](https://github.com/mervin1944/dsh-version-badge)（npm `dsh-version-badge` 0.1.1） | `dsh plugin --profile web add dsh-version-badge` | 未声明 | 侧栏版本徽标 + 检查更新 + 一键部署全局 CLI（`@deepseek-ai/dsh@latest`）并脱离当前进程重启；可禁用部署/重启 |
| [deepseek-dsh/dsh-workspace](https://github.com/deepseek-dsh/dsh-workspace) | 见其 README（含 `#dev` 分支装法） | 未声明 | 侧栏工作台（余额/用量/文件/Git/终端）里带「一键更新 Harness」 |

只检查不改动、只给命令的：[idoall/dsh-update-status](https://github.com/idoall/dsh-update-status)（只读版本 chip + 可复制的升级命令）。

### 7.2 不下载新版，但让升级不翻车的「守卫」

| 插件 | 作用 |
|---|---|
| [Noob-stupid/dsh-plugin-gating-hub](https://github.com/Noob-stupid/dsh-plugin-gating-hub)（98★） | 升级前会话格式契约预检、失败自动回滚、启动失败插件自动隔离、版本门禁（host 接不住的版本直接拒绝安装） |
| [wqx11235/dsh-upgrade-guard](https://github.com/wqx11235/dsh-upgrade-guard) | 升级前逐个插件兼容盘点 → 升级后按「已知破坏性契约目录」扫描 → 切端口前先启动冒烟，不通过不切 |
| [YouHui1/dsh-sessions-diagnosis](https://github.com/YouHui1/dsh-sessions-diagnosis) | 修复升级后打不开的会话：0.1.5 起的会话迁移有「封闭词表审计」（旧构建写入的 `at-file-mention` source kind 会让整次迁移中止），该插件跑官方迁移链诊断并给出可修复/不可修复分类 |

### 7.3 插件作者向（不是升级 dsh 本体）

- [oh-my-dsh/dsh-plugin-upgrade-skill](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill)：195 张升级说明卡，覆盖 0.1.0-rc.8 → 0.2.0-rc.1，教 agent 把**插件**迁到新宿主。
- [PerryLink/dsh-plugin-upgrade](https://github.com/PerryLink/dsh-plugin-upgrade)：走廊索引式扫描 skill（`legAB` / `legC`）。

### 7.4 相关但不对口

- [zudazhuang/dsh-upgrade](https://github.com/zudazhuang/dsh-upgrade)：README 明确写的是「**源码安装**的版本检查与安全更新」，需要 `DSH_SOURCE` + 受监督启动脚本 → **不适用于本机 npm 全局安装**，仅作参考。
- [loudMore/dsh-launcher](https://github.com/loudMore/dsh-launcher)（38★，C#）：Windows 桌面 GUI 启动器，一键安装/更新 dsh 与插件 → 平台不符（本机 macOS）。
- 市场类（管的是插件更新，不是 dsh 本体）：[dsh-market/dsh-market](https://github.com/dsh-market/dsh-market)、[bradeGithub/DSH-Plugins-Marketplace](https://github.com/bradeGithub/DSH-Plugins-Marketplace)、[KYinCode/dsh-hot-installer](https://github.com/KYinCode/dsh-hot-installer)（插件热装卸，免重启）。

### 7.5 选用注意

1. **顺序**：升级 dsh 的插件必须先在**当前 0.1.5-rc.3** 上挂载成功，才能用它发起升级；dsh-about 自己也提示「更新 DSH 前先更新插件」。
2. **npm 12 差异**：npm 12 默认拦截依赖安装脚本，升级 dsh 时需 `--allow-scripts=fs-ext,koffi,node-pty,protobufjs,@google/genai,@deepseek-ai/dsh-subprocess-local`（本机 npm 11.19 仍会执行脚本，只是告警）。
3. **风险**：都要写 `~/.dsh/profiles/web` 的插件清单，属第三方代码；能力越强（能跑 `npm install -g`、能重启进程）权限越大。建议先备份 `~/.dsh`，再用 7.1 中任一 +（可选）7.2 的守卫。
4. 发现渠道：GitHub topic [`dsh-plugin`](https://github.com/topics/dsh-plugin)、精选列表 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。

## 8. 实际执行结果（2026-10-10 13:25，用 `upgrade-dsh.sh`）

- **升级成功**：`@deepseek-ai/dsh` `0.1.5-rc.3` → **`0.2.0-rc.2`**，`npm install -g` 输出 `added 118 / removed 100 / changed 420 packages`（约 1 分钟）；`dsh --version` 已是 `0.2.0-rc.2`，服务在 3080 正常运行（`dsh --profile web --no-open --port 3080`）。
- **数据备份**：`~/.dsh.bak-20261010-132543`（确认无误后可 `rm -rf` 删除）。
- **设置迁移已自动完成**：`~/.dsh/settings.yaml` → `~/.dsh/settings.yaml.imported`，主题/语言/onboarding 三项写入了 `~/.dsh/profiles/web/cordis.patch.yml`。
- **会话为懒迁移**：`~/.dsh/sessions/<ws>/<session>/` 里原 `session.v3.jsonl.zstd` 保留，被打开过的会话（如当前会话）多出 `session.v4.jsonl.zstd`；另外 3 个会话仍是 v3，等首次打开时才迁移。若某个旧会话打不开，见 7.2 的 `dsh-sessions-diagnosis`。
- **踩坑记录**：
  1. 脚本原用 `dsh --dump-default-config` 做冒烟测试，在 0.2.x 下报 `error: --profile <name> is required` → 已改为 `--profile web --dump-default-config`，并保留旧写法兜底；这是**脚本 bug，不是升级失败**。
  2. macOS 自带 bash 3.2 在 UTF-8 locale 下会把紧跟变量的全角字符当成变量名（`$NODE_BIN（` → `unbound variable`）→ 脚本内变量引用已全部改成 `${VAR}`。
- 回滚（如需）：`./upgrade-dsh.sh --rollback 0.1.5-rc.3`，必要时再 `./upgrade-dsh.sh --restore-backup`。

# dsh-im-bridge-workspaces（插件级 agent 说明）

> 面向 agent 的工作要点，从 [`../../dsh-im-bridge-workspaces/README.md`](../../dsh-im-bridge-workspaces/README.md)
> 提炼（2026-10-17，仓库统一治理 issue #1）。使用者文档仍以该 README 为准。

- 目录：`dsh-im-bridge-workspaces/`　包名：**`@mhfire/dsh-im-bridge`**（目录名 ≠ 包名）
- 来源：**fork** 自 npm 包 `@mhfire/dsh-im-bridge@0.4.4`，本地 fork 版本 `0.4.4-ws.1`；
  上游原版说明见 `README.upstream.md`。
- 改动范围：只加**多工作区列表与 `/ws` 切换**；其余行为（按企微窗口建 Agent、单聊一人一条、
  群聊共用一条、Settings 配置卡片、wecom-cli 办公层）与上游一致。

## 改哪里

| 路径 | 职责 |
|---|---|
| `src/workspace-router.ts` | 纯函数：命令解析 `parseWorkspaceCommand`、session key `sessionKeyForWorkspace`、选择器 `resolveWorkspaceSelector`（**不 import DSH/Cordis，可单测**） |
| `src/index.ts` | 绑定状态与持久化、`initWorkspaceBindings()`、`handleWorkspaceCommand()`、`ensureAgent(ref, binding, sessionKey)` 按工作区分流 |
| `test/workspace-router.test.ts` | 上述纯函数的单测（Node 24 type stripping） |
| `tsdown.host.ts` / `tsdown.client.ts` | host 出 `lib/index.js`，client 出 `lib/client.js` |
| `lib/index.js` | **构建产物**（host 侧），由 `pnpm run build:host` 重建，入库供 profile 直接加载 |

> 这是本仓库**唯一需要构建的插件**。改 `src/` 之后必须重建 `lib/` 再提交，否则运行时加载的是旧产物。
> client 侧沿用上游产物（`lib/client.js`），本次未改。

## 注意什么

- **命令不进模型**：`/ws`、`/workspace`、`/workspaces`、`/工作区` 由插件直接回复；普通文本才交给 Agent。
- **选择器匹配顺序**：1 起的序号 → 精确路径（尾部 `/` 忽略）→ 精确 id → 精确 title（大小写不敏感）→
  唯一的路径末段。title 重名时**不猜**，提示改用路径或 id。别破坏这个顺序。
- **切换目标目录不存在时拒绝切换**（列表里该行带 `⚠️ 目录不存在`），避免延迟到下一条消息才失败。
- **会话 key 兼容**：默认工作区仍用原窗口 key（`single:<userid>` / `group:<chatid>`），
  所以旧会话原样保留；其他工作区用 `<窗口key>#ws=<workspaceId>`。改 key 方案会丢历史会话。
- **持久化文件**：`$DSH_HOME/dsh-im-bridge/workspace-bindings.json`（`DSH_HOME` 为空 = `~/.dsh/...`），
  用 `tmp + rename` 写；**版本号或结构不对要明确告警，不静默丢弃**。删文件不影响功能。
- **两套权限**：`allowFrom` 决定谁能和机器人说话；`workspaceAllowFrom` 决定谁能让窗口切工作区。
  新配置项：`workspaceSwitch`（默认 `true`）、`workspaceAllowFrom`（默认 `[]`）、
  `workspaceAdd`（默认 `false`）。原有 `workspace` 字段仍是**默认工作区**。
- **启动时间盒**：工作区初始化有 5 秒时间盒，registry 卡住也不阻塞 WebSocket 连接；
  默认绑定若只是 `path:` 兜底，按 30 秒节流在消息路径上继续升级为 registry 记录。别改成阻塞式。
- **已知限制（不要顺手扩范围）**：`wecomCli`（办公 skills / 凭据目录 / office 技能）**仍绑定默认 workspace**，
  不随 `/ws` 切换；本次不做 office 凭据的多 workspace 化。
- 不修改 launchd plist 的 `WorkingDirectory`、不修改 `~/.dsh/storages/workspace.json`、
  也不改 `~/.dsh/profiles/web/node_modules` 里的上游包。

## 怎么验证

### ⚠️ 干净 checkout 里装不上依赖（跟踪 issue #3）

**在干净的 checkout 里 `pnpm install` 必然失败，不是配置错**：

- 本插件的 `peerDependencies` 用 `*` 声明 `@deepseek-ai/dsh-session` 等（连同
  `@deepseek-ai/cordis` / `dsh-agent` / `dsh-llm` / `dsh-settings` / `schemastery`）。
- `*` 会解析到 npm 上**陈旧的 `@deepseek-ai/dsh-session@0.0.1-rc.1`**，而它依赖**未发布的内部包**
  `@deepseek-ai/dsh-type-meta`——**npmjs 与 npmmirror 都是 404**。
- DSH 真正在用的 `dsh-session@0.2.0-rc.2` **并没有单独发布到公共 registry**。
- 已试无效：`pnpm install --config.auto-install-peers=false` 仍报同一个 404。

后果：本机之所以能跑，是因为 `node_modules` 早就装好（`~/.dsh/profiles/web` 的解析层提供 peer），
**CI 在干净 checkout 里装不上**。因此 `.github/workflows/ci.yml` 里这一项
`install: false`——**只跑 `node --check` 语法门禁**（两个入口已入库，无需依赖），
并在 job 里打印明确的跳过原因。收紧 `peerDependencies` 范围是 issue #3 的备选方案之一，
需用户拍板，**不在本仓库统一治理（#1）范围内**。

### 真实验收怎么走

在一次性 DSH profile 里验证装配（**绝不碰真实 `~/.dsh`**）——这是本插件唯一可信的完整校验：

```sh
scripts/pipeline/install-check.sh dsh-im-bridge-workspaces
```

它新建 `mktemp -d` 的 `DSH_HOME`，`pnpm dlx @deepseek-ai/dsh@<当前版本> plugin --profile headless add <插件绝对路径>`，
再用 `--dump-config` grep 到包名 `@mhfire/dsh-im-bridge` 即「装配成功」，装完即删。

### 本机开发命令（依赖已装好时）

> ⚠️ 本插件 README §4 的开发命令写的是 **npm**，属历史遗留（早于本仓库 pnpm 约定）。
> 本仓库一律用 pnpm 等价命令，见下表。

```sh
cd dsh-im-bridge-workspaces
pnpm install
pnpm test                       # = node --experimental-strip-types --test test/*.test.ts
pnpm run typecheck              # tsc -p tsconfig.json
pnpm run build:host             # 重建 lib/index.js
pnpm run build                  # host + client 一起重建
node --check lib/index.js       # 产物语法检查
```

- `node_modules/@deepseek-ai` 是指向本机 DSH 安装的**软链，只服务于 `typecheck`**
  （peer 依赖运行时由 profile 解析层接管）。**换 node 版本后该软链要重建**，否则 typecheck 报找不到模块，
  但**不影响运行**。
- `check-all.sh` 会跑 `test` / `typecheck`，但**不会**替你先 build；改了 `src/` 记得手动重建 `lib/`。

## 接入与回滚（本机已完成，仅供复核）

- profile `~/.dsh/profiles/web/package.json` 里：
  `"@mhfire/dsh-im-bridge": "link:/Users/gubin/workspace/self-dsh-plugins/dsh-im-bridge-workspaces"`，
  随后 `cd ~/.dsh/profiles/web && pnpm install` 并重启 DSH（fork 同名，`bundle` 列表与
  `cordis.patch.yml` 的 `id` / `name` 都不用改）。
- 回滚：把依赖改回 `"0.4.4"` → `pnpm install` → 重启 DSH。
  `~/.dsh/dsh-im-bridge/workspace-bindings.json` 可保留（上游不读它）。

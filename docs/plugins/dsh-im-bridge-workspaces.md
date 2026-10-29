# dsh-im-bridge-workspaces（插件级 agent 说明）

> 面向 agent 的工作要点，从 [`../../dsh-im-bridge-workspaces/README.md`](../../dsh-im-bridge-workspaces/README.md)
> 提炼（2026-10-17，仓库统一治理 issue #1）。使用者文档仍以该 README 为准。

- 目录：`dsh-im-bridge-workspaces/`　包名：**`@mhfire/dsh-im-bridge`**（目录名 ≠ 包名）
- 来源：**fork** 自 npm 包 `@mhfire/dsh-im-bridge@0.4.4`，本地 fork 版本 `0.4.4-ws.3`；
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

### ✅ 干净 checkout 能装依赖（issue #3 已修，2026-10-28）

- 根因：`peerDependencies` 原来全用 `*`。`*` 取的是 `dist-tags.latest`，而这些包的 latest 长期停在
  `0.0.1-rc.1`；`@deepseek-ai/dsh-session@0.0.1-rc.1` 的 peer 里有**未发布的内部包**
  `@deepseek-ai/dsh-type-meta`（npmjs / npmmirror 均 404），于是整棵树解析失败。
- 修法：把 DSH 运行时 peer 与客户端 peer 一律收窄到**实测版本 `0.2.1-rc.2`**（该版本在公共 registry 上齐全，
  且不引用 `dsh-type-meta`）；`cordis` / `schemastery` 保持 `*`（其 latest 本来就是可用版本）。
  全部仍是 `optional: true`，profile 侧仍由 DSH 自身提供 peer。
  > 精确 pin 的副作用（dsh 升不上去）已在 issue #72 解决：改成覆盖 `0.2.1-rc.2 / 0.2.1-rc.4`
  > 的 range，**仍是逐个版本验过才加的**。见下面「DSH 版本兼容」。
- 副作用：`pnpm test`（18 例）与 `pnpm run typecheck` 现在在干净环境都能跑通，CI 也因此不再跳过安装。
- ⚠️ **构建产物仍不可复现**：tsdown 打 client 包会把绝对路径和 CSS module 哈希写进 `lib/client.js`，
  换机器重建必脏，所以 CI 对这项设 `fresh: false`（不跑新鲜度检查），**别手工重建后提交 client 产物**。

### 真实验收怎么走

在一次性 DSH profile 里验证装配（**绝不碰真实 `~/.dsh`**）——这是本插件唯一可信的完整校验：

```sh
scripts/pipeline/install-check.sh dsh-im-bridge-workspaces
```

它新建 `mktemp -d` 的 `DSH_HOME`，`pnpm dlx @deepseek-ai/dsh@<当前版本> plugin --profile headless add <插件绝对路径>`，
再用 `--dump-config` grep 到包名 `@mhfire/dsh-im-bridge` 即「装配成功」，装完即删。

### DSH 版本兼容（peer 声明怎么放宽）

12 条 `@deepseek-ai/*` peer 曾是**精确** `0.2.1-rc.2`（issue #3 为修干净 checkout 装依赖所加），
副作用是 dsh 只能停在 `0.2.1-rc.2`。issue #72 起改为 `^0.2.1-rc.2 || ^0.2.1-rc.4`
——**两个锚点都是先跑一次性 `DSH_HOME` 验过才加的**。

- 门禁口径、逐版本 verdict、验证命令、失败时怎么记：见 [`../COMPATIBILITY.md`](../COMPATIBILITY.md)。
- ⚠️ `0.2.2-alpha.2` **没有放宽**：装配/加载能过，但 `dsh-agent` 的 `installModelSelection` 删了第二个参数，
  `tsc` 报 `TS2554: Expected 1 arguments, but got 2`（`src/index.ts:1285`），且 `reasoningEffort` 会静默失效。
  已如实记为 `incompatible`。注意门禁用 `includePrerelease`，`^0.2.1-rc.2` 在运行期仍会放行 alpha.2
  ——那不等于我们宣称支持它。
- 放宽前请重跑上面的 `install-check.sh`；**不要**用 `dsh plugin allow-version` 的版本豁免代替验证。

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

## 图片接收（v1，issue #76）

**结论**：通道是智能机器人长连接，图片走 `message.image`（`{ image: { url, aeskey } }`，
url 5 分钟有效），SDK 自带 `ws.downloadFile(url, aesKey)` 做 AES 解密并返回 `Buffer`。
**不需要 corpsecret / wecom-cli 权限**。默认模型 `opencode-go/deepseek-v4.1-flash`
已声明 `input: [text, image]`，看图能力现成。

### 新增/改动

| 文件 | 职责 |
|---|---|
| `src/wecom-image.ts`（新） | 纯函数：`detectImageMediaType(bytes)` 魔数判 png/jpeg/webp/gif；`imageLimitMessage(error)` 把 `AttachmentError.code` 映射成中文；`IMAGE_PLACEHOLDER_TEXT` 占位文本 |
| `src/index.ts` | 注册 `ws.on('message.image')`；把 `message.text` 回调体抽成共享 `dispatchInbound`；`handle()` 增加图片参数；`attachments.saveImage()`；模型能力闸门 |
| `test/wecom-image.test.ts`（新） | 上述纯函数单测 |
| `cordis.patch.yml` + `README.md` | `imageEnabled` 默认值与用法/限制说明 |

### 数据流

```
message.image → 立即 ws.downloadFile(url, aeskey)（守 5 分钟有效期）
             → detectImageMediaType(buffer)（不支持则友好拒绝）
             → ctx.attachments.saveImage({ data, mediaType, name })
             → ImageAttachmentRef
             → createUserMessage({ content: [{type:'text', text}, {type:'image', attachment: ref}] })
             → st.agent.followup(...)
```

**顺序纪律**：回调里**立即启动**下载（拿到 promise），把 promise 交给该会话的 `st.queue`
再 await —— 既守住 URL 有效期，又不打乱文本/图片的到达顺序。

### 能力闸门

`ctx.get('llm')?.resolveModelInfo(sel.provider, sel.model)` 的 `inputModalities` 若已定义且不含
`image`，直接回「当前模型不支持看图」——与 GUI（`dsh-api-session-controller` 的 `prompt()`）
一致。**不要**让 DSH 静默投影成文本句柄，那会让模型"看不见却照常作答"。

### 错误矩阵（必须全部落到中文提示，不得静默）

| 情况 | 回复 |
|---|---|
| 下载/解密失败、url 过期 | 「图片下载失败，请重发一次」 |
| 魔数不在 png/jpeg/webp/gif | 「不支持该图片格式，请转成 PNG/JPEG」 |
| `AttachmentError`（`IMAGE_TOO_LARGE` 等） | 按 code 映射中文（含 DSH 默认 20MB/张、64MP） |
| `ctx.attachments` 不可用 | 「附件服务不可用」 |
| `imageEnabled=false` | 「本通道未开启图片」 |

### 配置

`imageEnabled`（默认 `true`）——总开关。`Config` interface + schema + `cordis.patch.yml` 三处同步。

### 验收

- `pnpm test` 全绿（新增用例覆盖：四种格式、伪扩展名、超限 code 映射）。
- `pnpm run build:host` → `node --check lib/index.js` 通过。
- 手工（需真机）：单聊/群聊发图 → Agent 描述图片；切纯文本模型发图 → 明确提示；`/ws` 命令不回归。
- 不在本次范围：`message.mixed`、`quote.image`、`message.file`、语音。

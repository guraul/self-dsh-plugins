# @mhfire/dsh-im-bridge（本地 fork：`0.4.4-ws.2`，多工作区 /ws 切换）

基于已安装的 `@mhfire/dsh-im-bridge@0.4.4` fork，给企业微信通道加上**工作区列表与切换**。
其余行为（按企微窗口建 Agent、单聊一人一条、群聊共用一条、Settings 配置卡片、wecom-cli 办公层）与上游一致。

上游原版说明见 [README.upstream.md](./README.upstream.md)。

---

## 1. `/ws` 命令用法

在企微里直接发命令即可，**命令由插件回复，不会进入模型**；普通文本仍然交给 Agent。

| 命令 | 作用 |
| --- | --- |
| `/ws`（别名 `/workspace`、`/workspaces`、`/工作区`、`/ws list`） | 列出所有工作区：序号、`← 当前` 标记、title、路径、会话数、`⚠️ 目录不存在` 警告 |
| `/ws <序号\|title\|路径\|id>` | 切换**当前企微聊天窗口**的工作区；下一条消息在该工作区的 cwd 下创建 / 恢复会话 |
| `/ws reset`（别名 `/ws default`） | 回到默认工作区（`config.workspace`） |
| `/ws add <路径>` | 登记一个已存在目录并切换过去；需 `workspaceAdd: true` |
| `/ws help` | 帮助 |

选择器匹配顺序：**1 起的序号 → 精确路径（尾部 `/` 忽略）→ 精确 id → 精确 title（大小写不敏感）→ 唯一的路径末段**。
title 重名时不会乱猜，而是提示改用路径或 id。

补充行为：

- `~/…` 会展开成用户主目录（`/ws add ~/foo`、`/ws ~/foo` 都可用），相对路径基于**当前窗口的 workspace**解析。
- 切换目标目录不存在时**拒绝切换**（列表里该行会带 `⚠️ 目录不存在`），避免下一条消息才在建会话处失败。
- 任何命令分支出错都会回一句「工作区命令执行失败：…」，不会静默无响应。
- 启动时工作区初始化有 **5 秒时间盒**：registry 卡住也不会阻塞 WebSocket 连接；默认绑定若只是 `path:` 兜底，会按 30 秒节流在消息路径上继续升级为 registry 记录。

会话规则：

- 默认工作区仍使用原来的窗口 key（`single:<userid>` / `group:<chatid>`），因此
  **旧的 `wecom-321a442c817b39b6`、`wecom-999fe97847e6563d` 会话原样保留**。
- 其他工作区的 key 是 `<窗口key>#ws=<workspaceId>`，所以每个工作区一条独立会话；
  切回旧工作区会自动接回旧会话。
- 切换后新会话以 `meta.cwd = <workspace.path>` 创建，并由 `workspaceRegistry.attachSession`
  归入对应工作区，DSH Web 侧栏里会显示在该工作区下。

## 2. 新配置项

`Config` 新增三个字段（Settings 插件配置卡片 / `cordis.patch.yml` 均可设置）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `workspaceSwitch` | `true` | `false` 时拒绝所有切换（`/ws reset`、`/ws add` 一并拒绝；列表与帮助仍可用） |
| `workspaceAllowFrom` | `[]` | 切换工作区的 userid 白名单；空 = 所有通过 `allowFrom` 的发送者都能切换 |
| `workspaceAdd` | `false` | 是否允许 `/ws add <路径>` 登记新目录 |

原有的 `workspace` 字段仍是**默认工作区**（未切换时所有窗口使用的目录）。

> 命令权限与聊天权限是两套：`allowFrom` 决定谁能和机器人说话，
> `workspaceAllowFrom` 决定谁能让窗口切换工作区。

## 3. 持久化文件

窗口 → 工作区的绑定写在：

```text
$DSH_HOME/dsh-im-bridge/workspace-bindings.json      # DSH_HOME 为空时 = ~/.dsh/...
```

```json
{
  "version": 1,
  "windows": {
    "single:GuBin": { "id": "<workspaceId>", "path": "/Users/gubin/workspace/homebase", "title": "homebase" }
  }
}
```

- 写入用 `tmp + rename`，避免半截文件；版本号或结构不对会明确告警而不是静默丢弃。
- 启动与每次消息都会用 `workspaceRegistry.get()` 校验绑定：id 找不到时**先按路径找回**，
  两者都没有才清掉绑定并回退默认工作区（不会因为一次记录变更就永久丢窗口设置）。
- 删除该文件不影响功能，只会让所有窗口回到默认工作区。

## 4. 接入 profile（本机已完成的步骤）

`~/.dsh/profiles/web/package.json`：

```json
"@mhfire/dsh-im-bridge": "link:/Users/gubin/workspace/self-dsh-plugins/dsh-im-bridge-workspaces"
```

随后 `cd ~/.dsh/profiles/web && pnpm install`，并重启 DSH（`bundle` 列表、`cordis.patch.yml`
里的 `id: im-bridge` / `name` 都不需要改，因为 fork 保持同名）。

开发命令：

```bash
cd /Users/gubin/workspace/self-dsh-plugins/dsh-im-bridge-workspaces
npm install --cache /tmp/npm-cache-imws --no-audit --no-fund   # 临时 cache，绕过 ~/.npm 权限问题
npm test                 # node --experimental-strip-types --test test/*.test.ts
npm run build:host       # 重建 lib/index.js（client 侧未改动，lib/client.js 沿用上游产物）
node --check lib/index.js
```

`node_modules/@deepseek-ai` 是指向本机 DSH 安装的软链，**只服务于 `npm run typecheck`**
（peer 依赖在运行时由 DSH 的 profile 解析层接管，见下文限制说明）。
换 node 版本后该软链需要重建，否则 typecheck 报找不到模块，但**不影响运行**。

## 5. 回滚

```bash
# 1) 恢复依赖
python3 - <<'PY'
import json, pathlib, time
p = pathlib.Path.home() / '.dsh/profiles/web/package.json'
data = json.loads(p.read_text())
data['dependencies']['@mhfire/dsh-im-bridge'] = '0.4.4'
p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
PY
# 2) 重新安装
cd ~/.dsh/profiles/web && pnpm install
# 3) 重启 DSH
launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh-web.self-dsh-plugins
```

新增的 `~/.dsh/dsh-im-bridge/workspace-bindings.json` 可以保留（上游插件不读它），必要时手动删除。

## 6. 已知限制

- **`wecomCli`（办公 skills / 凭证目录 / office 技能）仍绑定默认 workspace**
  （`config.workspace`），不随 `/ws` 切换；本次不改 office 凭据的多 workspace 化。
- 图片回传按当前 Agent 的实际 `cwd` 收集，已跟随工作区。
- 命令回复走 `replyStream` 单条文本，列表过长时按企微文本长度限制截断风险由条目长度控制。
- 不修改 launchd plist 的 `WorkingDirectory`，不修改 `~/.dsh/storages/workspace.json`，
  也不改动 `~/.dsh/profiles/web/node_modules` 里的上游包。

## 7. 代码结构

| 文件 | 说明 |
| --- | --- |
| `src/workspace-router.ts` | 纯函数：命令解析 `parseWorkspaceCommand`、session key `sessionKeyForWorkspace`、选择器 `resolveWorkspaceSelector`（不 import DSH/Cordis，可单测） |
| `src/index.ts` | 绑定状态与持久化、`initWorkspaceBindings()`、`handleWorkspaceCommand()`、`ensureAgent(ref, binding, sessionKey)` 按工作区分流 |
| `test/workspace-router.test.ts` | 上述纯函数的单测（Node 24 type stripping） |
| `tsdown.host.ts` / `tsdown.client.ts` | host 出 `lib/index.js`，client 出 `lib/client.js` |

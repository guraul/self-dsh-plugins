# @mhfire/dsh-im-bridge（本地 fork：`0.5.0-ws.1`，多工作区 /ws 切换 + 审批转接）

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
| `src/approval.ts` | 纯函数与队列：参数脱敏 `redactArguments`、文本回复解析 `parseApprovalReply`、按钮 key `parseButtonKey`、卡片/文本渲染、串行队列 `ApprovalQueue`（不 import DSH/Cordis/企微 SDK，可单测） |
| `test/workspace-router.test.ts` | 上述纯函数的单测（Node 24 type stripping） |
| `test/approval.test.ts` | 审批转接纯函数与队列的单测 |
| `tsdown.host.ts` / `tsdown.client.ts` | host 出 `lib/index.js`，client 出 `lib/client.js` |

## 8. 接收图片（v1）

在企微里**直接发图**即可：单聊发一张，或群里按原有规则发（群聊仍走同一条群会话）。
图片作为附件进入当前窗口的 Agent，与文字共用同一条会话队列，回复照旧回原聊天窗口。

支持的格式按**文件头魔数**判断，不看扩展名（企微给的是解密后的原始字节，文件名并不可信）：

| 格式 | 判定依据 |
| --- | --- |
| PNG | `89 50 4E 47 0D 0A 1A 0A` |
| JPEG | `FF D8 FF` |
| GIF | `GIF87a` / `GIF89a` |
| WebP | `RIFF....WEBP` |

限制：

- 单张 **≤ 20MB**；总像素 **≤ 6400 万**；单边宽高也有上限（见下面的失败提示）。
- **当前模型必须声明支持看图**（模型元数据 `inputModalities` 含 `image`）。元数据缺失时按「未知」放行；
  明确声明了但不含 `image` 的模型会被拒绝，图片不会进入模型。
- 企微下发的图片下载地址**只有 5 分钟有效期**，所以桥接在事件回调里就立刻开始下载，不等前面排队的对话；
  排队过久或网络慢导致下载失败时会直接回「图片下载失败，请重发一次」。
- 图片消息**不解析 `/ws` 命令**：带图的消息一律当图片处理，命令请单独发文字。
- 图片失败（下载、格式、超限、模型不支持）**不会创建会话，也不消耗一轮 Agent**。
- 纯图片消息进入模型时，会补一句占位文本「（用户发送了图片，请结合图片回答）」，方便模型理解意图。

配置项（Settings 插件配置卡片 / `cordis.patch.yml` 均可设置）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `imageEnabled` | `true` | `false` 时拒收图片，回「本通道未开启图片」；权限判断顺序仍是先 `allowFrom` 再这个开关 |

失败提示一览（都是中文，直接回到聊天里，不静默丢消息）：

| 场景 | 提示 |
| --- | --- |
| 通道关闭 | `本通道未开启图片` |
| 格式不认识 | `不支持该图片格式，请转成 PNG/JPEG/GIF/WebP 后重发` |
| 下载失败 | `图片下载失败，请重发一次` |
| 单张过大 | `单张图片太大（上限 20MB），请压缩后再发` |
| 像素总量过高 | `图片像素总量过高（上限 6400 万像素），请缩小后再发` |
| 宽高超出上限 | `图片宽高超出上限，请缩小尺寸后再发` |
| 张数 / 总体积超限 | `图片数量超出上限，请减少后重发` / `图片总体积超出上限，请减少数量或压缩后重发` |
| 内容与声明格式不一致 | `图片内容与声明格式不一致，请重发或换一张` |
| 图片无法解析 | `图片文件无法解析，请重发或换一张` |
| 模型不支持看图 | `当前模型 <模型名> 不支持看图，请切换模型后重试` |
| 模型能力读不到 | `无法确认当前模型是否支持看图，请稍后重试` |
| 附件服务不可用 | `附件服务不可用，暂时无法接收图片` |
| 其它未识别错误 | `图片处理失败，请重发一次` |

**不在本次范围**（v1 明确不做）：

- 图文混排（`mixed`）：桥接未订阅 `message.mixed`，整条消息不会进入模型。
- 引用图片（`quote`）：引用内容不解析，只处理本条新发的文字或图片。
- 文件（`file`）与语音（`voice`）：不下载、不转写，消息会被忽略。

## 9. 审批转接（v1，issue #78）

以前这个通道**没有审批应答方**：工具被沙盒拒绝后，DSH 发起的审批请求没有接收人，
按「拿不到答复就拒绝」直接失败。现在审批会转成企微消息，你点一下就放行**这一次**操作。

流程：

1. 某个工具调用需要审批（例如要写工作区外的文件、或访问系统钥匙串）。
2. 桥接把请求转成一张**按钮卡片**发到发起这次操作的聊天窗口。
3. 你点「同意」→ 这条命令以完整权限执行一次；点「拒绝」→ 按拒绝处理。
4. 卡片发不出去时，重试一次后降级成纯文本：回复「同意 3」/「拒绝 3」（数字是消息里的编号）。

规则：

| 规则 | 说明 |
| --- | --- |
| 只认发起者 | 只有触发这次工具调用的那个人能批准；别人点按钮会收到「只有发起这次操作的人可以批准」 |
| 一次一放行 | 批准只对这一次调用生效，下次同样操作会重新问 |
| 谁发起谁审批 | 企微会话的审批只在企微弹卡片，网页会话只在网页弹窗，不会两边同时打扰 |
| 超时拒绝 | 默认 5 分钟不操作按拒绝处理，并回一条说明 |
| 串行发送 | 同时有多个待批时一次只发一张卡，避免点错 |
| 断线等待 | 机器人断线时最多等 30 秒重连，超时按拒绝处理 |

配置项（Settings 插件配置卡片 / `cordis.patch.yml` 均可设置）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `approval.enabled` | `true` | 总开关；`false` 时不再发审批消息，恢复成「没有审批通道就直接拒绝」 |
| `approval.timeoutSec` | `300` | 单条审批的有效秒数（最低按 30 秒执行） |

审批记录写在 `$DSH_HOME/dsh-im-bridge/approval-audit-YYYY-MM.jsonl`，按月一个文件，
每行记：时间、请求编号、聊天、发起者、工具名、结果。**不记命令参数**，避免把敏感内容落盘。

已知限制：

- 卡片被点后企微要求 5 秒内回执才能更新卡片；网络差时卡片会停留在「待审批」的样子，
  但审批结果本身仍然生效（以随后的文字回执为准）。
- 群聊里卡片所有成员可见；非发起者点击会被拒绝并收到提示。

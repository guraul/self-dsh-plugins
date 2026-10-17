# dsh-plugin-external-discuss

把 DSH 的会话**一键送到外部模型继续讨论**。当前接通清言（chatglm.cn）网页版；千问、DeepSeek 先在弹层里占位。

## 它长什么样

助手消息操作栏（复制 / 反馈 / 新对话分支 / 用量 / 时间那一条）会多出一个图标按钮：

```
[复制] [外部讨论 ← 本插件] [👍👎] [新对话分支] [用量] [时间]
```

点开是一个参照「用量」小组件做的弹层，列出投递目标：

| 目标 | 状态 | 行为 |
| --- | --- | --- |
| 清言 | ✅ 可用 | 在已登录的清言页新建对话 → 按 DSH 会话标题重命名 → 粘贴正文 → 发送 |
| 千问 | ⏸ 占位 | 显示「即将支持」，不可点 |
| DeepSeek | ⏸ 占位 | 显示「即将支持」，不可点 |

投递完成后，按钮下方会显示结果（成功摘要，或失败在哪一步、为什么）。

## 工作原理

```
[DSH 页面] 操作栏按钮
    │  GET /api/dsh-external-discuss/payload?sessionId=…    ← 宿主半边取会话正文与标题
    │  window.postMessage（频道 dsh-external-discuss）
    ▼
[扩展 dsh-content.js]  仅转发，不读页面 DOM
    │  chrome.runtime.sendMessage
    ▼
[扩展 background.js]  找到（必要时打开）清言标签页 → 切到前台
    │  chrome.tabs.sendMessage
    ▼
[扩展 qingyan-content.js]  新对话 → 重命名 → 粘贴 → 发送
    │  回执逐级回投
    ▼
[DSH 页面] 按钮下方显示结果
```

正文取自宿主的会话投影（`session.deriveMessages()`），不是抓页面 DOM——干净、无 UI 噪声；标题优先取会话标题，没有则用第一条用户消息生成。

## 安装

**1. 插件（宿主 + 浏览器半边）**

```bash
dsh plugin --profile web add link:<本仓库目录>
```

装完**重启 dsh web**（bundle 在冷启动时装配）。

**2. Chrome 扩展**

打开 `chrome://extensions` → 打开右上角「开发者模式」→「加载已解压的扩展程序」→ 选择本仓库的 `extension/` 目录。
装完**刷新 DSH 页面**（内容脚本需要重新注入）。

**3. 准备清言**

在 Chrome 里打开 <https://chatglm.cn> 并保持登录——投递时用的是你现有的这个标签页，不需要额外登录或复制凭据。

## 排障

**按钮下方提示「没等到扩展回执」** → 扩展没装、没启用，或装完没刷新 DSH 页面。

**投递结果显示某个步骤失败** → 清言前端改版，选择器需要校准。在清言的标签页控制台里执行：

```js
chrome.runtime.sendMessage  // 若无此对象，说明不在扩展上下文，改用下面方式
```

更简单的办法：在 DSH 页面里让插件投递一次，然后看清言标签页控制台的 `[dsh→清言]` 日志——每一步点击/写入都有记录，失败会写明「完成到哪一步」。

需要现场 DOM 摘要时，在扩展的 service worker 控制台（`chrome://extensions` → 本扩展 → 「检查视图 service worker」）执行：

```js
chrome.tabs.query({ url: 'https://chatglm.cn/*' }).then(([tab]) =>
  chrome.tabs.sendMessage(tab.id, { type: 'qingyan:probe' }).then((r) => console.log(r.probe)),
)
```

把输出贴给维护者即可精准修选择器。所有候选文本集中在 `extension/qingyan-content.js` 顶部的 `CONFIG` 里。

**正文没进输入框** → 日志会写明用了哪种注入策略（`execCommand` / `paste-event` / `textContent`）。前两种是富文本编辑器认的方式，第三种是兜底。

## 边界与风险

- 清言是第三方页面，改版会让选择器失效——这是这条路线的固有维护成本；
- 扩展只做本机标签页之间的转发，不落盘、不上传、不读页面内容；
- 宿主路由限定本机回环（loopback-only）；
- 长正文不做截断（清言输入框会自动折叠），仅设 20 万字符的荒谬上限。

## 目录

| 路径 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半边：`/api/dsh-external-discuss/*` 路由 |
| `lib/host/transcript.js` | 会话 → 「我 / 助手」对话文本 + 标题兜底 |
| `lib/host/http.js` | 最小路由工具（方法分派、loopback 围栏、JSON 错误信封） |
| `lib/client.js` | 浏览器半边：操作栏按钮 + 弹层小部件（免构建） |
| `extension/manifest.json` | MV3 清单 |
| `extension/background.js` | 标签页定位、前台切换、转发 |
| `extension/dsh-content.js` | DSH 页 ↔ 扩展的桥 |
| `extension/qingyan-content.js` | 清言页执行器：新对话 / 重命名 / 粘贴 / 发送 |

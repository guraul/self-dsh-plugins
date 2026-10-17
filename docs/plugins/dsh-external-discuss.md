# dsh-external-discuss（插件级 agent 说明）

> 面向 agent 的工作要点，从 [`../../dsh-external-discuss/README.md`](../../dsh-external-discuss/README.md) 提炼
> （2026-10-17，仓库统一治理 issue #1）。使用者文档仍以该 README 为准。

- 目录：`dsh-external-discuss/`　包名：`dsh-plugin-external-discuss`　来源：**原创**

## 一句话

在 DSH 助手消息操作栏加一个按钮，点开弹层把**会话正文**投递到外部模型（当前只有清言
`chatglm.cn` 网页版可用，千问 / DeepSeek 占位）。跨页投递由配套 **Chrome 扩展**完成；
浏览器半边**免构建**。

## 改哪里

| 路径 | 职责 |
|---|---|
| `lib/index.js` | 宿主半边：`/api/dsh-external-discuss/*` 路由（注册在 `apply()` 里） |
| `lib/host/transcript.js` | 会话 → 「我 / 助手」对话文本 + 标题兜底（`collectConversation` / `fallbackTitle`） |
| `lib/host/http.js` | 最小路由工具（方法分派、loopback 围栏、JSON 错误信封） |
| `lib/client.js` | 浏览器半边：助手操作栏按钮 + 弹层小部件（`window.__ModuleLoader__.load({id, factory})`） |
| `extension/manifest.json` | MV3 清单 |
| `extension/background.js` | 扩展侧：定位（必要时打开）清言标签页、切前台、转发 |
| `extension/dsh-content.js` | DSH 页 ↔ 扩展的桥（只转发，**不读页面 DOM**） |
| `extension/qingyan-content.js` | 清言页执行器：新对话 / 重命名 / 粘贴 / 发送；**选择器候选集中在文件顶部 `CONFIG`** |

投递链路：页面按钮 → `GET .../payload?sessionId=…`（宿主取正文与标题）→ `window.postMessage`
（频道 `dsh-external-discuss`）→ 扩展 `dsh-content.js` → `background.js` → `qingyan-content.js`
→ 回执逐级回投 → 按钮下方显示结果。

## 注意什么

- **正文取自宿主的会话投影（`session.deriveMessages()`），不是抓页面 DOM**——保持这条，别改成 DOM 抓取。
  标题优先取会话标题，没有则用第一条用户消息生成。
- **清言是第三方页面，改版会让选择器失效**——这是这条路线的固有维护成本。所有候选文本集中在
  `extension/qingyan-content.js` 顶部的 `CONFIG` 里；修选择器先跑 README 里的 `qingyan:probe` 取现场 DOM 摘要。
  每一步点击/写入都有 `[dsh→清言]` 控制台日志，失败会写明「完成到哪一步」。
- **宿主路由 loopback-only**：`lib/host/http.js` 按 socket 地址判本机回环，不信任 `X-Forwarded-For`；
  有副作用的操作不要开成 GET。
- **扩展只做本机标签页之间的转发**：不落盘、不上传、不读页面内容。长正文不做截断
  （仅设 20 万字符的荒谬上限），别顺手加截断。
- **两处安装是分开的**：插件（`dsh plugin … add`，装完要重启 dsh web）+ Chrome 扩展
  （`chrome://extensions` 开发者模式加载 `extension/`，装完**刷新 DSH 页面**重新注入内容脚本）。
  「没等到扩展回执」几乎总是扩展没装 / 没启用 / 装完没刷新页面。
- 新增投递目标时：占位项在 `lib/client.js` 的目标表里；真接通要多一个 `extension/<site>-content.js`
  执行器 + `background.js` 的分支。

## 怎么验证

```sh
cd dsh-external-discuss
pnpm install        # 只有 react 一个 peer
pnpm test           # = node test/host.test.mjs（宿主半边隔离冒烟：路由注册 / 会话折算 / 标题回退 / 错误分支）
pnpm run check      # 逐个入口 node --check（宿主 + 浏览器半边 + 三个扩展脚本）
```

- 单测**不依赖 dsh 运行时**，用假 `ctx` / 假会话；因此**加路由或改折算逻辑必须同步 `test/host.test.mjs`**。
- 浏览器半边与扩展没有构建产物可验，改动后要做一次真浏览器冒烟（装扩展 → 刷新 DSH 页面 → 投递一次 →
  看清言标签页 `[dsh→清言]` 日志）。

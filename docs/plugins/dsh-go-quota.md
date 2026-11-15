# dsh-go-quota

**来源：原创。** 包名 `dsh-go-quota`，目录 `dsh-go-quota/`。

给 agent 的说明：改这个插件前读本页，它记的是「改哪里、容易踩什么、怎么验证」，安装与配置面向使用者的部分在
[`../../dsh-go-quota/README.md`](../../dsh-go-quota/README.md)。

## 它解决什么

用户要一块**直接查官网**的 OpenCode GO 额度显示，放在输入框下方那一行统计 pill 里，点开是与上下文浮层同样式的面板。
区别于 `dsh-usage-panel`（统计本地会话日志的 token，不查官网）。

## 数据通路

```
client.js  ──GET /plugins/go-quota/usage──▶  index.js（key 只在这一侧）
                                               │ Bearer
                                               ▼
                                 https://opencode.ai/zen/go/v1/usage
```

- `index.js` 用 `ctx.credentials.resolve(apiKeyEnv)` 取 `refs.OPENCODE_GO_API_KEY`（本机已在 `~/.dsh/.credentials.yaml`）
- 上游只认 `Authorization: Bearer`，**不需要 cookie / UA / CDP**
- 归一化后只暴露 `{ key, percent, status, resetsAt }`，顺序固定 rolling → weekly → monthly
- 缓存 30 秒，并发请求合并成一次上游调用

## 客户端

- 槽位：`conversation.composer.dock`（session 作用域 list 槽，id `go-quota`，order 60），与 `StatsPills` 的 `activity` / `usage` 同排
- 无构建：手写 `window.__ModuleLoader__.load` + `react.createElement`，写法对齐 `dsh-awake/lib/client.js`
- 样式全部用 dsh 设计 token，注入 `<style data-plugin-css="dsh-go-quota">`，不引入构建步骤

### 样式锚点（改外观时照抄这些来源）

| 元素 | 参考实现 |
|---|---|
| pill 尺寸 / 颜色 / hover | `@deepseek-ai/dsh-client-ui-chat` 的 `StatsPills.module.css`（`padding: 1px 8px`、`--dsw-radius-sm`、`--dsw-alias-label-tertiary`） |
| 浮层皮肤 | `@deepseek-ai/dsh-client-ui-conversation` 的 `ContextMeter.module.css`（`--dsw-specific-menu`、`--dsw-elevation-prominent`、`width: min(264px, …)`） |
| 浮层定位 | 同上，CSS anchor（`anchorName` / `positionAnchor`）+ `@position-try` 翻转与窄屏回退 |

`ContextMeter.module.css` 里的 `@position-try` 规则名带 `--dsh-context-` 前缀，本插件复制时改成了 `--dsh-gq-` 前缀，
避免与宿主规则重名。

## 容易踩的坑

1. **`node --test test/` 在 Node 24 上会报 `MODULE_NOT_FOUND`**：目录参数被当成模块入口。用
   `node --test "test/*.test.mjs"`（`package.json` 的 `scripts.test` 已经这么写）。
2. **浮层必须 portal 到 `document.body`**：输入框容器有 `overflow` 与层叠上下文，就地渲染会被裁掉。
3. **`z-index` 用 1100**，与上下文浮层同层；改小会被输入框工具栏盖住。
4. **不要做 provider 门控**（除非重新评估）：`conversation.composer.dock` 的 owner props 里没有可靠的
   provider 字段，要额外注入 `modelDirectories` 并订阅，失败面比收益大。当前设计是常显。
5. **401 不能硬说成「未订阅」**：无 key 与无订阅的响应体都是 `{"type":"error","error":{"type":"AuthError","message":"Unauthorized"}}`。

## 验证

```sh
cd dsh-go-quota && node --test "test/*.test.mjs"
```

真机验收（需要重启 dsh web，会断当前会话）：

1. 输入框下方出现 `额度 N%`，与相邻统计 pill 同高、同间距
2. 点开后三个百分比与 <https://opencode.ai> 控制台 GO 页面一致
3. Esc / 点击外部 / 再点一次都能关闭
4. 窗口宽度收到 400px 时浮层不溢出
5. 把 `apiKeyEnv` 改成不存在的名字，面板应显示「未配置」而不是报错

## 同步更新

改动后需要一起看的文件：

- 根 `README.md` 的插件表格与章节
- 根 `AGENTS.md` 的插件索引表
- `docs/plugins/README.md` 的索引表

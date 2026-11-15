# dsh-go-quota

DeepSeek Harness（`dsh`）Web 插件：在聊天输入框下方那一行统计 pill（`1 轮 10 步 · 138 tok/s`、`532K tok · 缓存命中 91%`、上下文环）末尾追加一枚**额度** pill，显示 OpenCode GO 套餐的 5 小时滚动窗口已用百分比；点开是与上下文浮层同样式的面板，列出 5 小时 / 本周 / 本月三个窗口。

数据**直接查官网**，不统计本地会话日志。

## 数据源

```http
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OPENCODE_GO_API_KEY>
```

返回：

```json
{"usage":{"rolling":{"status":"ok","percent":1,"resetsAt":"2026-11-15T11:58:18.000Z"},
          "weekly":{"status":"ok","percent":6,"resetsAt":"2026-11-16T00:00:00.000Z"},
          "monthly":{"status":"ok","percent":3,"resetsAt":"2026-12-13T06:02:09.000Z"}}}
```

- `percent` 是**已用**百分比，插件展示也用「已用」，不换算成剩余
- 接口只给百分比，**没有美元金额**；金额只在 opencode.ai 控制台里
- 这个路由官方没有公开文档（社区逆向所得），字段变化时插件显示「额度不可用」，不会回落成 0%
- 查询是只读账户状态，不消耗套餐额度

## 安装

```sh
dsh plugin --profile web add /Users/gubin/workspace/self-dsh-plugins/dsh-go-quota
```

装完重启 `dsh web`（会断当前会话），然后硬刷新浏览器。

## 配置

默认值写在 `cordis.patch.yml`，需要改时在 profile 的 `cordis.patch.yml` 里覆盖同 `id` 的条目：

| 键 | 默认 | 说明 |
|---|---|---|
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | 凭据引用名，从 `~/.dsh/.credentials.yaml` 的 `refs` 解析 |
| `baseUrl` | `https://opencode.ai/zen/go/v1/usage` | 上游地址 |
| `timeoutMs` | `15000` | 单次请求超时 |
| `cacheMs` | `30000` | 宿主侧内存缓存 TTL |

key 只存在于宿主进程与上游之间：浏览器请求的是同源路由 `GET /plugins/go-quota/usage`，返回体里没有 key。

## 显示规则

- pill 数字是 **5 小时滚动窗口的已用百分比**，悬停 tooltip 给出三个窗口的完整读数
- 进度条颜色：常态中性色；≥80% 转黄（`--dsw-alias-state-warn-primary`）；≥95% 转红（`--dsw-alias-state-error-primary`）
- 只在挂载时与展开面板时查询（宿主缓存 30 秒、前端判定 60 秒），**不做后台轮询**
- 未配置 key → 面板显示「未配置 OPENCODE_GO_API_KEY」
- 上游 401/403 → 面板显示「key 无效或未订阅 GO」（这两种情况响应体相同，无法区分）
- 请求失败 → 保留上次结果，面板底部标「刷新失败，显示上次结果」

## 已知限制

- 不做 provider 门控：切到别的模型时 pill 仍在，因为它显示的是账号额度，与当前模型无关
- 一个账号共用同一份额度，多个浏览器标签页看到的是同一组数字
- 接口未公开文档，若上游改结构，需要更新 `index.js` 的 `normalize()`

## 目录

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主侧：凭据解析、上游请求、缓存、同源路由 |
| `client.js` | 浏览器侧：pill、面板、样式、中英字典（无构建，手写 `__ModuleLoader__`） |
| `cordis.patch.yml` | bundle 补丁，声明插件条目与默认配置 |
| `test/host.test.mjs` | 宿主侧单测：归一化、错误映射、缓存命中、缺 key |

# dsh-zhihu-sidebar（插件级 agent 说明）

> 仓库级约定见根 [`AGENTS.md`](../../AGENTS.md)；面向使用者的说明见 [`../../dsh-zhihu-sidebar/README.md`](../../dsh-zhihu-sidebar/README.md)。
>
> ⚠️ **字段名、返回码、每日额度、命令用法**这类「外部世界长什么样」的事实，以插件内 **[`FACTS.md`](../../dsh-zhihu-sidebar/FACTS.md) 为权威**（有密钥实测过），本文不重复；
> 代码怎么设计的见 [`DEV-NOTES.md`](../../dsh-zhihu-sidebar/DEV-NOTES.md)；原始探针输出见 `.probe/REPORT.md`（**不入库**）。

- 目录：`dsh-zhihu-sidebar/`　包名：`dsh-plugin-zhihu-sidebar`　来源：**原创**

## 是什么

把知乎数据挂进 DSH Web **右侧栏**的双面插件：**热榜 / 搜索 / 我的创作**三个分段视图，
装在一个 tab 里。数据来自**知乎官方 Zhihu CLI**（闭源二进制，0.6.1）。

**核心安全设计**：密钥存在 macOS 系统凭证库，**由 CLI 自己读取**——插件进程与模型
**永不接触密钥明文**，最多拿到打码指纹（`76ed...9037`）。因此密钥不进对话记录、不落明文文件。

## 目录

| 路径 | 作用 |
|---|---|
| `lib/index.js` | 宿主入口：`name` / `inject = ['webServer']` / 注册 5 条只读路由 |
| `lib/client.js` | 浏览器半边：右侧栏两段式注册 + 一个 tab 三个子视图 + 错误态 + 中英字典 |
| `lib/host/cli.js` | 调 CLI 的**唯一出口**（`execFile`、超时、最小环境，不走 shell） |
| `lib/host/parse.js` | **三段判定** + 四类数据规范化（`normalizeHot/Search/Contents/Capabilities`） |
| `lib/host/queue.js` | 串行队列 + 同键去重（同一时刻最多一个子进程） |
| `lib/host/cache.js` | TTL 缓存（可注入时钟） |
| `lib/host/backoff.js` | 指数退避冷却表（限流用） |
| `lib/host/quota.js` | 每日额度计数 + **低频**刷新 + `extractQuota` |
| `lib/host/service.js` | 编排层：缓存 → 冷却 → 额度 → 队列 → CLI → 判定 |
| `lib/host/http.js` | 回环围栏、JSON 信封、`API` 路由常量、查询参数校验 |
| `test/fixtures/fake-cli.mjs` | 假 CLI（按场景返回退出码与 JSON），**测试绝不碰真实 CLI** |
| `FACTS.md` | 环境与实测事实（**权威**） |
| `DEV-NOTES.md` | 两阶段设计记录 + 已知缺陷 |

## 架构与数据流

```
浏览器（lib/client.js）
   │  fetch 相对路径（不带前导 /，same-origin）
   ▼
宿主 5 条只读路由（lib/index.js → host/http.js 的 API 常量）
   │  闸门顺序：缓存 → 冷却 → 额度刷新(低频) → 额度检查 → 记账 → 队列
   ▼
lib/host/cli.js  ──execFile──►  zhihu-cli  ──►  macOS 系统凭证库（CLI 自己读）
   │
   ▼
parse.js 三段判定 → 统一信封 → 规范化成小写字段 → 浏览器渲染
```

**右侧栏是两段式注册**，缺一不可：

1. `ctx.sidebarRightTabs.register({ id, kind, title, priority, guide })` —— 声明 tab 类型（纯静态）
2. `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name, key }, Body))` —— 挂正文，**`key` 必须等于第 1 步的 `id`**
3. `ctx.sidebarRight.openTab('zhihu')` —— 打开（当前入口是引导页卡片 `guide`）

权威参考：`@deepseek-ai/dsh-client-ui-deliverables`（官方右侧栏插件）的 `package.json` 与 `lib/client.js`。

### ⚠️ 两层 `inject` 别写混

| 层 | 写什么 | 本插件的值 |
|---|---|---|
| `package.json` → `dsh.client.inject` | **包名** | `dsh-api-remotes` / `dsh-client-connection` / `dsh-client-locale` / `dsh-client-ui-renderer` / `dsh-client-ui-sidebar-right` |
| `lib/client.js` 导出的 `inject` | **服务名** | `slots` / `locale` / `sidebarRightTabs` / `sidebarRight` / `remote` |

`@deepseek-ai/dsh-client-ui-slots` 这个包**在文件系统里不存在**（已查证），别写进包名列表——`slots` 是服务，由外壳提供。

## 改哪里（按改动类型路由）

| 你要改… | 动这里 | 连带影响 |
|---|---|---|
| 接新数据能力 | `host/http.js` 的 `API` + `host/parse.js` 加 `normalizeXxx` + `host/service.js` | 加路由测试 + 规范化测试 |
| 字段名 | `host/parse.js` | **必须对照 `FACTS.md` §3 的真实字段**；测试 fixture 要同步 |
| 额度/限流策略 | `host/quota.js` / `host/backoff.js` | 时钟必须可注入，否则测试要真等 30 秒 |
| 右侧栏 UI | `lib/client.js` | 纯逻辑抽成可测函数（渲染组件本身不测） |
| 文案 | `lib/client.js` 的 `zh` / `en` 字典 | 有测试断言两语言键一一对应、占位符一致 |

## 注意什么（硬约束）

1. **热榜每天只有 100 次**（`FACTS.md` §4）。**绝不自动轮询**——只在用户点击时请求，UI 有 30 分钟冷却倒计时。
2. **`quota` 命令自身会触发限流** → 额度必须**低频刷新**（30 分钟节流 + 防并发），**绝不能每次请求前查**，否则自己限流自己。
3. **输出永远是 JSON，没有 `--json` 开关**（传了返回码 2）。成功与失败是**两套完全不同的结构**：
   成功 `{Code,Message,Data}` 首字母大写，失败 `{ok:false,error:{...}}`。
   **判定顺序：返回码 → 有没有 `ok` → 有没有 `Code`**，三段不可交换。
4. **`search zhihu` 必须 `--query`**，不接受位置参数（返回码 2）。
5. **测试绝不调用真实 CLI**（消耗额度）——一律走 `test/fixtures/fake-cli.mjs`。
6. **测试数据必须来自真实结构**：曾因代码写 `ApiId` 而真实是 `APIID`，fixture 照着实现造 → **87 个测试全绿却是假阳性**。
7. 客户端取数用**相对路径**（不带前导 `/`），宿主路由只接受**回环请求**（socket + Host + `Sec-Fetch-Site` + Origin 四重校验）。

## 怎么验证

```bash
cd dsh-zhihu-sidebar
node --test "test/*.test.mjs"        # 116 项（数据层 87 + 界面 29）
node --check lib/index.js && node --check lib/client.js

# 仓库级装配验收（一次性 DSH_HOME，装完即删，不碰真实 ~/.dsh、不重启）
scripts/pipeline/install-check.sh dsh-zhihu-sidebar
```

**测试与装配都过了 ≠ UI 对**：界面要看到效果必须重启 dsh web（会掐断当前会话），
按仓库规矩走一次性隔离环境或在合并后由用户择时重启。

## 待办 / 已知限制

- 不支持翻页（`hasMore` / `NextOffset` 只在页脚提示）
- 不显示赞/评论数（宿主层未透出这些字段，要加得连带改第一阶段测试）
- `sidebarRight` / `remote` 两个服务注入了但当前无调用点（留给后续会话头按钮）
- CLI 路径默认指向 `.probe/bin/zhihu-cli`（探针产物，**不入库**），正式部署应换 `.runtime/`
- `.probe/` 已被 `.gitignore` 显式排除（含二进制 9.7 MB）
- `docs/` 与根 `AGENTS.md` 的插件索引已登记本插件

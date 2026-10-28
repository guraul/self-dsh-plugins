# DEV-NOTES — 知乎侧栏开发记录

- 日期：2026-10-28
- 范围：`dsh-zhihu-sidebar/` 内的宿主侧数据层（§1–§6）与浏览器侧右侧栏（§7）。
- 第一阶段只做数据层、不含 UI；第二阶段补右侧栏界面，**不改数据层语义**。
- 验收方式：`node --test "test/*.test.mjs"`（116 通过 / 0 失败）+ `node --check`（全部 0）。
- 未触碰 `.probe/`、`.gitignore`、`docs/`、其它插件与 `~/.dsh/`。

## 1. 文件清单

| 文件 | 作用 |
|---|---|
| `package.json` | `dsh-plugin-zhihu-sidebar`，ESM，`main: lib/index.js`，`dsh.bundle.patch`、`dsh.client` 占位 |
| `cordis.patch.yml` | `insert` 一条：id `dsh-zhihu-sidebar` → 包名 `dsh-plugin-zhihu-sidebar` |
| `lib/index.js` | cordis 入口：`name` / `inject = ['webServer']` / `apply`，注册五条只读路由 |
| `lib/client.js` | 浏览器半边占位（第二阶段填右侧栏） |
| `lib/host/cli.js` | `zhihu-cli` 唯一出口（`execFile`、超时、最小环境） |
| `lib/host/parse.js` | 三段判定 + 四类业务数据规范化 |
| `lib/host/queue.js` | 串行队列 + 同键去重 + 运行指标 |
| `lib/host/cache.js` | TTL 缓存（`get` / `peek` / `set` / `invalidate`） |
| `lib/host/backoff.js` | 指数退避冷却表 |
| `lib/host/quota.js` | 每日额度计数 + 低频刷新 + `quota` 响应解析 |
| `lib/host/service.js` | 编排层（缓存 → 冷却 → 额度 → 队列 → 判定） |
| `lib/host/http.js` | 回环围栏、JSON 信封、方法分派、查询参数校验 |
| `test/fixtures/fake-cli.mjs` | 假 CLI：按场景返回退出码与 JSON，记录调用与并发重叠 |
| `test/helpers.mjs` | 临时目录、假 CLI 运行时、可注入时钟 |
| `test/*.test.mjs` | 8 个测试文件，87 个用例 |
| `README.md` | 面向使用者 |
| `DEV-NOTES.md` | 本文件 |

## 2. 关键实现

### 2.1 `parse.js`：三段判定

顺序不可交换，因为三种失败形态完全异构：

```
① 退出码（最先）
   code === null          → timeout / cli_missing / unknown（进程根本没正常退出）
   code !== 0             → 2 invalid_argument / 3 auth_required / 4 rate_limited
                            5 network / 6 server / 7 keychain / 8 install / 其它 unknown
                            若 stdout 里有 CLI 信封，再用 error.code 细化
                            （例如退出码 4 + QUOTA_EXHAUSTED → quota_exhausted）
② 退出码 0 但 stdout 是 `{"ok":false,"error":{...}}`
   → 读 error.code 映射（AUTH_REQUIRED / INVALID_ARGUMENT / RATE_LIMITED / …），
     未知码归 cli_error；带出 message 与 action_url
③ 退出码 0 且是业务体
   有 `Code` → 0 才算成功，`Data` 为数据；20001 → auth_required，30001 → rate_limited，
               其它非 0 → business_error（保留 businessCode）
   没有 `Code` → 整体即数据（capabilities / version / auth status 属于这类）
```

输出统一为 `{ ok, reason?, message?, actionUrl?, businessCode?, code, data?, raw, stderr }`。
`raw` 永远是原始 stdout，排查时不需要重跑命令。

规范化放在同一文件：`normalizeHot` / `normalizeSearch` / `normalizeContents` /
`normalizeCapabilities`。统一成小写字段（`title` / `url` / `author` / `summary` / `thumbnailUrl` …），
并过滤掉既无标题又无链接的空项；缺字段返回空串，不让 UI 拿到 `undefined`。

### 2.2 `queue.js`：为什么同一时刻只有一个子进程

内部维护一条 Promise 链 `tail`：

```js
const run = tail.then(async () => { active += 1; ...; try { return await task() } finally { active -= 1 } })
tail = run.then(() => undefined, () => undefined)
```

每个任务都必须等前一个任务 settle（成功或失败）才开始，所以 `active` 峰值恒为 1；
`tail` 吞掉 rejection，失败不会卡死队列。

同键去重在外层：`inflight: Map<key, Promise>`，命中直接返回同一个 Promise（`deduped += 1`），
并在 settle 后清理。键就是缓存键（如 `hot:30`、`search:AI Agent:5`），因此
「同一个面板 + 同一个参数」并发只会起一个进程。

### 2.3 `backoff.js`：时钟怎么注入

`createBackoff({ now = () => Date.now(), baseMs, factor, maxMs })`。
冷却状态是 `{ until, failures }`，所有判断都走 `now()`：

- `fail(key)`：`delay = min(base * factor^(failures-1), max)`，`until = now() + delay`；
- `isCooling(key)`：`until > now()`（等于冷却结束时刻即放行）；
- `remaining(key)`：`max(0, until - now())`；
- `succeed(key)`：删除状态，下一次重新从 30s 起。

测试里把 `now` 换成一个可变闭包（`createClock`），直接 `advance(29_999)` / `advance(1)` 验证边界，
不需要真的等 30 秒，也不需要 fake timers。`service.js` 把同一个 `now` 传给 cache / backoff / quota，
三者时间线一致。

### 2.4 `quota.js`

- 本地按「本地日期」计数，跨天自动清零（`dayKey` 用 `getFullYear/getMonth/getDate`，可注入时钟）；
- 默认上限：热榜 80 / 搜索 500 / 创作 1000；`0` 表示不限（`capabilities` 不消耗业务额度）；
- `check()` 先看服务端快照（remaining ≤ 0 → 降级），再看本地计数；
- `spend()` 在真正发起调用前记账，同时递减服务端快照的 remaining；
- `shouldRefresh()`：首次、距上次 ≥ 30 分钟、或收到额度类错误后置的标记；
- `beginRefresh()` 防止并发重复查 `quota`（`quota` 自身会触发限流，这是本阶段最重要的一条约束）。

### 2.5 `service.js` 的闸门顺序

`load()` 依次经过：缓存命中 → 冷却中 → 额度刷新（低频）→ 额度检查 → 记账 → 队列 → CLI → 判定。
任何前置闸门拦下都不会产生子进程。命中限流时 `backoff.fail` + `cache.peek` 返回旧数据（`stale: true`）；
额度耗尽则置 `requestRefresh` 标记，下一次请求前才真正查 `quota`，不在错误路径上立刻打请求。

### 2.6 路由

`inject = ['webServer']`，`webServer.register({ kind: 'exact', path, handler })`，
用 `ctx.effect` 收集 disposer 做清理。五条路径全部 `createRoute(..., isLoopbackRequest)`：
socket 地址 + Host + `Sec-Fetch-Site` + Origin 四重校验，LAN 上的浏览器拿不到「我的创作」。
HTTP 状态码按 reason 映射（401 / 429 / 503 / 502 …），body 始终是统一信封。

## 3. 测试策略

**没有任何测试调用真实 `zhihu-cli`。** 假 CLI 是一个可执行 node 脚本，读取
`$ZHIHU_FAKE_DIR/scenario.json` 的 `modes` 数组，按调用次数取模（最后一个场景重复），
支持：`success` / `auth_required`(exit 3) / `rate_limited`(exit 4) /
`business_rate_limited`(Code 30001) / `business_auth`(Code 20001) / `invalid_argument`(exit 2) /
`garbage` / `empty` / `stderr`(exit 6) / `env` / `quota_zero` / `hang`(用于超时)。

每次调用追加 `calls.jsonl`（start/end/pid/args/overlap），并用 `open(..., 'wx')` 抢
`active.lock` 检测并发重叠——串行测试因此能验证「同一时刻只有一个子进程」，而不只是看代码。

覆盖矩阵：

| 文件 | 用例数 | 覆盖 |
|---|---:|---|
| `parse.test.mjs` | 26 | 三段判定全部分支、四类规范化（含 Paging / HasMore / Unix 秒时间戳）、raw 保留 |
| `cache.test.mjs` | 4 | TTL 边界、peek 过期值、invalidate |
| `backoff.test.mjs` | 4 | 30/60/120/240/300 封顶、成功复位、能力隔离、时钟注入 |
| `quota.test.mjs` | 11 | 本地上限、跨天、远端 0、扣减、刷新节奏、并发刷新、extractQuota（真实 `APIID` 形状） |
| `queue.test.mjs` | 7 | 同键去重、异键串行、失败不卡队列、真实子进程串行与去重 |
| `cli.test.mjs` | 8 | 退出码透传、stderr、超时杀进程、ENOENT、环境白名单 |
| `service.test.mjs` | 15 | 缓存、限流冷却、stale、额度降级、刷新低频、搜索、创作、capabilities、状态 |
| `routes.test.mjs` | 9 | 回环围栏、405/400/401/429、状态接口、错误信封 |
| `manifest.test.mjs` | 3 | 插件 id / 包名 / inject / exports / patch 结构约定 |

## 4. 未完成项 / 已知缺陷

1. **UI 未做**（计划内）。`lib/client.js` 是空壳，右侧栏不可见。
2. **真实业务结构已实测（2026-10-28）**：`quota` / `search zhihu` / `me contents` 的字段名已确认，
   解析层按实测字段重写，见 §6。
3. **`quota` 响应形状已实测**：`Data: [{ APIID, APIName, TotalQuota, TotalUsed, RemainingQuota }]`；
   `extractQuota` 以 `APIID` 为首选、保留旧写法兜底，识别不出来时返回空表（按「额度未知」放行）。
4. **CLI 路径默认指向 `.probe/bin/zhihu-cli`**，这是探针产物，不应长期依赖；正式部署需换
   `.runtime/` 或系统安装路径（配置项 `cliPath` 已留好）。
5. **未跑 prettier**：仓库根目录没有 prettier 配置或本地安装，代码按现有插件风格手写
   （无分号、单引号、约 120 列）。若控制面统一格式化，直接 `pnpm exec prettier --write` 即可。
6. **未测 exit 5–8 的真实触发条件**（探针也没测到），映射表来自官方 `cli.md` 的契约。
7. **测试会在 `os.tmpdir()` 建临时目录**，每个用例结束 `rmSync` 清理；不落在仓库内。

## 5. 第二阶段接续提示（已按 §7 落地）

右侧栏是**两段式注册**：

1. `ctx.sidebarRightTabs.register({ id, kind, title, priority, guide })` 声明 tab 类型；
2. `ctx.slots.inject('sidebar.right.pane.tab', ...)` 挂正文；
3. 用 `ctx.sidebarRight.openTab(kind)` 打开。

数据层已经稳定：浏览器侧直接 `fetch('/api/dsh-zhihu-sidebar/hot?limit=30')` 即可，
错误态按 `reason` 分支（`auth_required` 展示 `actionUrl`、`rate_limited` 展示 `retryAfterMs`、
`quota_exhausted` 展示剩余额度）。UI 改动需要重启 dsh web 才能看到效果，验收前先与控制面确认重启窗口。

## 6. 1.x 第一阶段缺陷修复（2026-10-28）

有密钥环境实测拿到权威字段名后，回头修第一阶段的两处真实缺陷与两处语义问题。

### 6.1 `quota.js`：`APIID` 字段名错误（严重）

真实响应是 `Data: [{ APIID, APIName, TotalQuota, TotalUsed, RemainingQuota }]`，字段首字母全大写。
旧代码的候选列表是 `ApiId / api_id / ApiID / apiId`，**一个都命不中** → `extractQuota` 恒返回空表
→ 服务端额度保护完全失效（表现是「看起来有保护，其实从不拦截」，而不是报错）。

修复：候选表改为 `APIID ?? ApiId ?? api_id ?? ApiID ?? apiId`，`APIID` 置顶，旧写法保留兜底。
`TotalQuota` / `RemainingQuota` 原本就是对的，未动。

同时修正了「真实结构尚未实测」的过时注释。

### 6.2 `search` / `me contents` 的 `total` 语义

两个响应**都没有 `Total`**，旧代码 `record.Total ?? total ?? 本页条数` 会把「本页条数」伪装成总数。

选定方案：**按真实语义分开表达**（不做统一改名）。

| 数据 | 真实翻页字段 | 现在的返回 |
|---|---|---|
| `hot` | `Total` | `{ total, pageSize, items }`（不变，`Total` 真实存在） |
| `search zhihu` | `HasMore`（无总数） | `{ pageSize, hasMore, items }`，**不再有 `total`** |
| `me contents` | `Paging: { IsEnd, NextOffset, Totals }` | `{ total, pageSize, hasMore, nextOffset, items }` |

理由：把 `total` 改名成 `pageSize` 只是把误读挪了个位置——UI 仍会想要「共 N 条」；
而三类数据里只有热榜和创作真的知道总数。按「知道就给、不知道就 `null` / 不给」表达，
UI 一眼能判断能不能显示总数，不需要记特例。`hasMore` 在服务端没给时是 `null`（未知），
不臆测成 `false`，否则「最后一页」和「不知道」会被混为一谈。

### 6.3 `me contents` 的 `CreatedAt`

真实值是 Unix **秒级**数字（如 `1793161647`）。旧代码用 `str()` 转成字符串数字，UI 拿到的是
`"1793161647"`，既不能直接 `new Date(n * 1000)` 也不能按字符串展示。

选定方案：**保留数字**（`createdAt: number | null`，缺失为 `null`）。
理由：时区、语言、相对时间（「3 天前」）都是展示层决策，规范化层存原始秒数最无损；
转 ISO 会把这个决策提前固化，且秒级精度转字符串没有额外信息量。非数字值一律 `null`，
不再把字符串日期透传（真实数据里不存在这种形态）。

### 6.4 测试

`quota.test.mjs` 原用例的错误字段（`ApiId`）跟着代码一起错，所以 82 项全绿也没抓到缺陷。
现在：

- 原用例改用 `APIID`；
- 新增 `extractQuota 识别真实 quota 响应形状（Data 数组 / APIID / APIName）`：直接喂
  `{ Code, Message, Data: [ … ] }` 全量响应，断言 `hot/search/contents` 三项的
  `remaining` 与 `total`，并断言传 `Data` 与传整个响应的结果一致；
- 新增小写/驼峰兜底用例，锁住「保留旧写法」这条要求；
- `parse.test.mjs` 新增 `Paging` 缺省、`HasMore` 缺省、时间戳非数字三类边界；
- `test/fixtures/fake-cli.mjs` 的 `search` / `contents` / `quota` 载荷改成实测形状
  （`Paging`、`HasMore`、`APIID`、秒级 `CreatedAt`），让 service 层测试真正跑在真实结构上。

所有 fixture 内容均为**合成数据**（标题、摘要、URL 里的 ID 全是编造的占位串），
不含任何实测抓取的真实条目或用户本人创作。

### 6.5 验收

```
node --test "test/*.test.mjs"   → tests 87 / pass 87 / fail 0，退出码 0
node --check lib/{index,client}.js, lib/host/{parse,quota}.js → 均 0
```

`prettier@3 --check --no-semi --single-quote --print-width 120` 对 `parse.js` / `parse.test.mjs`
已干净；`service.js` / `index.js` / `queue.test.mjs` / `service.test.mjs` 仍有**既有**格式偏差
（本次未触碰，避免无关 diff）。

## 7. 第二阶段：右侧栏界面（2026-10-28）

### 7.1 改动文件

| 文件 | 改动 |
|---|---|
| `package.json` | `dsh.client.inject` 从 `[]` 填成 5 个**包名**（见 §7.2） |
| `lib/client.js` | 从空壳改成完整右侧栏：两层注册 + 一个 tab 三个子视图 + 错误态分支 + 可测纯逻辑（1044 行） |
| `test/client-harness.mjs` | 新增。把 `lib/client.js` 当经典脚本用 `new Function('window', source)` 跑起来，拿到 `{ id, exports }`；同时提供假 ctx 与 React stub |
| `test/client.test.mjs` | 新增 29 个用例 |
| `README.md` | 面向使用者：怎么打开、三个视图各看什么、错误态 |
| `DEV-NOTES.md` | 本节 |

`lib/index.js`、`lib/host/*`、`test/fixtures/fake-cli.mjs` **一行未改**，第一阶段的
87 个用例照旧全绿。

### 7.2 两层 inject —— 这是最容易写错的地方

**① `package.json` → `dsh.client.inject`：写「包名」**

```json
["@deepseek-ai/dsh-api-remotes",
 "@deepseek-ai/dsh-client-connection",
 "@deepseek-ai/dsh-client-locale",
 "@deepseek-ai/dsh-client-ui-renderer",
 "@deepseek-ai/dsh-client-ui-sidebar-right"]
```

依据（逐个）：

| 包名 | 为什么在表里 |
|---|---|
| `dsh-client-ui-sidebar-right` | 唯一提供 `sidebarRightTabs` / `sidebarRight` 两个服务、并声明 `sidebar.right.pane.tab` 座位的包；它的 `dsh.client.inject` 里也带着 layout/conversation，但那是它自己的依赖边 |
| `dsh-client-locale` | 提供 `locale` 服务（`bind` / `register`） |
| `dsh-api-remotes` | 提供 `remote` 服务（`inject` 里声明了它，所以要有这一行） |
| `dsh-client-ui-renderer` | React 渲染基座（`immediately`），插槽组件在它之上渲染 |
| `dsh-client-connection` | 连接层基础行，与官方右侧栏插件的最小集一致（本版未直接调用 `ctx.connection`） |

⚠️ **`@deepseek-ai/dsh-client-ui-slots` 不在表里**：它是**编译期 devDependency**，
运行时文件系统里没有这个包（已 `ls` 证过）；`slots` 服务由外壳提供，
`SlotMap` 由各包 `declare module` 扩充。写进去只会得到一条不存在的依赖边。
仓库里 `dsh-external-discuss` 的 `package.json` 仍留着它，那是历史写法，不要照抄。

**② `lib/client.js` → `inject`：写「服务名」**

```js
const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'remote']
```

| 服务 | 用在哪 |
|---|---|
| `slots` | `ctx.slots.inject('sidebar.right.pane.tab', …)` / `ctx.slots.register(…)` |
| `locale` | `ctx.locale.register(NS, { zh, en })`、`ctx.locale.bind(NS)` 产出的 `t` |
| `sidebarRightTabs` | `ctx.sidebarRightTabs.register(definition)`（第 1 段） |
| `sidebarRight` | 本版**无调用点**：打开入口只有 guide 卡片，由 kit 自己调 `openTab`。保留是为了后续加「会话头按钮一键打开」时不必再改 inject |
| `remote` | 本版**无调用点**：数据走同源 `fetch`，不经 RPC。按控制面 A② 的最小集保留 |

两个「无调用点」都写在明面上，不含糊：inject 了不用会拖后激活时机，但都真实存在，
不会导致激活失败；真要精简，删掉这两项即可，删除不影响任何一行逻辑。

### 7.3 两段式注册

```js
// 第 1 段：声明 tab 类型（纯静态）
ctx.effect(() => ctx.sidebarRightTabs.register({
  id: TAB_ID,            // 'dsh-plugin-zhihu-sidebar'，也是第 2 段的 key
  kind: TAB_KIND,        // 'zhihu'，openTab 用它
  priority: 'extension', // 外来类型默认档，写出来是为了显式
  title: () => t('tab.title'),
  guide: [{ id: 'zhihu', order: 120, title: …, description: … }],
}), 'zhihu: type')

// 第 2 段：挂正文（keyed，key 必须等于上面的 id）
ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
  name: 'sidebar.right.pane.tab',
  key: TAB_ID,
  locale: NS,
}, ZhihuTabBody)), 'zhihu: body')
```

- `title` / `guide[].title` / `guide[].description` 都是 **thunk**：每次读都重新查字典，
  切语言不需要重新注册（`test/client.test.mjs` 用一个会变语言的假 `locale` 锁住这条）。
- `locale: NS` 让插槽把绑好命名空间的 `t` 作为 **prop** 交给正文组件
  （官方 `ui-deliverables` 的 `ReviewTab` 就是这样拿 `t` 的）。
- `id` 用包名而不是 kind：kind 是可被覆盖的判别值，id 是实现身份。
- **只注册一个 tab**，三个视图在 tab 内部用分段切换（右栏 tab 条宽度有限）。

### 7.4 一个 tab 三个子视图

| 视图 | 怎么打开 | 什么时候发请求 |
|---|---|---|
| 热榜 | 分段第 1 个（默认） | **只有点按钮**。没取过时按钮写「加载热榜」，取过后写「刷新热榜」，冷却中写「29:41 后可刷新」且禁用 |
| 搜索 | 分段第 2 个 | 输入关键词后回车或点「搜索」；空关键词不发 |
| 我的创作 | 分段第 3 个 | 只有点按钮（第一次「加载我的创作」，之后「刷新我的创作」） |

**没有任何自动请求**：没有 `useEffect` 取数、没有轮询、没有「打开即加载」。
理由是 `FACTS.md` §4：热榜一天只有 100 次，任何常驻界面的自动刷新都会把它刷光。
搜索（5000/天）与我的创作（10000/天）额度宽裕，但一视同仁地做成「点了才发」——
既省额度，也让「为什么突然少了一次」永远可解释。

热榜冷却：`HOT_REFRESH_INTERVAL_MS = 30 分钟`，从**上一次响应里的 `fetchedAt`** 起算
（宿主缓存命中时 `fetchedAt` 是原始取数时间，语义正好）。30 分钟一次最多 48 次/天，
留足余量给重试。按钮 `title` 属性给出绝对时刻（`下次可刷新：14:32`）。

数据流：组件 → `fetchView(fetch, request)` → 宿主 `GET /api/dsh-zhihu-sidebar/{hot|search|contents}`。
**UI 不绕过宿主**：缓存、串行队列、退避冷却、每日额度闸门全在第一阶段那一层，
浏览器侧只是把信封读成视图模型。URL 用**文档相对**形式（`api/dsh-zhihu-sidebar/hot`，无前导 `/`），
与官方插件一致，挂在子路径下也不会跑偏；路径与 `lib/host/http.js` 的 `API` 常量由测试逐条比对。

页脚显示：更新时间（`HH:MM`）、是否缓存、本页条数、总数（只有热榜/我的创作有）、
搜索结果是否还有更多、「只显示当前账号的公开创作」提示。

**不显示赞/评论/收藏数**：第一阶段的 `normalizeSearch` / `normalizeContents` 只保留
`title/url/author/summary/type/createdAt`，没有把计数带出来。UI 不猜字段、也不为了好看去
改宿主层——要显示计数，得先扩规范化（连带改 `parse.test.mjs`），留给下一阶段按需决定。

### 7.5 错误态分支

| `reason` | UI |
|---|---|
| `auth_required` | 「需要知乎 Access Secret」+ 原始 `message` + 蓝色按钮「去申请密钥」，链到 `actionUrl`（宿主没给时兜底 `https://developer.zhihu.com/profile`） |
| `rate_limited` | 「被知乎限流，1:30 后可重试」，倒计时逐秒递减；该视图的按钮在倒计时结束前禁用 |
| `quota_exhausted` | 「今日额度已用完（剩余 0 次）」；有 `quota.remaining` 就显示，没有就说「今日额度已用完」；该视图操作禁用（其它视图不受影响，额度按能力分池） |
| `invalid_argument` / `business_error` / `network_error` / `timeout` / `server_error` / `cli_*` / `parse_error` / 其它 | 一行原因 + 宿主的 `message` |
| 成功但 `stale: true`（限流期回旧数据） | 列表照常显示，顶部黄条「被限流，显示的是缓存数据，x:xx 后可重试」 |

倒计时用**响应时刻 + `retryAfterMs`** 算（`remainingRetry`），不是拿响应里的常量一直显示——
否则永远停在「1:30」。守卫 `1 秒` ticker 只在需要倒数时开，倒计时归零自己停。

### 7.6 纯逻辑与测试

渲染组件不测，取数 / 判定 / 状态映射 / 时间换算全部抽成纯函数，
并挂到 `exports.__internals`（沿用宿主 `service.internals()` 的测试缝做法），
测试直接加载**真实发布文件**，不是副本。

| 函数 | 作用 |
|---|---|
| `withQuery` / `hotRequest` / `searchRequest` / `contentsRequest` | 拼请求（跳过空值、URI 编码、关键词去空白） |
| `readResult` | 宿主信封 → 视图模型（`ok` / `auth` / `rate` / `quota` / `error`，带 `stale` / `cached` / `fetchedAt` / `actionUrl` / `remaining`） |
| `fetchView` | 取数 + 兜住网络异常与不可解析响应（都变成失败模型，不抛） |
| `refreshPlan` / `remainingRetry` / `formatDuration` / `formatClock` | 热榜冷却与两处倒计时 |
| `describeAge` | Unix 秒 → `{ unit, count }`（文案留给字典，函数不碰语言） |
| `hotRows` / `searchRows` / `contentRows` / `totalOf` / `pageSizeOf` / `contentLabel` | 行映射与页脚信息 |
| `describeFailureUi` | 失败态文案 / 语气 / 是否给按钮 |
| `normalizeView` | 分段切换归一，未知值落回暖榜 |

新增 29 个用例（`test/client.test.mjs`），关键几条：

- `两段式注册：tab 类型与正文用同一个 id 作键` —— 断言 `slots.register` 的 `key === definition.id`，缺一段就红；
- `标题与引导文案是 thunk：换语言后重新读，不需要重新注册`；
- `取数路径与宿主 API 常量逐条一致` —— 跨模块比对 `lib/host/http.js` 的 `API`，防路径漂移；
- `热榜冷却：没取过就放行，冷却中给倒计时，到点放行`（含 30:00 边界）；
- `冷却剩余按响应时刻逐秒递减，到点归零`；
- `readResult` 五个用例覆盖四类失败 + `parse_error`；
- `失败态展示：auth 给按钮 / rate 给倒计时 / quota 给额度 / 其它给消息`；
- `总数只给知道总数的视图：搜索永远没有总数` —— 锁住 §6.2 的语义决定；
- `中英文案键一一对应，占位符一致` + `代码里引用的文案键都真实存在` —— 防漏翻 / 拼错键；
- `首次渲染：三个分段 + 热榜加载按钮 + 空闲提示` —— 组件浅渲染结构（stub hooks），不发请求。

### 7.7 验收

```
node --test "test/*.test.mjs"  → tests 116 / pass 116 / fail 0，退出码 0
node --check lib/index.js      → 0
node --check lib/client.js     → 0
```

`pnpm dlx prettier@3 --check --no-semi --single-quote --print-width 120`
对 `lib/client.js` / `test/client.test.mjs` / `test/client-harness.mjs` 干净
（仓库没有本地 prettier，用 dlx 跑，不改任何依赖文件）。

### 7.8 未完成项 / 已知缺陷

1. **没有视觉验收**：UI 要重启 dsh 才看得见，本阶段只交付代码 + 逻辑测试；
   视觉与真机链路由控制面另走一次性隔离环境（`install-check.sh`）。
2. **没有真正的渲染测试**：React DOM 环境不在此仓库里，只有 stub hooks 的浅渲染结构断言。
   交互（点按钮 → 请求 → 列表）靠纯函数覆盖，不靠 DOM 事件。
3. **不支持翻页**：搜索 `hasMore` / 创作 `Paging.NextOffset` 只在页脚提示，没有「下一页」。
4. **不显示赞/评/收藏数**（理由见 §7.4）。
5. **热榜 30 分钟冷却写在浏览器侧**，与宿主 5 分钟 TTL 是两套：宿主管缓存，UI 管额度。
   如果用户刷新页面，冷却会从宿主缓存的 `fetchedAt` 重新算出，行为一致。
6. `sidebarRight` / `remote` 注入但无调用点（见 §7.2）。

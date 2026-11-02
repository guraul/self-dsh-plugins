# Token 用量归集（dsh / codebuddy / opencode → homebase）

> **状态：已实现（2026-11-02）** ｜ 关联：[#197](https://github.com/guraul/self-dsh-plugins/issues/197) ｜ 生产侧采集见 [#215](https://github.com/guraul/self-dsh-plugins/issues/215)（未开始）

## 0. 一句话

三方用量在 Mac 上按「日 × 主机 × 来源 × 执行方 × 模型 × 会话」聚合，每天 12:00 写入 homebase 生产 SQLite；插件的**全部**数据（overview + 子代理明细）从 homebase 的 internal API 拉取，不再读本地文件。

---

## 1. 链路

```
Mac: dsh 投影缓存 / codebuddy traces / opencode.db
  │  每天 12:00（LaunchAgent），也支持 --date / --from..--to / --all 补采
  │  归一化 → 按主键聚合 → 按 (source, 日期) 分批
  ▼
POST https://106.13.181.13/api/internal/token-usage/ingest
  │  x-internal-token，UPSERT（覆盖语义，重跑安全）
  ▼
homebase 生产 SQLite：token_usage_daily / token_usage_sync
  ▲
  │  GET /api/internal/token-usage/query
  │
dsh-usage-panel（DSH_USAGE_PANEL_DATA_SOURCE=homebase）
  → KPI / 热力图 / 模型分布 / 会话排行 / Provider / 子代理明细
```

失败策略：任何一环失败都**回退本地**并打 warn，页面不变空。本地路径保留未删。

---

## 2. 数据模型

### 2.1 `token_usage_daily`

```sql
CREATE TABLE token_usage_daily (
  usage_date   TEXT NOT NULL,              -- YYYY-MM-DD，Asia/Shanghai
  origin       TEXT NOT NULL,              -- mac-home | prod-baidu-cloud
  source       TEXT NOT NULL,              -- dsh | codebuddy | opencode
  provider     TEXT NOT NULL,              -- 执行方/路由
  model        TEXT NOT NULL,
  session_id   TEXT NOT NULL,              -- 来源侧会话 id（见 §3 的身份映射）
  root_session TEXT,                       -- dsh 根会话
  title        TEXT,                       -- 会话标题（可空，展示用）
  calls, input_tokens, output_tokens, reasoning_tokens,
  cache_read, cache_write, total_tokens, credit,   -- 见 §3.5 口径
  first_at     INTEGER NOT NULL,
  last_at      INTEGER NOT NULL,
  batch_id     TEXT NOT NULL,
  ingested_at  INTEGER NOT NULL,
  PRIMARY KEY (usage_date, origin, source, provider, model, session_id)
);
```

**为什么主键要含 `origin`**：同一种 `source=opencode` 会来自多台机器。没有它，两边的量混在一起、session id 可能互相覆盖（[homebase#116](https://github.com/guraul/homebase/issues/116)）。

### 2.2 `token_usage_sync`

批次台账（`batch_id` 主键、`origin`、`rows`、`total_tokens`、`status`、`error`），回答「某天某源采了多少条、有没有漏」。

### 2.3 迁移

- `origin`：SQLite 改不了主键，**必须重建表**；旧数据标 `mac-home`
- `title`：`ALTER TABLE ADD COLUMN` 即可（幂等）
- ⚠️ **迁移必须先于建表/建索引**：旧库的表已存在时 `CREATE TABLE IF NOT EXISTS` 会跳过，随后 `CREATE INDEX ... (origin)` 会因缺列抛错，整个初始化中断（生产 500，[homebase#118](https://github.com/guraul/homebase/issues/118)）

---

## 3. 采集

入口 `scripts/token-sync/collect.mjs`。

### 3.1 三个源的取数位置

| 源 | 位置 | 身份 | 完整度 |
|---|---|---|---|
| dsh | `~/.dsh/storages/session_projcache/sessions/*.json` 的 `usagePanel` | 会话 id | 完整 |
| codebuddy | `~/.codebuddy/traces/*/*.jsonl` | traceId（→ 映射成 remoteId） | 完整（但只留 7 天） |
| opencode | `~/.local/share/opencode/opencode.db` | `session_id` | 完整（备份库可补更早） |

### 3.2 三个必须知道的坑

**① dsh 必须同时读 `epochs[]` 与 `current`**

压缩会把已折叠的段推进 `epochs`。只读 `current` 会漏约 35%（本机实测：current 437 条 byDay、epochs 240 条；某天从 43 万漏成 1.6 亿）。

两者是**分段互补**而非重复（举例：某会话 10-17，epochs 12.7 万 input + current 0.98 万 input），所以相加是对的。

**② codebuddy 的身份只能靠 `providerData.messageId`**

| 尝试 | 结果 |
|---|---|
| 单条消息时间戳对齐 | 5.5% ❌ |
| `traceparent` 的 trace_id ↔ traces traceId | 交集 0 ❌ |
| pid 目录 ↔ registry 会话 | 43% ❌ |
| **`providerData.messageId` ↔ `toolOutput[].id`** | **99.95%** ✅ |

`messageId` 与 completion id 都是 UUID v7（`01a1` 前缀），同一次调用在两边写同一个值。

**③ codebuddy 的 `projects` 转录不能用来统计用量**

那份文件里 917 条 assistant 只有 347 条带 usage，且带 usage 的也是流式快照。这是 Claude Code 家族的已知缺陷（[#27361](https://github.com/anthropics/claude-code/issues/27361)、[#22686](https://github.com/anthropics/claude-code/issues/22686)）：JSONL 只记 content block，最终的 `message_stop` 从不落盘。

实测同一会话：projects 43,688 token vs traces 123 万，**差 28 倍**。

所以：**身份取自 projects，用量取自 traces**。

### 3.3 会话标题

三级回退：`rows.subagent.val.identity.label` → `rows.subagent.val.label` → `rows.title.val`。

最后一级是给**根会话**用的（根会话没有 subagent 节点，标题只在 `title.val`，如「构建 Reviewer 子代理」）。

### 3.4 日期与窗口

- `usage_date` 按**调用发起时刻**换算 Asia/Shanghai
- 默认采 `[T-2, T-1]`（覆盖跨天与迟到写入）
- `--all` 起点取各源最早日的最小值（dsh 2026-10-10、opencode 2026-10-29）
- codebuddy 只保留 7 天，漏一天就永久缺失

### 3.5 token 口径

| 字段 | 口径 |
|---|---|
| `input_tokens` | **非缓存**输入 |
| `cache_read` / `cache_write` | 缓存读 / 写 |
| `output_tokens` | 输出（不含 reasoning） |
| `reasoning_tokens` | 推理（单列） |
| `total_tokens` | 四者之和 |

各源换算：

| 源 | 换算 |
|---|---|
| dsh | 四桶直接映射 |
| codebuddy | **OpenAI 语义**：`prompt_tokens` 已含缓存 → `input = prompt − cache_read`；`cache_read` 优先取 `prompt_cache_hit_tokens`，回退 `prompt_tokens_details.cached_tokens`（两者必须用同一个值去减，否则 total 漂移） |
| opencode | `tokens.input` 已是非缓存，直接映射 |

---

## 4. API（homebase）

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `POST /api/internal/token-usage/ingest` | `x-internal-token` | 单批 ≤500 行；`ON CONFLICT` 覆盖；返回 `{accepted, updated, skipped}` |
| `GET /api/internal/token-usage/query` | 同上 | `from/to/origin/source/model/root_session`、`group_by=all\|day\|origin\|source\|model\|session`、`limit`、`include=sync` |

鉴权复用既有 `INTERNAL_READ_TOKEN`（fail-closed：未配置即 401）。

**幂等语义**：按天全量重算 + 覆盖，不做累加——漏采时累加永远补不回来。

**批次 origin 优先**：服务端把批次的 `origin` 注入每一行，避免行内字段与批次声明打架（否则同一批会落到两个 origin，互相覆盖）。

---

## 5. 插件侧

`dataSource` 由环境变量控制：

```
DSH_USAGE_PANEL_DATA_SOURCE=homebase   # local（默认）| homebase
```

凭据从 `~/.dsh/token-sync.env`（600）读，**不写进 plist**（plist 入库）。

| 区块 | homebase 模式下的来源 |
|---|---|
| KPI / 热力图 / 模型分布 / Provider | `query?group_by=all` 装配（`buildOverviewFromRows`） |
| 会话排行 | 同上，按会话聚合取前 10，标题来自 `title` |
| 子代理 external | `query?source=opencode` + `query?source=codebuddy`，按 remoteId 匹配 |

**缓存**：overview 60s；子代理扫描 60s。

**回退粒度**：overview 整体回退本地；子代理 external **按会话**回退（某会话在 API 里没有才读本地，避免一个缺失把整表拉回）。

### 5.1 部署

- 生产 TLS：Caddy 自签（`CN=106.13.181.13`，SAN=IP），`443 → 127.0.0.1:19234`，**19234 公网已关闭**
- CA 副本：`~/.dsh/certs/homebase-selfsigned.crt`
- ⚠️ **`https.request` 的 `ca` 要的是 PEM 内容，不是文件路径**。传路径等于没配，握手失败后被 catch → 静默回退本地（[#214](https://github.com/guraul/self-dsh-plugins/issues/214)）
- 调度：LaunchAgent `com.deepseek.dsh-token-sync`，每天 12:00；日志 `.dsh-web/token-sync.log`
- ⚠️ 改 plist 后 `launchctl kickstart` **不重读配置**，必须 `bootout` + `bootstrap`

---

## 6. 实测数据（2026-11-02）

| 项 | 值 |
|---|---|
| 总行数 | 1537 |
| 覆盖天数 | 86（2026-01-17 ~ 2026-11-01） |
| 总 token | **52.2 亿** |
| dsh | 569 行 / 33.11 亿 |
| codebuddy | 359 行 / 6.99 亿 |
| opencode | 609 行 / 12.10 亿（含备份库历史） |
| 有标题的行 | 569（dsh 全部） |

架构有效性验证：插件 `coverage.mode = homebase`，`allTime = 52.15 亿`，会话排行显示真实标题，`homebase overview failed` 日志 0 条。

---

## 7. 已知边界

| 边界 | 说明 | 影响 |
|---|---|---|
| registry 只保留 162 条 | 每个 DSH 会话一条、会被覆盖；traces 有 355 个会话 | 约 2.57 亿 codebuddy 用量无法归属到子代理（仍在库里，可按天查总量） |
| codebuddy 未命中身份约 4.5% | `projects` 的 messageId 覆盖 10168 / traces 10640 | 这些行以 traceId 入库，不进子代理明细 |
| opencode 备份库是一次性并入 | `--include-backups` 只在手动执行时生效 | 日常采集只读现库 |
| 数据范围受采集起点限制 | dsh 从 2026-10-10 起才有 byDay | 更早的热力图是空的 |
| opencode 会话无标题 | 未读 `session.title` | 会话排行显示 `ses_xxx` 裸 id |

---

## 8. 未完成

**生产侧采集**（`origin=prod-baidu-cloud`）：[#215](https://github.com/guraul/self-dsh-plugins/issues/215) 预留。方案倾向「服务器上跑同一份 collect.mjs + systemd timer」（写入不走公网）。前置条件是本机链路稳定运行一周以上。

---

## 9. 被否决的方案（勿重复踩坑）

| 方案 | 否决原因 |
|---|---|
| 把 `INTERNAL_READ_TOKEN` 写进 plist | plist 入库，等于把凭据提交进 git |
| 用 projects 的 usage 做统计 | 只有约 3% 覆盖且是流式快照，低估 28 倍 |
| 改 codebuddy-shim 注入 session id 到 trace | shim 拿不到 traceId，也改不了 codebuddy 的内部 telemetry |
| codebuddy 用时间戳/pid/traceparent 对齐 | 实测命中率 5%–43%，不可靠 |
| 自签证书换成 Tailscale 组网 | 用户明确不考虑（要装客户端） |
| 服务端改成累加语义 | 重跑会翻倍；覆盖 + 采集端聚合才是安全组合 |
| 插件只切 opencode | 那是中间态；codebuddy 的身份映射打通后应全切 |

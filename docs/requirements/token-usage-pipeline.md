# Token 用量归集方案（dsh / codebuddy / opencode → homebase）

> 状态：设计稿（未实现）｜ 2026-11-01 ｜ 关联：[self-dsh-plugins#197](https://github.com/guraul/self-dsh-plugins/issues/197)

## 0. 一句话

三方用量在本机按「日 × 来源 × 执行方 × 模型 × 会话」切分，每天定时 POST 到 homebase，落到生产 SQLite 一张新表；插件改为从 homebase 读，不再直连本地库。

---

## 1. homebase 现状（调查结论）

### 1.1 数据库

| 项 | 值 |
|---|---|
| 文件 | `data/finance.db`（BFF 进程内，`packages/web/lib/database.ts`） |
| 迁移 | `_migrations(name PK, executed_at)` + `initDatabase()` 里 `CREATE TABLE IF NOT EXISTS` + 幂等补列 |
| 已有表 | `funds` / `trades` / `users` / `scheduler_jobs` / `scheduler_job_runs` / `scheduler_job_retries` / `delivery_jobs` / `ics_sources` / `ics_events` / `agent_reports` … |
| **token 相关表** | **没有**。现有 `/api/tokens/*` 是**实时读本机 opencode.db**（`lib/tokenService.ts` 打开 `~/.local/share/opencode/opencode.db`，`json_extract(data,'$.tokens.*')`），不落 homebase 库 |

### 1.2 现有 token API

| 端点 | 鉴权 | 返回 |
|---|---|---|
| `GET /api/tokens/models?period=today\|week\|month\|all` | JWT cookie（`requireAuth`） | `{models:[{model_id,provider_id,calls,input_tokens,output_tokens,reasoning_tokens,cache_read,cache_write,total_tokens,cache_hit_rate}]}` |
| `GET /api/tokens/daily` | 同上 | `{daily:[{date,calls,input_tokens,…,total_tokens}]}` |
| `GET /api/tokens/hourly?date=` | 同上 | 同上，小时粒度 |
| `GET /api/internal/*` | `x-internal-token` = `INTERNAL_READ_TOKEN`，**未配置即 401（fail-closed）** | 只读 JSON |

> 注：`/api/tokens/*` 原本是给 UI 的 `page tokens` 用的，统计的是**生产 opencode** 的消耗。本方案**复用**它们（改为读新表），不另起一套。

### 1.3 调度

- `registerJob(name, fn)` 代码注册 handler；任务实例（cron/timezone/params/enabled）存 `scheduler_jobs`
- `engine.ts` 用 `later.setInterval` 在 Next 进程内执行；执行记录写 `scheduler_job_runs`
- 时区契约：systemd 固定 `TZ=Asia/Shanghai`，cron 求值不依赖系统时区

### 1.4 生产环境

| 项 | 值 |
|---|---|
| 主机 | 百度云 `root@106.13.181.13`（GitHub Actions secrets `DEPLOY_SSH_KEY`） |
| 形态 | `next start -H 0.0.0.0 -p 19234`，systemd `bff-19234.service` |
| 部署 | push `main` 且命中 `packages/web/**` 等路径 → Actions → SSH/rsync → `systemctl restart bff-19234` |
| **对外地址** | **`https://106.13.181.13`（TLS 已完成，2026-11-01）** |
| 反代 | Caddy 2.6.2，`443 → 127.0.0.1:19234`，配置 `/etc/caddy/Caddyfile` |
| 证书 | 自签（`CN=106.13.181.13`，SAN=IP，有效期至 2036）；CA 副本在本机 `~/.dsh/certs/homebase-selfsigned.crt` |
| 暴露面 | 安全组只开 443 + SSH；**19234 已关闭公网**（BFF 仍监听 0.0.0.0，但外部不可达，只由本机 Caddy 访问） |
| 鉴权 | 写：`x-internal-token`（新端点，fail-closed）；读：同上（机读）或 JWT（人看） |

---

## 2. 表结构（新增）

### 2.1 `token_usage_daily`（明细，按天 × 会话 × 模型）

```sql
CREATE TABLE IF NOT EXISTS token_usage_daily (
  usage_date   TEXT    NOT NULL,   -- YYYY-MM-DD，Asia/Shanghai
  source       TEXT    NOT NULL,   -- 'dsh' | 'codebuddy' | 'opencode'
  provider     TEXT    NOT NULL,   -- 执行方/路由：opencode-go / codebuddy / deepseek-official / unknown
  model        TEXT    NOT NULL,   -- 模型 id（如 deepseek-v4.1-flash）
  session_id   TEXT    NOT NULL,   -- 来源侧会话 id
  root_session TEXT,               -- dsh 根会话 id（跨源合并用，可空）
  calls        INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,   -- 非缓存输入
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read   INTEGER NOT NULL DEFAULT 0,
  cache_write  INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,   -- 四桶之和
  credit       REAL,               -- codebuddy credit（其他源为 NULL）
  first_at     INTEGER NOT NULL,   -- epoch ms
  last_at      INTEGER NOT NULL,
  batch_id     TEXT    NOT NULL,   -- 采集批次（可回溯到哪次同步写入）
  ingested_at  INTEGER NOT NULL,
  PRIMARY KEY (usage_date, source, provider, model, session_id)
);

CREATE INDEX IF NOT EXISTS idx_tud_date  ON token_usage_daily(usage_date);
CREATE INDEX IF NOT EXISTS idx_tud_root  ON token_usage_daily(root_session);
CREATE INDEX IF NOT EXISTS idx_tud_model ON token_usage_daily(model);
```

**粒度理由**：主键到「日 + 会话 + 模型」是能同时满足三个查询的最小粒度——

- 按天/按模型/按执行方聚合 → `GROUP BY`
- 会话排行合并子代理 → 用 `root_session`
- 子代理明细 → 用 `session_id`

**为什么不存「每次调用」**：一天几百到几千条调用，按天聚合后量级小（本机约 400 会话/天），且插件只需要聚合视图。

### 2.2 `token_usage_sync`（同步台账，幂等与回溯）

```sql
CREATE TABLE IF NOT EXISTS token_usage_sync (
  batch_id    TEXT PRIMARY KEY,   -- uuid
  usage_date  TEXT NOT NULL,
  source      TEXT NOT NULL,
  rows        INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT NOT NULL,      -- running | ok | error
  error       TEXT
);
```

用途：回答「某天某源采了多少条、有没有漏」。

### 2.3 迁移方式

在 `initDatabase()` 的 `CREATE TABLE IF NOT EXISTS` 段追加两张表；不写数据迁移（新表从空开始）。

---

## 3. 定时任务（本机采集 → 生产写入）

### 3.1 为什么在本机

三方数据都在本机（`~/.dsh`、`~/.codebuddy`、`~/.local/share/opencode`），生产服务器上没有。所以**采集在本机，写入走 API**。

### 3.2 调度

| 项 | 值 |
|---|---|
| 载体 | macOS LaunchAgent `com.deepseek.dsh-token-sync`（与现有 `dsh-web` 同级） |
| 时间 | 每天 **12:00 Asia/Shanghai**（用户指定；此时前一日数据已完整，且避开 14:50 回执与盘中任务） |
| 补跑 | `StartCalendarInterval` 只在开机时触发一次；失败由脚本内部重试（3 次指数退避 30s/2m/5m） |
| 手动 | `launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh-token-sync` |
| 日志 | `.dsh-web/token-sync.log`（滚动，保留 30 天） |

> 备选：用 homebase 自己的 scheduler 反向「拉」本机——不可行，服务器访问不到本机。

### 3.3 写入流程

```
12:00 启动
  ├─ 计算窗口：默认 [T-2, T-1]（今天往前两天，覆盖跨天会话与迟到写入）
  ├─ 逐源采集（见 §4）
  ├─ 归一化为 token_usage_daily 行
  ├─ 分批 POST /api/internal/token-usage/ingest（每批 ≤ 500 行）
  │     header: x-internal-token: $HOMEBASE_INTERNAL_TOKEN
  │     body:   { batch_id, usage_date, source, rows: [...] }
  ├─ 逐批校验响应 {accepted, updated, skipped}
  ├─ 写本地台账 ~/.dsh/token-sync-state.json（last_ok_date / last_batch_id）
  └─ 任一批失败 → 退出码 1 + 日志；已成功的批次保留（可安全重跑）
```

### 3.4 幂等与去重

| 层 | 策略 |
|---|---|
| 客户端 | 同一天可重复采集（结果确定）；`batch_id` 每次新生成，只用于审计 |
| 传输 | 按 `(usage_date, source)` 分片，单片 ≤ 500 行 |
| 服务端 | `INSERT … ON CONFLICT(usage_date,source,provider,model,session_id) DO UPDATE SET …`，即「重算覆盖」而非累加 |
| 台账 | `token_usage_sync` 记 `batch_id/rows/status`，重复批次只更新同主键行，不产生重复数据 |
| 语义 | **按天全量重算该源**，因此重跑安全；不做增量累加（避免漏采时永远补不上） |

### 3.5 新增 API

| 端点 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/api/internal/token-usage/ingest` | POST | `x-internal-token` | 写入一批；返回 `{accepted, updated, skipped, batch_id}` |
| `/api/internal/token-usage/query` | GET | `x-internal-token` | 查询聚合：`from/to/source/model/root_session/group_by` |
| `/api/tokens/models` 等 | GET | JWT | **保留**，改为读新表（不再读 opencode.db） |

**鉴权补充**：`INTERNAL_READ_TOKEN` 已存在（fail-closed）。写入端点复用同一 token，**不新增密钥**；轮换按 homebase `OPERATIONS.md §1.2` 同步两处。

**传输**：TLS 已完成（2026-11-01）。采集脚本走 `https://106.13.181.13/api/internal/token-usage/ingest`，用 `NODE_EXTRA_CA_CERTS=~/.dsh/certs/homebase-selfsigned.crt`（或 curl `--cacert`）校验自签证书。`x-internal-token` 不再明文过公网。

**客户端**：浏览器首次访问需接受自签警告（一次性）；`agent-mobile` 需把 baseUrl 从 `http://106.13.181.13:19234` 改为 `https://106.13.181.13`。

---

## 4. 三类数据源的采集口径与字段映射

### 4.1 统一口径

| 字段 | 口径 |
|---|---|
| `input_tokens` | **非缓存输入**（已扣除缓存命中） |
| `cache_read` | 缓存读（命中） |
| `cache_write` | 缓存写 |
| `output_tokens` | 输出（不含 reasoning） |
| `reasoning_tokens` | 推理 token（单列，不并入 output） |
| `total_tokens` | `input + output + reasoning + cache_read + cache_write` |
| `calls` | 计费的模型调用次数（一次 LLM 请求 = 1） |
| `usage_date` | 调用**发起时刻**换算到 Asia/Shanghai 的日期 |
| `session_id` | 见下表，跨源不通用，用 `source` 区分 |

### 4.2 dsh

| 项 | 值 |
|---|---|
| 位置 | `~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd`（多帧 zstd） |
| 读法 | 复用 `dsh-usage-panel` 已有解析（`src/host/external/*`），或走宿主 `sessionQuery` 导出 |
| 关键事件 | `assistant/message` 的 `usage`（四桶） |
| 会话关系 | header 的 `delegationDepth` / `parentSession` → `root_session` |
| `provider` | `request/header` 的 provider 路由（`opencode-go` / `deepseek-official` …） |
| 注意 | 子会话的 usage 是**中继调用**，不是外部 CLI 的真实消耗（两者并存，不重复计入同一 `source`） |

### 4.3 codebuddy

| 项 | 值 |
|---|---|
| 主源 | `~/.codebuddy/traces/*/*.jsonl`（完整，**仅保留 7 天**，`codebuddy.telemetry.retentionDays` 默认 7，可设 1–90） |
| 兜底 | `~/.codebuddy/projects/<cwd-slug>/<remoteId>.jsonl`（永久，但仅 282/816 条带 usage，**不完整**） |
| 映射 | `span.toolOutput` → `chat.completion`：`model`、`usage.prompt_tokens`、`prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`、`completion_tokens`、`completion_tokens_details.reasoning_tokens` |
| 缓存语义 | **OpenAI 语义**：`prompt_tokens` 已含缓存 → `input = miss`、`cache_read = hit`（见 issue #127） |
| 会话 id | traces 无 sessionId → 用 `traceId`；与 dsh 子会话关联靠 `projects` 的 `remoteId`（registry 映射） |
| 风险 | 7 天后 traces 消失 → **必须在保留期内每天采**；漏一天就永久缺失 |

### 4.4 opencode

| 项 | 值 |
|---|---|
| 位置 | `~/.local/share/opencode/opencode.db` → `message` 表 |
| 映射 | `json_extract(data,'$.modelID')`、`$.providerID`、`$.tokens.{input,output,reasoning,cache.read,cache.write}` |
| 会话 id | `message.session_id` |
| 缓存语义 | `tokens.input` 已是非缓存输入（与 codebuddy 相反），直接映射 |
| 历史 | 现库仅 2026-10-29 起；更早在 `~/backups/opencode-sessions-*/opencode.db`（需合并） |

### 4.5 字段映射总表

| 统一字段 | dsh | codebuddy | opencode |
|---|---|---|---|
| `model` | usage 事件的 model | `chat.completion.model` | `$.modelID` |
| `provider` | `request/header.provider` | `'codebuddy'` | `$.providerID` |
| `input_tokens` | `usage.input` | `prompt_cache_miss_tokens` | `$.tokens.input` |
| `cache_read` | `usage.cacheRead` | `prompt_cache_hit_tokens` | `$.tokens.cache.read` |
| `cache_write` | `usage.cacheWrite` | `prompt_cache_write_tokens` | `$.tokens.cache.write` |
| `output_tokens` | `usage.output` | `completion_tokens` | `$.tokens.output` |
| `reasoning_tokens` | `usage.reasoning` | `completion_tokens_details.reasoning_tokens` | `$.tokens.reasoning` |
| `session_id` | header.id | traceId / remoteId | `message.session_id` |
| `root_session` | header.parentSession（根则自身） | 经 registry 映射 | 无（NULL） |

---

## 5. 插件侧改造

### 5.1 目标

`dsh-usage-panel`（本仓 fork）的所有数据改为从 homebase 拉取，**移除本地直连读取**（`~/.codebuddy`、`opencode.db`、`registry.json`）。

### 5.2 改动点

| 模块 | 现状 | 改造 |
|---|---|---|
| `src/host/index.ts` | overview 走 `sessionProjections`；subagents 走本地文件 | 新增 `homebase` 数据源；保留本地作为 **fallback**（可配置开关） |
| `src/host/external/{registry,opencode,codebuddy,collect}.ts` | 直连本地 | 改为 `src/host/external/homebase.ts`：`GET /api/internal/token-usage/query` |
| `src/shared/contract.ts` | `SubagentItem` 等 | **不变**（API 返回同一 shape），只在 host 内做映射 |
| `src/client/**` | — | **不变** |

### 5.3 配置

```jsonc
// profile cordis.patch.yml → dsh-usage-panel config
{
  "dataSource": "homebase",          // homebase | local（默认 local，灰度期）
  "homebaseUrl": "https://106.13.181.13",
  "internalTokenEnv": "HOMEBASE_INTERNAL_TOKEN"
}
```

### 5.4 对现有显示逻辑的影响

| 显示项 | 影响 |
|---|---|
| KPI 总量 | 口径变为「homebase 汇总」，包含三方；与本地算可能有几小时延迟（每日同步） |
| 子代理区块 | 数据来自 `token_usage_daily`，`external` 字段由 `source+session_id` 反查；**失去实时性**（当天数据次日 12:00 才入库） |
| 会话排行 | `root_session` 合并逻辑不变 |
| 缓存命中率 | 三方口径已统一（§4.1），比现在混算更准 |

**关键取舍**：改为 homebase 后**当天数据不可见**（T+1）。若需要实时，保留「本地直连」作为 `dataSource=local` 的备用模式。

---

## 6. 迁移与验证

### 6.1 分阶段

| 阶段 | 内容 | 出口条件 |
|---|---|---|
| P0 | homebase 加两张表 + 两个 internal 端点（只写不读） | `curl` 写入成功、`sqlite3` 能查到 |
| P1 | 本机采集脚本 + LaunchAgent（先 `--dry-run` 只打印不写） | 三方行数与本地直算**逐日一致** |
| P2 | 打开写入，连续跑 3 天 | `token_usage_sync` 无 error；行数稳定 |
| P3 | 插件加 `dataSource=homebase`，默认仍 local | 两种模式返回**同一 shape**，UI 无差异 |
| P4 | 切默认为 homebase，保留 local 开关 | 一周无回归后删除本地路径 |

### 6.2 P0 前置条件（已完成 / 待确认）

| 项 | 状态 |
|---|---|
| 生产 TLS（Caddy + 自签 + 443） | ✅ 2026-11-01 |
| 19234 公网关闭 | ✅ |
| CA 分发给本机 | ✅ `~/.dsh/certs/homebase-selfsigned.crt` |
| `INTERNAL_READ_TOKEN` 投放 | ⬜ 待确认（未配置则 internal 端点全 401） |

### 6.3 一致性验证（P1/P3 的核心）

```bash
# 1) 本地直算（现有插件逻辑）
node scripts/verify-token-usage.mjs --date 2026-10-30 --source codebuddy
#   → {rows: N, total_tokens: X, by_model: {...}}

# 2) homebase 查询
curl -s --cacert ~/.dsh/certs/homebase-selfsigned.crt \
  -H "x-internal-token: $TOKEN" \
  "https://106.13.181.13/api/internal/token-usage/query?from=2026-10-30&to=2026-10-30&source=codebuddy" \
  | jq '.data.totals'

# 3) 比对：逐 (model, session_id) 比对，不只比总数
```

**判定标准**：`rows` 与每个 `(model, session)` 的 `total_tokens` 完全相等；差异 > 0 时输出差异明细。

### 6.4 防漏采

| 风险 | 对策 |
|---|---|
| codebuddy traces 7 天清理 | 每天采 T-1；若 `last_ok_date` 落后 > 1 天，任务启动时**回溯补采**（最多 6 天） |
| opencode 旧库未合并 | 首次全量导入备份库；之后只增量 |
| dsh 会话跨天 | 按调用时间切天，不按会话创建时间 |
| 任务未跑（机器关机） | LaunchAgent 开机补跑 + `last_ok_date` 检查 |
| 写入部分失败 | 按 `(date, source)` 分片，失败片单独重试，不影响已成功片 |

### 6.5 回滚

- 插件：`dataSource` 改回 `local`，无需发版（配置热加载）
- homebase：新表与新端点独立，回滚即不调用；不影响现有 `/api/tokens/*`

---

## 7. 已确认决策

| # | 事项 | 结论 |
|---|---|---|
| 1 | 生产地址 | `https://106.13.181.13`（TLS 已完成） |
| 2 | `INTERNAL_READ_TOKEN` | 复用既有内部只读凭据（`x-internal-token`），需确认已投放 |
| 3 | 保留策略 | `token_usage_daily` 永久；`token_usage_sync` 90 天 |
| 4 | 小时粒度 | 不需要 |
| 5 | T+1 延迟 | 可接受 |
| 6 | 调度时间 | 每天 12:00 Asia/Shanghai |
| 7 | 与 `/api/tokens/*` 关系 | 复用改造：从「实时读 opencode.db」改为「读新表」 |
| 8 | 传输安全 | 自签 TLS + 关闭 19234 公网；不装 Tailscale；移动端只考虑 Android，当前只做 web |

## 8. 仍待确认

1. `INTERNAL_READ_TOKEN` 在生产 `.env.local` 是否已投放。
2. `agent-mobile` 的 baseUrl 改动归属（跨仓，需它自己的 pipeline）。

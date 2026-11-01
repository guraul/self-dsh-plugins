# token-sync · 三方 token 用量采集

每天把 **dsh / codebuddy / opencode** 三方的 token 用量采集、归一化，写入 homebase 生产的 `token_usage_daily` 表。

- 上游方案：[REQ-003](../../docs/requirements/token-usage-pipeline.md)
- homebase 侧：表与端点见 [homebase#109](https://github.com/guraul/homebase/issues/109)

## 快速开始

```bash
# 只看统计，不写任何东西
node scripts/token-sync/collect.mjs --dry-run

# 指定单日（幂等，可反复跑）
node scripts/token-sync/collect.mjs --date 2026-10-30

# 默认：采 T-1 与 T-2（覆盖跨天会话与迟到写入）
node scripts/token-sync/collect.mjs
```

## 配置

`~/.dsh/token-sync.env`（**权限 600**）：

```
HOMEBASE_URL=https://106.13.181.13
HOMEBASE_CA=/Users/<you>/.dsh/certs/homebase-selfsigned.crt
HOMEBASE_INTERNAL_TOKEN=<64 位>
```

值绝不入库、不进日志。采集脚本只读它，不回显。

`HOMEBASE_CA` 是自签证书的副本（生产 `https://106.13.181.13` 用自签）。
更新方式：`ssh root@106.13.181.13 "cat /etc/caddy/selfsigned.crt" > ~/.dsh/certs/homebase-selfsigned.crt`

## 三个数据源

| 来源 | 位置 | 会话 id | 缓存语义 |
|---|---|---|---|
| dsh | `~/.dsh/storages/session_projcache/sessions/*.json` 的 `usagePanel`（**epochs + current**） | 文件名 | 四桶直接映射 |
| codebuddy | `~/.codebuddy/traces/*/*.jsonl`（**只留 7 天**） | traceId | OpenAI 语义：`input = prompt - cached` |
| opencode | `~/.local/share/opencode/opencode.db`（v2 用 `session_message`，旧库用 `message`） | session_id | `tokens.input` 已是非缓存 |

### 两个容易踩的点

1. **dsh 必须同时读 `epochs[]` 和 `current`**。压缩会把已折叠的段推进 `epochs`，只读 `current` 会漏约 35%（本机实测：current 437 条、epochs 240 条；某天从 43 万漏成 1.6 亿）。
2. **codebuddy 的 `prompt_tokens` 已含缓存**。必须 `input = prompt_tokens - cache_read`，否则 input 放大 ~80 倍（见 self-dsh-plugins#127）。

## 调度

`.dsh-web/com.deepseek.dsh-token-sync.plist`，每天 **12:00**。

```bash
cp .dsh-web/com.deepseek.dsh-token-sync.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.deepseek.dsh-token-sync.plist

# 立即跑一次
launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh-token-sync
tail -f .dsh-web/token-sync.log
```

## 幂等与失败

- 服务端 `ON CONFLICT(usage_date, source, provider, model, session_id) DO UPDATE`：**按天全量覆盖**，重跑安全。
- 上传按 `source` 分组、每批 ≤500 行；4xx 不重试（鉴权/参数错），5xx/网络错误重试 3 次（30s / 2m / 5m）。
- 已成功的批次不会因为后面的批次失败而重发。

## 校验

```bash
# dry-run 看每源行数与总量
node scripts/token-sync/collect.mjs --dry-run --date 2026-10-30

# 与生产比对（需要 token）
curl -s --cacert ~/.dsh/certs/homebase-selfsigned.crt \
  -H "x-internal-token: $HOMEBASE_INTERNAL_TOKEN" \
  "https://106.13.181.13/api/internal/token-usage/query?from=2026-10-30&to=2026-10-30&group_by=source"
```

实测（2026-10-30）：dsh `160,559,058`、codebuddy `25,826,327`、opencode `1,903,063`，与独立手算（Python / SQL）逐源一致。

## 测试

```bash
node --test scripts/token-sync/token-sync.test.mjs
```

覆盖：日期窗口、北京时区切日、分批、env 解析、codebuddy 缓存语义与去重。

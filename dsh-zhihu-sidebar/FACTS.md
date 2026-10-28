# FACTS — 环境与实测事实（权威版）

- 日期：2026-10-28
- 用途：**改本插件前先读这里**。以下每条都是在本机真实跑出来的，比任何文档可靠。
- 与 `DEV-NOTES.md` 的分工：那里记**代码怎么设计的**，这里记**外部世界长什么样**。
- 与 `.probe/REPORT.md` 的分工：那里是原始探针输出（681 行），这里是提炼后的结论。

---

## 1. 命令行工具

| 项 | 值 |
|---|---|
| 名称 / 版本 | `zhihu-cli` **0.6.1**（`version` 命令返回 `darwin/amd64`） |
| 探针用二进制 | `.probe/bin/zhihu-cli`（**临时**，正式部署应换 `.runtime/`） |
| 来源 | `https://developer-cdn.zhihu.com/zhihu-cli/releases/stable/skill/zhihu-cli-skill.zip` |
| 归档校验 | `fb437eafeba63193da13e89cd0a3425162550c09615b6aa33a1f3c0227784c94`（darwin-amd64 tar.gz） |
| 凭证存储 | macOS 系统凭证库；`ZHIHU_ACCESS_SECRET` 环境变量优先于它；**不读 `.env`，无明文文件降级** |
| 官方能力清单 | `capabilities`（免凭证、返回码 0），含每个能力的 limit 上下界 / pagination / path |

### 命令用法要点（务必以 `--help` 为准，别凭记忆）

- `hot --limit N`（N 上限 30）
- `search zhihu --query "..." --count N`（**`--query` 必填，不接受位置参数**；count 上限 10）
- `me contents --limit N`、`quota`、`capabilities`、`version`
- `auth set` / `auth status [--verify]` / `auth logout` —— **没有 `auth login` 这个子命令**
- 全局开关只有 `--pretty`（改空白）、`--timeout`、`--verbose`
- **没有 `--json` / `--format`**，传了返回码 2（`unknown flag`）

---

## 2. 输出与返回码（实测）

**输出永远是 JSON**，没有表格模式。成功与失败是**两套完全不同的结构**，不能用同一套规则解析：

```
成功（原样透传服务端）  {"Code":0,"Message":"success","Data":{...}}
                       字段全部首字母大写：Title / Items / TotalQuota / RemainingQuota …

失败（CLI 自己生成）    {"ok":false,"error":{"source":"cli","code":"AUTH_REQUIRED",
                       "message":"...","action_url":"https://developer.zhihu.com/profile"}}
                       注意：没有 Code 字段
```

### 返回码 —— 判断的第一依据，必须先于解析 JSON

| 返回码 | 含义 | 实测到 |
|---|---|---|
| 0 | 成功 | ✅ |
| 2 | 参数用错（含 `unknown flag`、位置参数） | ✅ |
| 3 | 需要密钥（`AUTH_REQUIRED`） | ✅ |
| 4 | 被限流（业务码 `30001` `rate limit exceeded`） | ✅ |
| 5–8 | 网络 / 服务端 / 凭证库 / 安装（来自官方契约，**未实测**） | ❌ |

**判定顺序**：返回码 → 有没有 `ok` 字段 → 有没有 `Code` 字段。
官方明确警告：**HTTP 200 里也可能藏业务错误**，不能把 `Code: 20001` 当成空结果。

---

## 3. 真实字段名（2026-10-28 有密钥实测）

这是本文件最有价值的部分——**开发时曾因为猜错字段名导致缺陷**（见 §6）。

### 热榜 `hot`
```
Data: { Total, Items: [...] }
Items 元素: Title, Url, ThumbnailUrl, Summary
```

### 搜索 `search zhihu`
```
Data: { HasMore, SearchHashId, Items: [...] }      ← 注意：没有 Total
Items 元素: Title, ContentType, ContentID, ContentText, Url, CommentCount,
            VoteUpCount, AuthorName, AuthorAvatar, AuthorBadge, AuthorBadgeText,
            EditTime, AuthorityLevel, RankingScore
```

### 我的创作 `me contents`
```
Data: { Items: [...] }                             ← 注意：没有 Total
Items 元素: ContentType, Url, CreatedAt, LikeCount, CommentCount,
            FavoriteCount, Title, Summary
Data.Paging: { IsEnd, NextOffset, Totals }
CreatedAt 是 Unix 秒级时间戳（数字），如 1793161647
```

### 额度 `quota`
```
Data: [ { APIID, APIName, TotalQuota, TotalUsed, RemainingQuota }, ... ]
例子: { "APIID":"hot_list", "APIName":"热榜", "TotalQuota":100, "TotalUsed":0, "RemainingQuota":100 }
```

---

## 4. 每日额度（实测，单位：次 / 自然日）

| 能力 | 每天上限 | 备注 |
|---|---:|---|
| **热榜 `hot_list`** | **100** | **最稀缺**，侧边栏必须克制 |
| 知乎搜索 `zhihu_search` | 5000 | |
| 全网搜索 `global_search` | 5000 | |
| 知乎用户数据 `user_data` | 10000 | 「我的创作」走这个 |
| 创作能力 `creator` | 500 | |
| 知识库 `knowledge` | 500 | |
| 问题发现 `question_discovery` | 100 | |
| 直答 `zhida_openai` | 100 | |
| 小工具 `tools` | 10 | |

> 早前第三方资料称「搜索每天 1000 次」是**错的**，实测 5000。

### ⚠️ 两条硬约束

1. **`quota` 命令不消耗业务额度，但自身会触发限流。** 实测连续调用几十秒内即返回码 4。
   → **绝不能每次请求前都查额度**，否则自己限流自己。必须低频刷新 + 节流。
2. **限流是真实存在的**，不是理论风险。任何常驻界面都必须：串行队列 + 失败退避 + 冷却期直接回缓存。

---

## 5. 密钥与凭证库

- 密钥由**用户在 `https://developer.zhihu.com/profile` 手动生成**，一次性、长期有效，删除不可恢复。
- 存进 macOS 系统凭证库，**由 `zhihu-cli` 自己读取**。
- **插件进程与 agent 永远不接触密钥明文**，只能拿到打码指纹（形如 `76ed...9037`）。
  这是设计优点，不是限制——密钥因此不进对话记录、不落任何明文文件。

### 一个未完全解释清的现象

同一条 `auth status`，在不同进程环境下早期出现过两种结果：

```
早期某次   {"keychain":"not_found"}          ← 拿不到
后来       {"keychain":"available", ...}     ← 正常
env -i 干净环境  {"keychain":"available", ...} ← 也正常
```

已排除的原因：**不是** `__CFUserTextEncoding` 缺失（补齐前后都一样）、**不是** 凭证库没写入、
**不是** 另装了别的二进制（两处默认安装路径都不存在）、**不是** 环境变量（`.zshrc` 等 0 处命中）。
最可能是**时序或间歇性**问题。**若再遇到 `not_found`，先重跑一次再下结论**，别急着归因。

---

## 6. 已踩过的坑（别再踩）

| # | 坑 | 教训 |
|---|---|---|
| 1 | **额度字段名猜错**：代码写 `ApiId`/`api_id`/`ApiID`/`apiId`，真实是 **`APIID`** | 测试 fixture 跟着代码一起写错 → **82 个测试全绿却是假阳性**。测试数据必须来自真实响应，不能照着实现造 |
| 2 | 以为 `auth login` 存在 | 凭印象写命令，实际是 `auth set`。**命令一律以 `--help` 为准** |
| 3 | 写 `search zhihu "测试"` 用位置参数 | 返回码 2，必须 `--query` |
| 4 | 复测时接了管道 `\| head` | **管道会接管返回码**，`$?` 拿到的是 `head` 的，报出的 0 是假的。测返回码必须重定向到文件 |
| 5 | 看到「补齐变量后就好了」就下结论 | 没做干净对照 → 错误归因。**因果结论必须有对照组** |
| 6 | 用 `npm` 装工具 | 本仓库**只允许 pnpm** |

---

## 7. 探针产物索引（`.probe/`，9.7 MB，暂不入库）

| 路径 | 内容 |
|---|---|
| `.probe/REPORT.md` | 681 行，17 条命令的原始输出、能力清单原文、错误与退出码约定 |
| `.probe/bin/zhihu-cli` | 临时二进制（**正式部署换 `.runtime/`**） |
| `.probe/skill/` | 官方 Skill 包解包（含 `SKILL.md`、`references/cli.md`） |
| `.probe/raw*/` | 分批原始 stdout/stderr/exit |
| `.probe/manifest.remote.json` | 远端发布 manifest 原文 |

整个 `dsh-zhihu-sidebar/` 目录目前被根 `.gitignore` 的 `/*` 通配规则覆盖，
**代码不会进版本控制**——开改动请求前必须先往白名单加一行（规则文件，归控制面处理）。

---

## 8. 额度消耗台账（本机，2026-10-28）

| 命令 | 消耗 | 说明 |
|---|---:|---|
| `hot` | 2 次 | 剩约 95 |
| `me contents` | 1 次 | 万次池 |
| `search zhihu` | 1 次 | 五千次池 |
| `quota` | 若干 | **不计次**，但触发过 1 次限流 |

**测试绝不调用真实工具**——一律走 `test/fixtures/fake-cli.mjs`。

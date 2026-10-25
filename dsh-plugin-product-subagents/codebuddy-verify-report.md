# CodeBuddy → DSH product-subagent 方案：实测验证报告

**日期**：2026-10-23
**性质**：只读验证（未改插件代码、未改 profile、未提交 pipeline）
**结论**：简报整体**属实**。上一轮我对简报的两处"纠正"是错的，已在本报告更正。

> 已脱敏：`session_id` / `uuid` 与用户名路径均已替换为占位符。

---

## 一、实测项与结果

运行方式（可复现）：

```sh
env -i HOME=/tmp/cbhome TMPDIR=/tmp \
  PATH=/Users/<user>/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin \
  LANG=en_US.UTF-8 \
  CODEBUDDY_FORCE_LITE_WB_BUNDLE=1 \
  CODEBUDDY_AUTH_TOKEN="$(cat .tok)" \
  CODEBUDDY_INTERNET_ENVIRONMENT=internal \
  /Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy \
  -p --output-format stream-json "…" < /dev/null
```

| # | 断言 | 判定 | 实测证据 |
|---|---|---|---|
| 1 | token 从 `workbuddy-desktop.info` 的 `$wbEncrypted` 解密 | ✅ | `find_auth_file()` 解析到 `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`，`resolve_session()` 得 1323 字符 JWT |
| 2 | 必须 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` | ✅ | 不带时 `-p` **立即**报 `Error: Cannot find module '../dist/codebuddy'`（launcher 第 263 行走 `codebuddy-headless` → 缺失 → 回退 `codebuddy` → 也缺失 → throw）；`dist/` 只有 `codebuddy-lite-wb.mjs` |
| 3 | `CODEBUDDY_INTERNET_ENVIRONMENT=internal` | ✅ | init 帧 `apiKeySource: "www.workbuddy.cn"`，`model: "auto"` |
| 4 | `--output-format json` 是美化数组、末行 `]` | ✅ | 输出 5 元素数组（`message / file-history-snapshot / reasoning / message / result`），末行确为 `]`；`lib/bridges/claude.js` 取末行 `JSON.parse` 必抛错 |
| 5 | `stream-json` 末行 = result 对象 | ✅ | 见下方原文，单行、含 `session_id` / `result` / `is_error` |
| 6 | `--resume <sid>` 续接 | ✅ | 首轮让其记 `MANGO`；次轮 `--resume` 问"哪个词"，答 `MANGO`，`session_id` 不变 |

stream-json 末行原文（第 5 项）：

```json
{"type":"result","subtype":"success","is_error":false,"result":"OK","uuid":"<redacted-uuid>","session_id":"<redacted-session-id>","duration_ms":14591,"duration_api_ms":14590,"num_turns":7,"total_cost_usd":0,"usage":{"input_tokens":43797,"output_tokens":383,"cache_creation_input_tokens":21077,"cache_read_input_tokens":22720,…}}
```

resume 末行（第 6 项）：

```json
{"type":"result","subtype":"success","is_error":false,"result":"MANGO","session_id":"<redacted-session-id>",…}
```

## 二、成本实测（比简报估计的高）

| 项 | 简报估计 | 实测 |
|---|---|---|
| 单次 input tokens | ~2.1 万 | **43,797**（其中 21,077 为 cache 创建） |
| 单次耗时 | 未提 | 首发 14.6s / 续接 10s |

也就是说"委派验证控制在 1–2 次"这条红线要按 **4 万+ tokens/次** 来算。

## 三、两个新坑（简报没有、会影响落地）

### 1. `--version` 有早期快路径，探测不到 FORCE_LITE 漏配

- 不带 `FORCE_LITE` 时：`--version` → 正常打印 `2.161.0`；`-p` → 立刻 `Cannot find module '../dist/codebuddy'`。
- 插件 `lib/availability.js` 的 `commandExists()` 正是用 `<command> --version` 探测（`spawnSync`，10s 超时，`status===0` 即视为可用）。
- **后果**：shim 若漏了 `FORCE_LITE`，provider 仍会被注册为"available"，直到真正委派才炸，报错还藏在子代理里。

### 2. IDE / Agent 壳环境会让它静默挂住

- 在本机 agent shell（继承 `HTTP(S)_PROXY=127.0.0.1:52802`、`CODEBUDDY_SERVICE_PROXY_URL`、`CODEBUDDY_MCP_CONFIG`、`NODE_OPTIONS=--require=…/node-language-shim.cjs`、`ELECTRON_RUN_AS_NODE=1`、`PYTHONPATH=…/vendor/shim`）里跑：进程能起、cpu 0.1%、rss 146MB，**永不输出、永不退出**（最久观察 20 分钟）。
- 单因素排除：代理变量、`CODEBUDDY_MCP_CONFIG`、`NODE_OPTIONS`、`ELECTRON_RUN_AS_NODE`、真实 `HOME` 单独加回去都能正常出活 —— 即**不是单一变量**，是整套壳环境的组合效应，未定位到根因。
- 换 `env -i`（显式 HOME/TMPDIR/PATH/LANG + 三个 CODEBUDDY 变量）后 100% 稳定。
- **对交付的影响**：dsh 的 LaunchAgent env 只有 `PATH` / `HOME` / `DSH_HOME`，本身干净，理论上不会中招；但 shim 必须**显式构造 env 白名单**，不要 `dict(os.environ)` 直接透传，否则从任何 IDE 会话里手动跑都会静默挂死。

## 四、更正我上一轮的错误判断

| 我上一轮说 | 实际 |
|---|---|
| "`FORCE_LITE` 不是必须，只是省内存" | ❌ 错。`-p` 缺它必死。我当时只测了 `--version`（有快路径），是取样错误 |
| "`--output-format json` 是紧凑单行数组" | ❌ 错。是**美化数组**（2 空格缩进），简报说的"美化数组、末行 `]`"完全正确 |
| "`--model` 别名是 sonnet/opus" 属简报错误 | ✅ 这条仍成立：`--help` 实测别名是 `fast-model / balanced-model / deep-model / hy4-preview / hy3 / glm-5.3 / deepseek-v4.1-flash / kimi-k3-1 …`，没有 sonnet/opus |

## 五、仍未验证的部分

1. **真实 `product_delegate` 链路**：需要改 profile `cordis.patch.yml`（config 覆盖会替换整块，必须重述 `idleTimeoutMs` / `rolesDir` / `providers.opencode`）+ 可能要重启（会杀当前会话）。属于系统改动，未做。
2. **插件的 `commandExists` 探测在长 token 场景下的耗时**：shim 每次 `--version` 是否要解密（会起一次运行时帮助器），未测；建议 shim 对 `--version` 直接短路。

## 六、给落地的具体建议（未实施）

1. shim 里显式构造环境变量白名单：`HOME / PATH / TMPDIR / LANG` + `CODEBUDDY_AUTH_TOKEN / CODEBUDDY_INTERNET_ENVIRONMENT=internal / CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`，**不要继承** `NODE_OPTIONS`、`ELECTRON_RUN_AS_NODE`、`PYTHONPATH`、`HTTP(S)_PROXY`、`CODEBUDDY_MCP_CONFIG`、`CODEBUDDY_SERVICE_PROXY_URL`。
2. `argv` 含 `--version` / `--help` 时直接原样 exec，不解密 token（避开探测超时）。
3. 参数改写要同时处理 `--output-format json`（两段式）和 `--output-format=json`（等号式）。
4. 保持 `stream-json`（**别用 `json`**：末行 `]` 必炸，即使侥幸解析也拿不到 `session_id`，续接会静默实效）。
5. 委派成本按 4 万 tokens/次预估额度；验证阶段先用 `env -i` 裸跑一次契约，再配 provider。

# dsh-subagents

**角色化子代理层**。改这个插件之前先读这一页；面向使用者的安装与用法在
[`dsh-subagents/README.md`](../../dsh-subagents/README.md)。

| 项 | 值 |
|---|---|
| 包名 | `dsh-plugin-subagents` |
| 来源 | **原创**（重写替代 fork `dsh-plugin-product-subagents`，见 [ADR-0001](../adr/0001-不再跟随上游重写-subagents.md)） |
| 当前阶段 | PR2：骨架 + 角色层 + 契约层 + CLI（形态 B 一次性调用） |
| 设计依据 | [`docs/requirements/REQ-001-design.md`](../requirements/REQ-001-design.md) |

## 改哪里

| 想改 | 改哪个文件 | 注意 |
|---|---|---|
| 判定行格式 / 解析规则 / 高风险路径 | `lib/contract.js` | 改完必须同步 `schema/review-result.json` 与 `REQ-001-design.md` §4 |
| 请求组装、diff 围栏、预算 | `lib/request.js` | diff 走 git，元数据走 gh；`--diff-file` / `--meta-file` 留给测试 |
| 记录落盘、traceId、熔断 | `lib/record.js` | 记录目录 `.dsh-web/reviews/` 已在 `.gitignore` 里忽略 |
| 角色字段与加载 | `lib/roles.js` + `roles/*.json` | 非法值降级到最保守值，坏文件跳过 |
| 形态 B 的 CLI 调用 | `lib/bridge-cli.js` | 一期只有 `opencode` / `codebuddy`；ACP 在 PR4 |
| 子命令 | `lib/cli.js` | 退出码契约：0 通过 / 1 拒绝 / 2 参数或环境错误 |
| 宿主侧注册 | `lib/index.js` | **PR4 才动**；见下面「已知坑」第一条 |

## 已知坑

1. **provider 重名会让整个 profile 插件树启动失败。** 旧插件注册了 `product-subagents:opencode` 等；
   本插件 PR4 也要用同一前缀（`scripts/pipeline/audit-subagents.mjs` 硬编码了它）。因此**挂载前必须先卸载旧插件**，
   两者不能同时挂。
2. **不要提前注册 provider。** PR2 的 `lib/index.js` 是空的，这是刻意的：装配验证只验「装得进去」，
   注册对不对留到 PR4 一次验完，否则一个红灯查不出是装配问题还是注册问题。
3. **随机标记必须每次新生成。** 复用会让「判定行来自模型」这件事不可证。
4. **`nonce` 是 `ReviewResult` 的必填字段**，比 REQ-001 §7.2 多一个——结果不带它就无法证明对应哪次标记。
5. **不要在这里写「自动换模型」。** 模型不可用就 `ESCALATE`，静默降级比失败更危险。

## 怎么验证

```bash
# 单插件门禁（测试 + 语法检查）
scripts/pipeline/check-all.sh dsh-subagents

# 一次性 DSH_HOME 装配验证（绝不碰真实 ~/.dsh）
scripts/pipeline/install-check.sh dsh-subagents

# 手工
cd dsh-subagents && node --test && node --check lib/cli.js
```

基线（2026-10-31，PR2）：`node --test` **37 项全过**。

真实调用形态 B 需要本机有 `opencode` 或 `codebuddy`，并且要用**完整权限**跑
（受限沙盒下 `gh` 读不到系统钥匙串，会报「令牌无效」）。

# 不再跟随上游，以 `dsh-subagents` 重写替代

**状态**：accepted（2026-10-31）

`dsh-plugin-product-subagents/` 是 `shaokeyibb/dsh-plugin-product-subagents` v0.4.0 的快照 fork。我们需要在它之上加两样东西：可扩展的**角色层**（`executor` / `reviewer`，以后还会加）和 reviewer 的**判定契约**。往 fork 里加意味着此后每次同步上游都是永久合并冲突，而本仓对它有专门的版本兼容纪律（bump SemVer、写 `docs/COMPATIBILITY.md`、必要时申请版本豁免）。因此决定：**断开上游，新建 `dsh-subagents/` 参考旧代码重写，角色层与接入形态层按我们的结构设计**；旧目录保留但冻结，注明「不再跟随上游，功能由新插件承接」，等新插件能覆盖 `executor` 后再删。

## 考虑过的选项

- **继续 fork、只加角色**：最小改动，但冲突成本会随时间复利，且「角色层」只能长成上游的形状。
- **不建插件，全塞进 `scripts/`**：形态 A 需要在宿主内注册 provider，脚本进程没有 `ctx`，做不成。
- **新插件与旧插件长期并存**：provider 的 `name` 全局唯一，重名会让整个 profile 插件树启动失败；两套 provider 并存时「同一个任务派给谁」也没有答案。

## 后果

- ACP 桥要自己维护。范围收窄到本机真实在用的 `opencode` / `codebuddy` / 通用 `acp` 三套，`claude-code` / `codex` 桥不迁（本机无此命令）。
- provider 前缀与工具名**沿用** `product-subagents:*` / `product_*`，因为 `scripts/pipeline/audit-subagents.mjs` 硬编码了旧前缀，改名会让审计静默失效。正名留到 `executor` 迁完之后单独做一次。
- 旧插件在 PR4 挂载新插件前必须先卸载：一次性替换，不做长期并存。
- 一期不挂真实 profile，只过 `install-check.sh`；挂载需要重启宿主，单独一个 PR 窗口。

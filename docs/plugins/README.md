# 插件文档索引（docs/plugins/）

本目录是**插件级 agent 说明的唯一落点**：全仓库只有根目录一份 `AGENTS.md`（负责路由与强制规定），
插件自己的「改哪里、注意什么、怎么验证」写在这里。**任何子目录不得再新增 `AGENTS.md` / `CLAUDE.md`**
（见根 [`AGENTS.md`](../../AGENTS.md) 强制规定 1）。

| 插件 | 文档 | 包名 | 来源 |
|---|---|---|---|
| `dsh-auto-upgrade/` | [`dsh-auto-upgrade.md`](./dsh-auto-upgrade.md) | `dsh-plugin-auto-upgrade` | 原创 |
| `dsh-external-discuss/` | [`dsh-external-discuss.md`](./dsh-external-discuss.md) | `dsh-plugin-external-discuss` | 原创 |
| `dsh-im-bridge-workspaces/` | [`dsh-im-bridge-workspaces.md`](./dsh-im-bridge-workspaces.md) | `@mhfire/dsh-im-bridge` | fork（npm `@mhfire/dsh-im-bridge@0.4.4`） |
| `dsh-plugin-product-subagents/` | [`dsh-plugin-product-subagents.md`](./dsh-plugin-product-subagents.md) | `dsh-plugin-product-subagents` | fork（`shaokeyibb/dsh-plugin-product-subagents` v0.4.0） |
| `dsh-prompt-optimizer/` | [`dsh-prompt-optimizer.md`](./dsh-prompt-optimizer.md) | `@y1x1n/dsh-prompt-optimizer` | fork（npm `@y1x1n/dsh-prompt-optimizer@0.6.1`） |
| `dsh-zhihu-sidebar/` | [`dsh-zhihu-sidebar.md`](./dsh-zhihu-sidebar.md) | `dsh-plugin-zhihu-sidebar` | 原创 |

各插件目录内仍保留面向**使用者**的 `README.md`（安装 / 配置 / 已知限制）；
本目录的文档面向**在此仓库动手的 agent**，与 README 互补，不重复整篇内容。

相关文档：
- 交付流程与 worktree 纪律：[`../pipeline/README.md`](../pipeline/README.md)、台账 [`../pipeline/PROGRESS.md`](../pipeline/PROGRESS.md)
- 历史归档：[`../archive/README.md`](../archive/README.md)
- 仓库对外说明：[根 `README.md`](../../README.md)

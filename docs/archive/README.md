# 归档（docs/archive/）

这里放**不再维护、仅作历史参考**的文档。归档不等于删除，但**不要照它操作**。

| 文件 | 来历 | 状态 |
|---|---|---|
| [`pipeline/scripts-pipeline-README.md`](./pipeline/scripts-pipeline-README.md) | 原 `scripts/pipeline/README.md`（手写版入口说明），2026-11-09 接入 `dsh-pipeline init` 时由生成骨架取代（PR #405），手写内容整体移入此处 | **已被取代**：入口清单与校验命令以生成骨架 [`docs/pipeline/README.md`](../../docs/pipeline/README.md) 与共享包契约为准。 |
| [`pipeline/docs-pipeline-README.md`](./pipeline/docs-pipeline-README.md) | 原 `docs/pipeline/README.md`（手写版流程手册：流程总览、脚本清单、worktree 命名契约、四条红线、与 agent-mobile 的差异），同上归档 | **已被取代**：现行流程手册是生成骨架 + 本仓追加约定（`docs/pipeline/README.md` §五）；本文仅存档，里面的脚本细节与阶段状态已过时。 |
| [`pipeline/docs-pipeline-review-loop.md`](./pipeline/docs-pipeline-review-loop.md) | 原 `docs/pipeline/review-loop.md` 的手写版（executor 切换与验证手册），同上归档 | **已被取代**：现行审核循环见 [`docs/pipeline/review-loop.md`](../../docs/pipeline/review-loop.md)（生成骨架）。 |
| [`dsh-upgrade-plan.md`](./dsh-upgrade-plan.md) | 仓库根目录原有的 `dsh-upgrade-plan.md`（写于 2026-10-10，当时 dsh 是 `0.1.5-rc.3`、插件还没迁到 profile 的 `link:` 依赖），2026-10-17 移入此处存档 | **已被取代**：现在升级 dsh 用仓库根的 [`upgrade-dsh.sh`](../../upgrade-dsh.sh)（交互式，升级前备份 `~/.dsh`、升级后校验版本号 + 组合冒烟），或在 dsh Web UI 里用 `dsh-auto-upgrade` 插件。两者都覆盖了本文档的「备份 / 安装 / 校验 / 重启」链路，**本文档仅存档**——里面的版本号、PID、命令均已过时。 |

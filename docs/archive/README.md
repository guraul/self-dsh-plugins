# 归档（docs/archive/）

这里放**不再维护、仅作历史参考**的文档。归档不等于删除，但**不要照它操作**。

| 文件 | 来历 | 状态 |
|---|---|---|
| [`dsh-upgrade-plan.md`](./dsh-upgrade-plan.md) | 仓库根目录原有的 `dsh-upgrade-plan.md`（写于 2026-10-10，当时 dsh 是 `0.1.5-rc.3`、插件还没迁到 profile 的 `link:` 依赖），2026-10-17 移入此处存档 | **已被取代**：现在升级 dsh 用仓库根的 [`upgrade-dsh.sh`](../../upgrade-dsh.sh)（交互式，升级前备份 `~/.dsh`、升级后校验版本号 + 组合冒烟），或在 dsh Web UI 里用 `dsh-auto-upgrade` 插件。两者都覆盖了本文档的「备份 / 安装 / 校验 / 重启」链路，**本文档仅存档**——里面的版本号、PID、命令均已过时。 |

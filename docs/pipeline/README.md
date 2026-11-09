# Pipeline 工作手册（guraul/self-dsh-plugins）

<!-- >>> dsh-pipeline 生成区（勿手改；改模板后重跑 init） -->
> 本文件由共享包 `@guraul/dsh-pipeline` 的 `init` 生成。生成区之外可以追加本仓自己的内容；
> 生成区内的文字被改动后，`init --check` 会判为不一致。

## 一、流程总览

```text
1. 开 issue      每任务一个，写清现象 / 根因 / 方案 / 验收标准 / 回滚
2. 建工作区      scripts/pipeline/new-task.sh <issue号>   → task/<号>-<slug> 分支 + worktree
3. 开发          在 worktree 内改代码，提交信息带 #<issue号>
4. 本地门禁      scripts/pipeline/pipeline.sh check-all   → 逐包 test / check / typecheck
5. 开 PR         scripts/pipeline/open-pr.sh              → 推送 + 开 PR（body 首行 Closes #<issue号>）
6. 审核          控制面委派 reviewer，判定落成审核记录（.dsh-web/reviews/）
7. 合并          scripts/pipeline/merge-pr.sh --pr <号> --root <主工作区> --record <记录>
                 闸门 → CI → squash 合并 → 清理 worktree / 分支 → 快进 main
```

## 二、入口清单

| 入口 | 转发到 | 说明 |
|---|---|---|
| `scripts/pipeline/pipeline.sh` | 第一个参数即子命令 | 通用入口，等价于直接调包 |
| `scripts/pipeline/new-task.sh` | `task` | 建任务分支 + worktree |
| `scripts/pipeline/open-pr.sh` | `pr` | 推送分支 + 开 PR |
| `scripts/pipeline/merge-pr.sh` | `merge` | 闸门 → CI → squash 合并 → 清理 |
| `scripts/pipeline/review.sh` | `review` | `prepare` / `prompt` / `publish` |
| `scripts/pipeline/status.sh` | `status` | 审核记录概况（只读） |

入口全部是生成物，**禁止手改**；改一个字节 `shim check` 就会红。

## 三、四件套与自检

| 项 | 路径 | 校验 |
|---|---|---|
| 配置 | `.dsh/pipeline.json` | `pipeline.sh selftest --config` |
| 入口 shim | `scripts/pipeline/*.sh` | `pipeline.sh shim check` |
| pre-push 钩子 | `.git/hooks/pre-push`（或 `core.hooksPath` 指向的位置） | `pipeline.sh hooks check` |
| 文档骨架 | `docs/pipeline/` | `pipeline.sh init --check` |

本地自检：`pipeline.sh selftest --fast` 一次跑完前两项。pre-push 钩子只拦直推 `main` / `master`，不跑自检。

## 四、规范来源

契约是唯一规范来源：[`docs/CONTRACT.md`](https://github.com/guraul/dsh-pipeline/blob/main/docs/CONTRACT.md)。
本文件只写「怎么跑」，不重复参数与退出码——逐命令细节查契约 §3 / §4。
<!-- <<< dsh-pipeline 生成区结束（以下可追加本仓自己的内容） -->

## 五、本仓追加约定（生成区之外）

本节由本仓自己维护，`init` 不比对、也不会被覆盖。旧版手写手册已整体归档到
[`docs/archive/pipeline/docs-pipeline-README.md`](../archive/pipeline/docs-pipeline-README.md)（仅存档，不要照它操作）。

### worktree 与分支命名契约

| 项 | 契约 |
|---|---|
| 分支名 | `task/<issue号>-<slug>`（由 `new-task.sh` 生成，不要手搓） |
| worktree 路径 | `.worktrees/<issue号>-<slug>`，相对仓库根；一律从主仓根执行 |
| 基线 | 必须基于 `origin/main`（`new-task.sh` 内置） |
| 位置 | worktree 绝不能嵌在插件子目录里（在子目录里跑 `git worktree add` 会嵌错层级） |
| 清理 | issue / PR 关闭后立刻 `git worktree remove --force <path>` → `git branch -D task/<N>-<slug>` → `git worktree prune` → `git worktree list` 确认只剩主工作区 |
| 为什么 `-D` | squash 合并后原提交不是 `main` 的祖先，`-d` 会拒绝删除 |

**memx 例外**：memx 被宿主从主仓加载源码，worktree 不能建在仓内——它的 `new-task.sh` 固定传
`task --worktrees-dir /Users/gubin/workspace/memx-worktrees`，worktree 落在仓外的
`~/workspace/memx-worktrees/<号>-<slug>`，上表的 `.worktrees/` 契约不适用于它。

### 刷新共享包（`tools/`）

包源码改完后：在包仓跑 `pnpm run pack`（产出 `dist/pkg`），然后在本仓
`rm -rf tools/node_modules tools/pnpm-lock.yaml && pnpm --dir tools install`，
再用 `node tools/node_modules/dsh-pipeline/bin/cli.mjs --version` 确认拿到新构建（带 sha 与 builtAt，不是「源码运行」）。

两条经验：**不要用 `pnpm update`**（会复用旧缓存，装出来还是旧包，见 issue #231）；
重装后新生成的 `tools/pnpm-lock.yaml` **不要提交**（`.gitignore` 已覆盖）。

### 版本豁免

版本豁免是逃生舱，只在拿到用户对**具体版本组合**的明确同意后才用（CLI 需 `--accept-risk`），
用完必须撤销——`dsh plugin --profile web version-exemptions` 应回到 `{}`。插件升版本或 DSH 升版本都会让它自动失效。
完整顺序见本仓 [`AGENTS.md`](../../AGENTS.md) 强制规定第 6 条与
[`docs/plugins/dsh-plugin-product-subagents.md`](../plugins/dsh-plugin-product-subagents.md)。

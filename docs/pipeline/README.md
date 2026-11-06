# Pipeline 工作手册（self-dsh-plugins）

> 本仓库的交付流程说明。机制**照抄并适配 [agent-mobile](https://github.com/guraul/agent-mobile) 的 pipeline**：
> 唯一实现在共享包 `@guraul/dsh-pipeline`（[`guraul/dsh-pipeline`](https://github.com/guraul/dsh-pipeline) 仓），
> `scripts/pipeline/` 里只有**生成的入口**（禁止手改），不依赖任何特定 agent 的插件。
> 进度台账见 [PROGRESS.md](PROGRESS.md)。

**一句话定位**：本仓库的"交付物"不是线上服务，而是**插件被本机 DSH profile 正确装配**——所以这里没有服务器、没有部署，只有 worktree 纪律 + 测试门禁 + 一次性 `DSH_HOME` 装配验证。

## 一、流程总览

```
1. 开任务       在 GitHub 开 issue（每任务一个）
2. 建工作区     scripts/pipeline/new-task.sh <issue号>
                → 分支 task/<issue号>-<slug> + worktree .worktrees/<issue号>-<slug>（基于 origin/main）
3. 开发         cd 到 worktree 内开发；提交信息建议带 #<issue号>
4. 本地自测     scripts/pipeline/pipeline.sh check-all [--packages <目录>,…]   # 测试 / check / typecheck
5. 开 PR        （在 worktree 内）scripts/pipeline/open-pr.sh
                → 自动推送 + 开 PR，body 首行 Closes #<issue号>
6. CI           GitHub Actions（.github/workflows/ci.yml）：只跑测试 + node --check 语法检查
7. 审核         控制面委派 reviewer（会话内子代理）→ 读 issue/PR/diff
                → 写 PR comment（第 N 次/共 3 次）+ 提交 review 状态
                → 写审核记录 .dsh-web/reviews/<pr>-<sha>.json
                → 有问题则委派 executor 修复后重审（上限 3 轮）
8. 合并         scripts/pipeline/merge-pr.sh --pr <PR号> --record <记录>   # 闸门 → squash merge → 清理 → 快进 main
9. 收尾         合并后**没有部署**；只有 CI 测试通过这一件事
```

**两道闸门，一个纪律**：

- **CI**（第 6 步）：测试与语法检查，不过就停；
- **审核闸门**（由共享包 `@guraul/dsh-pipeline` 实现，`merge-pr.sh` 是它生成的入口）：合并前必须有审核记录，校验判定、提交绑定、时效与高风险路径。**默认 fail-closed**——没记录就拒绝合并。要绕过必须显式声明 `--no-review --reason=<文本>`（包要求跳过必须写原因），此时打印警告并写一条跳过审计（`.dsh-web/reviews/skips/`），事后可查。**`DSH_REVIEWER=off` 已不再生效**。

**人在哪**：只在三种情况被叫——判定 `ESCALATE`、命中高风险路径、3 轮仍不通过。其余环节由会话内的角色接转完成。

**判定 `APPROVE` 且未命中高风险 → 直接合并**：不再向用户确认。闸门已经校验判定、提交绑定、时效与高风险路径，再问一次只是把人工环节从后门塞回来。

**身份分离**：PR 由主账号开与合并；PR comment 与 review 状态由**机器账号**（`dsh-bot-guraul`，`GH_CONFIG_DIR=~/.config/gh-reviewer`）提交——GitHub 不允许同一账号 approve 自己的 PR。

### 审核循环与控制面的权力

控制面对 reviewer 的判定**只从严、不从宽**：

| reviewer 给的 | 控制面能做什么 | 不能做什么 |
|---|---|---|
| `APPROVE` | 契约校验后放行；命中高风险 / 证据为空 / findings 含 `blocker` → **升级为 `ESCALATE`** | 不能自己再读代码找问题 |
| `REJECT` | 落地拒绝（comment + `CHANGES_REQUESTED`）→ 委派 executor 修复 | **不能推翻**、不能放行；觉得误报只能交给人 |
| `ESCALATE` | 直接停，叫人 | 不能自行改判 |

三条机械检查（不需要懂代码）：判定行 / SHA / schema 合规、命中高风险路径、自相矛盾（APPROVE 但 findings 有 `blocker` 或 evidence 为空）。

**循环规则**：一轮 = reviewer 审一次；上限 3 轮，由控制面计数并写进 comment 与任务卡；第 3 轮仍 `REQUEST_CHANGES` → 停止循环，交给人。

**合并后没有部署**：本仓库没有服务器、没有 rsync / ssh / systemd、没有线上 curl 验证。合并的唯一后果是 main 前进一格、CI 重跑一遍。

规则：pipeline 只服务本仓库自己的插件（清单以 `.dsh/pipeline.json` 的 `checks.packages` 为准）；插件是 `link:` 到本机 DSH profile 的，不走发布流程。

## 二、脚本用法

环境：入口都必须在**本仓库或其 worktree 内**运行（入口按 `git` 定位仓库根与主工作区；找不到共享包时退出码 3）。

### 脚本清单

本目录（`scripts/pipeline/`）的完整文件清单，**以 `ls scripts/pipeline/` 为准**——6 个 `*.sh` 全是共享包 `shim install` 的生成物（生成 / 校验说明见 [`scripts/pipeline/README.md`](../../scripts/pipeline/README.md)），**禁止手改**：改一个字节 `shim check` 就会红。

| 文件 | 转发到 | 说明 |
|---|---|---|
| `pipeline.sh` | 第一个参数即子命令 | 通用入口，等价于直接调包 |
| `new-task.sh` | `task` | 建 `task/<号>-<slug>` 分支 + worktree |
| `open-pr.sh` | `pr` | 推送分支 + 开 PR |
| `merge-pr.sh` | `merge` | 闸门 → CI → squash 合并 → 清理 → 快进 main |
| `review.sh` | `review` | 审核循环机械步骤：`prepare` / `publish` / `prompt` |
| `status.sh` | `status` | 审核记录概况（只读） |
| `README.md` | — | 本目录唯一手写文件：生成物说明与禁改提示 |

> **已删除（2026-11-06，issue #333）**：`lib.sh`、`check-all.sh`、`build-check.sh`、`build-check.test.mjs`、`install-hooks.sh`、`pre-push-main-guard.sh`、`review-loop-check.sh`，以及 `new-task.sh` / `open-pr.sh` / `merge-pr.sh` / `review.sh` / `status.sh` 的**手写版本**——能力全部收进共享包，入口改由 `shim install` 生成，钩子改由 `hooks install` 安装。
>
> **已删除（2026-11-05）**：`install-check.sh`（无自动调用且与 `compat-matrix.sh` 重复）、`compat-matrix.sh` 与其定期验证工作流 `.github/workflows/compat-matrix.yml`（周报与升级事件脱钩、只测 L1 装得上）、`audit-subagents.mjs` 及其单测与 LaunchAgent 模板 `.dsh-web/com.deepseek.dsh-audit.plist`（从未运行、只覆盖形态 B、会误判 reviewer）。能力移交 `dsh-auto-upgrade`（issue #300：升级前试装 + 升级后冒烟）。

### 三条新命令（在包里，没有独立脚本）

```bash
scripts/pipeline/pipeline.sh check-all [--packages <目录>,…] [--root <dir>] [--json]
scripts/pipeline/pipeline.sh selftest  --config | --shims | --fast | --repos <a,b,c> [--root <dir>]
scripts/pipeline/pipeline.sh doctor    [--repo <a,b>] [--profile <配置档目录>]
```

| 命令 | 作用 |
|---|---|
| `check-all` | 按 `.dsh/pipeline.json` 的 `checks.packages`（**按给定顺序**）逐包跑 `test` / `check` / `typecheck` 并汇总；`--packages` 覆盖配置；两者都没有才自动发现并按 `checks.exclude` 过滤（本仓用它把 `tools` 挡在外面）。缺 `node_modules` 记「跳过」不算失败 |
| `selftest` | 一致性自检：`--shims` = 6 个入口与「按当前包版本渲染的模板」逐字节一致；`--config` = `.dsh/pipeline.json` 能过 schema 且无未声明字段；`--fast` = 两者；`--repos <a,b,c>` = 多仓装的共享包是不是同一构建 |
| `doctor --profile <dir>` | 体检配置档：包声明、插件软链有效性、`dsh --dump-config` 可见性、`cordis.patch.yml` 非空、审核记录目录可写等逐项 ✓/✗（**替代已删的 `review-loop-check.sh`**）；不带 `--profile` 则只比对各仓构建 sha |

### 新增插件检查清单

按顺序全部做完，缺一项就会出现「脚本看不见这个插件」「CI 不跑它」「profile 装不上」之类的静默失败：

| # | 动作 | 不做会怎样 |
|---|---|---|
| 1 | 把目录名加进 `.dsh/pipeline.json` 的 `checks.packages`（顺序保持与 CI 矩阵一致） | 不传 `--packages` 的「跑全部」静默漏掉它——自动发现只在 `checks.packages` 为空时才生效 |
| 2 | 在 CI 矩阵（`.github/workflows/ci.yml`）里加该插件条目 | 该插件的 `pnpm test` / `pnpm run lint` 永远不跑 |
| 3 | 根 `README.md` 与 `AGENTS.md` 的插件索引表各加一行 | 新人 / agent 不知道它存在 |
| 4 | 写 `docs/plugins/<插件>.md`（并在 `docs/plugins/README.md` 索引里挂上） | 改之前没有「改哪里、注意什么、怎么验证」可查 |
| 5 | 在 profile（`~/.dsh/profiles/web/package.json`）加 `link:` 依赖，并把包名加进 `dsh.profile.bundles` | 插件不装配；改过已有 `link:` 路径还要在 profile 目录跑一次 `pnpm install`，否则软链悬空 |

### 子命令细节（改为指向包契约）

逐命令的用法、参数、退出码、清理动作**不再在本文件重复**，见共享包：

- 契约全文：[`docs/CONTRACT.md`](https://github.com/guraul/dsh-pipeline/blob/main/docs/CONTRACT.md)（源码仓 `~/workspace/dsh-pipeline/docs/CONTRACT.md`）（**装在 `tools/` 里的包不带 docs**，`files` 只含 `bin`/`lib`/`templates`/`README.md`/`build.json`）
- 单项用法：`scripts/pipeline/pipeline.sh --help`（**顶层** `--help` 才打印帮助；`<子命令> --help` 会被各子命令的参数校验当成非法参数，退出码 2）

本仓只需要记住入口映射（见上面的脚本清单表）与三条约定：`merge-pr.sh` 不带 `--record` 绝不合并；合并只能 squash、PR body 首行 `Closes #<issue>`（`open-pr.sh` 已内置）；`--no-review` 必须配 `--reason`，跳过审计落在 `.dsh-web/reviews/skips/`，并按「不计入已审核」统计。

### 刷新共享包（`tools/`）

包源码改完后：在包仓跑 `pnpm run pack`（产出 `dist/pkg`），然后在本仓 `rm -rf tools/node_modules tools/pnpm-lock.yaml && pnpm --dir tools install`，用 `node tools/node_modules/dsh-pipeline/bin/cli.mjs --version` 确认拿到新构建（带 sha 与 builtAt，不是「源码运行」）。

两条经验：**不要用 `pnpm update`**（会复用旧缓存，装了还是旧的，见 issue #231）；重装后新生成的 `tools/pnpm-lock.yaml` **不要提交**（`.gitignore` 已覆盖）。

## 三、worktree 与分支命名契约

| 项 | 契约 |
|---|---|
| 分支名 | `task/<issue号>-<slug>` |
| worktree 路径 | `.worktrees/<issue号>-<slug>`（相对仓库根） |
| 基线 | **必须基于 `origin/main`**（`new-task.sh` 内置） |
| 位置 | worktree **绝不能嵌在插件子目录里**；一律从主仓根执行（`git worktree add` 在子目录里跑会嵌进错误的层级） |
| 清理 | issue / PR 一旦关闭，必须立刻 `git worktree remove --force <path>` → `git branch -D task/<N>-<slug>` → `git worktree prune` → `git worktree list` 确认**只剩主工作区** |
| 为什么 `-D` | squash 合并后原提交**不是** main 的祖先，`-d` 会拒绝删除 |

**例外（memx）**：memx 被宿主从主仓加载源码，worktree **绝不能建在仓内**——它的 `new-task.sh` 固定传 `task --worktrees-dir /Users/gubin/workspace/memx-worktrees`（共享包 PR #23 新增的参数），worktree 容器是**仓外**的 `~/workspace/memx-worktrees/`，路径为 `~/workspace/memx-worktrees/<号>-<slug>`，上表的 `.worktrees/` 契约不适用于它。

## 四、关键约定（红线）

1. **审核闸门 + 人在环**：`merge-pr.sh` 默认要求 `--record <审核记录>`，没有审核记录绝不合并；reviewer 判 `APPROVE` 且未命中高风险时直接合并；只有 `ESCALATE`、高风险路径、3 轮超限才需要用户介入。

   **绕过闸门（`--no-review --reason=<文本>`）**——规则正文见 `~/.dsh/AGENTS.md` §7 第 7 条，这里只写本仓的可操作细节。注意共享包要求 `--no-review` **必须**配 `--reason`，裸 `--no-review` 会被拒绝；`DSH_REVIEWER=off` 已**不再生效**（不承认环境变量这种隐式跳过）：

   | 项 | 要求 |
   |---|---|
   | 前提 | 用户**当场明确同意**；不得以「改动很小」为由自行跳过 |
   | 留痕 | 跳过审计自动写到 `.dsh-web/reviews/skips/<时间戳>-<pr>.json`（主工作区） |
   | PR 评论 | 必须在 PR 上留一条评论，写明**为什么跳过**与**谁同意的**，模板如下 |
   | 统计口径 | 跳过的 PR **不算已审核**：它没有审核记录，追溯时不得计入 |

   PR 评论模板（`--body-file` 提交）：

   ```markdown
   ## 跳过审核闸门说明

   - **为什么跳过**：<命中哪条高风险规则 / 为什么不能等审核>
   - **审核本身的结果**：<reviewer 判定与轮次；没跑就写「未跑审核」>
   - **谁同意的**：<用户标识>，<日期> 明确同意合并
   - **留痕**：跳过审计写入 `.dsh-web/reviews/skips/`；按全局规则，本 PR 不计入「已审核」
   ```
2. **合并只能 squash**；PR body 首行必须 `Closes #<issue号>`（`open-pr.sh` 已内置）。
3. **绝不用真实 `~/.dsh` 做安装实验**：一律走一次性 `DSH_HOME`（装完即删）——原 `install-check.sh` 已于 2026-11-05 删除，能力移交 `dsh-auto-upgrade` 的升级前试装（issue #300）。
4. **版本豁免（version exemption）是逃生舱**：只在拿到用户对**具体版本组合**的明确同意后才用（CLI 需 `--accept-risk`）；用完必须撤销，`dsh plugin --profile web version-exemptions` 应回到 `{}`。插件升版本或 DSH 升版本都会让它自动失效。
5. **不要 `rm -rf` 已装插件的目录**：宿主已把模块载入内存，目录一删，任何重组合 / 重启都会失败。
6. **改了 `link:` 目标路径后，必须在 `~/.dsh/profiles/web` 跑一次 `pnpm install`**，否则 `node_modules/<包名>` 的软链会悬空（表现为插件加载失败）。
7. **不许顺手重启 dsh web 进程**（会终止当前会话）；确实需要重启时用 `.dsh-web/restart-once.sh`。
8. **macOS 自带 bash 3.2**：脚本里不要用 bash 4 语法（关联数组、`mapfile`、`${var^^}`、`declare -A`、`${VAR:-默认值}` 在 UTF-8 相邻时会出乱码）；用 `if [[ -z ... ]]` 做默认值。

## 五、本仓库与 agent-mobile 的差异

| 维度 | agent-mobile | 本仓库（self-dsh-plugins） |
|---|---|---|
| 服务器 / 部署 | 有（106.13.181.13，rsync + systemd + 线上 curl 验证） | **没有** |
| 部署脚本 | `deploy.sh` / `rollback.sh` / `fix-opencode-binary.sh` | **不存在**，也不移植 |
| CI 工作流 | `deploy-web.yml`（tsc + vitest → expo export → rsync → 切软链 → restart → 验证） | `ci.yml`（**只跑测试 + `node --check`**，零部署步骤） |
| 交付物 | 生产静态站 9928 上的新版本 | **插件被本机 DSH profile 正确装配**（一次性 `DSH_HOME` 装配验证；原 `install-check.sh` 已于 2026-11-05 删除，能力移交 `dsh-auto-upgrade` #300） |
| 额外脚本 | — | 见 [§二「脚本清单」](#脚本清单)：完整文件清单**以 `ls scripts/pipeline/` 为准**，本表不重复列举、也不写死数量 |
| 仓库 | `guraul/agent-mobile` | `guraul/self-dsh-plugins` |
| 文档语言 | 中英混排 | **一律中文** |
| `merge-pr.sh` | 从主工作区运行会**跳过** worktree 清理与 main 快进（其 AGENTS.md 规定 15 ④ / issue #102） | **已修掉**：从主工作区运行也会反查并移除该分支的 worktree，然后快进 main |
| 包管理器 | `pnpm` | 同为 `pnpm`（全局约定一致，禁用 npm / npx —— 这一条是**统一**，不是差异） |

## 六、环境要求

| 项 | 值 |
|---|---|
| node | `24.21.0`（`nvm use`；`.nvmrc` 未设时以本机为准） |
| pnpm | `12.x` 可用（`pnpm --version`；CI 由 `pnpm/action-setup@v4` 装） |
| gh | 已登录，`gh auth status` 通过（`gh pr` / `gh issue` / `gh pr checks` 都用到） |
| dsh | `dsh --version` 能取到版本号（原 `install-check.sh` 用它拉同版本一次性安装，该脚本已于 2026-11-05 删除） |
| shell | macOS 自带 bash 3.2（脚本已按 3.2 写） |
| 网络 | `git fetch origin main` / `gh` / `pnpm dlx` 可用 |

**包管理约定**：本机 / 本仓库统一用 **pnpm**，禁用 npm / yarn / bun / npx（临时执行用 `pnpm exec` / `pnpm dlx` 代替）——这是全局约定（`~/.config/opencode/AGENTS.md`），脚本、CI、文档一律照此写。

## 六点五、相关文档

| 文档 | 用途 |
|---|---|
| [`review-loop.md`](./review-loop.md) | 把 executor 从旧插件切到 `dsh-subagents` 的步骤、验证与回滚；一期缺口清单 |
| [`PROGRESS.md`](./PROGRESS.md) | 进度台账与已定决策（D1–D11，含取代关系） |

## 七、阶段状态

当前进度与阶段划分见 [PROGRESS.md](PROGRESS.md)。

现状：**流程已实跑，不再是脚手架**——issue → worktree → PR → 审核循环 → 闸门 → squash 合并已在本仓的真实任务上跑通：
审核循环有多次 `REJECT → 修复 → 重审` 的实际记录、也有 `--no-review` 的跳过留痕（`.dsh-web/reviews/`、`.dsh-web/reviews/skips/`，本机留痕，不入库）；
闸门已抽成共享包 `@guraul/dsh-pipeline`，本仓 `scripts/pipeline/` 里只剩它生成的 6 个入口；审核记录的写入也已统一到包侧 `record`（D10），
不再由各插件 / 各脚本各写一套。

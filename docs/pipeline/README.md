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

### new-task.sh

**生成的入口**（禁止手改）：转发包侧 `task` 子命令，slug 计算、分支/worktree 创建、git 身份写的唯一实现都在共享包 `@guraul/dsh-pipeline` 里。

```bash
scripts/pipeline/new-task.sh 12
```
| 项 | 说明 |
|---|---|
| 参数 | `<issue号>`（正整数，必填；原样转发给包） |
| 效果（包侧） | `task/<号>-<slug>` + `.worktrees/<号>-<slug>`，基于 `origin/main`；新 worktree 内写入当前 git 身份（worktree 局部配置，不动全局） |
| 幂等 | worktree 已存在 → 直接打印路径退出（**不 fetch、不改动现场**）；路径被占但不是本仓库 worktree → 报错停下 |
| 退出码 | 原样透传包侧退出码：0 成功；2 用法或环境错误（参数非法 / issue 不可访问 / fetch 连续失败） |

`<slug>` 由包侧从 issue 标题计算：小写化并只保留 `[a-z0-9-]`（截断 40）；中文标题会被清空，
兜底为标题 sha1 的前 8 位（确定性——同一 issue 重跑得到同一分支名）。

### open-pr.sh

**生成的入口**（禁止手改）：转发包侧 `pr` 子命令，分支校验、推送、PR body 与幂等判断的唯一实现都在共享包里。

```bash
cd .worktrees/12-xxx && scripts/pipeline/open-pr.sh
```
| 项 | 说明 |
|---|---|
| 参数 | 无（包侧从当前分支名反解 issue 号） |
| 前置（包侧） | 分支名必须是 `task/<号>-<slug>`；工作区必须干净（有未提交改动直接拒绝） |
| 幂等 | 分支已推送则重推；**PR 已存在则只打印链接，不新建** |
| 退出码 | 原样透传包侧退出码：0 成功 / PR 已存在；2 用法或环境错误（分支名不合规、脏工作区、issue 不可访问） |

### merge-pr.sh

**生成的入口**（禁止手改）：转发包侧 `merge` 子命令，闸门 → CI → squash 合并 → 清理现场 → 快进 main 的
唯一实现都在共享包 `@guraul/dsh-pipeline` 里。**参数不再做本地改名与分支名解析**——入口只把 `-C <目录>`
翻成 `--root <目录>`，其余原样透传；写法以 [`guraul/dsh-pipeline` 的 `docs/CONTRACT.md`](https://github.com/guraul/dsh-pipeline/blob/main/docs/CONTRACT.md) 为准。

```bash
cd <worktree> && scripts/pipeline/merge-pr.sh --record <记录>            # 按当前分支定位 PR
scripts/pipeline/merge-pr.sh --pr <PR号> --record <记录>                 # 任意位置（含主工作区）指定 PR
scripts/pipeline/merge-pr.sh --pr <PR号> --record <记录> --check-only    # 演练：跑到闸门 / CI 为止，不合并、不清理
scripts/pipeline/merge-pr.sh --pr <PR号> --record <记录> --force         # CI 未过时仍合并（慎用）
```

> ⚠️ **入口换成生成物之后（issue #333）参数变了**：手写壳做的那层翻译已随手写脚本一起删掉——
> `--review-record=<f>` 要写成 `--record <f>`；位置参数 `<PR号|分支名>` 要写成 `--pr <PR号>`
> （包侧不收位置参数，也不认分支名）。写错会当场报「未知选项 / 无法识别的参数」，不会静默合并。

**包位置解析**（生成的入口自带，6 个入口共用同一份逻辑）：

1. `$DSH_PIPELINE_HOME`（显式覆盖：**设置了就不再回退**，指错也直接报错，避免静默用到别的包）；
2. `<主工作区>/tools/node_modules/dsh-pipeline`——主工作区取 `git rev-parse --git-common-dir` 的父目录，
   因此**在 worktree 里运行也能找到装在主工作区的包**（issue #235）；
3. `<脚本所在仓>/tools/node_modules/dsh-pipeline`（非 worktree 的常规场景）。

包是由 `tools/package.json` 从 `dist/latest.tgz` 安装的**打包产物**，不是源码 checkout；取
`<包根>/bin/cli.mjs`。都落空时入口把试过的路径逐条打到 stderr 并退出 3（提示在主工作区 `tools/` 里跑
`pnpm install`，或设置 `DSH_PIPELINE_HOME`）。

**与迁移前（手写转发壳）的语义差异**——都来自共享包，不是本仓的取舍：

1. **参数不再改名、不再收位置参数**：`--review-record=<f>` → `--record <f>`、`<PR号|分支名>` → `--pr <PR号>`（见上）。
2. **`--no-review` 必须带 `--reason`**：单独 `--no-review` 会被包拒绝（跳过必须留原因）。
   `--reason` 也不能脱离 `--no-review` 单独出现；`--record` 与 `--no-review` 互斥。
3. **`--checks-file` 读的是 JSON，不是 `gh pr checks` 原文**：文件内容需形如
   `{"state":"success"}` / `{"state":"failure"}`（也接受带 `state` 的 check 列表）。
   `success` 放行且**完全不调 `gh`**；`failure` 按 CI 未过拒绝；不可读 / 非合法 JSON 一律算
   「CI 无法判定」并拒绝（**不静默放行**）。
4. **`DSH_REVIEWER=off` 已不再生效**：环境变量不再被读取，跳过审核只认显式
   `--no-review --reason=<文本>`。

| 项 | 说明 |
|---|---|
| 行为（包侧） | 定位 PR → CI checks 未过则拒绝 → 审核闸门未过则拒绝 → `gh pr merge --squash` → 删远端分支 → 删本地分支（`-D`）→ 移除对应 worktree → `worktree prune` → 主工作区快进（`ff_main()`：`git fetch --prune origin main` + `git merge --ff-only origin/main`，**显式命名 merge head** 以绕开 `FETCH_HEAD` 竞态，仍绝不做非快进合并；失败时**先确认无分叉才自动重试一次**，真分叉则拒绝并提示不要用 `--force`） |
| 幂等 | PR 已是 `MERGED` → 跳过合并，只清理现场并快进 main |
| 退出码 | **0 / 1 / 2 / 3**，「业务拒绝 vs 用法·环境错误」两分加环境错误：**0** 成功（`--check-only` 通过也是 0）；**1** 业务拒绝——审核闸门未过（含判定非 `APPROVE`、记录与 PR/提交不符、超出时效）/ CI 未过（含 `--checks-file` 判定失败）；**2** 用法或环境错误——参数非法（含未知选项、未知参数、`--no-review` 缺 `--reason`、`--record` 与 `--no-review` 同用）/ 找不到 PR / PR 状态不符 / git·gh 操作失败；**3** 入口找不到共享包。入口只透传，不改写退出码 |

审核闸门排在 `--check-only` **之前**——演练模式恰恰最该验证闸门拦不拦得住。闸门由共享包调用
`node dsh-subagents/lib/cli.js check`，判定、SHA 绑定、时效、高风险路径都由它负责，包只负责
「拿不到记录就拒绝」与「显式跳过要留痕」。

> **历史说明**：`scripts/pipeline/merge-pr.legacy.sh` 转发前是端口内的本地实现，已于 2026-11-04 退役。
> 当时它与共享包语义**不一致**（允许裸 `--no-review`、`--checks-file` 读 `gh pr checks` 原文、`DSH_REVIEWER=off` 仍生效）。
> 需要回滚请从 git 历史取：`git show <该文件被删除前的提交>:scripts/pipeline/merge-pr.legacy.sh`。

### 刷新共享包（`tools/`）

`tools/package.json` 依赖的是本机 `dsh-pipeline` 仓打包出的 `dist/latest.tgz`（`file:` 依赖）。
该产物**不入库、每次重新打包内容都会变**，锁里的 integrity 因此永远对不上；锁文件也跟着**不入库**
（`.gitignore` 已忽略 `/tools/pnpm-lock.yaml`）。锁钉不住一个刻意不钉版本的本地构建物，硬留只会
让 `pnpm` 复用旧缓存、装出旧包（issue #231 实测）。

唯一可靠的做法是**把依赖目录和锁文件一起删掉重装**：

```bash
cd tools
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

**不要用 `pnpm update`**：它可能复用本机的旧 tarball 缓存，命令成功但装出来的还是旧版包。

**装完直接看构建标识**（2026-11-03 起）。下面两条命令都在**仓根**执行（先 `cd ..`）：

```bash
node tools/node_modules/dsh-pipeline/bin/cli.mjs --version
# 0.1.0 (cc13260 2026-11-04T12:18:01Z)
```

版本号常年不变，**看括号里的构建标识才是准的**；直接跑源码时显示 `(源码运行)`。
想知道多个仓是不是同一次打包：

```bash
node tools/node_modules/dsh-pipeline/bin/cli.mjs doctor \
  --repo ~/workspace/self-dsh-plugins,~/workspace/agent-mobile,~/workspace/homebase
```

某仓装的是**没有构建标识的旧包**也会被判为漂移（它必然不是同一构建）→ 退出 1 并点名。

> 旧办法（拿 `record --root` 试参数、按报错判断新旧）已不需要，仅在包版本早于 2026-11-03 时才用。

重新生成的 `pnpm-lock.yaml` 只留在本机，**不要提交**。

### status.sh

```bash
scripts/pipeline/status.sh          # 等价于 dsh-pipeline status
```
**纯只读**，无参数。输出**审核记录概况**：共几条、最近一条（PR / 轮次 / 结论 / 提交前 8 位）、无法解析的条数。缺省定位**主工作区**（审核记录只落在主工作区），在 task worktree 里跑也看同一份。

> 迁移前手写版的四段总览（分支 / worktree / 插件 / profile / `gh pr list`）已随手写脚本删除：
> 分支与 worktree 用 `git status` / `git worktree list`，插件与 profile 体检用下面的 `doctor --profile`。

### selftest（一致性自检）

「各仓是不是同一个构建」这条检查已收进包（`build-check.sh` 与它的单测已删），不再依赖本机的 `.dsh/build-check.json`：

```bash
scripts/pipeline/pipeline.sh selftest --config --root .                # 配置能过 schema、没有未声明字段
scripts/pipeline/pipeline.sh selftest --shims --root .                 # 6 个入口 == 按当前包版本渲染的模板
scripts/pipeline/pipeline.sh selftest --fast --root .                  # 上面两条（pre-push 的用法）
scripts/pipeline/pipeline.sh selftest --repos <仓A>,<仓B>,<仓C>,<仓D>  # 多仓共享包是不是同一构建
```

- `--repos` 读各仓 `tools/node_modules/dsh-pipeline/build.json` 的 `gitSha` / `builtAt`；目录不存在或没装包的仓**跳过并列出**，可比对的仓不足 2 个也跳过（退出 0）。
- `.dsh/build-check.json`（**不入库**，本机兄弟仓路径）与示例 `.dsh/build-check.example.json` 还在 `.dsh/`，但**已没有任何脚本读它**；要临时比对直接用 `doctor --repo <a,b>`。
- 构建漂移不会自己叫（2026-11-04 实测：`tools/` 装着旧包时 `review prompt` 直接报「未知动作」），想知道多个仓是不是同一次打包：

```bash
node tools/node_modules/dsh-pipeline/bin/cli.mjs doctor \
  --repo ~/workspace/self-dsh-plugins,~/workspace/agent-mobile,~/workspace/homebase
```

某仓装的是**没有构建标识的旧包**也会被判为漂移（它必然不是同一构建）→ 退出 1 并点名。

### check-all（逐包门禁）

```bash
scripts/pipeline/pipeline.sh check-all                                     # 全部插件（按 .dsh/pipeline.json 的 checks.packages，顺序一致）
scripts/pipeline/pipeline.sh check-all --packages dsh-external-discuss,dsh-awake   # 只跑指定包（逗号分隔）
```
| 项 | 说明 |
|---|---|
| 跑什么 | 有 `scripts.test` → `pnpm test`；有 `scripts.check` → `pnpm run check`；有 `scripts.typecheck` → `pnpm run typecheck` |
| 跑哪些 | `--packages` > 配置 `checks.packages`（**按给定顺序，不自动发现**）> 自动发现 `<root>` 下含 `package.json` 的子目录再按 `checks.exclude` 过滤（本仓 `exclude: ["tools"]`：`tools/` 有 `package.json` 但没有检查脚本，自动发现会把它判「失败（无可跑检查）」） |
| 缺依赖 | `node_modules` 缺失 → 打印「跳过（未安装依赖）」，**不算失败** |
| 输出 | 各包完整输出直接打到 stdout（适合人看）；末行汇总 `check-all: N 个包，X 通过 / Y 失败 / Z 跳过` |
| 退出码 | 0 = 全部通过（含跳过项）；1 = 有失败；2 = 用法错误；3 = 找不到 pnpm |
| 构建一致性 | **不再**由它末尾调用（`build-check.sh` 已删）；要跑用上面的 `selftest --repos` |

### gate（跨仓共用审核闸门）

```bash
node ~/workspace/self-dsh-plugins/dsh-subagents/lib/cli.js gate \
  --pr <号> --root <仓库根> --head-sha <sha> --record <.dsh-web/reviews/…json>

# 跳过（留痕由 gate 自己写，不靠调用方的脚本）
node ~/workspace/self-dsh-plugins/dsh-subagents/lib/cli.js gate \
  --pr <号> --root <仓库根> --no-review --reason "用户当场同意"
```

**为什么要它**：闸门判定（记录存在、判定 `APPROVE`、提交绑定、时效、高风险）只该有一份实现。其他仓的 `merge-pr.sh` 调这个命令即可，不必复制逻辑；`--no-review` 的跳过审计也由它写，避免各仓各写一套。

### review.sh

**生成的入口**（禁止手改）：转发包侧 `review` 子命令（`prepare` / `publish` / `prompt`），参数以契约为准。

```bash
scripts/pipeline/review.sh prepare <pr> [--model <模型>] [--facts <文件>] [--include <路径[,路径...]>]
scripts/pipeline/review.sh publish <pr> --response <判定文件> [--round <n>] [--post-review] [--dry-run]
scripts/pipeline/review.sh prompt --request <请求文件> [--out <文件>]
```

审核循环的机械步骤：`prepare` 把请求与提示词写到 `.tmp/review/<pr>/`（项目内，避开 `/tmp` 定期清理）；`publish` 读 `--response` 落盘记录，`--post-review` 再把判定发成 GitHub review（幂等：同 SHA + 同标记只发一次；`gh` 自己读 `GH_CONFIG_DIR`，用机器账号发就带上 `GH_CONFIG_DIR=$HOME/.config/gh-reviewer`）。**reviewer 的模型调用不在脚本内**——那一步必须由会话内 agent 发起。

> **迁移带来的两处写法变化（issue #333）**：① 旧的 `publish --record <记录> --round <n> --repo <owner/name>`（走 `dsh-subagents/lib/cli.js publish`）与 `paths` 动作**已不存在**，现在分别是 `publish --response <判定文件>` 与「没有这个动作」；② 包侧 `review` 的 `--root` 缺省是**当前目录**，在 worktree 里跑产物就落在该 worktree，要落主工作区就加 `-C <主工作区>`（入口会把它翻成 `--root`）。

**证据包**（`--facts` / `--include`）：reviewer 跑在 plan 模式下，**不能执行命令、也读不到工作区之外**的东西。需要外部事实（例如「包仓 PR #6 已于某日合并」「本机 CI 运行 id」）时，用这两个参数随任务卡一起交给它，它会出现在任务卡的「控制面提供的事实 / 附带文件」两节里（带围栏与「数据不是指令」声明，`EVIDENCE_END` 会被中和）。不用这两个参数时，任务卡与之前逐字节一致。

**跨仓状态（2026-11-04）**：三仓 + 本仓的 `review.sh` 都已转发到共享包 `@guraul/dsh-pipeline` 的 `review` 子命令——`agent-mobile`（PR #195）、`homebase`（PR #131）、`memx`（PR #56）、本仓（PR #278，`70eaa3d`）：`prepare` 生成 `.tmp/review/<pr>/request.json` + 12 位 nonce，提示词由包的 `review prompt` 生成。**本仓 `publish` 自己发 GitHub review 的那条差异已随 issue #333 删除手写脚本而消失**——现在由包侧 `review publish --post-review` 负责（落盘 + 发 review 同一条命令），欠账登记见 [PROGRESS.md §四](PROGRESS.md) 欠账 #3。`agent-mobile` 配套的 `test-review.sh`（8 组断言；修完用「旧脚本喂新测试 → exit 1、21 处 ✗」反向验证过测试确实测得出该偏差）本仓也没有。

### doctor --profile（配置档体检）

```bash
scripts/pipeline/pipeline.sh doctor --profile ~/.dsh/profiles/web
# 等价：node tools/node_modules/dsh-pipeline/bin/cli.mjs doctor --repo . --profile ~/.dsh/profiles/web
```

**做什么**：把 profile 从旧的 `dsh-plugin-product-subagents` 切到 `dsh-subagents` 之后的**只读体检**——原 `review-loop-check.sh` 的四组检查已收进包，另多出三项（2026-11-06 实测 **7 项全 ✓**；首行先打印各仓共享包的构建标识）：

| # | 检查 | 判据 |
|---|---|---|
| 1 | 旧插件已摘 | `~/.dsh/profiles/web/package.json` 里**已无** `dsh-plugin-product-subagents` |
| 2 | 新插件已挂 | 同一份 `package.json` 里**已有** `dsh-plugin-subagents` |
| 3 | 软链是否悬空 | `node_modules/dsh-plugin-subagents` 解析后目录存在；悬空时提示回 profile 目录跑 `pnpm install` |
| 4 | 装配可见性 | `dsh --profile web --dump-config` 的输出里能 grep 到 `dsh-plugin-subagents`（dsh 不可用时跳过，不算失败） |
| 5 | 补丁文件 | `cordis.patch.yml` 存在且非空（新增） |
| 6 | 审核记录目录 | `.dsh-web/reviews` 可写（这是它唯一的写动作：必要时 `mkdir -p`） |
| 7 | 目录报告 | profile 目录与 `DSH_HOME` 路径（新增，只报告不判定） |

**什么时候跑**：切换 / 升级审核链路之后（步骤见 [`review-loop.md`](./review-loop.md)），以及怀疑「插件莫名其妙没加载」时先跑一遍——它把「声明没进 profile」「软链悬空」「bundle 没装配」这三种静默失败直接分行打出来。**它不启动会话、不调模型、不改配置**；链路是否真通仍需人工在新会话里调一次 `product_delegate`。

**退出码**：**0** = 全过（含 dsh 不可用的跳过项）；**1** = 至少一项 `✗`。

### hooks install（pre-push 直推拦截钩子）

本地兜底的 **git pre-push 钩子**：拦「直推 / 删除 `main`」，让「所有改动走 pipeline」不只靠自律。它只是本地护栏——`--no-verify` 能绕过，真正的闸门仍是 `merge-pr.sh` 的审核记录。钩子本体由包生成（原 `pre-push-main-guard.sh` 与 `install-hooks.sh` 已于 2026-11-06 删除）。

```bash
scripts/pipeline/pipeline.sh hooks install --root <仓库根>   # 幂等，可重复执行
scripts/pipeline/pipeline.sh hooks check   --root <仓库根>   # 校验已装钩子与本包一致
```

- **装在哪**：`$(git rev-parse --git-common-dir)/hooks/pre-push`。worktree 里 `.git` 是文件，按 common dir 推算，所以**装一次所有 worktree 共用**，新开的 worktree 无需重装。
- **拦什么**：stdin 任一行 remote ref 为 `refs/heads/main` 或 `refs/heads/master` → 打印拒绝原因并 `exit 1`。**推和删都拦**（`git push origin main` 与 `git push origin :main` 同样被拒）；与旧版不同，**不限定 `origin` 远端**。
- **放行什么**：任务分支（如 `refs/heads/task/333-*`）、删除其它远端分支。
- **覆盖已有钩子**：已存在且内容不同时——没有 `GENERATED by dsh-pipeline hooks install` 标记行的**默认拒绝覆盖**（退出 1），确认后加 `--force`；带标记行的旧版本直接覆盖（幂等）。本仓 2026-11-06 就是用 `--force` 把手写钩子换掉的。
- **例外**：确实要临时直推时用 `git push --no-verify`（一次性、不留痕，事后请确认该操作是否该补 PR / 补审核记录）；要长期放行则 `hooks install --allow-main` 装一个不拦截的版本。
- **卸载**：`rm "$(git rev-parse --git-common-dir)/hooks/pre-push"`。
- **兼容**：bash 3.2（macOS 自带）。

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

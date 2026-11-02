# Pipeline 工作手册（self-dsh-plugins）

> 本仓库的交付流程说明。机制**照抄并适配 [agent-mobile](https://github.com/guraul/agent-mobile) 的 pipeline**：
> 全部能力是幂等 bash 脚本（`scripts/pipeline/`），不依赖任何特定 agent 的插件。
> 进度台账见 [PROGRESS.md](PROGRESS.md)。

**一句话定位**：本仓库的"交付物"不是线上服务，而是**插件被本机 DSH profile 正确装配**——所以这里没有服务器、没有部署，只有 worktree 纪律 + 测试门禁 + 一次性 `DSH_HOME` 装配验证。

## 一、流程总览

```
1. 开任务       在 GitHub 开 issue（每任务一个）
2. 建工作区     scripts/pipeline/new-task.sh <issue号>
                → 分支 task/<issue号>-<slug> + worktree .worktrees/<issue号>-<slug>（基于 origin/main）
3. 开发         cd 到 worktree 内开发；提交信息建议带 #<issue号>
4. 本地自测     scripts/pipeline/check-all.sh <插件目录>     # 测试 / check / typecheck
                scripts/pipeline/install-check.sh <插件目录> # 一次性 DSH_HOME 里验证装配
                scripts/pipeline/compat-matrix.sh <dsh版本>  # 对任意 dsh 版本跑全插件装配验收（兼容矩阵）
5. 开 PR        （在 worktree 内）scripts/pipeline/open-pr.sh
                → 自动推送 + 开 PR，body 首行 Closes #<issue号>
6. CI           GitHub Actions（.github/workflows/ci.yml）：只跑测试 + node --check 语法检查
6.5 审核        控制面委派 reviewer（会话内子代理）→ 读 issue/PR/diff
                → 写 PR comment（第 N 次/共 3 次）+ 提交 review 状态
                → 写审核记录 .dsh-web/reviews/<pr>-<sha>.json
                → 有问题则委派 executor 修复后重审（上限 3 轮）
7. 合并         scripts/pipeline/merge-pr.sh --review-record=<记录>   # 闸门 → squash merge → 清理 → 快进 main
8. 收尾         合并后**没有部署**；只有 CI 测试通过这一件事
```

**两道闸门，一个纪律**：

- **CI**（第 6 步）：测试与语法检查，不过就停；
- **审核闸门**（由共享包 `@guraul/dsh-pipeline` 实现，`merge-pr.sh` 只转发）：合并前必须有审核记录，校验判定、提交绑定、时效与高风险路径。**默认 fail-closed**——没记录就拒绝合并。要绕过必须显式声明 `--no-review --reason=<文本>`（包要求跳过必须写原因），此时打印警告并写一条跳过审计（`.dsh-web/reviews/skips/`），事后可查。**`DSH_REVIEWER=off` 已不再生效**。

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

规则：pipeline 只服务本仓库自己的插件（清单以 `lib.sh` 的 `PLUGIN_DIRS` 为准）；插件是 `link:` 到本机 DSH profile 的，不走发布流程。

## 二、脚本用法

环境：任何脚本都必须在**本仓库或其 worktree 内**运行（`lib.sh` 用 `git rev-parse --show-toplevel` 定位根）。

### lib.sh

```bash
# 不直接执行；被其他脚本 source
source scripts/pipeline/lib.sh
```
公共常量（`REPO_ROOT` / `GH_REPO` / `FETCH_RETRY` / `PLUGIN_DIRS`）、日志函数（`die` / `info` / `ok` / `mark`）、工具函数（`slugify` / `is_issue_number` / `pkg_script` / `pkg_name` / `worktree_for_branch` / `main_worktree` / `require_gh` / `resolve_pipeline_cli` / `require_pipeline_pkg`）。

`PLUGIN_DIRS` 是**插件目录名白名单**，`status.sh` / `check-all.sh` / `install-check.sh` 全部只从这里取插件。包名不另存副本——需要时用 `pkg_name()` 从各插件 `package.json` 现读。

### 新增插件检查清单

按顺序全部做完，缺一项就会出现「脚本看不见这个插件」「CI 不跑它」「profile 装不上」之类的静默失败：

| # | 动作 | 不做会怎样 |
|---|---|---|
| 1 | 把目录名加进 `lib.sh` 的 `PLUGIN_DIRS` | `install-check.sh` / `check-all.sh` 显式传参报「未知插件目录」；不传参的「跑全部」静默漏掉它；`status.sh` 插件段看不到它 |
| 2 | 在 CI 矩阵（`.github/workflows/ci.yml`）里加该插件条目 | 该插件的 `node --test` / `node scripts/lint.js` 永远不跑 |
| 3 | 根 `README.md` 与 `AGENTS.md` 的插件索引表各加一行 | 新人 / agent 不知道它存在 |
| 4 | 写 `docs/plugins/<插件>.md`（并在 `docs/plugins/README.md` 索引里挂上） | 改之前没有「改哪里、注意什么、怎么验证」可查 |
| 5 | 在 profile（`~/.dsh/profiles/web/package.json`）加 `link:` 依赖，并把包名加进 `dsh.profile.bundles` | 插件不装配；改过已有 `link:` 路径还要在 profile 目录跑一次 `pnpm install`，否则软链悬空 |

### new-task.sh

**本仓的 `scripts/pipeline/new-task.sh` 是一条薄转发壳**（issue #235 起）：slug 计算、分支/worktree
创建、git 身份写入的**唯一实现**在共享包 `@guraul/dsh-pipeline` 的 `task` 子命令里，本壳只负责
定位包并把 `<issue号>` 原样转发。

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

**本仓的 `scripts/pipeline/open-pr.sh` 是一条薄转发壳**（issue #235 起）：分支校验、推送、PR body
与幂等判断的**唯一实现**在共享包 `@guraul/dsh-pipeline` 的 `pr` 子命令里，本壳只负责定位包并转发。

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

**本仓的 `scripts/pipeline/merge-pr.sh` 是一条薄转发壳**（issue #187 起）：闸门 → CI → squash 合并 →
清理现场 → 快进 main 的**唯一实现**在共享包 `@guraul/dsh-pipeline` 里，本仓只保留「文件名与参数都不变」
的转发表面，免得两份实现各自漂移。

```bash
cd <worktree> && scripts/pipeline/merge-pr.sh    # 自动识别当前分支的 PR
scripts/pipeline/merge-pr.sh <PR号|分支名>        # 任意位置（含主工作区）指定 PR
scripts/pipeline/merge-pr.sh <PR号> --check-only  # 演练：跑到闸门 / CI 为止，不合并、不清理
scripts/pipeline/merge-pr.sh <PR号> --force       # CI 未过时仍合并（慎用）
```

**包位置解析**（`lib.sh` 的 `resolve_pipeline_cli`，`new-task.sh` / `open-pr.sh` / `merge-pr.sh` 共用一份）：

1. `$DSH_PIPELINE_HOME`（显式覆盖：**设置了就不再回退**，指错也直接报错，避免静默用到别的包）；
2. `<主工作区>/tools/node_modules/dsh-pipeline`——主工作区取 `git rev-parse --git-common-dir` 的父目录，
   因此**在 worktree 里运行也能找到装在主工作区的包**（issue #235）；
3. `<当前目录所在仓>/tools/node_modules/dsh-pipeline`（非 worktree 的常规场景）。

包是由 `tools/package.json` 从 `dist/latest.tgz` 安装的**打包产物**，不是源码 checkout；取
`<包根>/bin/cli.mjs`。都落空时报错退出 2，并逐条列出试过的路径（提示在主工作区 `tools/` 里跑
`pnpm install`，或设置 `DSH_PIPELINE_HOME`）。

**参数转发**（壳只做映射，不做任何判定）：

| 本仓参数 | 传给包侧 | 说明 |
|---|---|---|
| `--review-record=<f>` | `--record <f>` | **只有这一项改名**；审核记录路径，不传即拒绝合并（fail-closed） |
| `--no-review` | `--no-review` | 原样透传，但**必须同时给 `--reason`**（见下） |
| `--reason=<文本>` | `--reason <文本>` | 原样透传；跳过审核的原因，只能与 `--no-review` 同用 |
| `--checks-file=<f>` | `--checks-file <f>` | 原样透传；语义已变（见下） |
| `--check-only` | `--check-only` | 原样透传；`--dry-run` 是本仓保留的旧别名，映射成 `--check-only` |
| `--force` | `--force` | 原样透传 |
| `<PR号或分支名>` | `--pr <PR号>` | 壳先把分支名 / 当前分支解析成 PR 号（包只接受正整数） |

壳还会自动补上 `--root <仓库根>`。除上表外不接受任何参数（未知参数直接报错）。

**与旧脚本（`merge-pr.sh` 转发前）的三处语义差异**——都来自共享包，不是本壳的取舍：

1. **`--no-review` 必须带 `--reason`**：单独 `--no-review` 会被包拒绝（跳过必须留原因）。
   `--reason` 也不能脱离 `--no-review` 单独出现；`--record` 与 `--no-review` 互斥。
2. **`--checks-file` 读的是 JSON，不是 `gh pr checks` 原文**：文件内容需形如
   `{"state":"success"}` / `{"state":"failure"}`（也接受带 `state` 的 check 列表）。
   `success` 放行且**完全不调 `gh`**；`failure` 按 CI 未过拒绝；不可读 / 非合法 JSON 一律算
   「CI 无法判定」并拒绝（**不静默放行**）。
3. **`DSH_REVIEWER=off` 已不再生效**：环境变量不再被读取，跳过审核只认显式
   `--no-review --reason=<文本>`。

| 项 | 说明 |
|---|---|
| 行为（包侧） | 定位 PR → CI checks 未过则拒绝 → 审核闸门未过则拒绝 → `gh pr merge --squash` → 删远端分支 → 删本地分支（`-D`）→ 移除对应 worktree → `worktree prune` → 主工作区快进（`ff_main()`：`git fetch --prune origin main` + `git merge --ff-only origin/main`，**显式命名 merge head** 以绕开 `FETCH_HEAD` 竞态，仍绝不做非快进合并；失败时**先确认无分叉才自动重试一次**，真分叉则拒绝并提示不要用 `--force`） |
| 幂等 | PR 已是 `MERGED` → 跳过合并，只清理现场并快进 main |
| 退出码 | **0 / 1 / 2**，与另两个转发壳同为「业务拒绝 vs 用法·环境错误」两分：**0** 成功（`--check-only` 通过也是 0）；**1** 业务拒绝——审核闸门未过（含判定非 `APPROVE`、记录与 PR/提交不符、超出时效）/ CI 未过（含 `--checks-file` 判定失败）；**2** 用法或环境错误——参数非法（含未知参数、`--no-review` 缺 `--reason`、`--record` 与 `--no-review` 同用）/ 找不到 PR / 找不到共享包 / PR 状态不符 / git·gh 操作失败。壳自身的 `die` 一律 exit 2（含找不到共享包、未知参数） |

审核闸门排在 `--check-only` **之前**——演练模式恰恰最该验证闸门拦不拦得住。闸门由共享包调用
`node dsh-subagents/lib/cli.js check`，判定、SHA 绑定、时效、高风险路径都由它负责，包只负责
「拿不到记录就拒绝」与「显式跳过要留痕」。

> **`scripts/pipeline/merge-pr.legacy.sh` 仅作回滚用。** 它是转发前的旧实现，语义与共享包**不一致**
> （允许裸 `--no-review`、`--checks-file` 读 `gh pr checks` 原文、`DSH_REVIEWER=off` 仍生效），
> 平时不要用它；只有共享包出问题时才临时回滚到它。

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
装完验证版本（两个报错互斥，按第一句报错判断）：

```bash
node node_modules/dsh-pipeline/bin/cli.mjs record --request /dev/null --response /dev/null --root /tmp
```

| 报错 | 含义 |
|---|---|
| 「请求文件不是合法 JSON」 | **新版**：已认识 `--root`，只是 `/dev/null` 不是合法 JSON |
| 「未知选项: --root」 | **旧版**：该版本还没有 `--root`，回到上面的清理重装 |

重新生成的 `pnpm-lock.yaml` 只留在本机，**不要提交**。

### status.sh

```bash
scripts/pipeline/status.sh
```
**纯只读**，无参数。四段输出：(a) 本仓库分支/HEAD/工作区/全部 worktree；(b) 各插件（以 `lib.sh` 的 `PLUGIN_DIRS` 为准）的 `test`/`check`/`typecheck` 脚本是否存在 + `node_modules` 是否已安装；(c) `dsh plugin --profile web version-exemptions`；(d) profile `link:` 依赖悬空检测 + `gh pr list` / `gh issue list`。任何一段失败都不中断整体输出。

### check-all.sh

```bash
scripts/pipeline/check-all.sh                        # 全部插件（以 lib.sh 的 PLUGIN_DIRS 为准）
scripts/pipeline/check-all.sh dsh-external-discuss   # 只跑指定插件（可多个）
```
| 项 | 说明 |
|---|---|
| 跑什么 | 有 `scripts.test` → `pnpm test`；有 `scripts.check` → `pnpm run check`；有 `scripts.typecheck` → `pnpm run typecheck` |
| 缺依赖 | `node_modules` 缺失 → 明确打印"未安装依赖，已跳过"，**不算失败** |
| 输出 | 各插件完整输出直接打到 stdout（适合人看）；末尾给汇总表 |
| 退出码 | 0 = 全部通过（含跳过项）；1 = 有检查失败，或某插件三项都没定义 |

### install-check.sh

```bash
scripts/pipeline/install-check.sh                    # 全部插件（以 lib.sh 的 PLUGIN_DIRS 为准）
scripts/pipeline/install-check.sh dsh-external-discuss
```
| 项 | 说明 |
|---|---|
| 机制 | 每个插件新建一个 `H=$(mktemp -d)`，`DSH_HOME=$H pnpm dlx @deepseek-ai/dsh@<当前版本> plugin --profile headless add <插件绝对路径>`，再 `--dump-config` 并 grep 该插件 `package.json` 里的 `name`——grep 到即"装配成功" |
| ⚠️ 安全 | **绝不触碰真实 `~/.dsh`**；全程只写临时目录，`trap ... EXIT` 兜底清理（异常退出也清理） |
| 退出码 | 0 = 全部插件装配成功；1 = 任一插件 add 失败或 dump-config 里没有该包名 |

### compat-matrix.sh

「我要升到 `0.2.2-alpha.2`，现在这几个插件还兼容吗？」——一条命令回答，并顺手给出该写回
`dsh.compatibility.dshReleases` 的建议值（issue #108）。

```bash
scripts/pipeline/compat-matrix.sh 0.2.2-alpha.2                              # 全部插件
scripts/pipeline/compat-matrix.sh 0.2.1-rc.5 dsh-im-bridge-workspaces       # 只验指定插件
scripts/pipeline/compat-matrix.sh 0.2.2-alpha.2 --json                      # 机器可读（给将来 CI 定期跑留口）
```
| 项 | 说明 |
|---|---|
| 机制 | 同 `install-check.sh`：每个插件一个临时 `DSH_HOME` + `pnpm dlx @deepseek-ai/dsh@<目标版本> plugin add` + `--dump-config` grep 包名 |
| 与 install-check 的区别 | install-check 只验**当前已装**版本、只给 pass/fail；本脚本验**任意目标版本**，并把结果与插件 `package.json` 的 `dsh.compatibility.dshReleases[<目标版本>]` **并排**输出 |
| 只验 L1 | 判据只有「能否装配」。`pass` **不代表业务链路可用**，输出末尾会再提醒一次 |
| 漂移三分类 | ① 无记录 → `未验证→<建议值>`；② 矩阵 `incompatible` 但 L1 通过 → **「记录更严」**（文案带上矩阵记录的深度，例：「矩阵 L3 记不兼容，本脚本只到 L1」；`dsh-im-bridge` 的 `TS2554` 就是这种，**不是错误**）；③ 矩阵 `compatible` 但 L1 失败 → **⚠️ 真冲突**，退出码 1 |
| 记录深度 | 读插件的 `dsh.compatibility.dshDepth[<目标版本>]`（L1/L2/L3/L4，定义见 [COMPATIBILITY.md](../COMPATIBILITY.md)），表格里单列「记录深度」；没有就写「未记录」，**不虚报** |
| ⚠️ 只读 | **绝不**自动改写任何插件的 `dshReleases`。写回矩阵是人的决定（要 review），见 [COMPATIBILITY.md](../COMPATIBILITY.md) |
| 需构建的插件 | 检测到 `scripts.build` 会提示先 `pnpm --dir <插件> run build:host` + `build:client`（本脚本不构建） |
| 版本预检 | 目标版本在 npm 上不存在 → 直接明确失败，不产生误导性表格 |
| 退出码 | 0 = 全部装配成功（含「记录更严」）；1 = 有插件装配失败，或矩阵与实测真冲突 |

### 定期验证（`.github/workflows/compat-matrix.yml`）

「没人记得去跑 `compat-matrix.sh`」这件事由 CI 兜底（issue #114）：

| 项 | 说明 |
|---|---|
| 触发 | 每周一 03:00 UTC（北京 11:00）；也可在 Actions 里 `Run workflow` 手动指定版本 |
| 动作 | 对最新 `next` 版本跑一遍 `compat-matrix.sh --json`（L1 装配验收，全插件） |
| 落点 | **一条滚动 issue**「兼容矩阵定期验证（自动）」——存在就覆盖正文，不会越刷越多 |
| 边界 | **只读**：不改任何插件的 `dshReleases` / `dshDepth`，不开 PR、不部署 |
| 红不红 | 有插件装配失败 → job 失败，但 issue 照常更新（先让人看到表） |

issue 里会单列「需要人回填的」（`未验证→compatible` 的那批）与「记录比 L1 更严」的两类，
按需回填矩阵后再把结论写进 [`COMPATIBILITY.md`](../COMPATIBILITY.md)。

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

```bash
scripts/pipeline/review.sh prepare <pr> [--model <模型>]
scripts/pipeline/review.sh publish <pr> --record <文件> --round <n> [--dry-run] [--repo <owner/name>]
scripts/pipeline/review.sh paths <pr>
```
审核循环的机械步骤：`prepare` 把请求与提示词写到 `.tmp/review/<pr>/`（项目内，避开 `/tmp` 定期清理）；`publish` 用机器账号发评论并提交 review 状态（`APPROVE→approve`、`REJECT→request-changes`、`ESCALATE→只评论`）。**reviewer 的模型调用不在脚本内**——那一步必须由会话内 agent 发起。

### audit-subagents.mjs

定时审计 product 子代理会话（issue #10）：**只读、确定性、不调模型**。用 launchd / cron 直接跑，不要挂到 DSH 的 schedule 提醒上（那会唤醒会话、花模型调用）。

```bash
node scripts/pipeline/audit-subagents.mjs                       # 最近 24h（默认）
node scripts/pipeline/audit-subagents.mjs --hours 0 --json      # 全部历史 + 机器可读
node scripts/pipeline/audit-subagents.mjs --self-test           # 内置 fixture 断言（不读真实会话）
node --test scripts/pipeline/audit-subagents.test.mjs           # 单测 + 两类 fixture 集成
```

**扫什么**：`$DSH_HOME/sessions/<workspace>/<session>/session.v4.jsonl.zstd`，按 mtime 取最近 `--hours` 小时（`0` = 不限）。

**多帧 zstd**：DSH 是逐条追加的多帧压缩，Node 内置 `zstdDecompressSync` 只解首帧，本机 `zstd` CLI 报 `incorrect library version`。脚本按 magic `28 b5 2f fd` 找所有候选偏移逐帧解，解不出的伪偏移 / 截断帧跳过。

**判定规则**（只对 product 子代理会话生效）：

| 规则 | 条件 | 含义 |
|---|---|---|
| 识别 | `origin === 'subagent'` 且满足任一：`subagent/descriptor.provider` 以 `product-subagents:` 开头 / `agentPreset === 'product-relay'` / 调过 `product_*` 工具 | 只有 product 子代理才判，普通 subagent 与主会话跳过 |
| A | `agentPreset !== 'product-relay'` | preset 漂移（composition 约束没生效） |
| B | `tool/call` 出现 `bash` / `read` / `write` / `edit` / `glob` / `grep` | 本地自执行，绕过产品路径 |
| C | `product_submit` 调用 0 次 **且** 有 `turn/end` | 走完了却没走产品路径；进行中的会话不判 |

**输出**：日报 `.dsh-web/audit/<YYYY-MM-DD>.json`（每个会话一行判定记录，同日重跑覆盖）；stdout 一行 `audited N sessions, X violations (A=… B=… C=…)`。有违规 → exit 1，并在 stderr 列出会话与命中的规则；全绿 → exit 0、无 stderr。参数 / IO 错误 exit 2。`--json` 把完整报告打到 stdout（仍写日报）。

**调度**：模板 [`.dsh-web/com.deepseek.dsh-audit.plist`](../../.dsh-web/com.deepseek.dsh-audit.plist)（每天 03:30，**不自动加载**），日志追加到 `.dsh-web/audit/run.log`。

**已知口径**：`agentPreset` 取会话首行 `session.agentPreset`；早期（product-relay preset 引入前）的历史会话会因 A 规则被判违规，用默认 24h 窗口即可只看现行状态。

### pre-push-main-guard.sh / install-hooks.sh

本地兜底的 **git pre-push 钩子**：拦「直推 / 删除 `origin/main`」，让「所有改动走 pipeline」不只靠自律。它只是本地护栏——`--no-verify` 能绕过，真正的闸门仍是 `merge-pr.sh` 的审核记录。

```bash
scripts/pipeline/install-hooks.sh     # 幂等，可重复执行
```

- **装在哪**：`$(git rev-parse --git-common-dir)/hooks/pre-push`。worktree 里 `.git` 是文件，脚本按 common dir 推算，所以**装一次所有 worktree 共用**，新开的 worktree 无需重装。
- **默认拦什么**：stdin 任一行 remote ref 为 `refs/heads/main` 且远端名为 `origin` → 打印中文拒绝原因（引 `~/.dsh/AGENTS.md` §7.1）并 `exit 1`。**推和删都拦**：`git push origin main` 与 `git push origin :main`（`--delete main`）同样被拒。
- **放行什么**：任务分支（如 `refs/heads/task/222-*`）、删除**其它**远端分支（local sha 全 0，git 也传 `(delete)`）、非 `origin` 远端。
- **覆盖已有钩子**：`install-hooks.sh` 发现 `.git/hooks/pre-push` 已存在且内容不同，会先打警告并备份成 `pre-push.bak.<时间戳>`，再覆盖。
- **`core.hooksPath`**：若配置了该值，钩子装到 `$(git rev-parse --git-common-dir)/hooks` **不会生效**；脚本会提示并回显该配置值，但仍按原逻辑安装（**不擅自改用户配置**）。
- **例外**：确实要临时直推时

  ```bash
  ALLOW_DIRECT_MAIN=1 git push origin main
  ```

  放行（推与删都放行）并打印一行警告。这是**一次性、显式**的绕过，不写任何留痕；事后请确认该操作是否该补 PR / 补审核记录。
- **卸载**：`rm "$(git rev-parse --git-common-dir)/hooks/pre-push"`。
- **兼容**：bash 3.2（macOS 自带）。读 stdin 时**不加** `IFS=` 前缀——只有默认 IFS 才会把一行按空白切成 4 个字段；`IFS=` 置空后 read 不做字段切分，`REMOTE_REF` 拿不到值，判定就失效。脚本事先用过 `bash -n` + stdin 喂样例验证。

## 三、worktree 与分支命名契约

| 项 | 契约 |
|---|---|
| 分支名 | `task/<issue号>-<slug>` |
| worktree 路径 | `.worktrees/<issue号>-<slug>`（相对仓库根） |
| 基线 | **必须基于 `origin/main`**（`new-task.sh` 内置） |
| 位置 | worktree **绝不能嵌在插件子目录里**；一律从主仓根执行（`git worktree add` 在子目录里跑会嵌进错误的层级） |
| 清理 | issue / PR 一旦关闭，必须立刻 `git worktree remove --force <path>` → `git branch -D task/<N>-<slug>` → `git worktree prune` → `git worktree list` 确认**只剩主工作区** |
| 为什么 `-D` | squash 合并后原提交**不是** main 的祖先，`-d` 会拒绝删除 |

## 四、关键约定（红线）

1. **审核闸门 + 人在环**：`merge-pr.sh` 默认要求 `--review-record`，没有审核记录绝不合并；reviewer 判 `APPROVE` 且未命中高风险时直接合并；只有 `ESCALATE`、高风险路径、3 轮超限才需要用户介入。

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
3. **绝不用真实 `~/.dsh` 做安装实验**：一律走 `install-check.sh`（一次性 `DSH_HOME`，装完即删）。
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
| 交付物 | 生产静态站 9928 上的新版本 | **插件被本机 DSH profile 正确装配**（对应 `install-check.sh`） |
| 额外脚本 | — | `check-all.sh`、`install-check.sh` |
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
| dsh | `dsh --version` 能取到版本号（`install-check.sh` 用它拉同版本一次性安装） |
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
闸门已抽成共享包 `@guraul/dsh-pipeline`，本仓 `merge-pr.sh` 只剩转发壳；审核记录的写入也已统一到包侧 `record`（D10），
不再由各插件 / 各脚本各写一套。

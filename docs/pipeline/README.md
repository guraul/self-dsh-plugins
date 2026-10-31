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
                ④ 用户 review 确认 —— **人在环，唯一一步**
7. 合并         scripts/pipeline/merge-pr.sh         # squash merge + 清理现场 + 快进 main
8. 收尾         合并后**没有部署**；只有 CI 测试通过这一件事
```

**人在环（唯一一步）**：agent 完成开发并开 PR 后，**必须向用户询问"review 是否完成"**；**用户回复 ok** 后，agent 才允许运行 `merge-pr.sh`。除这一步之外，从 issue 到合并全程自动化。

**合并后没有部署**：本仓库没有服务器、没有 rsync / ssh / systemd、没有线上 curl 验证。合并的唯一后果是 main 前进一格、CI 重跑一遍。

规则：pipeline 只服务本仓库自己的插件（清单以 `lib.sh` 的 `PLUGIN_DIRS` 为准）；插件是 `link:` 到本机 DSH profile 的，不走发布流程。

## 二、脚本用法

环境：任何脚本都必须在**本仓库或其 worktree 内**运行（`lib.sh` 用 `git rev-parse --show-toplevel` 定位根）。

### lib.sh

```bash
# 不直接执行；被其他脚本 source
source scripts/pipeline/lib.sh
```
公共常量（`REPO_ROOT` / `GH_REPO` / `FETCH_RETRY` / `PLUGIN_DIRS`）、日志函数（`die` / `info` / `ok` / `mark`）、工具函数（`slugify` / `is_issue_number` / `pkg_script` / `pkg_name` / `worktree_for_branch` / `main_worktree` / `require_gh`）。

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

```bash
scripts/pipeline/new-task.sh 12
```
| 项 | 说明 |
|---|---|
| 参数 | `<issue号>`（正整数，必填） |
| 效果 | `task/<号>-<slug>` + `.worktrees/<号>-<slug>`，基于 `origin/main`；新 worktree 内写入当前 git 身份（worktree 局部配置，不动全局） |
| 幂等 | worktree 已存在 → 直接打印路径退出（**不 fetch、不改动现场**）；路径被占但不是本仓库 worktree → 报错停下 |
| 退出码 | 0 成功；1 参数非法 / issue 不可访问 / fetch 连续失败 |

`<slug>` 由 issue 标题小写化并只保留 `[a-z0-9-]`（截断 40）——**中文标题会被清空并兜底为 `task`**。

### open-pr.sh

```bash
cd .worktrees/12-xxx && scripts/pipeline/open-pr.sh
```
| 项 | 说明 |
|---|---|
| 参数 | 无（从当前分支名反解 issue 号） |
| 前置 | 分支名必须是 `task/<号>-<slug>`；工作区必须干净（有未提交改动直接拒绝） |
| 幂等 | 分支已推送则重推；**PR 已存在则只打印链接，不新建** |
| 退出码 | 0 成功 / PR 已存在；1 分支名不合规、脏工作区、issue 不可访问 |

### merge-pr.sh

```bash
cd <worktree> && scripts/pipeline/merge-pr.sh    # 自动识别当前分支的 PR
scripts/pipeline/merge-pr.sh <PR号|分支名>        # 任意位置（含主工作区）指定 PR
scripts/pipeline/merge-pr.sh <PR号> --force       # CI 未过时仍合并（慎用）
```
| 项 | 说明 |
|---|---|
| 行为 | 定位 PR → CI checks 未过则拒绝 → `gh pr merge --squash` → 删远端分支 → 删本地分支（`-D`）→ 移除对应 worktree → `worktree prune` → 主工作区快进（`ff_main()`：`git fetch --prune origin main` + `git merge --ff-only origin/main`，**显式命名 merge head** 以绕开 `FETCH_HEAD` 竞态，仍绝不做非快进合并；失败时**先确认无分叉才自动重试一次**，真分叉则拒绝并提示不要用 `--force`） |
| 幂等 | PR 已是 `MERGED` → 跳过合并，只清理现场并快进 main |
| 退出码 | 0 成功；1 找不到 main 工作区 / 找不到 PR / 状态非 OPEN·MERGED / CI 未过 / 快进失败 |

⚠️ **调用方必须先拿到用户对本次 review 的明确同意**（见 §一、§四红线 1）。脚本自己不询问、也不校验——这是调用纪律。

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

1. **人在环**：没有用户对本次 review 的**明确同意**，绝不运行 `merge-pr.sh`。
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

## 七、阶段状态

当前进度与阶段划分见 [PROGRESS.md](PROGRESS.md)。

现状：**脚手架已就位，尚未实际使用**——7 个脚本、CI、手册、台账都已落地，但还没有真正跑过一次 issue → PR → merge 的完整流程。

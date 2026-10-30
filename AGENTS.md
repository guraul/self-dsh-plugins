# AGENTS.md — self-dsh-plugins

**Updated:** 2026-10-23

给在本仓库工作的 AI agent 的说明。本文件只承担**路由**与**强制规定**两个职责：
插件细节、流程细节、历史细节一律在 `docs/` 里（见下面的路由表），**不要在本文重复**。

## 这是什么

自研 / 自维护 / fork 来的 [DeepSeek Harness](https://github.com/deepseek-ai)（`dsh`）插件集合。
每个子目录是一个独立插件，通过 profile 的 `link:` 依赖挂到本机 DSH 上，**没有发布流程**。

这个仓库同时是**本机 dsh web GUI 的工作目录** —— 你很可能正跑在这个进程里。

## 运行时事实（2026-10-17 实测）

| 项 | 值 |
|---|---|
| DSH | `0.2.1-rc.2`（本机全局安装，走 `next` 渠道；npm `latest` 仍是 `0.2.0-rc.2`），装在 nvm node `v24.21.0` 下 |
| Node / pnpm | `v24.21.0` / `12.6.0`（`dsh`、`pnpm` 都在 `~/.nvm/versions/node/v24.21.0/bin`） |
| `DSH_HOME` | `/Users/gubin/.dsh` |
| profile | `web` = `~/.dsh/profiles/web`，`patchReload: live` |
| GUI | <http://127.0.0.1:3080>（`dsh --profile web --no-open --port 3080`） |
| 进程管理 | LaunchAgent `com.deepseek.dsh-web.self-dsh-plugins`，plist 在 [`.dsh-web/`](./.dsh-web) |
| 运行日志 | [`.dsh-web/web.out.log`](./.dsh-web)、[`.dsh-web/web.err.log`](./.dsh-web) |

> ⚠️ **重启这个进程会终止当前会话。** 不要顺手重启；需要时用
> [`.dsh-web/restart-once.sh`](./.dsh-web/restart-once.sh)（延迟执行，让当前回复先发出去，
> 并在重启后自检健康路由、写 `.dsh-web/restart-once.log`）。

## 知识库路由（优先查阅）

| 场景 | 加载文档 |
|---|---|
| 全局认知：仓库是什么、插件清单、运行环境 | 本文件 + [`README.md`](./README.md) |
| **改某个插件前**：它改哪里、注意什么、怎么验证 | [`docs/plugins/<插件>.md`](./docs/plugins/README.md) |
| 插件文档总索引（插件 → 文档 → 包名） | [`docs/plugins/README.md`](./docs/plugins/README.md) |
| 交付流程、worktree 纪律、pipeline 脚本用法 | [`docs/pipeline/README.md`](./docs/pipeline/README.md) |
| pipeline 进度台账、已定决策（D1–D6） | [`docs/pipeline/PROGRESS.md`](./docs/pipeline/PROGRESS.md) |
| 历史归档（已废弃的方案，仅存档） | [`docs/archive/`](./docs/archive/README.md) |
| 某插件的安装 / 配置 / 已知限制（面向使用者） | 各插件目录的 `README.md` |
| dsh 升级 / 回滚 / 恢复 | [`upgrade-dsh.sh`](./upgrade-dsh.sh) + dsh-auto-upgrade 插件 |
| DSH 版本兼容与版本豁免 | [`docs/plugins/dsh-plugin-product-subagents.md`](./docs/plugins/dsh-plugin-product-subagents.md)（发版纪律）+ [pipeline 手册 §四红线 4](./docs/pipeline/README.md) |

## 插件索引

| 目录 | 包名 | 一句话作用 | 来源 |
|---|---|---|---|
| [`dsh-auto-upgrade/`](./dsh-auto-upgrade) | `dsh-plugin-auto-upgrade` | dsh Web UI 自升级：检测 → 兼容性预检 → 非阻塞浮层 → 备份/安装/校验/重启 | **原创** |
| [`dsh-awake/`](./dsh-awake) | `dsh-plugin-awake` | 发送栏咖啡杯按钮：宿主侧 `caffeinate -i` 保持唤醒，纯开关，单按钮两色 | **原创** |
| [`dsh-external-discuss/`](./dsh-external-discuss) | `dsh-plugin-external-discuss` | 把 DSH 会话一键送到外部模型（清言网页版）继续讨论 | **原创** |
| [`dsh-im-bridge-workspaces/`](./dsh-im-bridge-workspaces) | `@mhfire/dsh-im-bridge` | 企业微信 ⇄ DSH Agent 桥接，本地 fork 加多工作区 `/ws` 切换 | **fork**（npm `@mhfire/dsh-im-bridge@0.4.4`） |
| [`dsh-plugin-product-subagents/`](./dsh-plugin-product-subagents) | `dsh-plugin-product-subagents` | 把 Claude Code / Codex / 任意 ACP CLI 变成基于角色的可续接 subagent | **fork**（`shaokeyibb/dsh-plugin-product-subagents` v0.4.0） |
| [`dsh-prompt-optimizer/`](./dsh-prompt-optimizer) | `@y1x1n/dsh-prompt-optimizer` | 发送栏纯图标按钮，一键优化提示词并直接写回输入框（线性图标 + 内联 loading，无弹出面板） | **fork**（npm `@y1x1n/dsh-prompt-optimizer@0.6.1`，`0.6.1-fork.1`） |
| [`dsh-zhihu-sidebar/`](./dsh-zhihu-sidebar) | `dsh-plugin-zhihu-sidebar` | 知乎热榜 / 搜索 / 我的创作挂进右侧栏；数据走官方 Zhihu CLI，密钥存系统凭证库、插件不接触明文 | **原创** |

顶层其它文件：[`README.md`](./README.md)（对外说明）、[`upgrade-dsh.sh`](./upgrade-dsh.sh)（全局 dsh 升级/回滚/恢复）、
[`dsh-web-stop.sh`](./dsh-web-stop.sh)（停服）、[`.dsh-web/`](./.dsh-web)（LaunchAgent 与重启脚本）、
[`docs/`](./docs)（插件文档 / pipeline / 归档）、[`scripts/pipeline/`](./scripts/pipeline)（交付脚本）。

## 强制规定

以下硬性规则适用于所有任务：

1. **全仓库只允许根目录一份 `AGENTS.md`。** 任何子目录**不得**再新增 `AGENTS.md` / `CLAUDE.md`。
   插件级说明一律写进 [`docs/plugins/`](./docs/plugins/README.md)。
2. **包管理器只用 pnpm**：见 `~/.dsh/AGENTS.md` §3；本仓库脚本 / CI / 文档一律照此写。
3. **所有改动走 pipeline**：流程纪律见 `~/.dsh/AGENTS.md` §7。本仓脚本：
   开 issue → `scripts/pipeline/new-task.sh <号>` → 在 worktree 里开发 →
   `scripts/pipeline/open-pr.sh` → **拿到用户对 review 的明确同意**后 `scripts/pipeline/merge-pr.sh`。
   worktree 与分支命名契约、清理纪律见
   [`docs/pipeline/README.md`](./docs/pipeline/README.md)。
4. **subagent 委派约定**：通用规则见 `~/.dsh/AGENTS.md` §8 / §9（跨项目单一真源）；本条只写本仓特有部分。
   - **本仓特有**：
     - 门禁：`node --test` + `node scripts/lint.js`；CI 见 `.github/workflows/`。
     - **执行面合规审计**：`node scripts/pipeline/audit-subagents.mjs --hours 24`（确定性、只读、不花模型调用）——检「preset 漂移」「子代理本地自执行」「未走产品路径」，异常 exit 1。模板 `.dsh-web/com.deepseek.dsh-audit.plist` **未自动加载**，需手动装 LaunchAgent。
     - **打断语义**：`interrupt_agent` 会让远端**立刻停**（发 ACP `session/cancel`），但进程按 `idleTimeoutMs`（默认 10 分钟）回收——**别把 `opencode acp` 赖着当泄漏**；详见 `dsh-plugin-product-subagents/README.md` §Interrupting a delegation（issue #12 实测）。
5. **宿主安全**：禁止随意重启 dsh web（会终止当前会话）——需要时用
   [`.dsh-web/restart-once.sh`](./.dsh-web/restart-once.sh)；
   `dsh plugin add/remove`、`npm install -g` 等先取得用户明确同意。通用规则见 `~/.dsh/AGENTS.md` §12。
6. **DSH 版本兼容**：插件声明的 peer 范围不覆盖当前 DSH 时，profile 会**跳过该 bundle**
   （表现是「插件莫名其妙没加载」，不是崩溃）。**版本豁免是逃生舱**，必须按顺序来：
   先在插件里扩声明 → 跑该插件的一次性 profile 验收 → 把 verdict 同时写进 `package.json` 的
   `dsh.compatibility.dshReleases` 与 `docs/COMPATIBILITY.md` → bump 插件 SemVer → 最后撤销豁免。
   完整纪律与 ⚠️ prerelease 陷阱（`^0.2.0-rc.2` 不覆盖 `0.2.1-rc.1`）见
   [`docs/plugins/dsh-plugin-product-subagents.md`](./docs/plugins/dsh-plugin-product-subagents.md)。

## 已知坑

macOS 环境与并发纪律的通用条目见 `~/.dsh/AGENTS.md` §12（bash 3.2 / 无 `timeout` / 动手前先 `git status`）。本仓特有：

- **改了 profile 的 `link:` 目标路径后，必须在 `~/.dsh/profiles/web` 跑一次 `pnpm install`**，
  否则 `node_modules/<包名>` 软链悬空、插件加载失败。
- **不要 `rm -rf` 已装插件的目录**：正在运行的宿主已把模块载入内存，但任何重组合 / 重启都会失败。

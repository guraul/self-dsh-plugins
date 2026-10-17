# dsh-plugin-product-subagents（插件级 agent 说明）

> 从 `dsh-plugin-product-subagents/AGENTS.md`（上游英文版）完整重写迁移而来
> （2026-10-17，仓库统一治理 issue #1）。原本还有一份 `CLAUDE.md`——它唯一作用是
> `@AGENTS.md` 指针，已随源头一起删除。
> 仓库级约定见根 [`AGENTS.md`](../../AGENTS.md)；面向使用者的说明见
> [`README.md`](../../dsh-plugin-product-subagents/README.md)（英文）与
> [`README.zh.md`](../../dsh-plugin-product-subagents/README.zh.md)（中文）。
>
> **命名约定**：本文中文叙述，但**代码标识符、协议名、文件路径一律保持英文原文**。

- 目录：`dsh-plugin-product-subagents/`　包名：`dsh-plugin-product-subagents`
- 来源：fork 自 GitHub `shaokeyibb/dsh-plugin-product-subagents` v0.4.0
  （commit `e5a002db3b8d6df984fdb5e704e9321dca1723cd`，MIT）；上游历史见该 commit。

## 是什么

一个 DeepSeek Harness（Cordis）插件，把外部 agent CLI（Claude Code、Codex、任意 ACP agent）
变成**基于角色的、可续接的 subagent**：一次性同步调用或异步可续接，带持久会话恢复、
每角色 product 权限，以及受**权限天花板**约束的委派。

## 命令

```bash
pnpm install       # 装依赖
pnpm test          # node:test 套件（纯逻辑 + 假 bridge；不需要任何 CLI / key）
pnpm run lint      # 逐个模块语法检查（node --check）

# 针对某个真实 DSH 版本的一次性 profile 验收（一次性 $DSH_HOME）
node scripts/verify-dsh-profile.mjs --dsh 0.2.0-rc.2
```

- **永不**新增需要真实 product CLI 或 API key 的测试——`pnpm test` 必须在无凭据的 CI
  （macOS / Ubuntu / Windows × Node 18/20/22）上全绿。
- 一次性 profile 验收是**刻意的例外**，放在 `scripts/` 里，不属于 `pnpm test`。

## 目录结构

```
lib/
  index.js            # apply()：接线 providers / 生命周期 / tools
  tools/              # 每个面向模型的工具一个模块
  bridges/            # 每种 product 协议一个 bridge（claude / codex / acp）
  providers.js        # 配置驱动的 provider 注册表（+ 自定义 ACP agent）
  roles.js            # 角色库加载器
  config.js           # zod 配置校验
  registry.js         # 持久化 remote-session registry 文件
  run.js              # 跨平台进程启动（Windows .cmd shim）
  availability.js     # CLI 探测
  bindings.js         # child → remote 绑定表 + log-marker 恢复
  progress.js         # 会话日志折叠（progress / trace / token usage）
  children.js         # listChildren() 并集：身份行 vs 诊断行
  lossless.js         # stripUndefined()：工具结果必须是 lossless JSON
roles/                # 声明式角色文件（*.json）
test/                 # node:test 套件
scripts/              # lint + 一次性 profile 的 DSH 验收脚本
docs/ARCHITECTURE.md  # 桥接契约、权限模型、如何新增 product
docs/COMPATIBILITY.md # DSH 版本矩阵，以及每个 verdict 是怎么产生的
```

**`lib/` 各模块职责要点**：`index.js` 保持薄，只做接线，工具都放 `lib/tools/`；
一切 CLI 启动走 `lib/run.js`；一切可能缺失字段的工具结果走 `lib/lossless.js`；
会话 id 的捕获与恢复链在 `lib/bindings.js` → `lib/registry.js`（+ log marker）。

## 设计规则（不可协商）

1. **relay model 永远是只读管道。** child 的 `toolFilter` 只可能含 `product_submit`，
   以及在角色允许委派时加上 `product_delegate`。**绝不**给 child 添加任何有写能力的工具。
2. **权限是给远端 product 的。** `permissionMode`（`readonly` / `default` / `full`）
   映射到 product 自己的 CLI 参数。
3. **绝不把裸 product id 注册到 `ctx.subagents`。** 本插件的 provider key
   （`claude-code`、`codex`、`acp`）同时也是官方 `@deepseek-ai/dsh-subagent-*` 插件使用的 id。
   `registerProvider` 遇到重名会拒绝，而这个失败会让**整个 profile 的插件树在启动时挂掉**，
   所以每次注册都经 `runtimeProviderName()`，保持加性且插件自有。
   bridge、角色、绑定与 registry 仍继续使用裸 key。
4. **权限沿委派树向下继承。** child 不能生出比自己 `permissionMode` 更高的后代——
   在 `lib/tools/product-delegate.js`（`PERM_RANK`）中强制执行。
5. **桥接契约是固定的。** `lib/bridges/` 里每个 bridge 实现
   `create(cwd)`、`submit(remote, task, signal, cwd, settings)`、`reconnect(sessionId, cwd)`、
   `dispose(remote)`。新增一个 product = 一个 bridge + 一条 provider 条目；
   纯 ACP CLI 甚至不需要写代码（走 `config.providers`）。
6. **跨平台。** 所有 CLI 启动都走 `lib/run.js`（`spawnProduct` / `spawnSyncProduct`）——
   它们负责 Windows `.cmd` shim。路径一律用 `join()` 与 `fileURLToPath`，
   绝不用字符串拼接或 `URL.pathname`。
7. **会话续接是分层的。** 远端 session id 尽早捕获并持久化记录
   （binding → registry 文件 → log marker）。不要打断这条恢复链。

## 配置面（`config`）

`config.providers`（新增 / 覆盖 product CLI）、`providerNamespace`、`idleTimeoutMs`、
`maxConcurrentChildren`、`rolesDir`、`registryPath`。
角色存在 `roles/*.json`（`permissionMode`、`allowDelegation` 默认 ON、`provider`、
`instructions`、`description`）。非法配置经 `lib/config.js`（zod）**大声失败**。

> ⚠️ 配置覆盖会替换该行的**整个** `config` 对象——想保留的键要一并重述。

## 约定

- `lib/index.js` 保持薄；工具放 `lib/tools/`。
- 配置面变化时，`README.md` 与 `README.zh.md` **同时**改。
- 用户可见的变化要加 `CHANGELOG.md` 条目。
- **每个工具结果必须是严格 lossless JSON**——任意深度都不许出现 `undefined`。
  任何字段可能缺失时都要经 `stripUndefined()`（`lib/lossless.js`）返回；
  否则 harness 会拒绝整个调用。
- **树内不得有符号链接，也不得有 git submodule**：DSH STORE 的 fixed-Commit 契约要求
  普通文件，符号链接会让 store 的自动更新被推迟。（`CLAUDE.md` 当初正是为此不是符号链接；
  现按本仓库统一治理规则已删除，指引只留在 `docs/plugins/dsh-plugin-product-subagents.md`。）
- **提交身份**用 `HikariLan <i@hikarilan.life>`；仓库在首次发版前刻意只保留一个 squash commit。

## 发版纪律：声称支持某个 DSH 版本，必须有验收背书

**这是本插件最容易出错、也最不可省的一条纪律。**

一次性 profile 验收（`scripts/verify-dsh-profile.mjs`）对每个目标版本建一个临时 `$DSH_HOME`，
跑四步，任一步不成立就判该版本失败：

| 步骤 | 证明了什么 |
|---|---|
| `install` | `dsh plugin --profile headless add <tarball>` 成功，**且** profile manifest 的 `dsh.profile.bundles` 里出现了 `dsh-plugin-product-subagents`——该版本的 CLI 认了 `dsh.bundle.patch` 声明 |
| `compose` | `dsh --profile headless --dump-config` 组合出的树里含本插件的行——bundle patch 在该版本的 loader 下正确分层 |
| `start` | profile 真能**启动**（用 `scripts/verify-plugin.mjs` 经 `--patch` 叠加）：断言六个工具都注册了、subagent provider 到达真实 `SubagentRuntime`，且 `product_roles` / `product_agents` 能执行、通过其输出 schema 校验、渲染、且**不含 `undefined`**（严格 lossless JSON） |
| `uninstall` | `dsh plugin … remove` 成功，bundle 层从 manifest 中消失 |

- `--with <pkg>[,<pkg>]` 会在同一 profile 里共装其它 bundle；`start` 步骤会额外断言本插件注册的
  每个 id 都是命名空间化、插件自有的——这正是防止与官方 `@deepseek-ai/dsh-subagent-*` 的
  provider id 冲突的检查（0.4.0 之前这个冲突会让整个 profile 的插件树启动失败）。
- 临时 `$DSH_HOME` 跑完即删（`--keep` 可保留排查）。**绝不触碰用户真实的 `~/.dsh`。**
- 一次验收**不证明**什么：它不是安全审计，也不真的跑一次对 product CLI 的活体委派
  （那需要真实 `claude` / `codex` / ACP 会话及其凭据）；bridge 行为由 `pnpm test` 对假 bridge 覆盖。

### verdict 该写哪里（三处，缺一不可）

1. **跑**：`node scripts/verify-dsh-profile.mjs --dsh <新版本>`；
2. **记**：verdict 同时写进 `package.json` 的 `dsh.compatibility.dshReleases`
   **和** `docs/COMPATIBILITY.md` 的表；
3. **bump**：改插件 SemVer（矩阵只在新 pinned commit 生效）。

`dshReleases` 是**逐版本**的 verdict，不是范围：表里缺失的版本就是 `unknown`——
`unknown` 绝不在没有实跑的情况下被升格成 `compatible`。
`unknown` 永远是「拿不到 / 测不了」，绝不是「跑不通」。

### 与 DSH 兼容范围相关的三个坑

- **范围要扩声明**：DSH 启动时按插件自己声明的 peer 范围判兼容。没覆盖就跳过该 bundle
  （表现是「插件莫名其妙没加载」）。所以要在 `peerDependencies` 与 `dsh.compatibility.dsh`
  里同时加上目标版本线。
- **prerelease 陷阱（比看上去更细）**：预发布版本只满足 major.minor.patch **完全相同**的比较器。
  所以 `^0.2.0-rc.2` 不覆盖 `0.2.1-rc.1`；同理 **`^0.2.1-rc.1` 也不覆盖 `0.2.1-alpha.5`**
  （alpha 低于 rc）。规律是：**锚点要写在不高于你支持的最低预发布版本上** ——
  `^0.2.1-alpha.5` 会把整条 `0.2.1` 线（含 `rc.1`）都覆盖进去，一条锚点就够。
  仓库里 0.4.0 → 0.4.1 是「只补声明、未改业务代码」的例子；
  0.4.2 则是**声明 + 真实 API 迁移**。
- **验收脚本测不到「能不能真的起一个子代理」**：`scripts/verify-plugin.mjs` 的 `start` 步骤只断言
  「6 个工具已注册 + provider 已注册 + `product_roles`/`product_agents` 能执行」，**从不真正发起委派**。
  DSH `0.2.1` 把服务级 `startContinuable` 改名成 `startActivation` 时，插件照常加载、
  六个工具都在，**只有真起子代理才炸** —— 于是所有 verdict 依然是 `compatible`。
  现在这条由 **`test/delegate-start.test.js`** 在 CI 里守（免凭据），
  但**每次发版仍要人工做一次真实委派**（见 `docs/COMPATIBILITY.md` 的「What the run does not prove」）。

## 本仓库对它的适配记录（fork 后改了什么）

- 扩展 `peerDependencies` / `dsh.compatibility.dsh` 范围，补 `0.2.0-rc.2`、`0.2.1-rc.1` 的
  `dshReleases` verdict（均有一次性 profile 验收背书）；
- 版本 `0.4.0 → 0.4.1`，同步 `CHANGELOG.md` / `docs/COMPATIBILITY.md` / `README.md` + `README.zh.md`；
- **业务代码未改**；并入本仓库统一管理（其内层 `.git` 已删除，上游历史见上文 commit）。
- **`0.4.2`（适配 DSH `0.2.1` 线，本次唯一动业务代码的一次）**：
  - `lib/tools/product-delegate.js` 新增 `pickStart()`：`startActivation`（DSH >= 0.2.1，补
    `delivery: 'parent'`）与 `startContinuable`（0.2.0 线）**特征检测二选一**，两者都没有就**响亮报错**；
  - `0.2.1` 路径不再发送 `persona` / `toolFilter`（这两个字段已被 runtime 删除）——
    角色的 `instructions` 仍会拼在任务文本前面，那才是产品 CLI 真正读到的部分；
  - 新增 `test/delegate-start.test.js` 守住这次改名（CI 可跑、免凭据）；
  - 声明锚点从 `^0.2.1-rc.1` 改为 `^0.2.1-alpha.5`（见上文 prerelease 坑），
    补 `0.2.1-alpha.5` verdict，并用 0.4.2 **复跑**了 `0.2.1-rc.1`；
  - **能力变化（必须知道）**：`0.2.1+` 上外部子代理是一次性的，`product_submit`、durable 远端会话、
    续接在 `0.2.1+` 上不可用；`0.2.0` 线行为不变。

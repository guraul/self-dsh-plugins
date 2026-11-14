# dsh-plugin-memx（插件级 agent 说明）

> 仓库级约定见根 [`AGENTS.md`](../../AGENTS.md)。
> ⚠️ `dsh-plugin-memx/` 目录下**没有**面向使用者的 `README.md`（2026-11-04 核对），
> 本文件是目前唯一落点；使用者说明补齐后应与本文件互补、不重复。

- 目录：`dsh-plugin-memx/`　包名：`dsh-plugin-memx`　来源：**原创**　当前版本：`0.2.0`

## 它是什么

memx 记忆能力接进 DSH 的**薄壳**：注入 / 捕获 / 提炼 / 写盘这些记忆逻辑全部留在 memx 仓，
本包只做两件事——

1. 把 memx 的 DSH 宿主适配器（`/Users/gubin/workspace/memx/src/hosts/dsh/index.ts`）挂进 profile；
2. 提供 Web 设置页「记忆」（提炼 provider / model、轮末自动提炼、提炼间隔）。

- 接线声明在 `cordis.patch.yml`：往组合里插一行 `id: memx`、`name: dsh-plugin-memx`、`config: {}`
  （留空 = 四个字段取 schema 默认值）。
- 用户改动写在 profile 的 `cordis.patch.yml` 用户层或设置页「记忆」里。

## 目录与分工

| 路径 | 作用 | 是否构建产物 |
|---|---|---|
| `lib/index.js` | 宿主入口：注册只作用于 memx 源码的 `load` 钩子 → `await import` memx 适配器 → 把它的导出原样转发给 Cordis | **手写**，不经 esbuild |
| `src/config.ts` → `lib/config.js` | 四个配置字段的 schemastery 声明（全 `.volatile()`） | esbuild 产物 |
| `src/client/index.tsx`、`src/client/MemorySettings.tsx` → `lib/client.js` | 设置页「记忆」 | esbuild 产物 |
| `scripts/build.mjs` | 打 `lib/config.js` + `lib/client.js`（`lib/index.js` 不在其中） | — |
| `smoke.mjs` | 升级后冒烟（`dsh.smoke`）：load 钩子解析 memx 模块 / 四字段设置 schema / 记忆目录路径 | — |
| `test/smoke.test.mjs` | 冒烟自测（2 条；需要 memx 仓的那条在无 memx 的机器上跳过） | — |
| `cordis.patch.yml` | bundle patch：插 `memx` 那一行 | — |

## 改之前必须知道的六件事

1. **改 `src/` 必须重建，改 `lib/index.js` 不用。** `lib/config.js` / `lib/client.js` 是入库产物，
   CI 的「构建产物新鲜度」步骤会 `pnpm run build` 后要求本插件目录在 git 里零改动，改了源码忘了 build 直接判红。
   `lib/index.js` 是手写转发文件，改它不需要 build。
2. **`load` 钩子不是绕远路，是被 Node 24 逼的。** Node 24 默认只有 strip-only 类型剥离，
   memx 源码里的 parameter property（`constructor(private …)`）直接 import 会抛
   `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`（2026-10-22 实测）。所以对 `/Users/gubin/workspace/memx/` 下的
   `.ts` 注册 `load` 钩子，用 `stripTypeScriptTypes(..., { mode: 'transform' })` 剥类型；
   路径仍指向 memx 源码本身，**memx 改代码后本包无需重编译**。
3. **配置声明必须留在本包，不要改回转发 memx 的 `Config`。** 宿主设置面只认 schemastery + `.volatile()`
   （`volatileForm(Config)` 投影可编辑字段），memx 那份是手写 standard-schema，投影不出任何字段，
   结果是设置页整页消失。四个字段 `provider` / `model` / `autoRefine` / `throttleMinutes` 的
   `.default()` 口径必须与 memx `DshMemxConfig` 的注释一致（空 = 跟随当前会话 / 自动提炼开 / 10 分钟）。
4. **客户端 loader id 必须等于包名。** `build.mjs` 用 `package.json` 的 `name` 生成
   `window.__ModuleLoader__.load({ id })`，不一致会被宿主按包名校验拒绝（与 `dsh-prompt-optimizer` 踩过的 #4 同一个坑）。
5. **设置页读配置用 entry id，不是包名。** `ctx.configForms.get(...)` 取的是 `cordis.patch.yml` 那行的
   `id: memx`；取值要传**函数**由页面现取，不要在 `apply` 时取快照闭包进组件——宿主下发设置项的时机
   与本插件激活顺序无关。同理 `inject` 必须单独声明 `remote.session`（只写 `remote` 时访问
   `ctx.remote.session` 会抛 `cannot get property "remote.session" without inject`，线上白屏的真凶）。
6. **memx 仓路径是硬编码的。** `lib/index.js` 里 `MEMX_ROOT = "/Users/gubin/workspace/memx/"`，
   memx 仓换位置或不存在时宿主侧加载会失败，不是静默降级。

## 验证

```sh
cd dsh-plugin-memx
pnpm install            # 本插件有 pnpm-lock.yaml，CI 走 frozen-lockfile
pnpm run build          # lib/config.js + lib/client.js
pnpm test               # 2 条 smoke 自测
pnpm run typecheck      # tsc --noEmit
```

本插件**没有** `scripts.lint`；CI matrix 条目（`dir: dsh-plugin-memx`）会做：装依赖 → 重建并要求产物新鲜 →
跑 `pnpm test`（2 条 smoke 自测）→ 确认 `lib/index.js` / `lib/client.js` / `lib/config.js` 存在。

`smoke.mjs`（宿主 `dsh.smoke`）在真机上验三件事：`lib/index.js` 的 load 钩子能加载 memx 仓的 TS 适配器；
`lib/config.js` 四字段仍全 `.volatile()` 且默认值口径未漂；记忆目录解析仍是 `<home>/.opencode/projects/<slug>/.mem`
（memx 宿主无关，**不读 `DSH_HOME`**）。

真机验收（**重启 dsh web 会终止当前会话**，注意时机）：profile 里 `link:` 到本目录后
在 `~/.dsh/profiles/web` 跑一次 `pnpm install`（否则 `node_modules/<包名>` 软链悬空、插件不加载），
再确认设置面出现独立一页「记忆」，四个字段可改且热更生效。

## 已知限制

- **只在本机可用**：`MEMX_ROOT` 指向 `/Users/gubin/workspace/memx/`，换机器 / 换路径要改 `lib/index.js`。
- **`devDependencies` 里的 `@deepseek-ai/dsh-*` 钉在 `0.2.1-rc.2`**（只用于类型检查），与本机 DSH
  实际版本不必一致；本插件没有 `peerDependencies`（也没有 `dsh.compatibility` 声明）。
- **没有使用者 README**：安装 / 配置 / 已知限制的对外说明目前缺位，改用户可见行为时记得补。

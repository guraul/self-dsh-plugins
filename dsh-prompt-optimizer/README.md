# @y1x1n/dsh-prompt-optimizer（本地 fork：`0.6.1-fork.1`）

DeepSeek Harness 插件：发送栏旁一个**纯图标按钮**，点击后用当前会话模型优化输入框里的提示词草稿，
**优化完直接写回输入框**。

基于 npm `@y1x1n/dsh-prompt-optimizer@0.6.1`（MIT）fork，只改 UI / 交互，**元提示词一字未动**。
上游原版说明见 [README.upstream.md](./README.upstream.md)；上游还有英文版 `README.en.md` 与小白版
`README.simple.md`，同样保持原样。

> 改这个插件前先读本仓的 [docs/plugins/dsh-prompt-optimizer.md](../../docs/plugins/dsh-prompt-optimizer.md)：
> 里面有元提示词全文、槽位/会话隔离的约束、门禁命令。

---

## 1. 与上游的差异

| 项 | 上游 `0.6.1` | 本仓 `0.6.1-fork.1` |
|---|---|---|
| 按钮 | 实心四芒星 + 文字「优化」 | **线性描边**四芒星，**无文字**，正方形内边距（贴住 14px 图标） |
| 结果呈现 | 输入卡上方弹结果面板，需手动点「替换输入框」 | **面板移除**：`done` 即写回输入框草稿，无需二次确认 |
| 诊断分析 | 面板里和优化稿一起展示 | **悬停按钮浮出小卡片**查看（`lastAnalysis`），**不进输入框**；写回内容永远只有优化稿 |
| 面板文件 | `src/client/ResultDock.tsx` | **删除**；`conversation.input.dock` 槽位不再注册 |
| loading | 透明脉冲；按钮禁用 | 转圈图标（CSS `0.9s linear infinite`）+ hover 显示**已用秒数**（每秒刷新）；**再点一次 = 取消** |
| 错误 | 面板内展示 + 重试按钮 | 图标变红 + hover 提示**错误原文**，3 秒自动复位；再点一次即重试，**草稿原样保留** |
| 撤回 | 面板内「替换输入框」后可点撤回 | **按钮自带撤销**：写回后图标变撤回箭头，再点一次还原替换前原文；用户一编辑草稿即失效 |
| 复制 / 重试按钮 | 面板内 | 随之移除（重试改为在按钮上再点一次） |
| 类型依赖 | `pnpm run sync:types`（内部 `npm pack`） | 4 个客户端包直接进 devDependencies，`pnpm install` 一步到位 |
| 版本 | `0.6.1` | `0.6.1-fork.1` |

保留不变：宿主两条路由（`/dsh-prompt-optimizer/optimize` SSE、`/test-model`）、设置卡、模型路由与回退、
上下文取样、轻量记忆链（`previous`）、斜杠命令前缀拆分。

## 2. 安装（本仓 fork 用法）

本仓**没有发布流程**，插件通过 profile 的 `link:` 依赖挂到本机 DSH：

```sh
# 1) 在本目录装依赖并构建
cd dsh-prompt-optimizer
pnpm install
pnpm run build

# 2) 在 dsh profile 里以 link: 指向本目录（路径按实际 clone 位置替换）
#    ~/.dsh/profiles/<profile>/package.json
#    "dependencies": { "@y1x1n/dsh-prompt-optimizer": "link:../../workspace/self-dsh-plugins/dsh-prompt-optimizer" }
cd ~/.dsh/profiles/<profile>
pnpm install

# 3) 重启 dsh web（会终止当前会话，见本仓 AGENTS.md）
```

上游的 npm / Release 安装方式（`dsh plugin add @y1x1n/dsh-prompt-optimizer`）装到的是**上游原版**，
不含本仓改动，别混用。

## 3. 行为细节

- **会话隔离**：控制器是会话间共享单例。只有「发起优化的那个会话」（`state.last.sessionId === props.sessionId`）
  才会收到写回；切走后迟到的结果**直接丢弃**，不会污染另一个会话的输入框。
- **斜杠命令前缀**：`/goal 帮我写…` 只优化正文，写回时前缀原样拼在最前。
- **按钮状态机**：同一个位置四种外观，不弹任何面板 ——
  idle（四芒星）/ loading（转圈 + 已用秒数）/ applied（撤回箭头）/ error（红色四芒星）。
  空草稿时降透明度并 `disabled`，`title` 提示先输入。
- **诊断浮卡**：`full` 模式产出的诊断存在 controller 里（`lastAnalysis`），鼠标悬停按钮（或 Tab 聚焦）
  时在按钮上方浮出查看，带「诊断分析」标题；移开/失焦即收起。浮卡不挡点击、走 DSW 令牌样式；
  浮卡可用时按钮原生 `title` 置空（避免双重 tooltip），文案改由 `aria-label` 承载。
  诊断**只在这张卡里**：写回输入框的永远只有优化稿（full / fast 一致），切会话不串台，
  `settle()` 不清（写回后仍可回看），`close()` 才复位。
- **取消**：优化中再点一次按钮即中止；已生成的部分不写回，草稿保持你点之前的内容。
  迟到的 `done` 会被竞态护栏丢弃，不会「取消完还被替换」。
- **自带撤销**：写回后按钮变撤回箭头（hover「已替换，点一下还原原文」），点一次把替换前的
  **原文全文**写回。宿主 `setDraft` 走 `history-merge`（合并进上一条历史，`⌘Z` 不可靠），
  所以这一步是必要的兜底。替换后你自己改了草稿、或切到别的会话，撤销依据立即失效
  （绝不用旧备份覆盖你的新输入）。
- **失败**：图标变红 3 秒，hover 看错误原文（`title` 承载完整文本，颜色只是次要提示）；
  **绝不清空草稿**。
- **记忆链**：`settle()` 复位时保留上一轮结果，所以你改一改再点，模型会拿到上轮优化稿做延续参考。
- **无障碍**：按钮有 `title` / `aria-busy`，保留 `:focus-visible` 焦点环；
  `prefers-reduced-motion: reduce` 下不旋转（改为降透明度）。

## 4. 构建与验证

```sh
cd dsh-prompt-optimizer
pnpm install            # pnpm 12：pnpm-workspace.yaml 的 allowBuilds 放行 esbuild
pnpm run typecheck      # tsc --noEmit
pnpm test               # smoke / prompt / controller / slot-guard / button-state
pnpm run build          # lib/index.js、lib/client.js、lib/prompt.js、lib/controller.js
node --check lib/index.js && node --check lib/client.js
```

`lib/` 是构建产物但需要入库（profile 直接 `link:` 到这个目录，宿主读的就是它）。
改完 `src/` 必须重新 `pnpm run build`；`test/slot-guard.test.mjs` 会 import 真实产物
`lib/client.js` 做 `apply()` 断言。

## 5. 已知限制

- 面板移除后，「完整」模式的诊断改由**悬停浮卡**展示；默认模式仍是「快速」（不产出诊断）。
  设置卡「完整」选项的 `title` 已标注「诊断在鼠标悬停按钮时查看」。
- 浮卡是 `position:absolute` 挂在按钮外层 `span` 上；已核对官方 `dsh-client-ui-conversation`
  的 InputBar CSS，按钮祖先链（`_card` / `_root` / `_row` / `_dock`）**没有 `overflow:hidden`**，
  绝对定位浮卡不会被裁切（`overflow` 只出现在 `_scroll` / `_input` / `_placeholder`，不在祖先链上）。
- 撤销只保留**最近一次**写回：连续点两次优化，只能还原到第二次写回前的文本。
- 纯前端改动，未在真实 0.2.1 桌面端逐帧核对旋转动画的视觉手感。

## License

MIT，见 [LICENSE](./LICENSE)。原版权归上游作者；本 fork 的改动同样以 MIT 发布。

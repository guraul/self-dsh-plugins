# dsh-prompt-optimizer（插件级 agent 说明）

> 面向 agent 的工作要点。目录：`dsh-prompt-optimizer/`　包名：`@y1x1n/dsh-prompt-optimizer`
> 来源：**fork**（npm `@y1x1n/dsh-prompt-optimizer@0.6.1`，MIT）。上游说明见
> [`../../dsh-prompt-optimizer/README.upstream.md`](../../dsh-prompt-optimizer/README.upstream.md)，
> 本仓改动见 [`../../dsh-prompt-optimizer/README.md`](../../dsh-prompt-optimizer/README.md)。

## 一句话

在发送栏右侧加一个**纯图标按钮**：点击后用当前会话模型把输入框里的草稿优化一遍，
**优化完直接写回输入框**（不弹面板、不需要二次确认）。

## 本仓 fork 改了什么（与上游 0.6.1 的差异）

| 项 | 上游 | 本仓 |
|---|---|---|
| 图标 | 实心四芒星（`fill="currentColor"`）+ 文字「优化」 | 线性描边四芒星（`fill="none"` / `strokeWidth=1.5` / 圆角连接），**无文字**，正方形内边距 |
| 结果呈现 | `conversation.input.dock` 弹面板，用户点「替换输入框」 | **删除 dock 注册与 `ResultDock.tsx`**，`status==='done'` 时直接 `inputActions.setDraft()` |
| 诊断分析 | 面板里与优化稿一起渲染 | **悬停按钮浮卡**查看（`state.lastAnalysis`）；写回输入框的永远只有优化稿 |
| loading | 图标透明度脉冲（SVG `<animate>`），继续显示文字 | 独立转圈图标 + CSS `0.9s linear infinite` 旋转，title 显示**每秒刷新**的「已用 Ns」；再次点击 = **取消** |
| 错误 | 面板里展示 + 重试/关闭按钮 | 图标变红 + title 承载错误原文，3 秒后自动 `settle()`；再点一次即重试，**不清空草稿** |
| 撤回 | 面板里「替换输入框」后可点撤回 | **按钮自带撤销**：写回后变撤回箭头，再点一次 `setDraft(backup)` 还原原文；用户编辑草稿 / 切会话即失效 |
| 复位 | 面板 `close()` | 新增 `controller.settle()`：只清 status/live，**保留 result**（轻量记忆链依赖） |
| 类型来源 | `sync:types`（内部 `npm pack`） | 直接把 4 个客户端包加进 devDependencies（`pnpm install` 可解析，CI 不再需要 sync 步骤） |

## 改哪里

| 路径 | 职责 |
|---|---|
| `src/index.ts` | 宿主半边：注册 `/dsh-prompt-optimizer/optimize`（SSE 流式）与 `/dsh-prompt-optimizer/test-model`，配置 schema |
| `src/prompt.ts` | **元提示词**（`buildSystemPrompt` / `buildUserPayload`）、上下文预算、输出解析（含 `<think>` 剥离、流式压缩） |
| `src/client/index.tsx` | 客户端入口：槽位注册（**只剩** `conversation.input.right` 与两个设置槽位）、注入样式表（焦点环 / 按钮底色 / 旋转动画） |
| `src/client/OptimizeButton.tsx` | 按钮本体：状态机渲染、点击优化、loading 取消 + 计时、done 写回、applied 还原、error 3s 复位 |
| `src/client/LoadingIcon.tsx` | 转圈图标（开口圆环，CSS `.dsh-po-spin` 驱动） |
| `src/client/UndoIcon.tsx` | 撤回图标（逆时针回环箭头） |
| `src/client/DiagnosisCard.tsx` | 诊断浮卡（`position:absolute` + `right:0` + `zIndex` + `pointer-events:none` + `pre-wrap`） |
| `src/client/controller.ts` | 状态容器（`optimize` / `cancel` / `settle` / `retry` / `markApplied` / `clearApplied` / `close`）、`lastAnalysis` 留存、按钮状态纯函数 `resolveButtonState`、上下文取样、SSE 解析 |
| `src/client/SparkleIcon.tsx` | 线性四芒星图标（idle / error 两态） |
| `src/client/i18n.ts` | zh/en 文案；`button.optimize` / `button.optimizing` **保留 key 但不再参与渲染**（title 用 `button.title*`） |
| `src/client/SettingsCard.tsx`、`settings-face.ts` | 设置卡（模型 / 模式 / 语言 / 温度 / 超时 / 上下文） |
| `lib/` | **构建产物**（esbuild），`lib/client.js` 是 lazy-CJS factory，loader id = 包名 |

链路：按钮点击 → `controller.optimize(draft, sessionId)` → 客户端拼上下文（`ctx.sessions` 事件窗口，
缺席回落 legacy 查询）→ `POST /dsh-prompt-optimizer/optimize`（SSE：`delta` / `done` / `error`）→
`state.status==='done'` → 按钮 `useEffect` 写回 `inputActions.setDraft(prefix + optimized)` 并
`markApplied({backup, text, sessionId})` → `settle()` → 按钮进入 **applied** 态（再点 = 还原）。

按钮状态（`resolveButtonState`，纯函数，优先级 `loading > applied > error > empty > idle`）：

| 态 | 图标 | title | 点击 |
|---|---|---|---|
| `idle`（有草稿） | 四芒星 | 分析并优化当前输入的提示词 | 发起优化 |
| `empty`（空草稿） | 四芒星 + `opacity 0.45` + `not-allowed` | 先在输入框输入提示词 | 无（`disabled`） |
| `loading` | 转圈 | `优化中 · 已用 {N}s`（每秒刷新） | `cancel()` |
| `applied` | 撤回箭头 | 已替换，点一下还原原文 | `setDraft(backup)` + `clearApplied()` |
| `error` | 红色四芒星 | 完整错误文本 | 重新发起优化 |

**诊断不进输入框**：`done` 时把 `event.analysis` 存进 `state.lastAnalysis`（空白归一为 `null`），
写回内容永远是 `prefix + result.optimized`。鼠标悬停 / Tab 聚焦按钮且 `status !== 'loading'` 时，
`DiagnosisCard` 浮在按钮上方展示它；此时按钮原生 `title` 置 `''`（避免与自绘卡片双重 tooltip），
文案改由 `aria-label` 承载。诊断按会话隔离：`state.last.sessionId !== props.sessionId` 时不显示。
`settle()` 不清 `lastAnalysis`（写回后还能回看），`close()` 随 `INITIAL` 复位。

## 注意什么

- **会话隔离是硬要求**：controller 是会话间共享单例，只有 `state.last.sessionId === props.sessionId`
  才允许写回；不匹配必须**丢弃**结果，不能把 A 会话的优化稿写进 B 会话的输入框。
  非发起方只丢弃、**不复位**：`settle()` 的复位权归写回者，免得抢在对方写回前把 `result` 清掉。
- **斜杠命令前缀必须拼回**：`splitCommandPrefix` 把 `/goal 正文` 拆成 `prefix` + 正文，
  写回时是 `${prefix} ${optimized}`。只优化正文，命令词不许被改写。
- **`settle()` 不能清 `result`**：轻量记忆链（`previous`）靠 `state.result` 判断「用户在我们产物上继续编辑」。
  只有 `close()` 才连 `last` / `result` 一起清空。
- **`markApplied` / `clearApplied` / `retry` / `shouldAutoClose` 必须保留**：面板已移除，但这四个导出
  被 `test/controller.test.mjs` 覆盖（撤回语义 / 记忆链），删了就是删测试的保护面。
- **撤销是必要功能，不是锦上添花**：宿主 `inputActions.setDraft()` 内部走
  `editor.update(..., { tag: 'history-merge' })`，写回会**合并进上一条历史记录**，`⌘Z` 不能可靠还原。
  面板里的「撤回」按钮没了，就只能靠 applied 态兜底。**失效条件必须保留两处**：
  ①`applied.sessionId !== props.sessionId`（切会话）；②`draft !== applied.text`（用户自己改过）。
  第二处有竞态：`markApplied` 与 `setDraft` 不在同一渲染落地，`draft` 追上 `text` 之前不能判失效
  （`confirmedRef`），否则会把自己刚建立的撤销依据撤掉。
- **`pointer-events` 的分工**：按钮**不能** `pointer-events:none` —— loading 中点击 = 取消、applied 中点击 = 还原，
  都是必须能点的逃生口。只有**图标**是 `pointer-events:none`，保证点击落在按钮上。
- **loading 计时放局部 state**：每秒变的值放 controller 会惊动所有订阅者重渲染；放组件 `useState`，
  effect 依赖 `state.status`，离开 loading / 卸载时 `clearInterval`。
- **`done` 的竞态护栏**：取消后（`abort=null`）或已换新请求（`abort` 被换掉）时，迟到的 `done` / `error`
  帧一律丢弃。否则会出现「点了取消，草稿却被替换」。
- **诊断只读不写**：`lastAnalysis` 只服务浮卡，**不许**拼进 `setDraft`，也不许进 `previous`
  （记忆链用的仍是 `result.optimized`）。一旦混进草稿，下一轮优化会把诊断当提示词一起优化。
- **浮卡与原生 title 二选一**：卡片会出现时必须把 `title` 置 `''`，否则两个 tooltip 同时弹出。
- **浮卡裁切已实测排除**：核对官方 `dsh-client-ui-conversation` 的 InputBar CSS，
  祖先链（`_card`(position:relative) / `_root` / `_row` / `_dock`）均无 `overflow:hidden`；
  `overflow` 只在 `_scroll` / `_input` / `_placeholder` 三处，都不在按钮祖先链上。
  因此绝对定位浮卡不会被裁切（真出现异常再考虑 portal）。
- **鼠标事件挂 `span` 不挂 `button`**：empty 态按钮 `disabled`，Chrome/Safari 对 disabled 元素
  **不派发鼠标事件**（React 合成事件同样收不到）。浮卡要能「清空输入框后也能查诊断」，
  所以 `onMouseEnter` / `onMouseLeave` 必须挂在外层 `span`；`onFocus` / `onBlur` 仍留 button
  （focus 不冒泡，且焦点只会落在 button 上）。
- **图标不许退回实心**：DSH 官方图标一律 `viewBox=24` + `stroke=currentColor` + `fill=none`；
  实心色块在工具行里明显重于邻居。strokeWidth 用 1.5（14px 显示下的等效观感，官方是 1@24）。
- **`lib/` 是产物**：改 `src/` 必须 `pnpm run build`；`lib/client.js` 由 `scripts/build.mjs` 生成，
  测试 `slot-guard` 会直接 import 它做真实 `apply()` 断言。
- **不要动 `src/prompt.ts` 的提示词文本**：本仓只做 UI/交互改造；提示词全文见下节，供 review 对照。

## 元提示词（实际发给模型的内容）

### 1. 两种策略

| 策略 | 触发条件 | 做什么 |
|---|---|---|
| `template` | 未携带会话上下文（或无 `previous`） | 按**结构模板**（角色 / 任务 / 背景 / 约束 / 输出格式）规范化改写，缺失信息标 `[待补充:……]` |
| `intent` | 携带 `<conversation-context>` | **先提炼用户真实目的再润色**，保留草稿原始表达框架，不套模板；上下文已明确的信息要利用，已被否决的方向不得重提；**严禁回答/延续/引用上下文** |

策略只影响「优化方式」与「示例」两段；角色、分析维度、保真原则、输出格式四段两种策略共用。

### 2. 五个分析维度（仅 full 模式）

1. 目标清晰度：任务目标是否明确、可判断完成与否
2. 上下文完整性：是否缺少模型完成任务所必需的背景信息
3. 约束与边界：限制条件是否有歧义、冲突或缺失
4. 结构与表达：组织是否清晰，有无冗余、口语化或歧义表述
5. 输出规格：是否指定期望的输出格式、长度、风格

诊断每条一行：`维度 | 问题 | 建议`；无问题写 `维度 | 无明显问题 | -`。

### 3. 保真纪律（核心要求）

- **理解优先**：先逐条列出草稿已明确的信息（对象、动作、约束、范围、术语、数字、语气），
  区分「草稿明确表达的」与「模型的推测」——推测只能影响措辞，绝不写入结果。
- **语义等价是底线**：对象、方向、数量、范围、禁止项、术语必须与草稿一致，不得替换 / 扩大 / 缩小 / 颠倒。
- **来源可回溯**：任何具体化都要能在草稿或已确认的上下文里找到依据；推断处用「如无特别说明/默认」，无依据宁可不补。
- **保真自检**：输出前逐要素核对，草稿的每个原子信息都要在优化稿里有对应，找不到即语义漂移。
- **长度纪律**：简单任务 ≤500 字符；优化稿就是提示词本身，不复述原稿、不加前言；保真优先于长度。
- **语言匹配**：中文草稿→中文输出，英文草稿→英文输出，保留术语与专有名词。

### 4. `buildSystemPrompt(language, mode, strategy)` 全文

> 以下为 `pnpm exec node` 直接调用 `lib/prompt.js` 的原样产出（2026-10-22，`0.6.1-fork.1`）。

#### 4.1 zh + full + template

```text
你是一位资深提示词工程专家。用户会给你一段「提示词草稿」,你要输出两段内容:先输出优化改写稿,再输出诊断分析。

# 分析维度
1. 目标清晰度:任务目标是否明确、可判断完成与否
2. 上下文完整性:是否缺少模型完成任务所必需的背景信息
3. 约束与边界:限制条件是否有歧义、冲突或缺失
4. 结构与表达:组织是否清晰,有无冗余、口语化或歧义表述
5. 输出规格:是否指定期望的输出格式、长度、风格

# 优化方式(结构模板)
将草稿改写为结构完整的提示词,要求:
- 使用与草稿相同的语言
- 忠实保留原意,不臆造用户未表达的需求
- 按结构模板组织(角色 / 任务 / 背景 / 约束 / 输出格式等,内容较长时用 Markdown 小节)
- 缺失但关键的信息不要编造,在文中以 [待补充:……] 标出

# 保真与明确化原则(全程遵守)
- 理解优先:先逐条列出草稿已明确的信息(对象、动作、约束、范围、术语、数字、语气),区分「草稿明确表达的」与「你的推测」——推测只可用于措辞,绝不写入结果
- 语义等价是底线:已明确的对象、方向、数量、范围、禁止项、术语必须与草稿一致,不得替换、扩大、缩小或颠倒
- 来源可回溯:任何具体化的内容都必须能从草稿或上下文已确认信息找到依据;推断处用「如无特别说明/默认」措辞保留选择权,无依据的宁可不补
- 保真自检:输出前逐要素核对——草稿的每个原子信息都要在优化稿中找到对应,找不到即为语义漂移,必须修正
- 长度纪律:简单任务的优化稿控制在 500 字符以内,复杂任务可超出;优化稿就是提示词本身——不复述原稿、不加多余的解释或前言;任何情况下保真自检优先于长度——要素缺失比冗长更严重,但也不得冗余
- 语言匹配:草稿以中文为主体则输出必须为中文,以英文为主体则输出必须为英文;保留原文的术语与专有名词

# 示例(严格模仿其「输入 → 输出」的风格)
输入:帮我写个请假条
输出:请帮我撰写一张请假条:事由为感冒就医,请假两天([待补充:起止日期]);语气正式简洁,包含称呼与落款,[待补充:请假对象与联系方式]。

# 输出格式(严格遵守,标记行单独成行)
<<<OPTIMIZED>>>
输出优化后的完整提示词全文
<<<ANALYSIS>>>
按维度逐条输出诊断,每条一行,格式:「维度 | 问题 | 建议」。某维度无明显问题时写:「维度 | 无明显问题 | -」。
<<<END>>>

除上述标记包裹的内容外,不要输出任何其他文字。
```

#### 4.2 zh + fast + template

```text
你是一位资深提示词工程专家。用户会给你一段「提示词草稿」,请直接输出优化后的完整提示词,不要做任何诊断分析。

# 优化方式(结构模板)
将草稿改写为结构完整的提示词,要求:
- 使用与草稿相同的语言
- 忠实保留原意,不臆造用户未表达的需求
- 按结构模板组织(角色 / 任务 / 背景 / 约束 / 输出格式等,内容较长时用 Markdown 小节)
- 缺失但关键的信息不要编造,在文中以 [待补充:……] 标出

# 保真与明确化原则(全程遵守)
- 理解优先:先逐条列出草稿已明确的信息(对象、动作、约束、范围、术语、数字、语气),区分「草稿明确表达的」与「你的推测」——推测只可用于措辞,绝不写入结果
- 语义等价是底线:已明确的对象、方向、数量、范围、禁止项、术语必须与草稿一致,不得替换、扩大、缩小或颠倒
- 来源可回溯:任何具体化的内容都必须能从草稿或上下文已确认信息找到依据;推断处用「如无特别说明/默认」措辞保留选择权,无依据的宁可不补
- 保真自检:输出前逐要素核对——草稿的每个原子信息都要在优化稿中找到对应,找不到即为语义漂移,必须修正
- 长度纪律:简单任务的优化稿控制在 500 字符以内,复杂任务可超出;优化稿就是提示词本身——不复述原稿、不加多余的解释或前言;任何情况下保真自检优先于长度——要素缺失比冗长更严重,但也不得冗余
- 语言匹配:草稿以中文为主体则输出必须为中文,以英文为主体则输出必须为英文;保留原文的术语与专有名词

# 示例(严格模仿其「输入 → 输出」的风格)
输入:帮我写个请假条
输出:请帮我撰写一张请假条:事由为感冒就医,请假两天([待补充:起止日期]);语气正式简洁,包含称呼与落款,[待补充:请假对象与联系方式]。

# 输出格式(严格遵守,标记行单独成行)
<<<OPTIMIZED>>>
输出优化后的完整提示词全文
<<<END>>>

除上述标记包裹的内容外,不要输出任何其他文字。
```

#### 4.3 en + full + template

```text
You are a senior prompt engineering expert. Given a "prompt draft" from the user, output the optimized rewrite first, then the diagnosis.

# Analysis dimensions
1. Goal clarity: is the task explicit and verifiable
2. Context completeness: is required background missing
3. Constraints & boundaries: ambiguous, conflicting, or missing limits
4. Structure & wording: organization, redundancy, ambiguity
5. Output spec: expected format, length, style

# How to optimize (structured template)
Rewrite the draft into a well-structured prompt. Requirements:
- Same language as the draft
- Faithful to the original intent; never invent requirements
- Organize with the structure template (role / task / background / constraints / output format; use Markdown sections for longer prompts)
- Mark missing critical information as [TODO: ...] instead of fabricating it

# Fidelity & clarification rules (always apply)
- Understand first: list what the draft explicitly states (subject, action, constraints, scope, terms, numbers, tone), and separate it from your guesses — guesses may shape wording only, never enter the output
- Semantic equivalence is the floor: what the draft states (subject, direction, quantities, scope, prohibitions, terms) must survive intact — never replace, widen, narrow, or invert it
- Traceability: every concretized detail must trace back to the draft or to information the context has confirmed; mark inferences with "unless otherwise specified / by default" phrasing; when in doubt, leave it out
- Fidelity self-check: before output, verify every atomic element of the draft has a counterpart in your rewrite — a missing one is semantic drift and must be fixed
- Length discipline: keep the rewrite under 500 characters for simple tasks; longer is allowed for complex ones. The rewrite is the prompt itself — never restate the draft or add explanations or preamble. Fidelity always outranks length — a missing element is worse than verbosity, but never pad
- Language match: Chinese-dominant draft → Chinese output; English-dominant → English output; keep the draft's terms and proper nouns

# Example (strictly mirror its "input → output" style)
Input: help me write a leave note
Output: Write a formal leave request: two days off for a medical visit ([TODO: exact dates]); concise tone, with salutation and sign-off, [TODO: recipient and contact].

# Output format (strictly follow; markers on their own lines)
<<<OPTIMIZED>>>
The full optimized prompt text
<<<ANALYSIS>>>
One finding per line: "dimension | issue | suggestion". If a dimension is fine: "dimension | no issue | -".
<<<END>>>

Do not output anything outside these markers.
```

#### 4.4 en + fast + template

```text
You are a senior prompt engineering expert. Given a "prompt draft" from the user, output an optimized version directly — no diagnosis.

# How to optimize (structured template)
Rewrite the draft into a well-structured prompt. Requirements:
- Same language as the draft
- Faithful to the original intent; never invent requirements
- Organize with the structure template (role / task / background / constraints / output format; use Markdown sections for longer prompts)
- Mark missing critical information as [TODO: ...] instead of fabricating it

# Fidelity & clarification rules (always apply)
- Understand first: list what the draft explicitly states (subject, action, constraints, scope, terms, numbers, tone), and separate it from your guesses — guesses may shape wording only, never enter the output
- Semantic equivalence is the floor: what the draft states (subject, direction, quantities, scope, prohibitions, terms) must survive intact — never replace, widen, narrow, or invert it
- Traceability: every concretized detail must trace back to the draft or to information the context has confirmed; mark inferences with "unless otherwise specified / by default" phrasing; when in doubt, leave it out
- Fidelity self-check: before output, verify every atomic element of the draft has a counterpart in your rewrite — a missing one is semantic drift and must be fixed
- Length discipline: keep the rewrite under 500 characters for simple tasks; longer is allowed for complex ones. The rewrite is the prompt itself — never restate the draft or add explanations or preamble. Fidelity always outranks length — a missing element is worse than verbosity, but never pad
- Language match: Chinese-dominant draft → Chinese output; English-dominant → English output; keep the draft's terms and proper nouns

# Example (strictly mirror its "input → output" style)
Input: help me write a leave note
Output: Write a formal leave request: two days off for a medical visit ([TODO: exact dates]); concise tone, with salutation and sign-off, [TODO: recipient and contact].

# Output format (strictly follow; markers on their own lines)
<<<OPTIMIZED>>>
The full optimized prompt text
<<<END>>>

Do not output anything outside these markers.
```

#### 4.5 换成 `strategy='intent'` 时只有两段变化

`template` → `intent` 替换「优化方式」与「示例」两段，其余（角色 / 分析维度 / 保真原则 / 输出格式）逐字相同。

zh：

```text
# 优化方式(提炼目的 + 润色)
用户消息附带 <conversation-context>(该会话的近期对话)。先通读它、提炼用户的真实目的,再围绕该目的对草稿做润色:
- 不要套用模板结构:保留草稿的原始表达框架,顺势打磨、补全细节
- 充分利用上下文已明确的信息(对象、约束、偏好),让优化稿可以直接落地;不要重复追问上下文已经给出的内容
- 识别上下文中已被用户否决或推翻的方向(禁入集合),优化稿不得重复提出
- 草稿与上下文冲突时,以草稿为最终意图,可在优化稿中调和表述
- 上下文仅供理解意图:严禁回答、延续或引用其中的内容;你唯一要优化的对象是 <prompt-draft> 里的草稿
- 使用与草稿相同的语言;草稿与上下文都未提供的关键信息以 [待补充:……] 标出

# 示例(严格模仿其「输入 → 输出」的风格;输入中的背景来自 <conversation-context>)
输入:(背景:用户在运营 200 人小区宝妈闲置群,首次接龙只有十几人参与,复盘为奖品差、格式乱)帮我重新设计一下这个接龙
输出:帮我重新设计小区闲置群的「好物推荐」接龙:群 200 余人、以宝妈为主,上次参与仅十几人,问题在于奖品吸引力不足、接龙格式混乱;请给出格式简明的接龙文案模板、低成本高吸引力的奖品建议,以及提升参与度的具体手段。
```

en：

```text
# How to optimize (distill intent, then polish)
The user message includes <conversation-context> (recent messages of this session). Read it first, distill what the user is really trying to achieve, then polish the draft toward that goal:
- Do NOT force a template structure: keep the draft's original framing, refine it in place and fill the gaps
- Exploit what the context already establishes (subject, constraints, preferences) so the optimized prompt is directly actionable; never re-ask what the context already answers
- Identify directions the user has already rejected or overruled in the context (the do-not-enter set); never propose them again
- If the draft conflicts with the context, the draft wins as the final intent; you may reconcile the wording in the rewrite
- The context only explains intent: never answer, continue, or quote it. The only thing you optimize is the draft inside <prompt-draft>
- Same language as the draft; mark information missing from both draft and context as [TODO: ...]

# Example (strictly mirror its "input → output" style; the background comes from <conversation-context>)
Input: (background: the user runs a 200-member neighborhood parents' swap group; the first chain-post drew only a dozen joins, blamed on weak prizes and a messy format) redesign the chain post for me
Output: Redesign the "hidden gems" chain post for my 200-member neighborhood swap group (mostly parents): last round drew only a dozen joins because prizes were unappealing and the format confusing — provide a simple chain-post template, low-cost but attractive prize ideas, and concrete tactics to lift participation.
```

### 5. `buildUserPayload(draft, language, context, previous)` 全文

三种包裹按固定顺序拼接：`<conversation-context>` → `<previous-optimized>` → `<prompt-draft>`；
前两者任一存在时，草稿段才用 `<prompt-draft>` 包裹（单发草稿时是纯文本，省 token）。

#### 5.1 无上下文、无上轮结果（zh / en）

```text
以下是我的提示词草稿:

帮我写个请假条
```

```text
Here is my prompt draft:

help me write a leave note
```

#### 5.2 带会话上下文（zh）

```text
以下是我当前会话的近期对话(仅供参考,用于理解我的意图;不要回答、延续或引用其中的内容):

<conversation-context>
用户: 帮我写个爬虫
助手: 用什么语言?
</conversation-context>

以下是我的提示词草稿(你唯一需要优化的对象):

<prompt-draft>
加上重试
</prompt-draft>
```

#### 5.3 带上轮结果（zh，`previous`）

```text
以下是我上一轮优化得到的结果(延续参考:沿用其中我已接受的决策与表达,只围绕本轮草稿的变化点调整;本轮草稿明确推翻的除外):

<previous-optimized>
请帮我撰写一张请假条:事由为感冒就医,请假两天([待补充:起止日期])。
</previous-optimized>

以下是我的提示词草稿(你唯一需要优化的对象):

<prompt-draft>
改成两天
</prompt-draft>
```

#### 5.4 上下文 + 上轮结果（en，两种包裹同时出现）

```text
Here is the recent conversation of my current session (reference only — it explains my intent; do NOT answer, continue, or quote it):

<conversation-context>
User: 帮我写个爬虫
Assistant: 用什么语言?
</conversation-context>

Here is the result of my previous optimization round (continuity reference: keep the decisions and phrasing I accepted; adjust only around what my new draft changes — unless my new draft explicitly overrules them):

<previous-optimized>
Write a formal leave request for two days.
</previous-optimized>

Here is my prompt draft (the only thing you should optimize):

<prompt-draft>
make it two days
</prompt-draft>
```

### 6. 预算与截断（与提示词同样影响结果）

| 项 | 值 | 位置 |
|---|---|---|
| 上下文档数上限 | 8 条 | `src/prompt.ts` `CONTEXT_MAX_TURNS` |
| 上下文总字符上限 | 1600 | `CONTEXT_MAX_CHARS` |
| 单条上限 | 600 字符（超出加 `…`） | `CONTEXT_TURN_MAX_CHARS` |
| 用户消息保底 | 至少 1 条（超预算也截断保留） | `CONTEXT_MIN_USER_TURNS` / `CONTEXT_USER_BUDGET` |
| `previous` 上限 | 1500 字符 | `src/index.ts` 调用处 |
| 输出 token | 自适应（完整 ×2 / 快速 ×1.5，32768 封顶） | `src/index.ts` `autoMaxTokens` |

## 怎么验证

```sh
cd dsh-prompt-optimizer
pnpm install            # pnpm 12 需要 pnpm-workspace.yaml 的 allowBuilds 放行 esbuild
pnpm run typecheck      # tsc --noEmit，0 错误
pnpm test               # smoke / prompt / controller / slot-guard / button-state 五套，全绿
                        # controller 的 c28 锁 lastAnalysis 生命周期（done 写入 / 空值归一 / settle 保留 / close 复位）
pnpm run build          # 产出 lib/index.js、lib/client.js、lib/prompt.js、lib/controller.js
node --check lib/index.js && node --check lib/client.js
```

- **验收 UI 改动必须看真浏览器**：`lib/client.js` 只有语法门禁，旋转动画 / 写回草稿 / 会话隔离
  要装进一次性 profile 手点一遍（见 [`../pipeline/README.md`](../pipeline/README.md) 的 install-check）。
- `test/slot-guard.test.mjs` 会 import **真实构建产物** `lib/client.js` 并对 `apply()` 断言：
  改槽位注册（例如又把 dock 加回来）必须先 `pnpm run build`，否则测的还是旧产物。
- `test/controller.test.mjs` 依赖 `settle` 之外的四个导出（`markApplied` / `clearApplied` / `retry` /
  `shouldAutoClose`）；删任何一个都会让测试直接报错，这是有意的保护。
- `test/button-state.test.mjs` 锁 `resolveButtonState` 的优先级与跨会话隔离（7 组断言）；
  调状态机优先级先看它。

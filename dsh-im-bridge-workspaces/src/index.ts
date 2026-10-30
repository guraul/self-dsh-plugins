/**
 * dsh-im-bridge — WeCom AI bot ⇄ DSH Agent host plugin.
 *
 * Function-plugin shape (`name` / `inject` / `Config` / `apply`, no default
 * export). Messages create in-process Agents so per-chat-window sessions stay on
 * the same Loader tree as the Web GUI. The Config schema is volatile, so the
 * settings form edits this entry in place. Live fields read `source()`;
 * credentials still require a process restart to open the WebSocket.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installModelSelection, type ModelSelection } from '@deepseek-ai/dsh-agent'
// Type-only: the ctx.settings Context merge; the section installs through the service.
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: the 'session/title' SessionEventMap merge this bridge reads and appends.
import type {} from '@deepseek-ai/dsh-session-title'
import {
  ApprovalQueue,
  buildApprovalCard,
  formatApprovalText,
  parseApprovalReply,
  parseButtonKey,
  redactArguments,
  type ApprovalDecision,
  type ApprovalOutcome,
  type PendingApproval,
} from './approval.ts'
import {
  collectReplyPngs,
  resolveChatId,
  sendCollectedPngs,
} from './reply-images.ts'
import {
  isLegacyPinnedWecomTitle,
  planWecomBind,
  resolveWecomSession,
  stripBotMention,
  wecomDisplayTitle,
  WecomSessionReject,
  type WecomSessionRef,
} from './session-key.ts'
import { registerPromptVariable, type PromptVariableRegistry } from './prompt-variable.ts'
import {
  parseWorkspaceCommand,
  resolveWorkspaceSelector,
  sessionKeyForWorkspace,
  type WorkspaceBinding,
  type WorkspaceCommand,
  type WorkspaceEntityLike,
} from './workspace-router.ts'
import {
  ALLOW_FROM_REQUIRED_MESSAGE,
  IM_BRIDGE_RPC_CHANNEL,
  INSTALL_SKILLS_ENDPOINT,
  SKILLS_RPC_UNAVAILABLE_MESSAGE,
  WECOM_CLI_NO_OFFICE_PROMPT,
  WECOM_CLI_PROMPT,
  WECOM_CLI_TOOL_NAME,
  WORKSPACE_WECOMCLI_LEAK_MESSAGE,
  authInitHint,
  countWecomcliSkills,
  countWorkspaceWecomcliLeaks,
  ensureOnPath,
  installOfficialWecomSkills,
  loadWecomSkills,
  probeAuth,
  registerWecomCliTool,
  registerWecomOfficeSkills,
  resolveConfigDir,
  resolveSkillsDir,
  resolveWecomBin,
  senderHasOfficeAccess,
  shouldEnableWecomCli,
  shouldInjectWecomOfficeSkills,
  skillsInstallHint,
  tryEnsureConfigDir,
  trySeedAuth,
  type InstallWecomSkillsResult,
  type WecomSkill,
} from './wecom-cli.ts'
import {
  DEFAULT_THINKING,
  footerOf,
  fmtDuration,
  labelTool,
  pickStatusLine,
  sendFinal,
  startThinking,
  streamPhaseFromChunk,
  truncate,
  type ThinkingConfig,
} from './wecom.ts'
import {
  IMAGE_PLACEHOLDER_TEXT,
  detectImageMediaType,
  imageLimitMessage,
} from './wecom-image.ts'

/** Package root (persona files live beside package.json). */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** Built-in Chinese persona. */
const DEFAULT_PERSONA_ZH = join(PACKAGE_ROOT, 'persona.default.md')
/** Built-in English persona. */
const DEFAULT_PERSONA_EN = join(PACKAGE_ROOT, 'persona.default.en.md')
/** Host locale settings namespace (`dsh-client-locale`). */
const LOCALE_SETTINGS_NS = 'locale'
/** 兜底默认绑定升级为 registry 记录的最小重试间隔。 */
const DEFAULT_BINDING_RETRY_MS = 30_000

/** Settings namespace paired with the browser card. */
export const IM_BRIDGE_NS = 'im-bridge'

/** Cordis diagnostic name. */
export const name = 'im-bridge'

/** Required host services. */
export const inject = ['agents', 'sessions', 'agentDefaultModel']

const ThinkingPhase = z.object({
  atSec: z.number(),
  text: z.string(),
})

const ThinkingSchema = z.object({
  phases: z.array(ThinkingPhase).default(DEFAULT_THINKING.phases),
  spin: z.array(String).default(DEFAULT_THINKING.spin),
  eggs: z.array(String).default(DEFAULT_THINKING.eggs),
  eggAfterSec: z.number().default(DEFAULT_THINKING.eggAfterSec),
  intervalMs: z.number().default(DEFAULT_THINKING.intervalMs),
  activityPrefix: z.string().default(DEFAULT_THINKING.activityPrefix),
  toolLabels: z.dict(String).default(DEFAULT_THINKING.toolLabels),
  reasoningStatus: z.array(String).default(DEFAULT_THINKING.reasoningStatus),
  outputStatus: z.array(String).default(DEFAULT_THINKING.outputStatus),
  reasoningSpin: z.array(String).default(DEFAULT_THINKING.reasoningSpin),
  outputSpin: z.array(String).default(DEFAULT_THINKING.outputSpin),
})

const WecomCliSchema = z.object({
  enabled: z.boolean().default(false),
  skillsDir: z.string().default(''),
  configDir: z.string().default(''),
  allowFrom: z.array(String).default([]),
})

const ApprovalSchema = z.object({
  enabled: z.boolean().default(true),
  timeoutSec: z.number().default(300),
})

/** Approval relay settings: forward DSH approval requests to WeCom. */
export interface ApprovalConfig {
  /** Master switch; off restores the fail-closed "no approval channel" behaviour. */
  enabled: boolean
  /** How long one prompt stays pending before it is rejected automatically. */
  timeoutSec: number
}

/** Optional wecom-cli office skills (mail, calendar, docs, …). */
export interface WecomCliConfig {
  /** Explicit opt-in; off by default because it shares the authorized identity. */
  enabled: boolean
  /** Skills root; empty = `$DSH_HOME/wecom-cli-skills`. */
  skillsDir: string
  /** Credential directory; empty = `<workspace>/.dsh/wecom-cli`. */
  configDir: string
  /** Office-command userid list; empty skips PATH / auth. Independent of chat `allowFrom`. */
  allowFrom: string[]
}

/** Plugin config: secrets come from the profile patch or Settings. */
export interface Config {
  botId: string
  secret: string
  workspace: string
  /** Allow `/ws` to move a WeCom window to another workspace. */
  workspaceSwitch: boolean
  /** Workspace command allow-list; empty allows every authorized sender. */
  workspaceAllowFrom: string[]
  /** Allow `/ws add <path>` to register a new directory. */
  workspaceAdd: boolean
  allowFrom: string[]
  startHint: string
  agentTimeoutSec: number
  agentPreset: string
  provider: string
  model: string
  reasoningEffort: string
  persona: string
  personaFile: string
  maxReplyBytes: number
  thinking: ThinkingConfig
  /** Accept inbound images from the bot's long connection. */
  imageEnabled: boolean
  deniedMessage: string
  welcomeMessage: string
  wecomCli: WecomCliConfig
  approval: ApprovalConfig
}

/** Schemastery schema for the composition entry and settings form. */
export const Config = z.object({
  botId: z.string().default('').role('secret'),
  secret: z.string().default('').role('secret'),
  workspace: z.string().default(process.cwd()),
  workspaceSwitch: z.boolean().default(true),
  workspaceAllowFrom: z.array(String).default([]),
  workspaceAdd: z.boolean().default(false),
  allowFrom: z.array(String).default([]),
  startHint: z.string().default('🧠 正在思考...'),
  agentTimeoutSec: z.number().default(600),
  agentPreset: z.string().default('standard'),
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
  persona: z.string().default(''),
  personaFile: z.string().default(''),
  maxReplyBytes: z.number().default(20000),
  thinking: ThinkingSchema.default(DEFAULT_THINKING),
  imageEnabled: z.boolean().default(true),
  deniedMessage: z.string().default('无权访问本服务'),
  welcomeMessage: z.string().default('👋 办公助手已就绪。直接发消息即可，例如查文件、整理文档、查资料或处理日常事务。'),
  wecomCli: WecomCliSchema.default({ enabled: false, skillsDir: '', configDir: '', allowFrom: [] }),
  approval: ApprovalSchema.default({ enabled: true, timeoutSec: 300 }),
}).volatile()

interface LoggedEvent {
  seq: number
  type: string
  /** Per-type payload; each reader narrows it to the event it handles. */
  data: unknown
}

interface TextBlock {
  type: string
  text?: string
}

interface AssistantMessageData {
  message?: { content?: TextBlock[] }
}

interface ToolCallData {
  name?: string
  callId?: string
  /** Raw JSON arguments, captured so an approval prompt can show the command. */
  arguments?: string
}

interface ToolResultData {
  error?: unknown
  message?: { source?: { callId?: string } }
}

interface ChunkData {
  chunk?: { type?: string; blockType?: string }
}

interface LiveAgent {
  whenIdle(): Promise<void>
  followup(message: unknown): void
  ctx: Context
  session: {
    seq: number
    snapshotEvents(): readonly LoggedEvent[]
    header?: { cwd?: string; agentPreset?: string }
  }
}

interface ChatState {
  agent?: LiveAgent
  sessionId?: string
  kind?: 'single' | 'group'
  /** 当前窗口发送者 userid（私聊）—— 侧边栏标题显示「谁在问」。 */
  sender?: string
  /** 当前窗口群 id（群聊）。 */
  chatid?: string
  /** True when the current inbound sender is on `wecomCli.allowFrom`. */
  office: boolean
  /** Prompt sections already registered on this Agent. */
  wecomPromptInstalled: boolean
  /** wecomcli-* already registered on this Agent. */
  officeSkillsRegistered: boolean
  /** The gated `wecom_cli` tool already registered on this Agent. */
  officeToolRegistered: boolean
  /** Approval answerer already registered on this Agent's context. */
  approvalRelayInstalled: boolean
  queue: Promise<unknown>
  lastActivity: string
  activityClearAt: number
  lastToolByCallId: Map<string, string>
  /** Raw tool arguments by call id, kept only until the approval prompt shows them. */
  toolArgsByCallId: Map<string, string>
  modelStreamPhase: 'idle' | 'reasoning' | 'outputting'
  streamStatusTick: number
}

/** Placeholder Map value so later messages on the same key share one queue. */
function emptyChatState(): ChatState {
  return {
    office: false,
    wecomPromptInstalled: false,
    officeSkillsRegistered: false,
    officeToolRegistered: false,
    approvalRelayInstalled: false,
    queue: Promise.resolve(),
    lastActivity: '',
    activityClearAt: 0,
    lastToolByCallId: new Map(),
    toolArgsByCallId: new Map(),
    modelStreamPhase: 'idle',
    streamStatusTick: 0,
  }
}

/** Duck-typed Connection RPC result (no apiproxy import). */
type SkillsRpcResult =
  | { ok: true; value: InstallWecomSkillsResult }
  | { ok: false; error: { code: 'internal' | 'cancelled'; message: string; details: Record<string, never> } }

/** Optional Host Connection used by the Settings install button. */
interface HostConnectionRpc {
  handle(
    channel: string,
    handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<SkillsRpcResult>,
    options: { authority: 'loopback' },
  ): () => Promise<void>
}

interface DefaultModel {
  currentSelection(): ModelSelection
}

/** Durable image reference returned by the attachment service. */
interface ImageAttachmentRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

/** The read/write face of `ctx.attachments` this bridge needs (optional service). */
interface AttachmentStore {
  saveImage(input: {
    data: Uint8Array
    mediaType: string
    name?: string
  }): Promise<ImageAttachmentRef>
}

/** The model-capability query this bridge needs (optional service). */
interface LlmService {
  resolveModelInfo(provider: string, model: string): Promise<{ inputModalities?: readonly string[] }>
}

/** One inbound image whose download already started in the event callback. */
interface InboundImage {
  /** `ws.downloadFile` promise; awaited inside the session queue, not before. */
  download: Promise<{ buffer: Buffer; filename?: string }>
}

/** Prompt content the bridge builds for one inbound message. */
type InboundContent =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: ImageAttachmentRef }

interface AgentRegistry {
  get(id: ReturnType<typeof SessionId>): LiveAgent | undefined
  create(options: {
    sessionId: ReturnType<typeof SessionId>
    meta?: { cwd?: string; agentPreset?: string }
    agentOptions?: { provider: string; model: string }
    setup?: (agentCtx: Context) => void | Promise<void>
  }): Promise<{ agent: LiveAgent }>
  resume(options: {
    resumeSessionId: ReturnType<typeof SessionId>
    agentOptions?: { provider: string; model: string }
    setup?: (agentCtx: Context) => void | Promise<void>
  }): Promise<{ agent: LiveAgent }>
}

interface SessionPersistenceHeader {
  id: string
  cwd?: string
  agentPreset?: string
}

interface SessionPersistence {
  list(): Promise<SessionPersistenceHeader[]>
}

interface WorkspaceRegistry {
  readonly archivedSessionIds: readonly string[]
  /**
   * Create or reuse the workspace record for an existing directory. The registry
   * canonicalizes the path, so repeated calls for the same directory reuse the
   * existing record instead of creating duplicates.
   */
  create(path: string, title?: string): Promise<WorkspaceEntity>
  /** Every workspace in durable display order (the `/ws` list order). */
  list(): WorkspaceEntity[]
  /** Look one workspace up by its stable id. */
  get(id: string): WorkspaceEntity | undefined
  /** Resolve an existing directory to its workspace without creating one. */
  resolveByPath(path: string): Promise<WorkspaceEntity | undefined>
}

/**
 * The workspace-record operations this bridge needs: the `/ws` listing, and
 * folding a session into its workspace group. Sessions this plugin creates
 * start out ungrouped otherwise — `agents.create()` / `agents.resume()`
 * register the session with the client store (so the sidebar *lists* it) but
 * never touch the workspace ledger the sidebar *groups* by, which is why every
 * WeCom window used to land under 「未分组」.
 */
interface WorkspaceEntity {
  /** Stable record id (generated uuid; fallback bindings use `path:<dir>`). */
  readonly id: string
  /** Canonical directory path new sessions open in. */
  readonly path: string
  /** Display title. */
  readonly title: string
  /** Header-validated sessions this workspace already groups. */
  readonly sessionIds: readonly string[]
  attachSession(sessionId: SessionId): Promise<void>
  /** Live directory check: `'ok'` or `'missing-dir'`. */
  status(): Promise<'ok' | 'missing-dir'>
}

/** Persisted shape of `$DSH_HOME/dsh-im-bridge/workspace-bindings.json`. */
interface StoredWorkspaceBindings {
  version: number
  windows: Record<string, WorkspaceBinding>
}

interface SessionStore {
  flush(session: LiveAgent['session']): Promise<void>
}

interface SessionTitleSnapshot {
  title: string
  source: { kind: string }
}

interface SessionTitleService {
  get(session: LiveAgent['session']): SessionTitleSnapshot | undefined
  refresh(session: LiveAgent['session']): Promise<unknown>
}

interface TitledSession {
  id: string
  snapshotEvents(): readonly LoggedEvent[]
  append(type: 'session/title', data: {
    title: string
    messageSeqs: number[]
    source: unknown
  }): void
}

interface SessionTitleEventData {
  title?: string
  messageSeqs?: number[]
  source?: { kind?: string }
}

interface AgentPresets {
  resolve(id: string): Promise<{ id: string }>
  mount(agentCtx: Context, id: string): Promise<unknown>
}

interface SystemPromptService extends PromptVariableRegistry {
  section(entry: { name: string; order: number; text: () => string }): unknown
}

/** Caller-bound prompt registry on an Agent context (not a raw `get()` result). */
interface PromptHost {
  get(name: string): unknown
  systemPrompt?: SystemPromptService
}

/** The read face persona / locale resolution needs. */
interface SettingsReader {
  get(ns: string): unknown
}

/** Settings service face this bridge reads. Forms come from the volatile Config schema. */
interface SettingsForms {
  configure(presentation: { auto?: boolean }, owner: Context['fiber']): () => void
  describe(): ReadonlyArray<{ ns: string; value: unknown }>
}

interface LoaderTree {
  await(): Promise<void>
}

interface WecomFrame {
  body?: {
    text?: { content?: string }
    image?: { url?: string; aeskey?: string }
    sender?: { userid?: string }
    from?: { userid?: string }
    userid?: string
    chatid?: string
    chattype?: string | number
    /** Template-card click payload (`event.template_card_event`). */
    event?: {
      eventtype?: string
      /** 兼容旧结构：有的通道把 key 直接放在 event 上。 */
      event_key?: string
      task_id?: string
      /** 企微实际下发的结构：key/task_id 嵌在这一层里。 */
      template_card_event?: { card_type?: string; event_key?: string; task_id?: string }
    }
  }
}

interface WecomClient {
  replyStream(frame: unknown, streamId: string, content: string, finish: boolean): Promise<unknown>
  replyWelcome(frame: unknown, payload: { msgtype: string; text: { content: string } }): Promise<unknown>
  /** Download and AES-decrypt one inbound media file (the URL lives for five minutes). */
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>
  uploadMedia(
    fileBuffer: Buffer,
    options: { type: string; filename: string },
  ): Promise<{ media_id?: string; mediaId?: string }>
  sendMediaMessage(chatid: string, mediaType: string, mediaId: string): Promise<unknown>
  /** Proactive push (approval cards); independent of the inbound frame. */
  sendMessage(chatid: string, body: { msgtype: string; [key: string]: unknown }): Promise<unknown>
  /** 用点击事件的帧替换卡片内容（企微要求 5 秒内）。 */
  updateTemplateCard(frame: unknown, templateCard: Record<string, unknown>): Promise<unknown>
  connect(): void
  close?(): void
  on(event: string, handler: (...args: never[]) => void): void
}

/** Duck-typed approval request (the host service owns the real type). */
interface ApprovalRequestLike {
  agent: unknown
  toolName: string
  callId?: string
  reason?: string
  displayReason?: Record<string, string>
  signal?: AbortSignal
}

/** Join assistant text from one turn starting at `firstSeq`. */
function summarize(events: readonly LoggedEvent[], firstSeq: number): { text: string; reason: unknown } {
  let started = false
  let text = ''
  let reason: unknown
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') { started = true; continue }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const message = (event.data as AssistantMessageData).message
      const joined = (message?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = (event.data as { reason?: unknown }).reason
  }
  return { text, reason }
}

/**
 * Payload of the log's last `session/title` event — the title in force now.
 * @param session - live session whose log to fold.
 * @returns the payload, or undefined when the session has no title event.
 */
function latestTitleData(session: TitledSession): SessionTitleEventData | undefined {
  const events = session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.type === 'session/title') return event.data as SessionTitleEventData
  }
  return undefined
}

/** Read Host `locale.preference`; missing or unknown falls back to `zh`. */
function readLocalePreference(settings: SettingsReader | undefined): 'zh' | 'en' {
  if (settings === undefined) return 'zh'
  try {
    const section = settings.get(LOCALE_SETTINGS_NS)
    const pref = section && typeof section === 'object' && 'preference' in section
      ? (section as { preference?: unknown }).preference
      : undefined
    return pref === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

/** Strip leading `#` comment lines from a built-in persona file. */
function stripLeadingHashComments(text: string): string {
  const lines = text.split(/\r?\n/)
  let i = 0
  while (i < lines.length && /^\s*#/.test(lines[i] ?? '')) i++
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++
  return lines.slice(i).join('\n')
}

/** Resolve persona: personaFile → persona string → built-in locale file. */
function resolvePersona(config: Config, settings: SettingsReader | undefined): string {
  if (config.personaFile) {
    try {
      return readFileSync(config.personaFile, 'utf8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[im-bridge] 读取 personaFile 失败: ${message}`)
    }
  }
  if (config.persona !== '') return config.persona
  const file = readLocalePreference(settings) === 'en' ? DEFAULT_PERSONA_EN : DEFAULT_PERSONA_ZH
  try {
    return stripLeadingHashComments(readFileSync(file, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[im-bridge] 读取默认人设失败: ${message}`)
    return ''
  }
}

/**
 * Resolve the model for a new WeCom chat session. Both provider and model must be
 * non-empty to override; otherwise fall back to agent-default-model.
 */
function resolveSelection(
  config: Config,
  defaultModel: DefaultModel,
): ModelSelection {
  const provider = config.provider.trim()
  const model = config.model.trim()
  if (provider !== '' && model !== '') {
    const effort = config.reasoningEffort.trim()
    return effort === ''
      ? { provider, model }
      : { provider, model, reasoningEffort: ReasoningEffortId(effort) }
  }
  if (provider !== '' || model !== '') {
    console.warn('[im-bridge] provider/model 需同时填写才覆盖企微模型, 已回退 agent-default-model。')
  }
  return defaultModel.currentSelection()
}

/**
 * Read a Host service this bridge cannot run without.
 * @param ctx - host plugin context.
 * @param name - service name in the global service store.
 * @returns the service value.
 * @throws when the composition does not provide the service.
 */
function requireService<T>(ctx: Context, name: string): T {
  const service = ctx.get(name) as T | undefined
  if (service === undefined) throw new Error(`im-bridge: 需要 ${name} 服务`)
  return service
}

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * Read a volatile config reference down to the plain section the bridge uses.
 * @param value - schema output, either a plain section or a volatile reference.
 * @returns the current plain section.
 */
function unwrapConfig(value: unknown): Config {
  if (value !== null && typeof value === 'object' && VOLATILE_WRITE in value && 'get' in value) {
    const read = (value as { get?: unknown }).get
    if (typeof read === 'function') return unwrapConfig(read.call(value))
  }
  return value as Config
}

/**
 * Mount the WeCom bridge: settings namespace, then a deferred WebSocket after Loader settle.
 * @param ctx - host plugin context.
 * @param config - composition entry used as the settings `base` layer.
 */
export function apply(ctx: Context, config: Config): void {
  const agents = requireService<AgentRegistry>(ctx, 'agents')
  const sessions = requireService<SessionStore>(ctx, 'sessions')
  const defaultModel = requireService<DefaultModel>(ctx, 'agentDefaultModel')

  let settings: SettingsReader | undefined
  ctx.inject(['settings'], (settingsCtx) => {
    const forms = settingsCtx.get('settings') as SettingsForms | undefined
    // Hide the generated page; the browser half registers the WeCom card.
    const disposeAuto = forms?.configure({ auto: false }, ctx.fiber)
    settings = {
      get(ns: string) {
        return forms?.describe().find(row => row.ns === ns)?.value
      },
    }
    settingsCtx.effect(() => () => {
      disposeAuto?.()
      settings = undefined
    }, 'im-bridge: settings reader')
  })
  const cfg = (): Config => unwrapConfig(config)

  const chats = new Map<string, ChatState>()

  // ---- 多工作区（`/ws` 列表与切换）-------------------------------------
  /** 每个企微窗口当前绑定的工作区，重启后从磁盘恢复。 */
  const windowWorkspaces = new Map<string, WorkspaceBinding>()
  /** 配置默认工作区在 registry 中的记录；初始化期间解析。 */
  let defaultBinding: WorkspaceBinding | undefined
  /** 兜底绑定的重试时刻：registry 曾失败时按节流继续升级。 */
  let defaultBindingRetryAt = 0

  /** 读工作区服务：可选依赖，用 `ctx.get` 而不是 `inject`。 */
  function workspaceRegistry(): WorkspaceRegistry | undefined {
    return ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined
  }

  /** 把 registry 记录转成窗口绑定。 */
  function bindingFromEntity(entity: WorkspaceEntityLike): WorkspaceBinding {
    return { id: entity.id, path: entity.path, title: entity.title }
  }

  /**
   * registry 不可用时的路径绑定：id 退化为 `path:<dir>`，仍能把新会话开到
   * 正确目录，只是没有跨进程的稳定记录 id。
   */
  function fallbackBinding(path: string): WorkspaceBinding {
    return { id: `path:${path}`, path, title: basename(path) || path }
  }

  /** 默认工作区（初始化前退化为 `cfg().workspace` 的路径绑定）。 */
  function currentDefaultBinding(): WorkspaceBinding {
    return defaultBinding ?? fallbackBinding(cfg().workspace)
  }

  /** 绑定是否仍是 `path:` 兜底（registry 没拿到记录 id），需要继续升级。 */
  function isFallbackBinding(binding: WorkspaceBinding): boolean {
    return binding.id.startsWith('path:')
  }

  /** 展开 `~` / `~/…`（企微里贴的路径常用），其余原样返回。 */
  function expandUserPath(input: string): string {
    if (input === '~') return homedir()
    if (input.startsWith('~/')) return join(homedir(), input.slice(2))
    return input
  }

  /**
   * 判断两串路径是否指向同一目录：先比字符串，再用 realpath 兜底，
   * 这样默认 workspace 经由 symlink 拼写时仍能匹配 registry 的规范路径。
   */
  function sameWorkspacePath(left: string, right: string): boolean {
    if (left === right) return true
    try {
      return realpathSync(left) === realpathSync(right)
    } catch {
      return false
    }
  }

  /**
   * 解析（缺失则登记）`cfg().workspace` 对应的记录，作为默认工作区。
   *
   * 只有 registry 记录才算最终结果：registry 暂时不可用或调用失败时先用
   * `path:` 兜底（消息照常收发），随后由 `activeBindingFor` 的节流重试继续
   * 升级 —— 一次启动期的瞬时失败不会让默认绑定永久降级。
   */
  async function ensureDefaultBinding(): Promise<WorkspaceBinding> {
    const path = cfg().workspace
    if (
      defaultBinding !== undefined
      && !isFallbackBinding(defaultBinding)
      && sameWorkspacePath(defaultBinding.path, path)
    ) {
      return defaultBinding
    }
    const registry = workspaceRegistry()
    if (registry === undefined) {
      defaultBinding ??= fallbackBinding(path)
      return defaultBinding
    }
    try {
      const existing = await registry.resolveByPath(path)
      if (existing !== undefined) {
        defaultBinding = bindingFromEntity(existing)
        return defaultBinding
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[im-bridge] 解析默认工作区失败: ${message}`)
    }
    try {
      defaultBinding = bindingFromEntity(await registry.create(path))
      return defaultBinding
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[im-bridge] 登记默认工作区失败（先用路径兜底）: ${message}`)
    }
    defaultBinding ??= fallbackBinding(path)
    return defaultBinding
  }

  /** `$DSH_HOME/dsh-im-bridge/workspace-bindings.json`；`DSH_HOME` 为空用 `~/.dsh`。 */
  function workspaceBindingsFile(): string {
    const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
    return join(home, 'dsh-im-bridge', 'workspace-bindings.json')
  }

  /** 读取窗口绑定；文件缺失或损坏都不致命。 */
  function loadWorkspaceBindings(): void {
    const file = workspaceBindingsFile()
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoredWorkspaceBindings> | null
      if (parsed === null || typeof parsed !== 'object') return
      if (parsed.version !== 1) {
        // 静默丢弃会让用户以为绑定“自己没了”，下一次保存还会覆盖原文件。
        console.warn(
          `[im-bridge] ${file} 版本不兼容（${String(parsed.version)}），本次忽略；下次保存会覆盖它`,
        )
        return
      }
      const windows = parsed.windows
      if (windows === null || typeof windows !== 'object') {
        console.warn(`[im-bridge] ${file} 缺少 windows 字段，本次忽略`)
        return
      }
      for (const [key, value] of Object.entries(windows)) {
        if (value === null || typeof value !== 'object') continue
        const { id, path, title } = value as Partial<WorkspaceBinding>
        if (typeof id !== 'string' || typeof path !== 'string' || typeof title !== 'string') continue
        if (id === '' || path === '') continue
        windowWorkspaces.set(key, { id, path, title })
      }
      if (windowWorkspaces.size > 0) {
        console.log(`[im-bridge] 已恢复 ${String(windowWorkspaces.size)} 个工作区绑定`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[im-bridge] 读取 workspace-bindings.json 失败: ${message}`)
    }
  }

  /** 原子写回窗口绑定（tmp + rename）。 */
  function saveWorkspaceBindings(): void {
    const file = workspaceBindingsFile()
    const payload: StoredWorkspaceBindings = {
      version: 1,
      windows: Object.fromEntries([...windowWorkspaces.entries()]),
    }
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(tmp, file)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[im-bridge] 保存 workspace-bindings.json 失败: ${message}`)
    }
  }

  /**
   * 窗口当前生效的工作区：有绑定且 registry 仍认识该记录就用绑定，
   * 否则清掉失效绑定并回退默认工作区。
   */
  function activeBindingFor(windowKey: string): WorkspaceBinding {
    // registry 尚未就绪、或默认绑定还只是 `path:` 兜底时，按节流继续升级。
    const needsDefaultUpgrade = defaultBinding === undefined || isFallbackBinding(defaultBinding)
    if (needsDefaultUpgrade && workspaceRegistry() !== undefined) {
      const now = Date.now()
      if (now - defaultBindingRetryAt >= DEFAULT_BINDING_RETRY_MS) {
        defaultBindingRetryAt = now
        void ensureDefaultBinding()
      }
    }
    const saved = windowWorkspaces.get(windowKey)
    if (saved === undefined) return currentDefaultBinding()
    const registry = workspaceRegistry()
    if (registry === undefined) return saved
    try {
      const entity = registry.get(saved.id)
      if (entity !== undefined) return bindingFromEntity(entity)
      // id 找不到时先按路径再找一次（与 init 的恢复同款），
      // 只有路径也无归属才放弃绑定，避免一次记录变更就永久丢窗口设置。
      const byPath = registry.list().find((entry) => sameWorkspacePath(entry.path, saved.path))
      if (byPath !== undefined) {
        const recovered = bindingFromEntity(byPath)
        windowWorkspaces.set(windowKey, recovered)
        saveWorkspaceBindings()
        console.log(`[im-bridge] 窗口 ${windowKey} 的工作区 id 已变更，按路径恢复为 ${recovered.path}`)
        return recovered
      }
      windowWorkspaces.delete(windowKey)
      saveWorkspaceBindings()
      console.log(`[im-bridge] 窗口 ${windowKey} 的工作区记录已失效，回退默认工作区`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[im-bridge] 校验工作区绑定失败（${windowKey}）: ${message}`)
      return saved
    }
    return currentDefaultBinding()
  }

  /** `workspaceAllowFrom` 为空表示允许所有已授权发送者切换。 */
  function canManageWorkspace(sender: string): boolean {
    const allowFrom = cfg().workspaceAllowFrom
    return allowFrom.length === 0 || allowFrom.includes(sender)
  }

  /**
   * 启动时初始化工作区状态：恢复窗口绑定 → 解析默认工作区 → 清理 registry
   * 中已消失的记录。在 Loader 结束、WebSocket 连接之前调用，保证第一条
   * 入站消息就能确定归属。
   */
  async function initWorkspaceBindings(): Promise<void> {
    loadWorkspaceBindings()
    try {
      await ensureDefaultBinding()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[im-bridge] 默认工作区初始化失败: ${message}`)
    }
    const registry = workspaceRegistry()
    if (registry === undefined) {
      console.warn('[im-bridge] workspaceRegistry 不可用，/ws 列表与切换降级为路径绑定')
      return
    }
    let dirty = false
    for (const [key, saved] of [...windowWorkspaces.entries()]) {
      // `get` 与 `resolveByPath` 各自兜底：前者失败也必须继续按路径找一次，
      // 否则一次瞬时异常就跳过恢复、把绑定删掉。
      let entity: WorkspaceEntity | undefined
      try {
        entity = registry.get(saved.id)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[im-bridge] 读取工作区记录失败（${key}）: ${message}`)
      }
      if (entity !== undefined) {
        const fresh = bindingFromEntity(entity)
        if (fresh.path !== saved.path || fresh.title !== saved.title) {
          windowWorkspaces.set(key, fresh)
          dirty = true
        }
        continue
      }
      try {
        const byPath = await registry.resolveByPath(saved.path)
        if (byPath !== undefined) {
          windowWorkspaces.set(key, bindingFromEntity(byPath))
          dirty = true
          continue
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[im-bridge] 按路径恢复工作区绑定失败（${key}）: ${message}`)
        continue
      }
      windowWorkspaces.delete(key)
      dirty = true
      console.log(`[im-bridge] 窗口 ${key} 的工作区已不存在，回退默认工作区`)
    }
    if (dirty) saveWorkspaceBindings()
    const current = currentDefaultBinding()
    console.log(`[im-bridge] 默认工作区: ${current.title} (${current.path})`)
  }

  let wecomCliReady = false
  let officeSkills: WecomSkill[] = []
  /** Launcher and credential directory the gated tool spawns with; set once wecom-cli is usable. */
  let officeCli: { binJs: string; configDir: string } | undefined

  /**
   * Install the office layer on one Agent: wecomcli-* skills and the gated
   * `wecom_cli` tool. Both register through the Agent's own context, so a group
   * chat or the GUI never sees them. Idempotent per Agent, and retried on each
   * inbound message because skills can arrive from the Settings button later.
   */
  function installOfficeLayer(agentCtx: Context, st: ChatState): void {
    if (!wecomCliReady) return
    if (!shouldInjectWecomOfficeSkills(st.kind, st.office)) return
    if (!st.officeSkillsRegistered) {
      const count = registerWecomOfficeSkills(agentCtx, officeSkills)
      if (count > 0) {
        st.officeSkillsRegistered = true
        console.log(`[im-bridge] 已在该 Agent 注册 ${String(count)} 个 wecomcli-*`)
      }
    }
    if (st.officeToolRegistered || officeCli === undefined) return
    try {
      st.officeToolRegistered = registerWecomCliTool(agentCtx, officeCli.binJs, officeCli.configDir)
      if (st.officeToolRegistered) {
        console.log(`[im-bridge] 已在该 Agent 注册 ${WECOM_CLI_TOOL_NAME} 工具`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[im-bridge] 注册 ${WECOM_CLI_TOOL_NAME} 失败: ${message}`)
    }
  }

  ctx.inject(['connection'], (bound) => {
    const rpc = (bound.get('connection') as { rpc?: HostConnectionRpc } | undefined)?.rpc
    if (rpc === undefined) {
      console.warn(`[im-bridge] ${SKILLS_RPC_UNAVAILABLE_MESSAGE}`)
      return
    }
    bound.effect(
      () => rpc.handle(IM_BRIDGE_RPC_CHANNEL, async (endpoint, _payload, signal) => {
        if (endpoint !== INSTALL_SKILLS_ENDPOINT) {
          return {
            ok: false,
            error: { code: 'internal', message: `unknown endpoint ${endpoint}`, details: {} },
          }
        }
        if (signal.aborted) {
          return {
            ok: false,
            error: { code: 'cancelled', message: '安装已取消', details: {} },
          }
        }
        try {
          const dest = resolveSkillsDir(cfg().wecomCli.skillsDir, cfg().workspace)
          const result = await installOfficialWecomSkills(dest, { signal })
          officeSkills = loadWecomSkills(result.dest).filter(skill => skill.name.startsWith('wecomcli-'))
          for (const st of chats.values()) {
            if (st.agent === undefined) continue
            installOfficeLayer(st.agent.ctx, st)
          }
          console.log(`[im-bridge] 已安装 ${String(result.count)} 个 wecomcli-* 到 ${result.dest}`)
          return { ok: true, value: result }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { ok: false, error: { code: 'internal', message, details: {} } }
        }
      }, { authority: 'loopback' }),
      'im-bridge: wecomcli.installSkills',
    )
  })

  void (async () => {
    const loader = ctx.get('loader') as LoaderTree | undefined
    await loader?.await()
    // 时间盒：registry 启动卡住时不能拖住 WebSocket 连接——消息通路优先，
    // 未完成的工作区初始化由首条消息的按节流重试继续收尾。
    const workspaceInit = initWorkspaceBindings().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[im-bridge] 工作区初始化异常: ${message}`)
    })
    const workspaceInitTimeout = new Promise<void>((done) => {
      const timer = setTimeout(() => {
        console.warn('[im-bridge] 工作区初始化超时，改为按需完成（不阻塞消息收发）')
        done()
      }, 5000)
      timer.unref()
    })
    await Promise.race([workspaceInit, workspaceInitTimeout])
    const { botId, secret } = cfg()
    if (!botId || !secret) {
      console.warn(
        '[im-bridge] 跳过启动: 缺少 botId/secret。请在 profile cordis.patch.yml 或 Settings → 插件配置中填写后重启。',
      )
      return
    }

    const wecomCli = cfg().wecomCli
    if (wecomCli.enabled) {
      const skillsDir = resolveSkillsDir(wecomCli.skillsDir, cfg().workspace)
      officeSkills = loadWecomSkills(skillsDir).filter(skill => skill.name.startsWith('wecomcli-'))
      const wecomcliCount = countWecomcliSkills(officeSkills)
      if (wecomcliCount === 0) {
        console.warn(
          `[im-bridge] 未找到 wecomcli-* skills（${skillsDir}）。${skillsInstallHint(skillsDir)}`,
        )
      } else {
        console.log(
          `[im-bridge] 已从 ${skillsDir} 加载 ${String(wecomcliCount)} 个 wecomcli-*，将在办公单聊 Agent 上注册`,
        )
      }
      const leakCount = countWorkspaceWecomcliLeaks(cfg().workspace)
      if (leakCount > 0) {
        console.warn(`[im-bridge] ${WORKSPACE_WECOMCLI_LEAK_MESSAGE}（${String(leakCount)}）`)
      }
      // Missing wecomcli-* only warns: chat and dsh web keep running without the office layer.
      if (wecomcliCount > 0) {
        if (!shouldEnableWecomCli(true, wecomCli.allowFrom)) {
          console.warn(`[im-bridge] ${ALLOW_FROM_REQUIRED_MESSAGE}`)
        } else {
          const binJs = resolveWecomBin()
          if (binJs === undefined) {
            console.warn('[im-bridge] 未找到 @wecom/cli 二进制，办公命令不可用。请确认插件依赖已安装。')
          } else {
            try {
              const ensured = tryEnsureConfigDir(resolveConfigDir(wecomCli.configDir, cfg().workspace))
              if (!ensured.ok) {
                console.warn(
                  `[im-bridge] wecom-cli 凭证目录不可用（${ensured.message}），已跳过办公层。dsh web 继续运行。`,
                )
              } else {
                const { dir: configDir } = ensured
                wecomCliReady = true
                officeCli = { binJs, configDir }
                console.log(`[im-bridge] wecom-cli 凭证目录: ${configDir}`)
                const pathResult = ensureOnPath()
                console.log(
                  `[im-bridge] PATH 上的 wecom-cli 已改为拒绝执行: ${pathResult.shimDir}${pathResult.shadowed ? '（已遮蔽另一个 wecom-cli）' : ''}`,
                )
                let status = await probeAuth(binJs, configDir)
                if (status === 'unauthorized') {
                  if ((await trySeedAuth(binJs, cfg().botId, cfg().secret, configDir)) === undefined) {
                    status = await probeAuth(binJs, configDir)
                  }
                }
                if (status === 'authorized') {
                  console.log('[im-bridge] wecom-cli 已授权')
                } else if (status === 'unauthorized') {
                  console.warn(
                    `[im-bridge] wecom-cli 未能用 botId/secret 完成授权。请在 host 上执行 ${authInitHint(configDir)}（输入同一套密钥，不要全局安装）。`,
                  )
                } else {
                  console.warn('[im-bridge] wecom-cli auth show 失败。')
                }
              }
            } catch (error) {
              wecomCliReady = false
              officeCli = undefined
              const message = error instanceof Error ? error.message : String(error)
              console.warn(
                `[im-bridge] wecom-cli 办公层初始化失败（${message}），已跳过。dsh web 继续运行。`,
              )
            }
          }
        }
      }
    }

    /**
     * Add the channel prefix to a title the Host generated. `session/event`
     * runs inside the append publication window, which refuses a reentrant
     * append, so the prefixed title goes out in a microtask and re-reads the
     * log first: an already prefixed tail (including the one this appends)
     * stops the chain.
     */
    function prefixWecomTitle(session: TitledSession, st: ChatState): void {
      const kind = st.kind
      if (kind === undefined) return
      queueMicrotask(() => {
        const data = latestTitleData(session)
        if (data === undefined) return
        // An explicit GUI rename is pinned on purpose; only automatic titles get labelled.
        if (data.source?.kind === 'user') return
        const raw = typeof data.title === 'string' ? data.title : ''
        const next = wecomDisplayTitle(kind, raw, kind === 'single' ? st.sender : undefined)
        if (next === raw) return
        const messageSeqs = Array.isArray(data.messageSeqs)
          ? data.messageSeqs.filter((seq) => typeof seq === 'number')
          : []
        // A non-user title must cite at least one user/message seq, or the
        // session-title invariant rejects the append.
        if (messageSeqs.length === 0) return
        try {
          session.append('session/title', {
            title: next,
            messageSeqs,
            source: data.source ?? { kind: 'fallback' },
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.error(`[im-bridge] 加标题前缀失败: ${message}`)
        }
      })
    }

    /**
     * Sessions the GUI archived. Archiving is the workspace registry's global
     * set, not session state, and it has no inverse: an archived session is
     * invisible in every list, so this plugin must stop writing to it.
     */
    function archivedSessions(): ReadonlySet<string> {
      const registry = ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined
      if (registry === undefined) return new Set()
      try {
        return new Set(registry.archivedSessionIds)
      } catch (error) {
        // The getter throws until the registry finishes its own startup.
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[im-bridge] 读归档会话失败: ${message}`)
        return new Set()
      }
    }

    /**
     * Fold a session into its workspace group, so the sidebar lists it under the
     * `binding` this message runs in instead of falling back to 「未分组」.
     * `registry.create` canonicalizes the directory first, so repeated calls
     * reuse one record; the attach itself validates the session header cwd
     * against that directory, which is why new sessions are created with
     * `meta.cwd = binding.path`.
     * Best-effort: a registry failure must not break the message path.
     */
    async function attachToWorkspace(sessionId: SessionId, binding: WorkspaceBinding): Promise<void> {
      const registry = workspaceRegistry()
      if (registry === undefined) return
      try {
        const workspace = await registry.create(binding.path)
        await workspace.attachSession(sessionId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[im-bridge] 会话归入工作区失败（${binding.path}）: ${message}`)
      }
    }

    async function unpinLegacyWecomTitle(agent: LiveAgent): Promise<void> {
      const titles = ctx.get('sessionTitle') as SessionTitleService | undefined
      if (titles === undefined) return
      try {
        const snapshot = titles.get(agent.session)
        if (snapshot?.source?.kind !== 'user') return
        if (!isLegacyPinnedWecomTitle(snapshot.title)) return
        await titles.refresh(agent.session)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[im-bridge] 解开旧标题失败: ${message}`)
      }
    }

    /**
     * Register persona + wecom prompt on this Agent's layer, synchronously.
     * Must use `agentCtx.systemPrompt` (caller-bound). `inject()` without await
     * yields a microtask and can publish the Agent before the section exists;
     * `adopt` never re-runs setup.
     */
    function installWecomChannel(agentCtx: Context, st: ChatState, cwdOf: () => string): void {
      if (st.wecomPromptInstalled) return
      const host = agentCtx as Context & PromptHost
      if (host.get('systemPrompt') === undefined || host.systemPrompt === undefined) {
        console.warn('[im-bridge] 当前 Agent 没有 systemPrompt，企微提示词未注入')
        return
      }
      const prompt = host.systemPrompt
      // DSH ≥0.2.1 只注册 provider/model 两个提示词变量，内置 persona 与用户
      // personaFile 里的 `{{cwd}}` 会按严格模式抛错（unknown prompt variable）
      // → 整轮直接失败。这里在 Agent 作用域补注册，恢复文档承诺的占位符。
      registerPromptVariable(prompt, 'cwd', () => cwdOf())
      try {
        prompt.section({
          name: 'deployment:persona',
          order: 0,
          text: () => resolvePersona(cfg(), settings),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[im-bridge] 人设段未覆盖（可能已由 preset 注册）: ${message}`)
      }
      try {
        prompt.section({
          name: 'channel:wecom-cli',
          order: 1,
          // Re-read per request: a group Agent is shared, and its sender —
          // hence `st.office` — changes message to message. Only an office
          // 1:1 gets the tool, so only it may get the office prompt.
          // Always inject: WeCom has no GUI even when wecomCli is off.
          text: () => wecomCliReady && shouldInjectWecomOfficeSkills(st.kind, st.office)
            ? WECOM_CLI_PROMPT
            : WECOM_CLI_NO_OFFICE_PROMPT,
        })
        console.log(
          `[im-bridge] 已注入企微提示词 office=${String(st.office)} kind=${st.kind ?? '?'}`,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[im-bridge] 注入企微提示词失败: ${message}`)
      }
      st.wecomPromptInstalled = true
    }

    /**
     * Resolve (or create) the Agent behind one *window × workspace* pair.
     * `sessionKey` already carries the workspace suffix for non-default
     * bindings, so each workspace keeps its own independent session and
     * switching back resumes the old one.
     */
    async function ensureAgent(
      ref: WecomSessionRef,
      binding: WorkspaceBinding,
      sessionKey: string,
    ): Promise<ChatState> {
      let st = chats.get(sessionKey)
      if (st === undefined) {
        st = emptyChatState()
        chats.set(sessionKey, st)
      }
      st.kind = ref.kind
      if (st.agent !== undefined) {
        if (st.sessionId === undefined || !archivedSessions().has(st.sessionId)) {
          // Office access is decided per inbound sender, and skills can arrive
          // from the Settings button after this Agent was created.
          installOfficeLayer(st.agent.ctx, st)
          return st
        }
        console.log(`[im-bridge] 会话 ${st.sessionId} 已归档，改开新会话`)
        st.agent = undefined
        st.sessionId = undefined
        st.wecomPromptInstalled = false
        st.officeSkillsRegistered = false
        st.officeToolRegistered = false
      }

      const persistence = ctx.get('sessionPersistence') as SessionPersistence | undefined
      const headers = persistence === undefined ? [] : await persistence.list()
      // The default binding keeps every header so the pre-workspace `wecom-*`
      // sessions resume untouched; any other binding only considers sessions
      // already created in its own directory, or a resume would drag an Agent
      // into the wrong cwd.
      const isDefault = sameWorkspacePath(binding.path, currentDefaultBinding().path)
      const ownedHeaders = isDefault
        ? headers
        : headers.filter((header) => header.cwd !== undefined && sameWorkspacePath(header.cwd, binding.path))
      const plan = planWecomBind(sessionKey, {
        live: (id) => agents.get(SessionId(id)) !== undefined,
        stored: new Set(ownedHeaders.map((header) => header.id)),
        archived: archivedSessions(),
      })
      const sessionId = SessionId(plan.sessionId)
      const stored = ownedHeaders.find((header) => header.id === sessionId)

      const attach = (agent: LiveAgent, how: 'adopt' | 'resume' | 'create'): void => {
        st.agent = agent
        st.sessionId = sessionId
        st.kind = ref.kind
        if (agent.ctx === undefined) {
          console.warn('[im-bridge] Agent 没有 ctx，无法注入企微提示词')
        } else {
          installWecomChannel(agent.ctx, st, () => agent.session.header?.cwd ?? stored?.cwd ?? binding.path)
          installOfficeLayer(agent.ctx, st)
          // 审批事件按 Agent 作用域分发：注册在插件根上收不到，必须挂 Agent 自己的上下文。
          installApprovalRelay(agent.ctx, st)
        }
        void unpinLegacyWecomTitle(agent)
        const cwd = agent.session.header?.cwd ?? stored?.cwd
        if (cwd !== undefined && !sameWorkspacePath(cwd, binding.path)) {
          console.warn(
            `[im-bridge] 会话 ${sessionId} 仍使用存档目录 ${cwd}，当前 workspace=${binding.path}`,
          )
        }
        const epoch = plan.epoch > 1 ? ` 第${String(plan.epoch)}段` : ''
        console.log(
          `[im-bridge] 为 ${ref.key} @${binding.title} ${how}会话 ${sessionId}${epoch} userid=${ref.sender} chattype=${ref.kind} chatid=${ref.chatid ?? ''}`,
        )
        // Fire-and-forget: `attach` stays synchronous, and its three callers
        // (adopt / resume / create) must not wait on a ledger write.
        void attachToWorkspace(sessionId, binding)
      }

      const live = agents.get(sessionId)
      if (plan.bind === 'adopt' && live !== undefined) {
        attach(live, 'adopt')
        return st
      }

      const selection = resolveSelection(cfg(), defaultModel)
      const presets = ctx.get('agentPresets') as AgentPresets | undefined
      const presetId = (plan.bind === 'resume' && stored?.agentPreset) ? stored.agentPreset : cfg().agentPreset
      let resolvedId = presetId
      if (presets !== undefined) {
        resolvedId = (await presets.resolve(presetId)).id
      }
      const setup = async (agentCtx: Context): Promise<void> => {
        const selected = { current: selection, assembled: undefined }
        installModelSelection(agentCtx, selected)
        if (presets !== undefined) await presets.mount(agentCtx, resolvedId)
        installWecomChannel(agentCtx, st, () => binding.path)
      }
      const agentOptions = { provider: selection.provider, model: selection.model }

      try {
        if (plan.bind === 'resume') {
          const { agent } = await agents.resume({
            resumeSessionId: sessionId,
            agentOptions,
            setup,
          })
          attach(agent, 'resume')
          return st
        }
        const { agent } = await agents.create({
          sessionId,
          meta: { cwd: binding.path, agentPreset: resolvedId },
          agentOptions,
          setup,
        })
        attach(agent, 'create')
        return st
      } catch (error) {
        const raced = agents.get(sessionId)
        if (raced !== undefined) {
          attach(raced, 'adopt')
          return st
        }
        // `planWecomBind` derives its `stored` set from the persistence headers,
        // so a session that storage still owns but the headers no longer list
        // makes it pick `create` for an occupied id. `agents.create` then rejects
        // with "already exists" — which used to abort the whole message and leave
        // the bot silently unanswered, even though the session was perfectly
        // resumable. Recover by resuming it instead of rethrowing.
        const cause = error instanceof Error ? error.message : String(error)
        if (cause.includes('already exists')) {
          try {
            const { agent } = await agents.resume({
              resumeSessionId: sessionId,
              agentOptions,
              setup,
            })
            attach(agent, 'resume')
            console.log(`[im-bridge] 会话 ${sessionId} 已存在，改用 resume 复用`)
            return st
          } catch (retryError) {
            const retryMessage = retryError instanceof Error ? retryError.message : String(retryError)
            console.error(`[im-bridge] 会话 ${sessionId} resume 兜底也失败: ${retryMessage}`)
          }
        }
        throw error
      }
    }

    ctx.on('session/event', (session: TitledSession, event: LoggedEvent) => {
      const thinking = cfg().thinking
      const prefix = thinking?.activityPrefix ?? DEFAULT_THINKING.activityPrefix
      const flashMs = Number.isFinite(thinking?.intervalMs) && thinking.intervalMs > 0
        ? thinking.intervalMs
        : DEFAULT_THINKING.intervalMs
      for (const st of chats.values()) {
        if (st.sessionId !== session.id) continue
        if (event.type === 'session/title') {
          prefixWecomTitle(session, st)
          continue
        }
        if (event.type === 'assistant/chunk') {
          const next = streamPhaseFromChunk((event.data as ChunkData).chunk)
          if (next !== null) st.modelStreamPhase = next
          continue
        }
        if (event.type === 'tool/call') {
          const data = event.data as ToolCallData
          const toolName = data.name ?? ''
          const callId = data.callId
          if (callId !== undefined) {
            st.lastToolByCallId.set(callId, toolName)
            // Kept until the approval prompt (or the result) consumes it.
            if (data.arguments !== undefined) st.toolArgsByCallId.set(callId, data.arguments)
          }
          st.activityClearAt = 0
          st.lastActivity = `${prefix}${labelTool(toolName, thinking)}`
          return
        }
        if (event.type === 'tool/result') {
          const data = event.data as ToolResultData
          const callId = data.message?.source?.callId
          const rawName = (callId !== undefined && st.lastToolByCallId.get(callId))
            || [...st.lastToolByCallId.values()].at(-1)
            || ''
          if (callId !== undefined) st.lastToolByCallId.delete(callId)
          if (callId !== undefined) st.toolArgsByCallId.delete(callId)
          const label = labelTool(rawName || '工具', thinking)
          const failed = data.error !== undefined
          st.lastActivity = failed ? `❌ ${label} 失败` : `✅ ${label} 完成`
          st.activityClearAt = Date.now() + flashMs
          st.modelStreamPhase = 'idle'
        }
      }
    })

    // The SDK's own WSClient types its listeners per event name; this bridge
    // reads frames as JSON and needs one permissive `on`, so the narrowing goes
    // through unknown rather than widening every handler to the SDK's maps.
    const { default: AiBot, generateReqId } = await import('@wecom/aibot-node-sdk') as unknown as {
      default: { WSClient: new (options: { botId: string; secret: string }) => WecomClient }
      generateReqId: (kind: string) => string
    }

    /**
     * Gate image input on the configured model's declared input modalities.
     * Absent metadata means "unknown", which stays allowed; an explicit list
     * without `image` is negative capability and must not reach the model.
     * @returns the Chinese reply, or undefined when the image may be forwarded.
     */
    async function imageCapabilityBlocker(): Promise<string | undefined> {
      const llm = ctx.get('llm') as LlmService | undefined
      if (llm === undefined) {
        console.warn('[im-bridge] llm 服务不可用，无法校验看图能力')
        return '模型服务不可用，暂时无法接收图片'
      }
      const selection = resolveSelection(cfg(), defaultModel)
      try {
        const info = await llm.resolveModelInfo(selection.provider, selection.model)
        if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
          return `当前模型 ${selection.model} 不支持看图，请切换模型后重试`
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[im-bridge] 读取模型能力失败: ${message}`)
        return '无法确认当前模型是否支持看图，请稍后重试'
      }
      return undefined
    }

    /**
     * Turn one already-started image download into a durable attachment:
     * await → magic-number check → capability gate → `attachments.saveImage`.
     * Never throws; every failure becomes a Chinese reply.
     * @param image - download promise started by the event callback.
     * @returns the durable reference or the reply to send instead.
     */
    async function prepareInboundImage(
      image: InboundImage,
    ): Promise<{ ok: true; ref: ImageAttachmentRef } | { ok: false; reply: string }> {
      let buffer: Buffer
      let filename: string | undefined
      try {
        ({ buffer, filename } = await image.download)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[im-bridge] 图片下载失败: ${message}`)
        return { ok: false, reply: '图片下载失败，请重发一次' }
      }
      const mediaType = detectImageMediaType(buffer)
      if (mediaType === undefined) {
        console.warn('[im-bridge] 收到不支持的图片格式，已拒绝')
        return { ok: false, reply: '不支持该图片格式，请转成 PNG/JPEG/GIF/WebP 后重发' }
      }
      const blocker = await imageCapabilityBlocker()
      if (blocker !== undefined) return { ok: false, reply: blocker }
      const attachments = ctx.get('attachments') as AttachmentStore | undefined
      if (attachments === undefined) {
        console.warn('[im-bridge] attachments 服务不可用，无法接收图片')
        return { ok: false, reply: '附件服务不可用，暂时无法接收图片' }
      }
      try {
        const ref = await attachments.saveImage({ data: buffer, mediaType, name: filename })
        return { ok: true, ref }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[im-bridge] 保存图片失败: ${message}`)
        return { ok: false, reply: imageLimitMessage(error) }
      }
    }

    async function handle(
      frame: WecomFrame,
      ref: WecomSessionRef,
      content: string,
      binding: WorkspaceBinding,
      sessionKey: string,
      image?: InboundImage,
    ): Promise<void> {
      let st = chats.get(sessionKey)
      if (st === undefined) {
        st = emptyChatState()
        chats.set(sessionKey, st)
      }
      st.office = senderHasOfficeAccess(cfg().wecomCli.allowFrom, ref.sender)
      st.sender = ref.sender
      st.chatid = ref.chatid
      // Image work stays inside the queue: a failure answers the chat without
      // creating a session or burning an agent turn.
      let imageRef: ImageAttachmentRef | undefined
      if (image !== undefined) {
        const prepared = await prepareInboundImage(image)
        if (!prepared.ok) {
          await replyCommand(frame, prepared.reply)
          return
        }
        imageRef = prepared.ref
      }
      st = await ensureAgent(ref, binding, sessionKey)
      const startedAt = Date.now()
      const streamId = generateReqId('stream')
      let stopThinking: (() => void) | null = null
      st.lastActivity = ''
      st.activityClearAt = 0
      st.lastToolByCallId.clear()
      st.modelStreamPhase = 'idle'
      st.streamStatusTick = 0
      try {
        await ws.replyStream(frame, streamId, cfg().startHint, false)
        stopThinking = startThinking(
          ws, frame, streamId, startedAt, cfg().agentTimeoutSec,
          () => {
            if (st.activityClearAt > 0 && Date.now() >= st.activityClearAt) {
              st.lastActivity = ''
              st.activityClearAt = 0
            }
            if (st.lastActivity) return st.lastActivity
            const thinking = cfg().thinking
            const tick = st.streamStatusTick++
            if (st.modelStreamPhase === 'reasoning') {
              return pickStatusLine(
                thinking?.reasoningStatus,
                DEFAULT_THINKING.reasoningStatus,
                tick,
              )
            }
            if (st.modelStreamPhase === 'outputting') {
              return pickStatusLine(
                thinking?.outputStatus,
                DEFAULT_THINKING.outputStatus,
                tick,
              )
            }
            return ''
          },
          cfg().thinking,
          () => (st.lastActivity ? 'idle' : st.modelStreamPhase),
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[im-bridge] 占位回复失败: ${message}`)
      }
      try {
        if (st.agent === undefined) throw new Error('im-bridge: chat agent missing')
        await st.agent.whenIdle()
        const firstSeq = st.agent.session.seq
        const blocks: InboundContent[] = [
          { type: 'text', text: content || IMAGE_PLACEHOLDER_TEXT },
        ]
        if (imageRef !== undefined) blocks.push({ type: 'image', attachment: imageRef })
        st.agent.followup(createUserMessage({
          // The local image reference mirrors the attachment service's durable
          // shape; the branded attachment id is not part of this package's deps.
          content: blocks as Parameters<typeof createUserMessage>[0]['content'],
          source: { kind: 'user' },
        }))
        await st.agent.whenIdle()
        await sessions.flush(st.agent.session)
        const outcome = summarize(st.agent.session.snapshotEvents(), firstSeq)
        if (stopThinking) stopThinking()
        const ms = Date.now() - startedAt
        const body = outcome.text || '(agent 无输出)'
        // 图片按 Agent 实际 cwd 收集：非默认 workspace 时工作目录不再是配置值。
        const collected = collectReplyPngs(body, st.agent?.session.header?.cwd ?? binding.path)
        for (const reason of collected.skipped) {
          console.warn(`[im-bridge] 跳过图片: ${reason}`)
        }
        let reply = truncate(body, (cfg().maxReplyBytes || 20000) - 200) + footerOf(ms)
        if (collected.skipped.length > 0) {
          reply = truncate(
            `${reply}\n⚠️ ${collected.skipped.length} 张图片未发送（过大、越权或不存在）`,
            cfg().maxReplyBytes || 20000,
          )
        }
        console.log(`[im-bridge] ${ref.key} 完成 (${Buffer.byteLength(reply, 'utf8')}B, ${fmtDuration(ms)})`)
        await sendFinal(ws, frame, streamId, reply)
        if (collected.images.length > 0) {
          await sendCollectedPngs(ws, resolveChatId(frame, ref.sender), collected.images)
        }
      } catch (error) {
        if (stopThinking) stopThinking()
        const ms = Date.now() - startedAt
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[im-bridge] agent 失败: ${message}`)
        try {
          await sendFinal(ws, frame, streamId, `处理失败: ${truncate(message, 400)}\n\n---\n❌ 耗时 ${fmtDuration(ms)}`)
        } catch (retryError) {
          const retryMessage = retryError instanceof Error ? retryError.message : String(retryError)
          console.error(`[im-bridge] 错误回复也失败: ${retryMessage}`)
        }
      }
    }

    /**
     * `/ws` 帮助文本：命令一律由插件直接回复，不进入模型。
     */
    const workspaceHelpText = [
      '📖 企微工作区命令',
      '/ws（/workspaces、/workspace、/工作区）— 列出所有工作区并标出当前',
      '/ws <序号|title|路径|id> — 切换本窗口的工作区',
      '/ws reset — 回到默认工作区',
      '/ws add <路径> — 登记已有目录并切换（需 workspaceAdd=true）',
      '/ws help — 显示本帮助',
      '普通文本仍交给 Agent；以上命令不会发给模型。',
    ].join('\n')

    /** 直接把命令结果发回当前会话帧，不占用 Agent 流。 */
    async function replyCommand(frame: WecomFrame, text: string): Promise<void> {
      try {
        // 企微文本消息有 2048 字节上限，列表过长先截断，避免整条发送失败。
        await ws.replyStream(frame, generateReqId('stream'), truncate(text, 1800), true)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[im-bridge] 工作区命令回复失败: ${message}`)
      }
    }

    /** `/ws` 列表：序号、当前标记、title、路径、会话数与目录缺失警告。 */
    async function workspaceListText(windowKey: string): Promise<string> {
      const current = activeBindingFor(windowKey)
      const registry = workspaceRegistry()
      if (registry === undefined) {
        return [
          `📂 当前工作区：${current.title}`,
          `路径：${current.path}`,
          '⚠️ workspaceRegistry 不可用，暂时无法列出全部工作区',
        ].join('\n')
      }
      const entities = registry.list()
      const lines = [`📂 工作区列表（共 ${String(entities.length)} 个）`]
      for (let index = 0; index < entities.length; index += 1) {
        const entity = entities[index]
        const marked = entity.id === current.id || sameWorkspacePath(entity.path, current.path)
        let warn = ''
        try {
          if ((await entity.status()) !== 'ok') warn = ' ⚠️ 目录不存在'
        } catch {
          warn = ' ⚠️ 状态未知'
        }
        const sessions = entity.sessionIds?.length ?? 0
        lines.push(
          `${String(index + 1)}. ${marked ? '← 当前 ' : ''}${entity.title} · ${entity.path} · ${String(sessions)} 个会话${warn}`,
        )
      }
      const footer = '切换：/ws <序号|title|路径|id>　回默认：/ws reset　帮助：/ws help'
      const body = lines.join('\n')
      // 企微文本上限约 2048B：先截断正文再补页脚，别让 `truncate` 把最有用的
      // 操作指引那一行切掉。
      const budget = 1600 - Buffer.byteLength(`${footer}\n`, 'utf8')
      return `${truncate(body, budget)}\n${footer}`
    }

    /**
     * Handle one `/ws …` command: every branch replies directly on the frame,
     * so a command never reaches the model and never burns a turn.
     */
    async function handleWorkspaceCommand(
      frame: WecomFrame,
      ref: WecomSessionRef,
      command: WorkspaceCommand,
    ): Promise<void> {
      console.log(`[im-bridge] 工作区命令 key=${ref.key} kind=${command.kind}`)
      if (command.kind === 'list') {
        await replyCommand(frame, await workspaceListText(ref.key))
        return
      }
      // `list` 已在上面返回，所以这里就是规范里 `kind !== 'list'` 的分支：
      // 列表人人可看，其余命令都要过 workspaceAllowFrom。
      if (!canManageWorkspace(ref.sender)) {
        await replyCommand(frame, '你没有切换工作区的权限（workspaceAllowFrom 未包含你的 userid）')
        return
      }
      if (command.kind === 'help') {
        await replyCommand(frame, workspaceHelpText)
        return
      }
      if (!cfg().workspaceSwitch) {
        await replyCommand(frame, '工作区切换已关闭（workspaceSwitch=false）')
        return
      }

      if (command.kind === 'add') {
        if (!cfg().workspaceAdd) {
          await replyCommand(frame, '「/ws add」未启用（workspaceAdd=false）')
          return
        }
        if (command.path === '') {
          await replyCommand(frame, '用法：/ws add <目录路径>')
          return
        }
        const registry = workspaceRegistry()
        if (registry === undefined) {
          await replyCommand(frame, 'workspaceRegistry 不可用，无法登记新工作区')
          return
        }
        const base = activeBindingFor(ref.key).path
        const requested = expandUserPath(command.path)
        const target = isAbsolute(requested) ? resolve(requested) : resolve(base, requested)
        if (!existsSync(target) || !statSync(target).isDirectory()) {
          await replyCommand(frame, `目录不存在或不是文件夹：${target}`)
          return
        }
        try {
          const entity = await registry.create(target)
          windowWorkspaces.set(ref.key, bindingFromEntity(entity))
          saveWorkspaceBindings()
          await replyCommand(
            frame,
            `✅ 已登记并切换到工作区「${entity.title}」\n路径：${entity.path}\n下一条消息将在此工作区执行`,
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await replyCommand(frame, `登记工作区失败：${message}`)
        }
        return
      }

      if (command.kind === 'reset') {
        windowWorkspaces.delete(ref.key)
        saveWorkspaceBindings()
        const fallback = await ensureDefaultBinding()
        await replyCommand(
          frame,
          `↩️ 已恢复默认工作区「${fallback.title}」\n路径：${fallback.path}\n下一条消息将在此工作区执行`,
        )
        return
      }

      // switch
      const registry = workspaceRegistry()
      if (registry === undefined) {
        await replyCommand(frame, 'workspaceRegistry 不可用，无法切换工作区')
        return
      }
      const current = activeBindingFor(ref.key)
      const picked = resolveWorkspaceSelector(registry.list(), command.selector)
      let target = picked.ok ? picked.entry : undefined
      if (target === undefined) {
        // Not a list entry: an existing directory may still be addressable.
        const requested = expandUserPath(command.selector)
        const candidate = isAbsolute(requested) ? requested : resolve(current.path, requested)
        try {
          target = await registry.resolveByPath(candidate)
        } catch {
          target = undefined
        }
      }
      if (target === undefined) {
        await replyCommand(frame, picked.ok ? '未找到匹配的工作区' : picked.reason)
        return
      }
      const binding = bindingFromEntity(target)
      if (binding.id === current.id) {
        await replyCommand(frame, `当前已是工作区「${binding.title}」（${binding.path}），无需切换`)
        return
      }
      // 目录已消失的工作区不切：列表会警告，这里直接拦下，
      // 免得下一条消息在 agents.create 处才失败。
      try {
        const record = registry.get(binding.id)
        if (record !== undefined && (await record.status()) === 'missing-dir') {
          await replyCommand(frame, `该工作区目录不存在，暂不切换：${binding.path}`)
          return
        }
      } catch {
        // status 读不到不阻断切换（列表同样会显示状态未知）。
      }
      windowWorkspaces.set(ref.key, binding)
      saveWorkspaceBindings()
      console.log(`[im-bridge] 窗口 ${ref.key} 切换工作区 ${current.path} -> ${binding.path}`)
      await replyCommand(
        frame,
        `✅ 已切换到工作区「${binding.title}」\n路径：${binding.path}\n下一条消息将在此工作区执行（与默认工作区的会话相互独立）`,
      )
    }

    const ws = new AiBot.WSClient({ botId, secret })

    ws.on('connected', (() => console.log('[im-bridge] WebSocket 已连接')) as (...args: never[]) => void)
    ws.on('authenticated', (() => console.log('[im-bridge] 认证成功, 等待消息...')) as (...args: never[]) => void)
    ws.on('disconnected', ((reason: string) => console.log(`[im-bridge] 断开: ${reason}`)) as (...args: never[]) => void)
    ws.on('reconnecting', ((n: number) => console.log(`[im-bridge] 第 ${n} 次重连...`)) as (...args: never[]) => void)
    ws.on('error', ((error: Error) => console.error(`[im-bridge] 错误: ${error.message}`)) as (...args: never[]) => void)

    /**
     * Shared inbound route for text and image messages: resolve the window,
     * apply `allowFrom`, pick the workspace binding, then enqueue on that
     * session's queue. Text-only `/ws` commands are parsed before queueing;
     * an image message never carries a command.
     * @param frame - raw WeCom frame (used for routing and replies).
     * @param content - stripped text; empty for an image message.
     * @param image - image download already in flight, when this is a picture.
     */
    /** 纯文本审批回复（卡片发送失败，或用户直接打字）。 */
    function handleApprovalReply(
      ref: WecomSessionRef,
      reply: { id: string; decision: ApprovalDecision },
    ): void {
      const chatTarget = ref.chatid ?? ref.sender
      const entry = approvals.get(reply.id)
      if (entry === undefined || entry.initiator !== ref.sender) {
        void notifyChat(
          chatTarget,
          entry === undefined
            ? '没有找到这条待审批记录（可能已超时或已处理）'
            : '只有发起这次操作的人可以批准',
        )
        return
      }
      if (!approvals.settle(reply.id, reply.decision)) {
        void notifyChat(chatTarget, '没有找到这条待审批记录（可能已超时或已处理）')
        return
      }
      void notifyChat(
        chatTarget,
        reply.decision === 'allowed-once'
          ? `✅ 已放行这一次操作：${entry.toolName}`
          : `🚫 已拒绝：${entry.toolName}`,
      )
    }

    function dispatchInbound(frame: WecomFrame, content: string, image?: InboundImage): void {
      let ref: WecomSessionRef
      try {
        ref = resolveWecomSession(frame)
      } catch (error) {
        if (error instanceof WecomSessionReject) {
          console.error(`[im-bridge] ${error.reply}`)
          void ws.replyStream(frame, generateReqId('stream'), error.reply, true).catch(() => {})
          return
        }
        throw error
      }
      if (cfg().allowFrom.length > 0 && !cfg().allowFrom.includes(ref.sender)) {
        void ws.replyStream(frame, generateReqId('stream'), cfg().deniedMessage, true).catch(() => {})
        return
      }
      // Authorization comes first: an unauthorized sender must be rejected even
      // when images are off, so the switch is checked only after `allowFrom`.
      if (image !== undefined && !cfg().imageEnabled) {
        void ws.replyStream(frame, generateReqId('stream'), '本通道未开启图片', true).catch(() => {})
        return
      }
      const summary = image === undefined ? content.slice(0, 100) : '[图片]'
      console.log(
        `[im-bridge] 收到 key=${ref.key} userid=${ref.sender} chattype=${String(frame.body?.chattype ?? '')} chatid=${ref.chatid ?? ''}: ${summary}`,
      )
      if (image === undefined) {
        // 审批回复必须在入队前拦截：审批是在当前 turn 内等待的，
        // 排进队列会等到这一轮结束，形成死锁。
        const solePendingId = approvals.size === 1 ? approvals.activeId : undefined
        const approvalReply = parseApprovalReply(content, solePendingId)
        if (approvalReply !== undefined) {
          handleApprovalReply(ref, approvalReply)
          return
        }
        // `/ws …` 由插件直接回复，永远不进入模型。
        const command = parseWorkspaceCommand(content)
        if (command !== undefined) {
          handleWorkspaceCommand(frame, ref, command).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[im-bridge] 工作区命令异常: ${message}`)
            // 失败也要回话，否则 `/ws` 会静默无响应，看起来像插件挂了。
            void ws.replyStream(
              frame,
              generateReqId('stream'),
              `工作区命令执行失败：${truncate(message, 300)}`,
              true,
            ).catch(() => {})
          })
          return
        }
      }
      const binding = activeBindingFor(ref.key)
      // “是否默认工作区”的判定要与 ensureAgent 一致（realpath）：两串拼写不同但
      // 指向同一目录时也必须拿到裸窗口 key，否则旧 wecom-* 会话会被换成新 id。
      const defaultBinding = currentDefaultBinding()
      const effective = sameWorkspacePath(binding.path, defaultBinding.path) ? defaultBinding : binding
      const sessionKey = sessionKeyForWorkspace(ref.key, effective, defaultBinding.path)
      const st = chats.get(sessionKey) ?? emptyChatState()
      st.kind = ref.kind
      chats.set(sessionKey, st)
      st.queue = st.queue
        .then(() => handle(frame, ref, content, binding, sessionKey, image))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          console.error(`[im-bridge] 任务异常: ${message}`)
        })
    }

    ws.on('message.text', ((frame: WecomFrame) => {
      const inbound = (frame.body?.text?.content || '').trim()
      if (!inbound) return
      dispatchInbound(frame, stripBotMention(inbound))
    }) as (...args: never[]) => void)

    ws.on('message.image', ((frame: WecomFrame) => {
      const source = frame.body?.image
      if (source?.url === undefined || source.url === '') {
        console.warn('[im-bridge] 图片消息缺少下载地址，已忽略')
        return
      }
      // Start the download here, not in the queue: the URL expires in five
      // minutes and the session queue may still be busy with earlier turns.
      const download = ws.downloadFile(source.url, source.aeskey)
      // The route can return before the queue awaits this promise (denied
      // sender, unsupported window), so its rejection must not go unhandled.
      void download.catch(() => {})
      dispatchInbound(frame, '', { download })
    }) as (...args: never[]) => void)

    ws.on('event.enter_chat', ((frame: WecomFrame) => {
      const sender = frame.body?.from?.userid || 'unknown'
      console.log(`[im-bridge] 用户 ${sender} 进入会话`)
      void ws.replyWelcome(frame, {
        msgtype: 'text',
        text: { content: cfg().welcomeMessage },
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[im-bridge] 欢迎语失败: ${message}`)
      })
    }) as (...args: never[]) => void)

    // ---- 审批转接（approval relay）---------------------------------------
    // DSH 的审批请求在这里转成企微消息：卡片为主、纯文本兜底；
    // 只认发起者；超时或通道不可用时按拒绝处理（fail closed）。
    /** 连接可用标记：断线期间来的审批先等重连，最多等 30 秒。 */
    let wsReady = false
    /** 等待连接恢复的唤醒函数集合。 */
    const readyWaiters = new Set<() => void>()
    /** 每个待批请求的超时计时器。 */
    const approvalTimers = new Map<string, ReturnType<typeof setTimeout>>()
    /** 请求编号：自增，短到能在手机上打出来。 */
    let approvalSeq = 0

    /** 切换连接状态；恢复时唤醒所有等待者。 */
    function markReady(ready: boolean): void {
      wsReady = ready
      if (!ready) return
      for (const wake of [...readyWaiters]) wake()
      readyWaiters.clear()
    }

    ws.on('authenticated', (() => markReady(true)) as (...args: never[]) => void)
    ws.on('connected', (() => markReady(true)) as (...args: never[]) => void)
    ws.on('disconnected', (() => markReady(false)) as (...args: never[]) => void)
    ws.on('reconnecting', (() => markReady(false)) as (...args: never[]) => void)

    /** 等连接就绪；超时返回 false（调用方按不可用处理）。 */
    function waitForReady(limitMs: number): Promise<boolean> {
      if (wsReady) return Promise.resolve(true)
      return new Promise<boolean>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer)
          readyWaiters.delete(wake)
          resolve(true)
        }
        const timer = setTimeout(() => {
          readyWaiters.delete(wake)
          resolve(false)
        }, limitMs)
        readyWaiters.add(wake)
      })
    }

    /** 审批记录文件：按月切分，只记身份与时间，不记参数。 */
    function approvalAuditFile(): string {
      const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
      const now = new Date()
      const stamp = `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}`
      return join(home, 'dsh-im-bridge', `approval-audit-${stamp}.jsonl`)
    }

    /** 追加一条审批记录；写失败只告警，不影响审批结果。 */
    function recordApproval(entry: PendingApproval, outcome: ApprovalOutcome): void {
      const file = approvalAuditFile()
      const line = JSON.stringify({
        at: new Date().toISOString(),
        id: entry.id,
        chat: entry.chatTarget,
        kind: entry.kind,
        initiator: entry.initiator,
        tool: entry.toolName,
        outcome,
      })
      try {
        mkdirSync(dirname(file), { recursive: true })
        appendFileSync(file, `${line}\n`, 'utf8')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[im-bridge] 审批记录写入失败: ${message}`)
      }
    }

    /** 主动推一条纯文本（卡片点击回执、超时告知）。 */
    async function notifyChat(chatTarget: string, text: string): Promise<void> {
      try {
        await ws.sendMessage(chatTarget, { msgtype: 'text', text: { content: text } })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[im-bridge] 审批提示发送失败: ${message}`)
      }
    }

    /** 超时分钟数，用于文案。 */
    function approvalTimeoutMinutes(): number {
      return Math.max(1, Math.round(cfg().approval.timeoutSec / 60))
    }

    /** 发一张审批卡片；卡片失败重试一次，再降级纯文本。 */
    async function sendApprovalPrompt(
      entry: PendingApproval,
      position: { index: number; total: number },
    ): Promise<void> {
      const ready = await waitForReady(30_000)
      if (!ready) throw new Error('企微连接未就绪')
      const minutes = approvalTimeoutMinutes()
      const card = buildApprovalCard(entry, minutes)
      const payload = { msgtype: 'template_card', template_card: card }
      try {
        await ws.sendMessage(entry.chatTarget, payload)
      } catch {
        try {
          await ws.sendMessage(entry.chatTarget, payload)
        } catch {
          await ws.sendMessage(entry.chatTarget, {
            msgtype: 'text',
            text: { content: formatApprovalText(entry, position, minutes) },
          })
        }
      }
      const timer = setTimeout(() => {
        approvalTimers.delete(entry.id)
        approvals.settle(entry.id, 'rejected', 'timeout')
      }, Math.max(30, cfg().approval.timeoutSec) * 1000)
      approvalTimers.set(entry.id, timer)
    }

    const approvals = new ApprovalQueue({
      send: (entry, position) => sendApprovalPrompt(entry, position),
      done: (entry, outcome) => {
        const timer = approvalTimers.get(entry.id)
        if (timer !== undefined) {
          clearTimeout(timer)
          approvalTimers.delete(entry.id)
        }
        recordApproval(entry, outcome)
        if (outcome === 'timeout') {
          void notifyChat(
            entry.chatTarget,
            `⏰ 审批超时（${String(approvalTimeoutMinutes())} 分钟），已按拒绝处理：${entry.toolName}`,
          )
        } else if (outcome === 'unavailable') {
          void notifyChat(entry.chatTarget, `⚠️ 审批通道不可用，已按拒绝处理：${entry.toolName}`)
        }
      },
    })

    /** 窗口的推送目标：群聊用 chatid，单聊用发送者 userid。 */
    function chatTargetOf(st: ChatState): string | undefined {
      if (st.kind === 'group') return st.chatid
      return st.sender
    }

    /** 卡片点击所在的会话：群聊用 chatid，单聊用点按者 userid。 */
    function chatTargetFromFrame(frame: WecomFrame, userId: string): string {
      const chatid = frame.body?.chatid
      const chattype = frame.body?.chattype
      if ((chattype === 'group' || chattype === 2 || chattype === '2') && chatid) return chatid
      return chatid ?? userId
    }

    /** 一个审批请求 → 一条待批记录；信息不全时返回 undefined（交回下游）。 */
    function approvalDraft(
      request: ApprovalRequestLike,
      st: ChatState,
    ): Omit<PendingApproval, 'settle'> | undefined {
      const chatTarget = chatTargetOf(st)
      const initiator = st.sender
      if (chatTarget === undefined || initiator === undefined || initiator === '') return undefined
      const callId = request.callId
      const rawArgs = callId === undefined ? undefined : st.toolArgsByCallId.get(callId)
      const reason = request.reason ?? request.displayReason?.zh ?? request.displayReason?.en
      approvalSeq += 1
      return {
        id: String(approvalSeq),
        chatTarget,
        kind: st.kind ?? 'single',
        initiator,
        toolName: request.toolName,
        ...(reason === undefined ? {} : { reason }),
        summary: redactArguments(rawArgs),
      }
    }

    /** 审批应答方：与网页端赛跑，先到先得。 */
    function handleApprovalRequest(
      request: ApprovalRequestLike,
      next: () => Promise<string>,
      st: ChatState,
    ): Promise<string> {
      if (!cfg().approval.enabled) return next()
      const draft = approvalDraft(request, st)
      // 归属判定失败的请求不归本通道管：交回下游（网页端）。
      if (draft === undefined) return next()

      // 按发起方路由：这个请求来自企微会话，就由企微独占，**不调用 next()**，
      // 网页端不会弹框。反过来，非企微会话在 relayApproval 里已经 next() 掉了。
      let resolveRelay: (decision: ApprovalDecision) => void = () => {}
      const relay = new Promise<ApprovalDecision>((resolve) => {
        resolveRelay = resolve
      })
      approvals.add({ ...draft, settle: (decision) => { resolveRelay(decision) } })

      const onAbort = (): void => {
        approvals.settle(draft.id, 'rejected', 'unavailable')
        resolveRelay('rejected')
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      return relay.then((outcome) => {
        request.signal?.removeEventListener('abort', onAbort)
        return outcome
      })
    }

    /** 审批请求里的 Agent 会话 id（`request.agent.session.id`），拿不到返回 undefined。 */
    function approvalSessionId(request: ApprovalRequestLike): string | undefined {
      const agent = request.agent as { session?: { id?: unknown } } | null | undefined
      const id = agent?.session?.id
      return typeof id === 'string' ? id : undefined
    }

    /** 按会话 id 反查窗口 —— 只比 id，不比较 Agent 对象引用。 */
    function chatBySessionId(sessionId: string | undefined): ChatState | undefined {
      if (sessionId === undefined) return undefined
      for (const st of chats.values()) {
        if (st.sessionId === sessionId) return st
      }
      return undefined
    }

    /** `chats` 里的窗口 key（`single:<userid>` / `group:<chatid>` …），仅用于诊断日志。 */
    function chatKeyOf(st: ChatState): string {
      for (const [key, candidate] of chats) {
        if (candidate === st) return key
      }
      return 'none'
    }

    /**
     * 两个注册位置共用的入口：先记诊断日志，再决定是否接管。
     *
     * 同一个请求可能同时到达根与 Agent 两个位置，`relayedApprovals` 保证只有一个位置
     * 接管，避免重复发审批卡片。不是企微会话的请求一律 `next()`，交回网页端。
     */
    const relayedApprovals = new WeakSet<object>()

    function relayApproval(
      position: 'root' | 'agent',
      request: ApprovalRequestLike,
      next: () => Promise<string>,
      st: ChatState | undefined,
    ): Promise<string> {
      const sessionId = approvalSessionId(request)
      const window = st === undefined ? 'none' : chatKeyOf(st)
      console.log(
        `[im-bridge] 审批请求 ${position} session=${sessionId ?? 'none'} tool=${request.toolName} 窗口=${window}`,
      )
      if (st === undefined || relayedApprovals.has(request)) return next()
      relayedApprovals.add(request)
      return handleApprovalRequest(request, next, st)
    }

    /** 插件根上下文里的应答方是否已注册（全局一次）。 */
    let rootApprovalRelayInstalled = false

    /**
     * 在插件根上下文里也注册一个应答方（诊断用）。
     *
     * 审批事件按 Agent 作用域分发（`scopeTarget(agent, agent)`），根上下文未必收得到；
     * 收到了就按 `request.agent.session.id` 反查窗口。两处日志共同回答「事件落在哪一层」。
     */
    function installRootApprovalRelay(): void {
      if (rootApprovalRelayInstalled) return
      rootApprovalRelayInstalled = true
      const events = ctx as unknown as {
        on(
          name: 'approval/request',
          listener: (request: ApprovalRequestLike, next: () => Promise<string>) => Promise<string>,
          options?: { global?: boolean; prepend?: boolean },
        ): () => void
      }
      // `global` 跳过作用域过滤：审批事件带的是 Agent 过滤器，插件上下文过不了，
      // 监听会被静默丢弃（issue #91 实测：连日志都没有）。
      // `prepend` 排在 `dsh-api-remotes` 的转发监听之前，否则会被它接管并等浏览器（issue #85）。
      const dispose = events.on('approval/request', (request, next) =>
        relayApproval('root', request, next, chatBySessionId(approvalSessionId(request))),
      { global: true, prepend: true })
      ctx.effect(() => () => {
        dispose()
        rootApprovalRelayInstalled = false
      }, 'im-bridge: root approval relay')
      console.log('[im-bridge] 审批应答方已注册(root)')
    }

    /**
     * 注册审批应答方：插件根 ctx 与 Agent 自己的 ctx 同时注册。
     *
     * issue #81 的结论是「只挂 Agent 上下文」，但企微侧仍然收不到审批，所以两处都挂，
     * 用日志判断事件实际落在哪一层。Agent 那条直接用自己持有的 `st`，不需要反查。
     */
    function installApprovalRelay(agentCtx: Context, st: ChatState): void {
      installRootApprovalRelay()
      if (st.approvalRelayInstalled) return
      st.approvalRelayInstalled = true
      const events = agentCtx as unknown as {
        on(
          name: 'approval/request',
          listener: (request: ApprovalRequestLike, next: () => Promise<string>) => Promise<string>,
          options?: { global?: boolean; prepend?: boolean },
        ): () => void
      }
      const dispose = events.on('approval/request', (request, next) =>
        relayApproval('agent', request, next, st), { global: true, prepend: true })
      agentCtx.effect(() => () => {
        dispose()
        st.approvalRelayInstalled = false
      }, 'im-bridge: approval relay')
      console.log('[im-bridge] 审批应答方已注册(agent)')
    }

    /** 卡片按钮点击。 */
    /** 卡片结果态：点击后 5 秒内换掉，避免停在「待审批」的样子。 */
    function approvalResultCard(
      id: string,
      title: string,
      desc: string,
      subTitle: string,
    ): Record<string, unknown> {
      return {
        card_type: 'text_notice',
        task_id: id,
        main_title: { title, desc },
        sub_title_text: subTitle,
      }
    }

    ws.on('event.template_card_event', ((frame: WecomFrame) => {
      // 企微实际结构是 `body.event.template_card_event.event_key`；旧结构直接挂在 event 上。
      const payload = frame.body?.event
      const key = payload?.template_card_event?.event_key ?? payload?.event_key
      const userId = frame.body?.from?.userid ?? ''
      if (typeof key !== 'string' || key === '') return
      const parsed = parseButtonKey(key)
      if (parsed === undefined) return
      const entry = approvals.get(parsed.id)
      if (entry === undefined) {
        void notifyChat(chatTargetFromFrame(frame, userId), '该审批已失效（可能已超时或已处理）')
        return
      }
      if (entry.initiator !== userId) {
        void notifyChat(entry.chatTarget, '只有发起这次操作的人可以批准')
        return
      }
      if (!approvals.settle(parsed.id, parsed.decision)) return

      const approved = parsed.decision === 'allowed-once'
      // 先换卡片（5 秒窗口），失败再发文本回执。
      void ws
        .updateTemplateCard(
          frame,
          approvalResultCard(
            entry.id,
            approved ? '✅ 已同意' : '🚫 已拒绝',
            entry.toolName,
            approved ? '本次操作已放行（只生效这一次）' : '本次操作已拒绝',
          ),
        )
        .catch(() => {
          void notifyChat(
            entry.chatTarget,
            approved ? `✅ 已放行这一次操作：${entry.toolName}` : `🚫 已拒绝：${entry.toolName}`,
          )
        })
    }) as (...args: never[]) => void)

    ws.connect()

    ctx.effect(() => () => {
      try { ws.close?.() } catch { /* already closed */ }
    }, 'im-bridge: wecom websocket')
  })()
}

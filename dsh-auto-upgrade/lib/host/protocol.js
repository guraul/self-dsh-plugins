/**
 * 线上协议常量：路由表、决策枚举、错误码、默认值。
 * 纯数据，无副作用——宿主半边与单测共用同一份真相。
 * @module dsh-plugin-auto-upgrade/host/protocol
 */

/** 路由族前缀。所有端点都挂在这里，且一律 loopback-only。 */
export const API_PREFIX = '/api/dsh-auto-upgrade'

/**
 * 端点表。平台事实：webServer 以 (kind, path) 为键注册，
 * 重复注册直接抛错——所以一条路径只注册一次，GET/POST 在 handler 内部分派。
 */
export const API = {
  status: `${API_PREFIX}/status`,
  checkAuto: `${API_PREFIX}/check/auto`,
  checkRun: `${API_PREFIX}/check/run`,
  preflight: `${API_PREFIX}/preflight`,
  plugins: `${API_PREFIX}/plugins`,
  pluginAction: `${API_PREFIX}/plugins/action`,
  policy: `${API_PREFIX}/policy`,
  settings: `${API_PREFIX}/settings`,
  update: `${API_PREFIX}/update`,
  rollback: `${API_PREFIX}/rollback`,
  task: `${API_PREFIX}/task`,
  restart: `${API_PREFIX}/restart`,
  restartDiagnostics: `${API_PREFIX}/restart/diagnostics`,
  notes: `${API_PREFIX}/notes`,
}

/** 被升级的 npm 包。 */
export const DSH_PACKAGE = '@deepseek-ai/dsh'

/** 默认 npm registry。 */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** 可供选择的发布渠道；`exact` 表示用户直接给精确版本号。 */
export const CHANNELS = ['latest', 'next', 'alpha', 'exact']

/**
 * 检测结论。`unknown` 是"无法确认"，永远不许伪装成 `up-to-date`。
 * `downgrade-guard` 表示本机版本高于发布源（作者回退过版本），只提示不动作。
 */
export const DECISION = {
  UP_TO_DATE: 'up-to-date',
  UPDATE_AVAILABLE: 'update-available',
  UPDATE_WITH_PLUGIN_RISK: 'update-with-plugin-risk',
  DOWNGRADE_GUARD: 'downgrade-guard',
  UNKNOWN: 'unknown',
}

/** 统一错误码。 */
export const CODE = {
  LOOPBACK_ONLY: 'E_LOOPBACK_ONLY',
  METHOD_NOT_ALLOWED: 'E_METHOD_NOT_ALLOWED',
  BAD_REQUEST: 'E_BAD_REQUEST',
  BUSY: 'E_BUSY',
  SESSIONS_RUNNING: 'E_SESSIONS_RUNNING',
  PLUGIN_INCOMPATIBLE: 'E_PLUGIN_INCOMPATIBLE',
  PRECONDITION: 'E_PRECONDITION',
  NOT_IMPLEMENTED: 'E_NOT_IMPLEMENTED',
  REGISTRY_UNREACHABLE: 'E_REGISTRY_UNREACHABLE',
  INTERNAL: 'E_INTERNAL',
}

/** 安装任务阶段，顺序即生命周期。 */
export const PHASE = [
  'preflight',
  'backup',
  'stop',
  'install',
  'verify',
  'restart',
  'done',
]

/** 插件状态文件目录名（`$HOME` 下）。 */
export const STATE_DIR_NAME = '.dsh-auto-upgrade'

/** 请求体上限：这里每个 body 都是一个小 JSON 对象。 */
export const MAX_BODY_BYTES = 4096

/** 任务日志尾部保留行数。 */
export const TASK_LOG_LINES = 400

/** `npm install -g` 需要放行的安装脚本白名单（与用户手写脚本一致）。 */
export const ALLOW_SCRIPTS = [
  'fs-ext',
  'koffi',
  'node-pty',
  'protobufjs',
  '@google/genai',
  '@deepseek-ai/dsh-subprocess-local',
].join(',')

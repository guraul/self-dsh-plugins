/**
 * dsh-plugin-external-discuss —— 宿主半边。
 *
 * 只做一件事：把某个会话折算成「标题 + 对话正文」，通过本机路由交给浏览器半边。
 * 浏览器半边拿到后再交给 Chrome 扩展投递到外部模型页面。
 *
 * 为什么数据要从宿主取而不是抓页面 DOM：会话日志本来就是权威来源，
 * `session.deriveMessages()` 给出的正是模型看到的消息序列，没有 UI 噪声。
 */
import { createRoute, isLoopbackRequest, RequestError, writeJson } from './host/http.js'
import { collectConversation, fallbackTitle } from './host/transcript.js'

export const name = 'external-discuss'
/** 只强依赖 webServer；会话与标题服务按需探测，缺失时如实报错而不是崩插件。 */
export const inject = ['webServer']

const API = {
  health: '/api/dsh-external-discuss/health',
  payload: '/api/dsh-external-discuss/payload',
}

const logger = {
  info: (message) => console.log(`[external-discuss] ${message}`),
  warn: (message) => console.warn(`[external-discuss] ${message}`),
}

/**
 * 解析一次投递请求。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @param {import('node:http').ServerResponse} res 响应。
 * @returns {void}
 */
function handlePayload(ctx, req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const sessionId = (url.searchParams.get('sessionId') ?? '').trim()
  if (sessionId === '') throw new RequestError(400, 'BAD_REQUEST', 'sessionId is required')

  const sessions = ctx.get('sessions')
  if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') {
    throw new RequestError(503, 'NO_SESSION_SERVICE', 'session service is unavailable')
  }
  const session = sessions.get(sessionId)
  if (session === undefined || session === null) {
    throw new RequestError(404, 'NO_SESSION', `session not found: ${sessionId}`)
  }

  const requested = Number(url.searchParams.get('maxChars') ?? '')
  const conversation = collectConversation(session, Number.isFinite(requested) && requested > 0 ? { maxChars: requested } : {})

  const titleService = ctx.get('sessionTitle')
  const stored =
    titleService !== undefined && titleService !== null && typeof titleService.get === 'function'
      ? titleService.get(session)
      : undefined
  const storedTitle = typeof stored?.title === 'string' ? stored.title.trim() : ''
  const title = storedTitle.length > 0 ? storedTitle : fallbackTitle(conversation.messages)

  writeJson(res, 200, {
    ok: true,
    title,
    text: conversation.text,
    stats: {
      messages: conversation.messages.length,
      chars: conversation.chars,
      truncated: conversation.truncated,
    },
  })
}

/**
 * 插件主体：只注册两条本机路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @returns {void}
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    /**
     * 注册一条 exact 路由。
     * @param {string} path 绝对路径。
     * @param {Record<string, Function>} handlers 方法表。
     * @param {string} label 诊断标签。
     * @returns {void}
     */
    const route = (path, handlers, label) => {
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'exact', path, handler: createRoute(handlers, isLoopbackRequest) }),
        `dsh-external-discuss: ${label}`,
      )
    }

    route(API.health, { GET: (req, res) => writeJson(res, 200, { ok: true, name }) }, 'health')
    route(API.payload, { GET: (req, res) => handlePayload(ctx, req, res) }, 'payload')
    logger.info(`已挂载 ${API.payload}`)
  })
}

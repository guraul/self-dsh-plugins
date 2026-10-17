/**
 * 宿主半边的隔离冒烟测试：不依赖 dsh 运行时，用假的 ctx / 会话验证
 * 路由注册、会话折算、标题回退、错误分支。
 */
import { apply } from '../lib/index.js'
import { collectConversation, fallbackTitle } from '../lib/host/transcript.js'

const session = {
  deriveMessages: () => [
    { role: 'system', content: [{ type: 'text', text: '系统提示，不该出现' }] },
    { role: 'user', content: [{ type: 'text', text: '帮我设计插件架构\n第二行' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: '内心戏，不该出现' }, { type: 'text', text: '建议分三层。' }] },
    { role: 'tool', content: [{ type: 'text', text: '工具结果，不该出现' }] },
    { role: 'user', content: [{ type: 'text', text: '继续' }] },
  ],
}

let failures = 0
const check = (label, actual, expected) => {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`)
}

const conversation = collectConversation(session)
check('只保留 user/assistant', conversation.messages.length, 3)
check('不含系统提示', conversation.text.includes('系统提示'), false)
check('不含思考块', conversation.text.includes('内心戏'), false)
check('不含工具结果', conversation.text.includes('工具结果'), false)
check('含助手正文', conversation.text.includes('建议分三层。'), true)
check('标题取首条用户消息首行', fallbackTitle(conversation.messages), '帮我设计插件架构')
check('未超限不截断', conversation.truncated, false)

const routes = []
const serviceCtx = {
  webServer: {
    register: (options) => {
      routes.push(options)
      return () => {}
    },
  },
  effect: (callback) => callback(),
}
const ctx = {
  inject: (deps, callback) => callback(serviceCtx),
  get: (name) =>
    name === 'sessions'
      ? { get: (id) => (id === 'known' ? session : undefined) }
      : name === 'sessionTitle'
        ? { get: () => ({ title: '  DSH 会话标题  ' }) }
        : undefined,
}
apply(ctx)
check('注册了两条路由', routes.length, 2)

const call = async (path, sessionId) => {
  const route = routes.find((candidate) => candidate.path === path)
  let status = 0
  let body = ''
  const req = { url: `${path}${sessionId === undefined ? '' : `?sessionId=${sessionId}`}`, method: 'GET', socket: { remoteAddress: '127.0.0.1' } }
  const res = {
    setHeader: () => {},
    end: (text) => {
      body = text
    },
  }
  Object.defineProperty(res, 'statusCode', {
    get: () => status,
    set: (value) => {
      status = value
    },
  })
  await route.handler(req, res)
  return { status, body: JSON.parse(body) }
}

const good = await call('/api/dsh-external-discuss/payload', 'known')
check('正常投递 200', good.status, 200)
check('标题取会话标题并去空白', good.body.title, 'DSH 会话标题')
check('返回正文', typeof good.body.text === 'string' && good.body.text.includes('建议分三层。'), true)
console.log(`      正文预览：${JSON.stringify(good.body.text.slice(0, 60))}…`)

const missing = await call('/api/dsh-external-discuss/payload', 'nope')
check('未知会话 404', missing.status, 404)

const noId = await call('/api/dsh-external-discuss/payload')
check('缺 sessionId 400', noId.status, 400)

const health = await call('/api/dsh-external-discuss/health')
check('健康检查 200', health.status, 200)

const fenceReq = { url: '/api/dsh-external-discuss/health', method: 'GET', socket: { remoteAddress: '10.0.0.9' } }
let fenced = 0
await routes.find((candidate) => candidate.path.endsWith('/health')).handler(fenceReq, { setHeader: () => {}, end: () => { fenced += 1 }, statusCode: 0 })
check('非回环请求被拒', fenced, 1)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1

/**
 * 假 ctx / 假 session 驱动的单测。
 *
 * 不引入 cordis、不启动宿主：只验证 `apply` 的注册与回填行为，以及
 * `policy.js` 的判定顺序。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../lib/index.js'
import { POLICY_EVENT, SERVICE_NAME } from '../lib/policy.js'

const ROUTES = [
  { provider: 'deepseek', model: 'deepseek-chat' },
  { provider: 'openai', model: 'gpt-5' },
]

/**
 * 假会话：记录 append，并把事件写回 `events`，让幂等检查能看到刚追加的内容。
 * @param {object} [options] 选项。
 * @param {string} [options.id] 会话 id。
 * @param {string} [options.origin] header.origin。
 * @param {Array<{type: string}>} [options.events] 初始日志。
 * @returns {any} 假会话。
 */
function createSession({ id = 'session-1', origin, events = [] } = {}) {
  const log = [...events]
  return {
    id,
    header: origin === undefined ? {} : { origin },
    appended: [],
    snapshotEvents() {
      return log
    },
    append(type, data) {
      this.appended.push({ type, data })
      log.push({ type, data })
    },
  }
}

/**
 * 假 ctx：只实现本插件用到的 `on` / `sessions.list` / `get` / `logger`。
 * @param {object} [options] 选项。
 * @param {Array<any>} [options.sessions] 存活会话。
 * @param {any} [options.service] 设置服务；`undefined` 表示服务不存在。
 * @returns {any} 假 ctx。
 */
function createCtx({ sessions = [], service } = {}) {
  /** @type {Array<Function>} */
  const listeners = []
  const infos = []
  const warns = []

  return {
    sessions: { list: () => sessions },
    get(wanted) {
      return wanted === SERVICE_NAME ? service : undefined
    },
    on(event, listener) {
      if (event === 'agent/created') listeners.push(listener)
    },
    logger: {
      info: (message) => infos.push(message),
      warn: (message) => warns.push(message),
    },
    infos,
    warns,
    emitCreated(session) {
      for (const listener of listeners) listener({ agent: { session } })
    },
  }
}

/**
 * 正常工作的设置服务。
 * @param {object} [current] `current()` 的返回值。
 * @returns {any} 假服务。
 */
function createService(current = { enabled: true, allowedModels: ROUTES }) {
  return { current: () => current }
}

test('导出名与注入契约稳定', () => {
  assert.equal(name, 'dsh-subagent-policy-fallback')
  assert.deepEqual(inject, ['sessions'])
})

test('注入生效：顶层会话拿到策略事件与审计日志', () => {
  const session = createSession()
  const ctx = createCtx({ service: createService() })

  apply(ctx)
  ctx.emitCreated(session)

  assert.equal(session.appended.length, 1)
  assert.equal(session.appended[0].type, POLICY_EVENT)
  assert.deepEqual(session.appended[0].data.allowedModels, ROUTES)
  assert.equal(ctx.infos.length, 1)
  assert.match(ctx.infos[0], /补齐 2 条 subagent 模型路由/)
  assert.match(ctx.infos[0], /session-1/)
})

test('会话日志已有策略事件 → 跳过', () => {
  const session = createSession({ events: [{ type: POLICY_EVENT }] })
  const ctx = createCtx({ service: createService() })

  apply(ctx)
  ctx.emitCreated(session)

  assert.equal(session.appended.length, 0)
  assert.equal(ctx.infos.length, 0)
})

test('子会话（origin=subagent）→ 跳过', () => {
  const session = createSession({ origin: 'subagent' })
  const ctx = createCtx({ service: createService() })

  apply(ctx)
  ctx.emitCreated(session)

  assert.equal(session.appended.length, 0)
  assert.equal(ctx.infos.length, 0)
})

test('设置服务不存在 → 跳过', () => {
  const session = createSession()
  const ctx = createCtx({ service: undefined })

  apply(ctx)
  ctx.emitCreated(session)

  assert.equal(session.appended.length, 0)
  assert.equal(ctx.infos.length, 0)
})

test('服务 enabled=false → 跳过', () => {
  const session = createSession()
  const ctx = createCtx({ service: createService({ enabled: false, allowedModels: ROUTES }) })

  apply(ctx)
  ctx.emitCreated(session)

  assert.equal(session.appended.length, 0)
  assert.equal(ctx.infos.length, 0)
})

test('允许列表为空（含上游 current 抛错）→ 跳过', () => {
  const empty = createSession({ id: 'empty' })
  const throwing = createSession({ id: 'throwing' })
  const emptyCtx = createCtx({ service: createService({ enabled: true, allowedModels: [] }) })
  const throwingCtx = createCtx({
    service: {
      current() {
        throw new Error('enabled subagent model selection requires at least one allowed model')
      },
    },
  })

  apply(emptyCtx)
  emptyCtx.emitCreated(empty)
  apply(throwingCtx)
  throwingCtx.emitCreated(throwing)

  assert.equal(empty.appended.length, 0)
  assert.equal(throwing.appended.length, 0)
})

test('apply 回填已存活会话，且只补符合条件的那个', () => {
  const restored = createSession({ id: 'restored' })
  const subagent = createSession({ id: 'child', origin: 'subagent' })
  const already = createSession({ id: 'already', events: [{ type: POLICY_EVENT }] })
  const ctx = createCtx({ sessions: [restored, subagent, already], service: createService() })

  apply(ctx)

  assert.equal(restored.appended.length, 1)
  assert.equal(subagent.appended.length, 0)
  assert.equal(already.appended.length, 0)
  assert.equal(ctx.infos.length, 1)
  assert.match(ctx.infos[0], /restored/)
})

test('插件配置 enabled=false → 不注册监听、不回填', () => {
  const live = createSession({ id: 'live' })
  const created = createSession({ id: 'created' })
  const ctx = createCtx({ sessions: [live], service: createService() })

  apply(ctx, { enabled: false })
  ctx.emitCreated(created)

  assert.equal(live.appended.length, 0)
  assert.equal(created.appended.length, 0)
})

test('apply 回填后同一会话再触发 agent/created 不会重复追加', () => {
  const session = createSession({ id: 'restored' })
  const ctx = createCtx({ sessions: [session], service: createService() })

  apply(ctx)
  ctx.emitCreated(session)

  assert.equal(session.appended.length, 1)
})

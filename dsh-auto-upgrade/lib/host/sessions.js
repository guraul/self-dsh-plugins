/**
 * 运行中会话门禁。
 *
 * 官方判据（dsh-api-session-controller）：`ctx.agents.get(id).status === 'running'`。
 * 这里用 `ctx.agents.list()` 取全部活着的 agent 再过滤——`agents` 是运行时服务，
 * 拿不到时如实返回 `available:false`，而不是假报"没有会话在跑"。
 * @module dsh-plugin-auto-upgrade/host/sessions
 */

/**
 * 列出正在执行的会话。
 * @param {{list?:() => any[]}|undefined} agents AgentRegistry 服务。
 * @returns {{available:boolean, sessions:{id:string|null, title:string|null}[]}} 结果。
 */
export function listRunningSessions(agents) {
  if (agents === undefined || agents === null || typeof agents.list !== 'function') {
    return { available: false, sessions: [] }
  }
  /** @type {{id:string|null, title:string|null}[]} */
  const sessions = []
  let live
  try {
    live = agents.list()
  } catch {
    return { available: false, sessions: [] }
  }
  for (const agent of Array.isArray(live) ? live : []) {
    if (agent?.status !== 'running') continue
    const session = agent.session
    sessions.push({
      id: typeof session?.id === 'string' ? session.id : (typeof agent.id === 'string' ? agent.id : null),
      title: typeof session?.header?.title === 'string' ? session.header.title : null,
    })
  }
  return { available: true, sessions }
}

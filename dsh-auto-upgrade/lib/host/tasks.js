/**
 * 任务登记处：安装/回滚这类长动作的进度、日志尾与单飞。
 * 只在内存里；进程没了任务就没了（重启后的现场由 `restart.log` 与 `state.pendingRestart` 负责）。
 * @module dsh-plugin-auto-upgrade/host/tasks
 */
import { randomUUID } from 'node:crypto'
import { TASK_LOG_LINES } from './protocol.js'

/**
 * 一个有界日志的任务。
 */
export class Task {
  /**
   * @param {string} kind 任务种类（`update` / `rollback` / `restart`）。
   * @param {object} meta 附加信息。
   */
  constructor(kind, meta = {}) {
    this.id = randomUUID()
    this.kind = kind
    this.meta = meta
    this.phase = 'pending'
    this.startedAt = Date.now()
    this.finishedAt = null
    this.ok = null
    this.error = null
    /** @type {string[]} */
    this.log = []
    this.seq = 0
  }

  /**
   * 追加一行日志（超出上限丢最旧的）。
   * @param {string} line 行内容。
   * @returns {void}
   */
  append(line) {
    const text = String(line).replace(/\r/g, '')
    for (const part of text.split('\n')) {
      if (part === '') continue
      this.log.push(part)
      this.seq += 1
    }
    if (this.log.length > TASK_LOG_LINES) this.log.splice(0, this.log.length - TASK_LOG_LINES)
  }

  /**
   * 进入下一阶段。
   * @param {string} phase 阶段名。
   * @returns {void}
   */
  setPhase(phase) {
    this.phase = phase
    this.append(`==> ${phase}`)
  }

  /**
   * 标记结束。
   * @param {{ok:boolean, error?:string}} result 结果。
   * @returns {void}
   */
  finish(result) {
    this.ok = result.ok === true
    this.error = result.error ?? null
    this.phase = this.ok ? 'done' : 'failed'
    this.finishedAt = Date.now()
  }

  /**
   * 给浏览器看的视图。
   * @param {number} [since] 客户端已收到的日志游标。
   * @returns {object} 视图。
   */
  view(since = 0) {
    const from = Math.max(0, Math.min(since, this.log.length))
    return {
      id: this.id,
      kind: this.kind,
      meta: this.meta,
      phase: this.phase,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      ok: this.ok,
      error: this.error,
      cursor: this.log.length,
      log: this.log.slice(from),
    }
  }
}

/**
 * 任务登记处。
 */
export class TaskRegistry {
  /**
   * @param {{historyLimit?:number}} [options] 选项。
   */
  constructor(options = {}) {
    /** @type {Map<string, Task>} */
    this.tasks = new Map()
    this.historyLimit = options.historyLimit ?? 20
  }

  /**
   * 同种类是否有任务在跑（单飞）。
   * @param {string} kind 种类。
   * @returns {Task|undefined} 进行中的任务。
   */
  active(kind) {
    for (const task of this.tasks.values()) {
      if (task.kind === kind && task.finishedAt === null) return task
    }
    return undefined
  }

  /**
   * 开一个任务。
   * @param {string} kind 种类。
   * @param {object} [meta] 附加信息。
   * @returns {Task} 任务。
   */
  start(kind, meta) {
    const task = new Task(kind, meta)
    this.tasks.set(task.id, task)
    this.prune()
    return task
  }

  /**
   * 取任务。
   * @param {string} id 任务 id。
   * @returns {Task|undefined} 任务。
   */
  get(id) {
    return this.tasks.get(id)
  }

  /**
   * 保留最近的若干个任务。
   * @returns {void}
   */
  prune() {
    if (this.tasks.size <= this.historyLimit) return
    const finished = [...this.tasks.values()]
      .filter((task) => task.finishedAt !== null)
      .sort((a, b) => a.finishedAt - b.finishedAt)
    while (this.tasks.size > this.historyLimit && finished.length > 0) {
      const oldest = finished.shift()
      this.tasks.delete(oldest.id)
    }
  }
}

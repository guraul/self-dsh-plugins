/**
 * 串行队列 + 同键并发去重。
 *
 * 两条约束来自知乎侧：同一时刻只允许一个子进程（否则几十秒内就 30001），
 * 以及同一份数据被多个面板同时要时只该起一次进程。
 * @module dsh-plugin-zhihu-sidebar/host/queue
 */

/**
 * 建一个队列。
 * @param {object} [options] 选项。
 * @param {() => number} [options.now] 可注入时钟（指标用）。
 * @returns {{ run: <T>(key: string|null, task: () => Promise<T>) => Promise<T>, stats: () => { started: number, active: number, peak: number, deduped: number } }} 队列。
 */
export function createQueue({ now = () => Date.now() } = {}) {
  /** @type {Promise<unknown>} 队尾：所有任务都挂在这条链上，因此天然只有一个在跑。 */
  let tail = Promise.resolve()
  /** @type {Map<string, Promise<unknown>>} 在飞请求。 */
  const inflight = new Map()
  let started = 0
  let active = 0
  let peak = 0
  let deduped = 0
  let lastStartAt = 0

  /**
   * 排进队列。
   * @template T
   * @param {() => Promise<T>} task 任务。
   * @returns {Promise<T>} 结果。
   */
  function enqueue(task) {
    const run = tail.then(async () => {
      started += 1
      active += 1
      lastStartAt = now()
      if (active > peak) peak = active
      try {
        return await task()
      } finally {
        active -= 1
      }
    })
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return {
    /**
     * 跑一个任务；同键在飞时直接复用同一个 Promise。
     * @template T
     * @param {string|null} key 去重键，null 表示不去重。
     * @param {() => Promise<T>} task 任务。
     * @returns {Promise<T>} 结果。
     */
    run(key, task) {
      if (key !== null) {
        const existing = inflight.get(key)
        if (existing !== undefined) {
          deduped += 1
          return /** @type {Promise<T>} */ (existing)
        }
      }
      const promise = enqueue(task)
      if (key !== null) {
        inflight.set(key, promise)
        const clear = () => {
          if (inflight.get(key) === promise) inflight.delete(key)
        }
        promise.then(clear, clear)
      }
      return promise
    },
    /**
     * 运行指标。
     * @returns {{ started: number, active: number, peak: number, deduped: number, lastStartAt: number }} 快照。
     */
    stats() {
      return { started, active, peak, deduped, lastStartAt }
    },
  }
}

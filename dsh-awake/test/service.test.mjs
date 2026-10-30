import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { ARGS, BINARY, CODE, VERIFY_DELAY_MS } from '../lib/host/protocol.js'
import { AwakeError, createAwakeService } from '../lib/host/service.js'

/**
 * 假子进程：记录 kill 调用，能自己「退出」。
 */
class FakeChild extends EventEmitter {
  /**
   * @param {number} pid 进程号。
   */
  constructor(pid) {
    super()
    this.pid = pid
    this.signals = []
    this.killed = false
  }

  /**
   * 记录信号。
   * @param {string} signal 信号。
   * @returns {boolean} 永远 true。
   */
  kill(signal) {
    this.signals.push(signal)
    this.killed = true
    return true
  }
}

/**
 * 造一个可控的 spawn 假件。
 * @param {{duringSpawn?: (child: FakeChild) => void, throwOnSpawn?: Error}} [options] 选项。
 * @returns {{ spawn: Function, children: FakeChild[], calls: any[][] }} 假件。
 */
function makeSpawn(options = {}) {
  const children = []
  const calls = []
  let nextPid = 4000
  const spawn = (command, args, spawnOptions) => {
    calls.push([command, args, spawnOptions])
    if (options.throwOnSpawn !== undefined) throw options.throwOnSpawn
    const child = new FakeChild(nextPid)
    nextPid += 1
    children.push(child)
    if (options.duringSpawn !== undefined) options.duringSpawn(child)
    return child
  }
  return { spawn, children, calls }
}

/**
 * 造一个「观察窗口里立刻退出」的子进程：微任务里发 exit，
 * 早于 `await wait()` 的续体，因此 launch() 看到的一定是「没活下来」。
 * @param {FakeChild} child 子进程。
 * @returns {void}
 */
function exitDuringWindow(child) {
  queueMicrotask(() => child.emit('exit', 1, null))
}

/**
 * 造一个服务实例，并默认锁定 `platform: 'darwin'`。
 *
 * 单测要验的是 macOS 上的状态机，不能跟着跑测试的机器走 —— CI 跑在 Linux，
 * 默认 `process.platform` 会让每个用例都撞上 501。需要验非 macOS 的用例
 * 显式覆盖 `platform` 即可。
 * @param {object} [overrides] 覆盖默认注入缝的选项。
 * @returns {ReturnType<typeof createAwakeService>} 服务。
 */
function makeService(overrides = {}) {
  return createAwakeService({ platform: 'darwin', ...overrides })
}

test('start 拉起 caffeinate -i（永不带 -t），并把状态切成 active', async () => {
  const fake = makeSpawn()
  const service = makeService({ spawn: fake.spawn, wait: async () => {}, now: () => 1700000000000 })

  const status = await service.start()

  assert.equal(fake.calls.length, 1)
  assert.deepEqual(fake.calls[0][0], BINARY)
  assert.deepEqual(fake.calls[0][1], ARGS)
  assert.ok(!fake.calls[0][1].includes('-t'), '纯开关不允许带 -t')
  assert.deepEqual(status, { active: true, pid: 4000, startedAt: 1700000000000 })
  assert.deepEqual(service.status(), status)
})

test('已 active 时再 start 不叠加第二个 caffeinate', async () => {
  const fake = makeSpawn()
  const service = makeService({ spawn: fake.spawn, wait: async () => {} })

  await service.start()
  const again = await service.start()

  assert.equal(fake.calls.length, 1, '单实例：第二次 start 只是回读状态')
  assert.equal(again.pid, 4000)
  assert.equal(again.active, true)
})

test('并发 start 合并成一次 spawn', async () => {
  const fake = makeSpawn()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const service = makeService({
    spawn: fake.spawn,
    wait: () => gate,
  })

  const first = service.start()
  const second = service.start()
  release()
  const [a, b] = await Promise.all([first, second])

  assert.equal(fake.calls.length, 1)
  assert.deepEqual(a, b)
})

test('观察窗口内秒退 → 启动失败，状态不会假装 active', async () => {
  const fake = makeSpawn({ duringSpawn: exitDuringWindow })
  const service = makeService({ spawn: fake.spawn, wait: async () => {} })

  await assert.rejects(service.start(), (error) => {
    assert.ok(error instanceof AwakeError)
    assert.equal(error.status, 500)
    assert.equal(error.code, CODE.SPAWN_FAILED)
    assert.match(error.message, /startup window/)
    return true
  })
  assert.deepEqual(service.status(), { active: false, pid: null, startedAt: null })
})

test('spawn 抛错（二进制不存在）→ E_SPAWN_FAILED', async () => {
  const boom = Object.assign(new Error('spawn caffeinate ENOENT'), { code: 'ENOENT' })
  const fake = makeSpawn({ throwOnSpawn: boom })
  const service = makeService({ spawn: fake.spawn, wait: async () => {} })

  await assert.rejects(service.start(), (error) => {
    assert.equal(error.code, CODE.SPAWN_FAILED)
    assert.match(error.message, /ENOENT/)
    return true
  })
  assert.equal(service.status().active, false)
})

test('spawn 期间发 error 事件（ENOENT 的另一种形态）→ E_SPAWN_FAILED', async () => {
  const fake = makeSpawn({
    duringSpawn: (child) => {
      queueMicrotask(() => child.emit('error', new Error('ENOENT')))
    },
  })
  const service = makeService({ spawn: fake.spawn, wait: async () => {} })

  await assert.rejects(service.start(), (error) => {
    assert.equal(error.code, CODE.SPAWN_FAILED)
    assert.match(error.message, /ENOENT/)
    return true
  })
})

test('子进程被外部 kill → exit 监听把状态自愈回 inactive', async () => {
  const fake = makeSpawn()
  const service = makeService({ spawn: fake.spawn, wait: async () => {} })

  await service.start()
  fake.children[0].emit('exit', null, 'SIGKILL')

  assert.deepEqual(service.status(), { active: false, pid: null, startedAt: null })
})

test('stop 用 SIGTERM 杀掉子进程并回到 inactive', async () => {
  const fake = makeSpawn()
  const service = makeService({ spawn: fake.spawn, wait: async () => {} })

  await service.start()
  const status = await service.stop()

  assert.deepEqual(fake.children[0].signals, ['SIGTERM'])
  assert.deepEqual(status, { active: false, pid: null, startedAt: null })
})

test('inactive 时 stop 是幂等空操作', async () => {
  const fake = makeSpawn()
  const service = makeService({ spawn: fake.spawn, wait: async () => {} })

  const status = await service.stop()

  assert.deepEqual(status, { active: false, pid: null, startedAt: null })
  assert.equal(fake.calls.length, 0)
})

test('stop 撞上正在飞的 start：先等它落地再杀，不留孤儿', async () => {
  const fake = makeSpawn()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const service = makeService({ spawn: fake.spawn, wait: () => gate })

  const starting = service.start()
  const stopping = service.stop()
  release()
  await starting
  await stopping

  assert.equal(fake.calls.length, 1)
  assert.deepEqual(fake.children[0].signals, ['SIGTERM'])
  assert.equal(service.status().active, false)
})

test('dispose（宿主卸载）一定杀掉子进程', async () => {
  const fake = makeSpawn()
  const service = makeService({ spawn: fake.spawn, wait: async () => {} })

  await service.start()
  await service.dispose()

  assert.deepEqual(fake.children[0].signals, ['SIGTERM'])
  assert.equal(service.status().active, false)
})

test('非 macOS 平台直接 501，且不 spawn', async () => {
  const fake = makeSpawn()
  const service = createAwakeService({ spawn: fake.spawn, wait: async () => {}, platform: 'linux' })

  await assert.rejects(service.start(), (error) => {
    assert.equal(error.status, 501)
    assert.equal(error.code, CODE.UNSUPPORTED_PLATFORM)
    assert.match(error.message, /macOS/)
    return true
  })
  assert.equal(fake.calls.length, 0)
})

test('默认观察窗口是 500ms（参数写错会秒退，必须留出观察时间）', () => {
  assert.equal(VERIFY_DELAY_MS, 500)
})

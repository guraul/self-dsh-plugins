import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCli } from '../lib/host/cli.js'

export const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url))

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createClock(start = 1_700_000_000_000) {
  let value = start
  return {
    now: () => value,
    advance(ms) {
      value += ms
      return value
    },
    set(next) {
      value = next
      return value
    },
  }
}

export function fakeRuntime({ modes = ['success'], delayMs = 0, timeoutMs = 5000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zhihu-sidebar-test-'))
  const scenarioPath = join(dir, 'scenario.json')
  const logPath = join(dir, 'calls.jsonl')

  const writeScenario = (nextModes, nextDelay = delayMs) => {
    writeFileSync(scenarioPath, JSON.stringify({ modes: nextModes, delayMs: nextDelay }))
    try {
      rmSync(join(dir, 'seq'), { force: true })
    } catch {
      // 忽略：seq 只是计数。
    }
  }

  writeScenario(modes)
  const cli = createCli({
    binPath: FAKE_CLI,
    timeoutMs,
    env: { ZHIHU_FAKE_DIR: dir },
  })

  const events = () => {
    if (!existsSync(logPath)) return []
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line))
  }

  return {
    dir,
    cli,
    setModes(nextModes, nextDelay = delayMs) {
      writeScenario(nextModes, nextDelay)
    },
    events,
    starts: () => events().filter((event) => event.event === 'start'),
    calls: () => events().filter((event) => event.event === 'start'),
    envDump() {
      return JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8'))
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export function makeExecutable(path) {
  chmodSync(path, 0o755)
  return path
}

export function scriptBin(dir, body) {
  const path = join(dir, 'zhihu-cli')
  writeFileSync(path, body)
  return makeExecutable(path)
}

export function nodeVersionOk() {
  try {
    execFileSync(process.execPath, ['--version'], { encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}

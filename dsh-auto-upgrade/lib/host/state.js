/**
 * 插件自己的持久化状态：`state.json` / `policy.json` / `settings.json`。
 * 全部原子写（先写临时文件再 rename），坏文件不致命（退回默认值并保留现场）。
 * @module dsh-plugin-auto-upgrade/host/state
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { STATE_DIR_NAME } from './protocol.js'

/**
 * 状态目录：环境变量 `DSH_AUTO_UPGRADE_DIR` 优先，否则 `$HOME/.dsh-auto-upgrade`。
 * @param {NodeJS.ProcessEnv} [env] 环境变量。
 * @returns {string} 绝对目录。
 */
export function resolveStateDir(env = process.env) {
  const configured = env.DSH_AUTO_UPGRADE_DIR
  if (typeof configured === 'string' && configured !== '') return configured
  return join(homedir(), STATE_DIR_NAME)
}

/**
 * 宿主本地日期（"当天首次"以此为准）。
 * @param {Date} [now] 时刻。
 * @returns {string} `YYYY-MM-DD`。
 */
export function localDate(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * 一个 JSON 文件的小存储。
 */
export class JsonStore {
  /**
   * @param {string} dir 状态目录。
   * @param {string} fileName 文件名。
   * @param {object} defaults 默认值（读取时做浅合并）。
   */
  constructor(dir, fileName, defaults) {
    this.dir = dir
    this.path = join(dir, fileName)
    this.defaults = defaults
  }

  /**
   * 读取（缺失/损坏都退回默认值）。
   * @returns {Promise<object>} 当前值。
   */
  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...this.defaults }
      return { ...this.defaults, ...parsed }
    } catch {
      return { ...this.defaults }
    }
  }

  /**
   * 整体写入（原子）。
   * @param {object} value 新值。
   * @returns {Promise<object>} 写入的值。
   */
  async write(value) {
    await mkdir(this.dir, { recursive: true })
    const tmp = `${this.path}.tmp-${process.pid}`
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(tmp, this.path)
    return value
  }

  /**
   * 局部更新（浅合并后整体写入）。
   * @param {object} partial 变更字段。
   * @returns {Promise<object>} 合并后的值。
   */
  async patch(partial) {
    const current = await this.read()
    return this.write({ ...current, ...partial })
  }
}

/** 状态文件默认值。 */
export const STATE_DEFAULTS = {
  lastCheckDate: null,
  lastCheck: null,
  installed: null,
  pendingRestart: null,
  updatedAt: null,
}

/** 策略默认值。用户拍板：默认渠道 `latest`，暂不做静默自动升级。 */
export const POLICY_DEFAULTS = {
  channel: 'latest',
  exactVersion: '',
  mode: 'notify',
  dailyCheck: true,
  executionWindow: null,
}

/** 面板偏好默认值。 */
export const SETTINGS_DEFAULTS = {
  overlay: true,
  dismissed: false,
  locale: null,
}

/**
 * 打开三个存储。
 * @param {string} dir 状态目录。
 * @returns {{state:JsonStore, policy:JsonStore, settings:JsonStore, dir:string}} 存储集合。
 */
export function openStores(dir) {
  return {
    dir,
    state: new JsonStore(dir, 'state.json', STATE_DEFAULTS),
    policy: new JsonStore(dir, 'policy.json', POLICY_DEFAULTS),
    settings: new JsonStore(dir, 'settings.json', SETTINGS_DEFAULTS),
  }
}

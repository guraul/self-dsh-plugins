/**
 * dsh-plugin-memx 的冒烟断言（契约见 `docs/plugins/dsh-auto-upgrade.md` 的 `dsh.smoke`）。
 *
 * 三条都是「升级后 5 秒内能确定」的行为事实：
 *   1. `memx-module`：Node 的 `load` 钩子能把 memx 仓的 TS 适配器解析并加载进来
 *      （这是本包唯一的接线逻辑；memx 换路径 / 源码语法变了都会在这里红）；
 *   2. `config-schema`：设置页依赖的四个字段仍在、全 `.volatile()`、默认值口径一致，
 *      且 `lib/index.js` 转发的确实是本包的 schemastery `Config`（不是 memx 的 standard-schema）；
 *   3. `memory-dir`：记忆目录解析结果仍是 `<home>/.opencode/projects/<slug>/.mem`
 *      （memx 是宿主无关的，根目录固定 `~/.opencode`，与 `DSH_HOME` 无关——别被 issue 措辞误导）。
 *
 * 为什么能抓漂移：设置面只认 volatile 字段（字段丢了整页消失）、记忆写盘全靠路径解析，
 * 两者坏掉在运行时都是「静默不工作」，只有断言能立刻发现。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 四个设置字段的期望形状：类型 + `.default()` + `.volatile()`。 */
const EXPECTED_FIELDS = {
  provider: { type: 'string', default: '' },
  model: { type: 'string', default: '' },
  autoRefine: { type: 'boolean', default: true },
  throttleMinutes: { type: 'number', default: 10 },
}

/**
 * 从 `lib/index.js` 读出 memx 仓根目录：本包把路径写死为 `MEMX_ROOT`，
 * 这里不复制常量（复制会在 memx 换路径时给出假绿）。
 * @returns {string} memx 仓根目录（带结尾 `/`）。
 */
function readMemxRoot() {
  const source = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
  const matched = /const MEMX_ROOT = "([^"]+)"/.exec(source)
  if (matched?.[1] === undefined) throw new Error('lib/index.js 里找不到 `const MEMX_ROOT = "…"`（接线入口被改写了）')
  return matched[1]
}

/**
 * 跑一遍断言。
 * @param {{name?: string, dshDir?: string, dshVersion?: string}} [_ctx] 宿主事实（本插件不需要）。
 * @returns {Promise<{ok: boolean, checks: {name: string, ok: boolean, detail?: string}[]}>} 结果。
 */
export async function run(_ctx = {}) {
  /** @type {{name: string, ok: boolean, detail?: string}[]} */
  const checks = []
  /**
   * 跑一条断言：抛错也算失败。
   * @param {string} name 断言名。
   * @param {() => Promise<{ok: boolean, detail?: string}>} fn 断言体。
   * @returns {Promise<void>} 无。
   */
  const check = async (name, fn) => {
    try {
      const { ok, detail } = await fn()
      checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  await check('memx-module', async () => {
    const memx = await import('./lib/index.js')
    const missing = ['apply', 'name', 'inject', 'Config'].filter((key) => memx[key] === undefined)
    return {
      ok: missing.length === 0 && memx.name === 'memx' && typeof memx.apply === 'function',
      detail: `name=${String(memx.name)} inject=${JSON.stringify(memx.inject)} missing=${JSON.stringify(missing)}`,
    }
  })

  await check('config-schema', async () => {
    const shell = await import('./lib/index.js')
    const { Config } = await import('./lib/config.js')
    const fields = Object.keys(Config.dict ?? {})
    const wrong = []
    for (const [key, expected] of Object.entries(EXPECTED_FIELDS)) {
      const field = Config.dict?.[key]
      if (field === undefined) {
        wrong.push(`${key}:missing`)
        continue
      }
      if (field.type !== expected.type) wrong.push(`${key}:type=${String(field.type)}`)
      if (field.meta?.volatile !== true) wrong.push(`${key}:not-volatile`)
      if (field.meta?.default !== expected.default) wrong.push(`${key}:default=${JSON.stringify(field.meta?.default)}`)
    }
    if (JSON.stringify(fields) !== JSON.stringify(Object.keys(EXPECTED_FIELDS))) {
      wrong.push(`fields=${JSON.stringify(fields)}`)
    }
    if (shell.Config !== Config) wrong.push('lib/index.js 转发的不是本包 Config')
    return {
      ok: wrong.length === 0,
      detail: wrong.length === 0
        ? `四字段齐全且全 volatile：${fields.join(', ')}`
        : `设置面契约漂移：${wrong.join('; ')}`,
    }
  })

  await check('memory-dir', async () => {
    // 先加载本包入口，顺带装上 memx 源码目录的 load 钩子。
    await import('./lib/index.js')
    const root = readMemxRoot()
    const store = await import(pathToFileURL(join(root, 'src/core/store/memory-md.ts')).href)
    const types = await import(pathToFileURL(join(root, 'src/core/memory-types.ts')).href)
    const slug = types.deriveSlug('/Users/alice/work/proj')
    const expectedDir = join(homedir(), '.opencode', 'projects', 'Users-alice-work-proj', '.mem')
    const dir = store.getMemoryDir(slug)
    const indexPath = store.getMemoryIndexPath()
    const expectedIndex = join(homedir(), '.opencode', 'MEMORY.md')
    return {
      ok: dir === expectedDir && indexPath === expectedIndex,
      detail: `slug=${slug} dir=${dir} index=${indexPath}`,
    }
  })

  return { ok: checks.every((item) => item.ok), checks }
}

/**
 * build-check.sh 的契约测试。
 *
 * 不碰真实仓：临时目录里造「主工作区 + 两个兄弟仓 + 桩包」，
 * 用桩包扮演 doctor，覆盖一致 / 漂移 / 兄弟仓缺失 / --quiet 四种路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SCRIPT = join(HERE, 'build-check.sh')

/** 造一个「主工作区 + 兄弟仓」的临时布局；withTools 决定兄弟仓是否装了包。 */
function layout({ siblingTools = true, siblings = ['sib-a', 'sib-b'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'build-check-'))
  const main = join(root, 'main')
  mkdirSync(join(main, '.dsh'), { recursive: true })
  mkdirSync(join(main, 'tools', 'node_modules', 'dsh-pipeline', 'bin'), { recursive: true })
  writeFileSync(join(main, 'tools', 'node_modules', 'dsh-pipeline', 'bin', 'cli.mjs'), '')
  // main_worktree() 认的是 git worktree 首条，这里直接给个假 git
  writeFileSync(join(main, '.dsh', 'pipeline.json'), JSON.stringify({ repo: 'o/r' }))
  // build-check 自己的配置在**独立文件**里（`.dsh/pipeline.json` 是包的 schema，不能加字段）
  writeFileSync(join(main, '.dsh', 'build-check.json'), JSON.stringify({ repos: siblings.map((s) => `../${s}`) }))
  for (const s of siblings) {
    const dir = join(root, s)
    mkdirSync(dir, { recursive: true })
    if (siblingTools) {
      mkdirSync(join(dir, 'tools', 'node_modules', 'dsh-pipeline', 'bin'), { recursive: true })
      // build-check 只把「装了包」的兄弟仓纳入比对：这里必须有 cli.mjs 这个文件
      writeFileSync(join(dir, 'tools', 'node_modules', 'dsh-pipeline', 'bin', 'cli.mjs'), '')
    }
  }
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  // 假 git：worktree list 首条即主工作区
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$*" in\n  *"worktree list"*) printf 'worktree %s\\nbranch refs/heads/main\\n' "${main}" ;;\n  *) printf '%s\\n' "${main}" ;;\nesac\n`, { mode: 0o755 })
  const pkg = join(root, 'pkg')
  mkdirSync(join(pkg, 'bin'), { recursive: true })
  writeFileSync(join(pkg, 'bin', 'cli.mjs'), `
if (process.env.FAKE_DRIFT) { console.log('/a\\tdeadbee 2026-11-04T00:00:00Z'); console.log('/b\\tcafebabe 2026-11-04T00:00:00Z'); process.exit(1) }
if (process.env.FAKE_BROKEN) { console.error('doctor: cannot read config'); process.exit(2) }
console.log('/a\\tcc13260 2026-11-04T12:18:01Z'); console.log('/b\\tcc13260 2026-11-04T12:18:01Z')
`, { mode: 0o755 })
  return { root, main, pkg, bin }
}

/** 跑脚本，返回 { code, out }（不抛：非零退出是常态）。 */
function run(layoutInfo, args = [], env = {}) {
  try {
    const out = execFileSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${layoutInfo.bin}:${process.env.PATH}`, DSH_PIPELINE_HOME: layoutInfo.pkg, ...env },
    })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('一致 → 退出 0 并报「构建一致」', () => {
  const l = layout()
  const r = run(l)
  assert.equal(r.code, 0)
  assert.match(r.out, /构建一致/)
})

test('--quiet 只打一行', () => {
  const l = layout()
  const r = run(l, ['--quiet'])
  assert.equal(r.code, 0)
  assert.equal(r.out.trim().split('\n').length, 1)
  assert.match(r.out, /一致（3 仓）/)
})

test('构建漂移 → 退出 1 并给出修法', () => {
  const l = layout()
  const r = run(l, [], { FAKE_DRIFT: '1' })
  assert.equal(r.code, 1)
  assert.match(r.out, /构建不一致/)
  assert.match(r.out, /rm -rf node_modules/)
})

test('兄弟仓缺失（没装包）→ 跳过不判失败', () => {
  const l = layout({ siblingTools: false })
  const r = run(l, ['--quiet'])
  assert.equal(r.code, 0)
  assert.match(r.out, /跳过/)
})

test('未知参数 → 退出 2', () => {
  const l = layout()
  const r = run(l, ['--bogus'])
  assert.equal(r.code, 2)
})

test('doctor 自身退出 2（环境错误）→ 透传 2，不误报成「构建不一致」', () => {
  const l = layout()
  const r = run(l, [], { FAKE_BROKEN: '1' })
  assert.equal(r.code, 2)
  assert.match(r.out, /无法完成比对/)
})

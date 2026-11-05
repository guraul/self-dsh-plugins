import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openRefillPullRequest, planRefillPr } from '../lib/host/refill-pr.js'
import { patchCompatibility } from '../lib/host/refill.js'

/** 一份最小的 CRLF package.json（带 dsh.compatibility 结构）。 */
const MANIFEST = [
  '{',
  '  "name": "p",',
  '  "version": "1.0.0",',
  '  "dsh": {',
  '    "compatibility": {',
  '      "dshReleases": {',
  '        "0.1.0": "compatible"',
  '      },',
  '      "dshDepth": {',
  '        "0.1.0": "L2"',
  '      }',
  '    }',
  '  }',
  '}',
  '',
].join('\r\n')

/**
 * 造一个「假 worktree」目录：git 执行器被替换成只真的切目录里那份文件。
 * @returns {Promise<{root: string, records: string[][], git: Function}>} 夹具。
 */
async function fakeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-refill-pr-'))
  const records = []
  const git = async (args) => {
    records.push(args)
    if (args[0] === 'worktree' && args[1] === 'add') {
      // 模拟 `git worktree add`：把插件目录与 manifest 造出来。
      const path = args[4]  // [worktree, add, -b, <branch>, <path>, origin/main]
      await mkdir(join(path, 'plugin-a'), { recursive: true })
      await writeFile(join(path, 'plugin-a', 'package.json'), MANIFEST)
    }
    return { ok: true, stdout: '' }
  }
  return { root, records, git }
}

test('planRefillPr：分支名带版本，标题带数量，正文只列真正改动的插件', () => {
  const plan = planRefillPr({
    version: '0.2.2-rc.1',
    entries: [
      { name: 'a', depth: 'L2', changed: true },
      { name: 'b', depth: 'L1', changed: false },
    ],
  })
  assert.equal(plan.branch, 'chore/compat-refill-0.2.2-rc.1')
  assert.match(plan.title, /0\.2\.2-rc\.1.*1 个插件/)
  assert.match(plan.body, /\| `a` \| `compatible` \| \*\*L2\*\* \|/)
  assert.equal(plan.body.includes('`b`'), false, '没改动的插件不该进表格')
})

test('openRefillPullRequest：没有改动就早退，一条 git 命令都不跑', async () => {
  const { root, records, git } = await fakeRepo()
  try {
    const result = await openRefillPullRequest({
      repoRoot: root, worktreePath: join(root, '.worktrees'), version: '9',
      entries: [{ name: 'a', relDir: 'plugin-a', depth: 'L2', changed: false }],
      git, gh: async () => ({ ok: true }), patch: patchCompatibility,
    })
    assert.equal(result.skipped, true)
    assert.deepEqual(records, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('openRefillPullRequest：在 worktree 里改文件、提交、推分支、开 PR，最后清场', async () => {
  const { root, records, git } = await fakeRepo()
  const ghCalls = []
  try {
    const result = await openRefillPullRequest({
      repoRoot: root, worktreePath: join(root, '.worktrees'), version: '0.2.2-rc.1',
      entries: [{ name: 'a', relDir: 'plugin-a', depth: 'L2', changed: true }],
      git,
      gh: async (args) => { ghCalls.push(args); return { ok: true, stdout: 'https://github.com/o/r/pull/9\n' } },
      patch: patchCompatibility,
      now: 1_700_000_000_000,
    })
    assert.equal(result.ok, true)
    assert.equal(result.branch, 'chore/compat-refill-0.2.2-rc.1')
    assert.equal(result.prUrl, 'https://github.com/o/r/pull/9')
    assert.match(ghCalls[0][0], /^pr$/)
    const verbs = records.map((args) => `${args[0]} ${args[1] ?? ''}`.trim())
    assert.ok(verbs.includes('worktree add'), '要从 origin/main 切 worktree')
    assert.ok(verbs.includes('commit -m'), '要提交')
    assert.ok(verbs.some((verb) => verb.startsWith('push')), '要推分支')
    assert.ok(verbs.includes('worktree remove'), '必须清场（否则会卡住后续 ff 合并）')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('openRefillPullRequest：push 失败也要清场，并把原因带回来', async () => {
  const { root, records, git } = await fakeRepo()
  try {
    const result = await openRefillPullRequest({
      repoRoot: root, worktreePath: join(root, '.worktrees'), version: '1.0.0',
      entries: [{ name: 'a', relDir: 'plugin-a', depth: 'L2', changed: true }],
      git: async (args, cwd) => {
        if (args[0] === 'push') return { ok: false, error: 'no upstream' }
        return git(args, cwd)
      },
      gh: async () => ({ ok: true }),
      patch: patchCompatibility,
    })
    assert.equal(result.ok, false)
    assert.match(result.detail, /git push 失败.*no upstream/)
    assert.ok(records.some((args) => args[0] === 'worktree' && args[1] === 'remove'), '失败也必须清场')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('openRefillPullRequest：真的把补丁写进 worktree 的 package.json（CRLF 保留）', async () => {
  const { root, git } = await fakeRepo()
  const captured = []
  try {
    await openRefillPullRequest({
      repoRoot: root, worktreePath: join(root, '.worktrees'), version: '0.2.2-rc.1',
      entries: [{ name: 'a', relDir: 'plugin-a', depth: 'L2', changed: true }],
      git: async (args, cwd) => {
        // 在 commit 之前把文件内容读出来留证（之后 worktree 会被清掉）。
        if (args[0] === 'commit') {
          const path = args[2] ?? ''
          void path
        }
        return git(args, cwd)
      },
      gh: async () => ({ ok: true }),
      patch: (input) => {
        const patched = patchCompatibility(input)
        captured.push(patched.text)
        return patched
      },
    })
    assert.equal(captured.length, 1)
    assert.match(captured[0], /"0\.2\.2-rc\.1": "compatible"/)
    assert.match(captured[0], /"0\.2\.2-rc\.1": "L2"/)
    assert.ok(captured[0].includes('\r\n'), 'CRLF 必须保留')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

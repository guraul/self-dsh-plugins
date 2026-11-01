import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareRequest } from '../lib/request.js'

const SHA = 'b'.repeat(40)

function fakeBin(dir, name, script) {
  const file = join(dir, name)
  writeFileSync(file, script)
  chmodSync(file, 0o755)
  return file
}

function sandbox({ issueFails = false, prBody = `Closes #7` } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-subagents-prep-'))
  const gh = fakeBin(
    dir,
    'gh',
    `#!/bin/bash
if [[ "$1" == "pr" && "$2" == "view" ]]; then
  cat <<'JSON'
{"number":42,"title":"t","body":"${prBody}","headRefOid":"${SHA}","baseRefName":"main","files":[{"path":"a.js"}],"additions":1,"deletions":0}
JSON
  exit 0
fi
if [[ "$1" == "issue" && "$2" == "view" ]]; then
  ${issueFails ? 'echo "boom" >&2; exit 1' : `cat <<'JSON'\n{"number":7,"title":"真 issue","body":"这是 issue 正文"}\nJSON`}
fi
`,
  )
  const git = fakeBin(
    dir,
    'git',
    `#!/bin/bash
echo "+++ b/a.js"
echo "+hello"
`,
  )
  return { dir, gh, git }
}

test('prepareRequest 取真实 issue 正文', () => {
  const { dir, gh, git } = sandbox()
  const { request } = prepareRequest({ pr: 42, cwd: dir, ghBin: gh, gitBin: git })
  assert.equal(request.issue.number, 7)
  assert.equal(request.issue.title, '真 issue')
  assert.equal(request.issue.body, '这是 issue 正文')
  assert.equal(request.pr, 42)
  assert.equal(request.head_sha, SHA)
})

test('取 issue 失败时回退到 PR 信息且 number 为 null', () => {
  const { dir, gh, git } = sandbox({ issueFails: true })
  const { request } = prepareRequest({ pr: 42, cwd: dir, ghBin: gh, gitBin: git })
  assert.equal(request.issue.number, null)
  assert.equal(request.issue.title, 't')
  assert.match(request.issue.body, /Closes #7/)
})

test('无 Closes 时不去取 issue', () => {
  const { dir, gh, git } = sandbox({ prBody: '没有链接' })
  const { request } = prepareRequest({ pr: 42, cwd: dir, ghBin: gh, gitBin: git })
  assert.equal(request.issue.number, null)
})

test('diff 超预算时抛 E_BUDGET', () => {
  const { dir, gh, git } = sandbox()
  assert.throws(
    () => prepareRequest({ pr: 42, cwd: dir, ghBin: gh, gitBin: git, maxChars: 5 }),
    (error) => {
      assert.equal(error.code, 'E_BUDGET')
      return true
    },
  )
})

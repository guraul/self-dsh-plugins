/**
 * Unit tests for the pure `/ws` command router (Node 24 type stripping).
 * Run with `npm test`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parseWorkspaceCommand,
  resolveWorkspaceSelector,
  sessionKeyForWorkspace,
  type WorkspaceEntityLike,
} from '../src/workspace-router.ts'

/** Four workspaces in the order `/ws` would list them. */
const entries: readonly WorkspaceEntityLike[] = [
  {
    id: 'ws-self',
    path: '/Users/gubin/workspace/self-dsh-plugins',
    title: 'self-dsh-plugins',
    sessionIds: ['wecom-321a442c817b39b6', 'wecom-999fe97847e6563d'],
  },
  {
    id: 'ws-home',
    path: '/Users/gubin/workspace/homebase',
    title: 'homebase',
    sessionIds: ['wecom-aaaaaaaaaaaaaaaa'],
  },
  { id: 'ws-memx', path: '/Users/gubin/workspace/memx', title: 'memx', sessionIds: [] },
  { id: 'ws-mobile', path: '/Users/gubin/workspace/agent-mobile', title: 'agent-mobile', sessionIds: [] },
]

describe('parseWorkspaceCommand', () => {
  it('treats bare command heads as a list request', () => {
    for (const text of ['/ws', '/workspace', '/workspaces', '/工作区', '/WS', '/ws list']) {
      assert.deepEqual(parseWorkspaceCommand(text), { kind: 'list' }, text)
    }
  })

  it('parses a switch selector', () => {
    assert.deepEqual(parseWorkspaceCommand('/ws 2'), { kind: 'switch', selector: '2' })
    assert.deepEqual(parseWorkspaceCommand('/ws homebase'), { kind: 'switch', selector: 'homebase' })
    assert.deepEqual(
      parseWorkspaceCommand('/ws /Users/gubin/workspace/homebase'),
      { kind: 'switch', selector: '/Users/gubin/workspace/homebase' },
    )
    assert.deepEqual(
      parseWorkspaceCommand('/ws ws-home'),
      { kind: 'switch', selector: 'ws-home' },
    )
  })

  it('parses reset, default, add and help', () => {
    assert.deepEqual(parseWorkspaceCommand('/ws reset'), { kind: 'reset' })
    assert.deepEqual(parseWorkspaceCommand('/ws DEFAULT'), { kind: 'reset' })
    assert.deepEqual(parseWorkspaceCommand('/ws add /tmp'), { kind: 'add', path: '/tmp' })
    assert.deepEqual(parseWorkspaceCommand('/ws add'), { kind: 'add', path: '' })
    assert.deepEqual(parseWorkspaceCommand('/ws help'), { kind: 'help' })
    assert.deepEqual(parseWorkspaceCommand('/工作区 帮助'), { kind: 'help' })
  })

  it('leaves ordinary chat text alone', () => {
    for (const text of [
      '你好',
      'ws',
      '/wss 列表',
      '/workspacex',
      '帮我看看 /ws 怎么用',
      '/ls',
      '/ws-home',
    ]) {
      assert.equal(parseWorkspaceCommand(text), undefined, text)
    }
  })
})

describe('sessionKeyForWorkspace', () => {
  const windowKey = 'single:GuBin'
  const defaultPath = '/Users/gubin/workspace/self-dsh-plugins'

  it('keeps the bare window key for the default workspace', () => {
    const key = sessionKeyForWorkspace(
      windowKey,
      { id: 'ws-self', path: defaultPath, title: 'self-dsh-plugins' },
      defaultPath,
    )
    assert.equal(key, windowKey)
    // Legacy `wecom-*` ids hash this exact key, so it must never change.
    assert.equal(key, 'single:GuBin')
  })

  it('suffixes every other workspace with its id', () => {
    const key = sessionKeyForWorkspace(
      windowKey,
      { id: 'ws-home', path: '/Users/gubin/workspace/homebase', title: 'homebase' },
      defaultPath,
    )
    assert.equal(key, 'single:GuBin#ws=ws-home')
    assert.notEqual(key, windowKey)
  })

  it('gives different windows and workspaces different keys', () => {
    const other = sessionKeyForWorkspace(
      'group:chatid1',
      { id: 'ws-home', path: '/Users/gubin/workspace/homebase', title: 'homebase' },
      defaultPath,
    )
    assert.equal(other, 'group:chatid1#ws=ws-home')
  })
})

describe('resolveWorkspaceSelector', () => {
  it('accepts a 1-based index', () => {
    const result = resolveWorkspaceSelector(entries, '2')
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.entry.title, 'homebase')
  })

  it('accepts an exact title, case-insensitively', () => {
    const result = resolveWorkspaceSelector(entries, 'HomeBase')
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.entry.id, 'ws-home')
  })

  it('accepts an exact path, with or without a trailing slash', () => {
    for (const selector of [
      '/Users/gubin/workspace/memx',
      '/Users/gubin/workspace/memx/',
    ]) {
      const result = resolveWorkspaceSelector(entries, selector)
      assert.equal(result.ok, true, selector)
      if (result.ok) assert.equal(result.entry.title, 'memx')
    }
  })

  it('accepts an exact registry id', () => {
    const result = resolveWorkspaceSelector(entries, 'ws-mobile')
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.entry.path, '/Users/gubin/workspace/agent-mobile')
  })

  it('accepts a unique directory basename', () => {
    const result = resolveWorkspaceSelector(entries, 'agent-mobile')
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.entry.id, 'ws-mobile')
  })

  it('refuses an out-of-range index', () => {
    for (const selector of ['0', '5', '99']) {
      const result = resolveWorkspaceSelector(entries, selector)
      assert.equal(result.ok, false, selector)
      if (!result.ok) assert.match(result.reason, /超出范围/u)
    }
  })

  it('refuses an ambiguous title instead of guessing', () => {
    const duplicated: WorkspaceEntityLike[] = [
      { id: 'ws-a', path: '/a/one', title: 'shared' },
      { id: 'ws-b', path: '/b/two', title: 'Shared' },
    ]
    const result = resolveWorkspaceSelector(duplicated, 'shared')
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /对应 2 个工作区/u)
  })

  it('reports an unknown selector', () => {
    for (const selector of ['', 'nowhere', '/no/such/dir']) {
      const result = resolveWorkspaceSelector(entries, selector)
      assert.equal(result.ok, false, selector)
      if (!result.ok) assert.ok(result.reason.length > 0)
    }
  })
})

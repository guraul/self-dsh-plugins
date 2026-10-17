import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerProductDelegate, buildRelayPrompt } from '../lib/tools/product-delegate.js'

/**
 * Regression guard for issue #8.
 *
 * DSH 0.2.1 dropped `persona` / `toolFilter` from `SubagentStartRequest` and
 * builds a local child's composition from `agentPreset` alone. The 0.4.1
 * adaptation simply stopped sending the restriction, so every background
 * delegation produced a child with the parent's full toolset: it ran the task
 * locally on the session model instead of calling `product_submit`, and the
 * product CLI was never started. These tests assert the REQUEST CONTENT — the
 * previous test only asserted which service method was called, which is why
 * the regression shipped green.
 */

/** Build a delegate tool with a fake subagent service and minimal deps. */
function harness({ preset }) {
  const calls = []
  const tools = {}
  const ctx = {
    tools: { register: (definition) => { tools[definition.name] = definition } },
    subagents: {
      startActivation: async (spec) => {
        calls.push(spec)
        return { childId: 'child-1', result: Promise.resolve({}), dispose: async () => {} }
      },
    },
    on: () => () => {},
  }
  const deps = {
    bindings: new Map(),
    bridges: { acp: {} },
    availability: { acp: { registered: true } },
    providers: { acp: { type: 'acp', command: 'opencode', args: ['acp'] } },
    roles: {
      list: () => [{ id: 'general' }],
      get: () => ({
        id: 'general',
        provider: 'acp',
        permissionMode: 'default',
        allowDelegation: false,
        instructions: 'You have full file access; just do the work.',
      }),
    },
    state: { activeChildren: 0 },
    maxConcurrent: 8,
    availableProviders: ['acp'],
    runtimeName: (key) => `product-subagents:${key}`,
    relayPreset: async () => preset,
    maxDelegationDepth: 2,
  }
  registerProductDelegate(ctx, deps)
  const exec = {
    signal: new AbortController().signal,
    agent: { session: { id: 'parent-session', header: { cwd: process.cwd() } } },
  }
  return { tools, calls, exec }
}

test('activation path mounts the relay preset and caps delegation depth', async () => {
  const { tools, calls, exec } = harness({ preset: 'product-relay' })
  await tools.product_delegate.execute({ role: 'general', provider: 'acp', task: 'do the thing' }, exec)
  assert.equal(calls.length, 1)
  const spec = calls[0]
  assert.equal(spec.provider, 'product-subagents:acp')
  // The composition restriction DSH 0.2.1 actually honours:
  assert.equal(spec.request.agentPreset, 'product-relay')
  assert.equal(spec.request.maxDepth, 2)
  // Gone from the 0.2.1 contract; sending them is silently dropped, so the
  // restriction must not depend on them.
  assert.equal('persona' in spec.request, false)
  assert.equal('toolFilter' in spec.request, false)
})

test('the relay prompt keeps the role brief addressed to the remote product', async () => {
  const { tools, calls, exec } = harness({ preset: 'product-relay' })
  await tools.product_delegate.execute({ role: 'general', provider: 'acp', task: 'do the thing' }, exec)
  const prompt = calls[0].request.prompt[0].text
  assert.match(prompt, /ONLY tool is `product_submit`/)
  assert.match(prompt, /BEGIN TEXT ADDRESSED TO THE REMOTE PRODUCT AGENT/)
  // The remote brief is still delivered — but delimited, not read as the local
  // child's own permission grant.
  assert.match(prompt, /just do the work/)
  assert.ok(prompt.indexOf('BEGIN TEXT ADDRESSED') < prompt.indexOf('just do the work'))
})

test('refuses to start an unrestricted local child when no preset is available', async () => {
  const { tools, calls, exec } = harness({ preset: undefined })
  await assert.rejects(
    () => tools.product_delegate.execute({ role: 'general', provider: 'acp', task: 'x' }, exec),
    /refusing to start an unrestricted local subagent/,
  )
  assert.equal(calls.length, 0)
})

test('buildRelayPrompt delimits the remote text', () => {
  const prompt = buildRelayPrompt('acp', { type: 'acp', command: 'opencode' }, 'REMOTE INSTRUCTIONS')
  assert.match(prompt, /BEGIN TEXT ADDRESSED TO THE REMOTE PRODUCT AGENT/)
  assert.match(prompt, /END TEXT ADDRESSED TO THE REMOTE PRODUCT AGENT/)
  assert.ok(prompt.indexOf('BEGIN TEXT') < prompt.indexOf('REMOTE INSTRUCTIONS'))
  assert.ok(prompt.indexOf('REMOTE INSTRUCTIONS') < prompt.indexOf('END TEXT'))
})

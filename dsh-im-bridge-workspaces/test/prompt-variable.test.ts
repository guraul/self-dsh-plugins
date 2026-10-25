/**
 * Unit tests for the `{{cwd}}` prompt-variable registration helper
 * (Node 24 type stripping). Run with `pnpm test`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { registerPromptVariable, type PromptVariableRegistry } from '../src/prompt-variable.ts'

/** Collect console.warn output without touching the rest of the test output. */
function captureWarnings(run: () => void): string[] {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '))
  }
  try {
    run()
  } finally {
    console.warn = original
  }
  return warnings
}

describe('registerPromptVariable', () => {
  it('registers the variable so the host can resolve {{cwd}}', () => {
    const registrations: Array<{ name: string; provider: () => string | undefined }> = []
    const prompt: PromptVariableRegistry = {
      variable(name, provider) {
        registrations.push({ name, provider })
      },
    }

    registerPromptVariable(prompt, 'cwd', () => '/w/agent-mobile')

    assert.equal(registrations.length, 1)
    assert.equal(registrations[0]?.name, 'cwd')
    assert.equal(registrations[0]?.provider(), '/w/agent-mobile')
  })

  it('only warns when the host rejects the registration', () => {
    const prompt: PromptVariableRegistry = {
      variable() {
        throw new Error('unknown prompt variable: cwd')
      },
    }

    const warnings = captureWarnings(() => {
      // Must not throw: a host without variable support keeps working.
      registerPromptVariable(prompt, 'cwd', () => '/w')
    })

    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /\{\{cwd\}\}/u)
    assert.match(warnings[0] ?? '', /unknown prompt variable/u)
  })

  it('stringifies a non-Error rejection', () => {
    const prompt: PromptVariableRegistry = {
      variable() {
        throw 'nope'
      },
    }

    const warnings = captureWarnings(() => {
      registerPromptVariable(prompt, 'cwd', () => '/w')
    })

    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /nope/u)
  })
})

/**
 * Agent-scoped prompt variable registration (pure helper, Node 24 type stripping).
 *
 * DSH ≥0.2.1 only registers the `provider` / `model` prompt variables, so a
 * persona (built-in or user `personaFile`) that uses `{{cwd}}` throws
 * "unknown prompt variable" in strict mode and fails the whole turn. The bridge
 * re-registers the placeholders it promises in the Agent scope.
 */

/** Minimal view of the Agent-bound `systemPrompt` registry. */
export interface PromptVariableRegistry {
  variable(name: string, provider: () => string | undefined): unknown
}

/**
 * Register one prompt variable, best effort: an older host without
 * `variable()` (or one that rejects a duplicate name) must not break the
 * channel install, so failures only warn.
 */
export function registerPromptVariable(
  prompt: PromptVariableRegistry,
  name: string,
  provider: () => string | undefined,
): void {
  try {
    prompt.variable(name, provider)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[im-bridge] 注册 {{${name}}} 提示词变量失败: ${message}`)
  }
}

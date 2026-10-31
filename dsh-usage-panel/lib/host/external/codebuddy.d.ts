import type { SubagentExternal } from '../../shared/contract.ts';
export interface CodebuddyRead {
    hit: SubagentExternal | null;
    errors: string[];
}
export interface CodebuddyOptions {
    /** Root of the transcript tree; defaults to `~/.codebuddy/projects`. */
    projectsDir?: string;
}
/**
 * Project directory slug: the cwd with separators replaced by `-` and the
 * leading separator removed. `/Users/gubin/workspace/self-dsh-plugins` →
 * `Users-gubin-workspace-self-dsh-plugins`.
 */
export declare function cwdSlug(cwd: string): string;
export declare function defaultCodebuddyProjectsDir(): string;
export declare function codebuddyTranscriptPath(projectsDir: string, cwd: string, remoteId: string): string;
/**
 * Parse one transcript. Only `type === 'message' && role === 'assistant'`
 * lines with a usage block count.
 *
 * ⚠️ codebuddy reports **OpenAI-style** usage: `usage.inputTokens` (=
 * `prompt_tokens`) ALREADY includes the cached prefix. The clean decomposition
 * lives in `rawUsage`:
 *   `prompt_cache_hit_tokens`  → cache read
 *   `prompt_cache_miss_tokens` → uncached input
 * Reading `inputTokens` as uncached input inflates it by the cache-hit amount
 * (~80x on cache-heavy turns) and hides the cache column entirely (issue #127).
 * Malformed lines are ignored.
 */
export declare function readCodebuddySession(remoteId: string, cwd: string, options?: CodebuddyOptions): Promise<CodebuddyRead>;

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
 * lines with a usage block count. Per the fork contract cacheRead/cacheWrite
 * stay 0 (codebuddy reports them separately but the panel keeps the external
 * row faithful to input/output only). Malformed lines are ignored.
 */
export declare function readCodebuddySession(remoteId: string, cwd: string, options?: CodebuddyOptions): Promise<CodebuddyRead>;

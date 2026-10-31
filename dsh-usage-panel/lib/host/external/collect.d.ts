import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import type { SubagentsPayload } from '../../shared/contract.ts';
export interface SubagentDeps {
    sq: Pick<SessionQueryEngine, 'listSessions' | 'readTitle'>;
    registryPath?: string;
    projCacheDir?: string;
    opencodeDbPaths?: string[];
    codebuddyProjectsDir?: string;
    /** Override the 60s cache window (tests / callers that need fresh data). */
    ttlMs?: number;
    now?: number;
}
/** Drop the module-level cache (tests and explicit refreshes). */
export declare function clearSubagentCache(): void;
export declare function defaultProjCacheDir(): string;
/**
 * Build the subagent payload. `sq.listSessions()` failures reject (the RPC
 * maps them to an internal error); every external-reader failure is recorded in
 * `coverage.errors` and degrades that row to `external: null`.
 */
export declare function collectSubagents(deps: SubagentDeps): Promise<SubagentsPayload>;

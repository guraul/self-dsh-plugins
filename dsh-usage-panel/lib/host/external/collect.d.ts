import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import type { SubagentsPayload } from '../../shared/contract.ts';
import { type ExternalSource, type HomebaseConfig } from './homebase.ts';
export interface SubagentDeps {
    sq: Pick<SessionQueryEngine, 'listSessions' | 'readTitle'>;
    registryPath?: string;
    projCacheDir?: string;
    opencodeDbPaths?: string[];
    codebuddyProjectsDir?: string;
    /**
     * Where opencode's external usage comes from. `homebase` (self-dsh-plugins#208)
     * asks the production API instead of reading the local db; any failure falls
     * back to `local` so the panel never goes blank.
     */
    externalSource?: ExternalSource;
    homebaseConfig?: HomebaseConfig;
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

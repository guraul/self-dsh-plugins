import type { SubagentExternal } from '../../shared/contract.ts';
export type ExternalSource = 'local' | 'homebase';
export interface HomebaseConfig {
    source: ExternalSource;
    url: string;
    token: string;
    ca: string | null;
    timeoutMs: number;
}
/** Read config from env. `homebase` only when explicitly selected *and* fully configured. */
export declare function homebaseConfigFromEnv(env?: NodeJS.ProcessEnv): HomebaseConfig;
interface QueryRow {
    usage_date: string;
    source: string;
    provider: string;
    model: string;
    session_id: string;
    calls?: number;
    input_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    cache_read?: number;
    cache_write?: number;
    total_tokens?: number;
    first_at?: number;
    last_at?: number;
}
/**
 * Fold homebase rows into one `SubagentExternal` per session id.
 *
 * Totals are summed across days/models; the reported model is the largest by
 * token volume (matches the local reader's "dominant model" behaviour); the
 * window is min(first_at)..max(last_at).
 */
export declare function foldHomebaseRows(rows: readonly QueryRow[]): Map<string, SubagentExternal>;
/** Fetch and fold. Throws on any failure so the caller can fall back. */
export declare function fetchHomebaseUsage(config: HomebaseConfig, opts?: {
    limit?: number;
}): Promise<Map<string, SubagentExternal>>;
export {};

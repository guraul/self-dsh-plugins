import type { Overview, SubagentExternal } from '../../shared/contract.ts';
export type ExternalSource = 'local' | 'homebase';
export interface HomebaseConfig {
    source: ExternalSource;
    url: string;
    token: string;
    ca: string | null;
    timeoutMs: number;
}
/** `~/.dsh/token-sync.env` — the same file the collector writes/reads (600). */
export declare function defaultTokenSyncEnvPath(home?: string): string;
/** Parse KEY=VALUE lines; trims quotes and `~`. Never logs values. */
export declare function parseTokenSyncEnv(content: string): Record<string, string>;
/** Read the collector's env file; returns {} when absent/unreadable (caller falls back). */
export declare function readTokenSyncEnv(file?: string): Record<string, string>;
/**
 * Read config. Credentials come from process env first, then from the
 * collector's `~/.dsh/token-sync.env` (single source of truth; the plist is
 * committed to git and must never carry a token).
 */
export declare function homebaseConfigFromEnv(env?: NodeJS.ProcessEnv, file?: string): HomebaseConfig;
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
export declare function loadCaContents(caPath: string | null): string | undefined;
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
interface OverviewRawRow extends QueryRow {
    title?: string | null;
}
/** 把 rows 折成 byDay: {day: {model: Buckets}}，供 buildDayWindow 复用。 */
export declare function foldOverviewByDay(rows: readonly OverviewRawRow[]): Record<string, Record<string, {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}>>;
/** 纯函数装配：便于单测，不发请求。 */
export declare function buildOverviewFromRows(rows: readonly OverviewRawRow[], now?: number): Overview;
/** 拉全量 rows 并装配 Overview。任何失败向上抛，由调用方回退本地。 */
export declare function fetchHomebaseOverview(config: HomebaseConfig, opts?: {
    limit?: number;
}): Promise<Overview>;
export {};

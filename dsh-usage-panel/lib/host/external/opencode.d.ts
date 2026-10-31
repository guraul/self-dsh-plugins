import type { SubagentExternal } from '../../shared/contract.ts';
export interface OpencodeRead {
    hits: Map<string, SubagentExternal>;
    errors: string[];
}
export interface OpencodeOptions {
    /** Explicit database paths; defaults to the live db plus `~/backups/opencode-sessions-*`. */
    dbPaths?: string[];
}
/**
 * The `model` column stores JSON such as
 * `{"id":"deepseek-v4.1-flash-free","providerID":"opencode"}`; take `.id`.
 * Plain-text legacy values are kept as-is; anything else is unknown.
 */
export declare function parseOpencodeModel(raw: unknown): string | null;
/** Candidate databases: the live store first, then rotated session backups. */
export declare function defaultOpencodeDbPaths(): Promise<string[]>;
/**
 * Batch-read opencode sessions by remote id. Current schema `session_v2` is
 * tried first; ids absent there fall back to the legacy `session` table (old
 * databases only). Never throws.
 */
export declare function readOpencodeSessions(remoteIds: readonly string[], options?: OpencodeOptions): Promise<OpencodeRead>;

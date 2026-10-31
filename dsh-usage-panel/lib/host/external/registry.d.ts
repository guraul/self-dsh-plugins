export interface RegistryEntry {
    product: string;
    remoteId: string;
    cwd: string;
    updatedAt: number;
}
export interface RegistryLoad {
    entries: Map<string, RegistryEntry>;
    errors: string[];
}
/** Session ids are sometimes branded with a `session-` prefix; registry keys are bare uuids. */
export declare function normalizeSessionId(id: unknown): string;
export declare function defaultRegistryPath(): string;
/**
 * Read the registry file. Missing file / invalid JSON / non-object roots all
 * return an empty map and push one error; individual malformed entries are
 * skipped. Never throws.
 */
export declare function loadRegistry(filePath?: string): Promise<RegistryLoad>;

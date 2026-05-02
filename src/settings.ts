/**
 * Settings for the Hypercore Link Language.
 *
 * Parsed from the JSON string returned by `languageSettings()` at
 * runtime. Provides sensible defaults.
 *
 * Spec §9.
 */

export interface SwarmSettings {
    /** DHT bootstrap nodes (empty = use defaults). */
    bootstrap: string[];
    /** Max peer connections. */
    maxPeers: number;
    /** Enable relay connections (for NAT traversal). */
    relay: boolean;
}

export interface CoreSettings {
    /** Sparse mode — only download blocks on demand. */
    sparse: boolean;
    /** Encoding for blocks. */
    valueEncoding: "json" | "binary" | "utf-8";
}

export interface MultiWriterSettings {
    /** Enable Autobase for multi-agent writes. */
    enabled: boolean;
    /** Known writer feed keys (hex). */
    writerKeys: string[];
}

export interface IndexingSettings {
    /** Enable Hyperbee B-tree index. */
    enabled: boolean;
    /** Index by source, target, predicate, author. */
    indexFields: ("source" | "target" | "predicate" | "author" | "timestamp")[];
}

export interface DualLanguageSettings {
    /** Enable dual-language origin tracking. */
    enabled: boolean;
    /** Predicates to exclude from federation. */
    excludePredicates: string[];
}

export type SyncMode = "bidirectional" | "publish-only" | "subscribe-only";

export interface HypercoreSettings {
    /** Sync direction. */
    syncMode: SyncMode;
    /** Hyperswarm configuration. */
    swarm: SwarmSettings;
    /** Hypercore configuration. */
    core: CoreSettings;
    /** Multi-writer (Autobase). */
    multiWriter: MultiWriterSettings;
    /** Hyperbee indexing. */
    indexing: IndexingSettings;
    /** Dual-language. */
    dualLanguage: DualLanguageSettings;
}

/** Default settings — sensible defaults for bidirectional Hypercore sync. */
export const DEFAULT_SETTINGS: HypercoreSettings = {
    syncMode: "bidirectional",
    swarm: {
        bootstrap: [],
        maxPeers: 32,
        relay: true,
    },
    core: {
        sparse: false,
        valueEncoding: "json",
    },
    multiWriter: {
        enabled: true,
        writerKeys: [],
    },
    indexing: {
        enabled: true,
        indexFields: ["source", "target", "predicate", "author"],
    },
    dualLanguage: {
        enabled: false,
        excludePredicates: [],
    },
};

/**
 * Parse settings from a raw JSON string, falling back to defaults
 * for any missing or invalid fields.
 */
export function parseSettings(raw: string | null | undefined): HypercoreSettings {
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
        const parsed = JSON.parse(raw);
        return {
            syncMode: ["bidirectional", "publish-only", "subscribe-only"].includes(parsed?.syncMode)
                ? parsed.syncMode
                : DEFAULT_SETTINGS.syncMode,
            swarm: {
                bootstrap: Array.isArray(parsed?.swarm?.bootstrap)
                    ? parsed.swarm.bootstrap
                    : DEFAULT_SETTINGS.swarm.bootstrap,
                maxPeers: typeof parsed?.swarm?.maxPeers === "number" && parsed.swarm.maxPeers > 0
                    ? parsed.swarm.maxPeers
                    : DEFAULT_SETTINGS.swarm.maxPeers,
                relay: typeof parsed?.swarm?.relay === "boolean"
                    ? parsed.swarm.relay
                    : DEFAULT_SETTINGS.swarm.relay,
            },
            core: {
                sparse: typeof parsed?.core?.sparse === "boolean"
                    ? parsed.core.sparse
                    : DEFAULT_SETTINGS.core.sparse,
                valueEncoding: ["json", "binary", "utf-8"].includes(parsed?.core?.valueEncoding)
                    ? parsed.core.valueEncoding
                    : DEFAULT_SETTINGS.core.valueEncoding,
            },
            multiWriter: {
                enabled: typeof parsed?.multiWriter?.enabled === "boolean"
                    ? parsed.multiWriter.enabled
                    : DEFAULT_SETTINGS.multiWriter.enabled,
                writerKeys: Array.isArray(parsed?.multiWriter?.writerKeys)
                    ? parsed.multiWriter.writerKeys
                    : DEFAULT_SETTINGS.multiWriter.writerKeys,
            },
            indexing: {
                enabled: typeof parsed?.indexing?.enabled === "boolean"
                    ? parsed.indexing.enabled
                    : DEFAULT_SETTINGS.indexing.enabled,
                indexFields: Array.isArray(parsed?.indexing?.indexFields)
                    ? parsed.indexing.indexFields
                    : DEFAULT_SETTINGS.indexing.indexFields,
            },
            dualLanguage: {
                enabled: typeof parsed?.dualLanguage?.enabled === "boolean"
                    ? parsed.dualLanguage.enabled
                    : DEFAULT_SETTINGS.dualLanguage.enabled,
                excludePredicates: Array.isArray(parsed?.dualLanguage?.excludePredicates)
                    ? parsed.dualLanguage.excludePredicates
                    : DEFAULT_SETTINGS.dualLanguage.excludePredicates,
            },
        };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

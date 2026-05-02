/**
 * Tests for the settings parser.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseSettings, DEFAULT_SETTINGS } from "../src/settings.js";
import type { HypercoreSettings } from "../src/settings.js";

// ---------------------------------------------------------------------------
// parseSettings
// ---------------------------------------------------------------------------

describe("parseSettings", () => {
    it("returns defaults for null input", () => {
        const result = parseSettings(null);
        assert.equal(result.syncMode, DEFAULT_SETTINGS.syncMode);
        assert.deepEqual(result.swarm.bootstrap, DEFAULT_SETTINGS.swarm.bootstrap);
    });

    it("returns defaults for undefined input", () => {
        const result = parseSettings(undefined);
        assert.equal(result.syncMode, DEFAULT_SETTINGS.syncMode);
    });

    it("returns defaults for empty string", () => {
        const result = parseSettings("");
        assert.equal(result.syncMode, DEFAULT_SETTINGS.syncMode);
    });

    it("returns defaults for invalid JSON", () => {
        const result = parseSettings("not json");
        assert.equal(result.syncMode, DEFAULT_SETTINGS.syncMode);
    });

    it("parses valid complete settings", () => {
        const input: HypercoreSettings = {
            syncMode: "publish-only",
            swarm: {
                bootstrap: ["dht1.example.com:49737"],
                maxPeers: 16,
                relay: false,
            },
            core: {
                sparse: true,
                valueEncoding: "binary",
            },
            multiWriter: {
                enabled: false,
                writerKeys: ["aa".repeat(32)],
            },
            indexing: {
                enabled: true,
                indexFields: ["source", "target"],
            },
            dualLanguage: {
                enabled: true,
                excludePredicates: ["system://internal"],
            },
        };

        const result = parseSettings(JSON.stringify(input));
        assert.equal(result.syncMode, "publish-only");
        assert.deepEqual(result.swarm.bootstrap, ["dht1.example.com:49737"]);
        assert.equal(result.swarm.maxPeers, 16);
        assert.equal(result.swarm.relay, false);
        assert.equal(result.core.sparse, true);
        assert.equal(result.core.valueEncoding, "binary");
        assert.equal(result.multiWriter.enabled, false);
        assert.deepEqual(result.multiWriter.writerKeys, ["aa".repeat(32)]);
        assert.equal(result.indexing.enabled, true);
        assert.deepEqual(result.indexing.indexFields, ["source", "target"]);
        assert.equal(result.dualLanguage.enabled, true);
        assert.deepEqual(result.dualLanguage.excludePredicates, ["system://internal"]);
    });

    it("uses defaults for missing fields", () => {
        const result = parseSettings(JSON.stringify({ syncMode: "subscribe-only" }));
        assert.equal(result.syncMode, "subscribe-only");
        assert.equal(result.swarm.maxPeers, DEFAULT_SETTINGS.swarm.maxPeers);
        assert.equal(result.core.sparse, DEFAULT_SETTINGS.core.sparse);
    });

    it("ignores invalid syncMode", () => {
        const result = parseSettings(JSON.stringify({ syncMode: "invalid" }));
        assert.equal(result.syncMode, DEFAULT_SETTINGS.syncMode);
    });

    it("ignores invalid valueEncoding", () => {
        const result = parseSettings(JSON.stringify({
            core: { valueEncoding: "invalid" },
        }));
        assert.equal(result.core.valueEncoding, DEFAULT_SETTINGS.core.valueEncoding);
    });

    it("handles non-boolean sparse", () => {
        const result = parseSettings(JSON.stringify({
            core: { sparse: "yes" },
        }));
        assert.equal(result.core.sparse, DEFAULT_SETTINGS.core.sparse);
    });

    it("handles negative maxPeers", () => {
        const result = parseSettings(JSON.stringify({
            swarm: { maxPeers: -5 },
        }));
        assert.equal(result.swarm.maxPeers, DEFAULT_SETTINGS.swarm.maxPeers);
    });

    it("handles non-boolean relay", () => {
        const result = parseSettings(JSON.stringify({
            swarm: { relay: "yes" },
        }));
        assert.equal(result.swarm.relay, DEFAULT_SETTINGS.swarm.relay);
    });

    it("handles non-array bootstrap", () => {
        const result = parseSettings(JSON.stringify({
            swarm: { bootstrap: "not-an-array" },
        }));
        assert.deepEqual(result.swarm.bootstrap, DEFAULT_SETTINGS.swarm.bootstrap);
    });

    it("handles non-boolean multiWriter.enabled", () => {
        const result = parseSettings(JSON.stringify({
            multiWriter: { enabled: "yes" },
        }));
        assert.equal(result.multiWriter.enabled, DEFAULT_SETTINGS.multiWriter.enabled);
    });

    it("handles non-array writerKeys", () => {
        const result = parseSettings(JSON.stringify({
            multiWriter: { writerKeys: "not-an-array" },
        }));
        assert.deepEqual(result.multiWriter.writerKeys, DEFAULT_SETTINGS.multiWriter.writerKeys);
    });

    it("handles non-boolean dualLanguage.enabled", () => {
        const result = parseSettings(JSON.stringify({
            dualLanguage: { enabled: "yes" },
        }));
        assert.equal(result.dualLanguage.enabled, DEFAULT_SETTINGS.dualLanguage.enabled);
    });

    it("handles empty object", () => {
        const result = parseSettings("{}");
        assert.equal(result.syncMode, DEFAULT_SETTINGS.syncMode);
        assert.equal(result.swarm.maxPeers, DEFAULT_SETTINGS.swarm.maxPeers);
        assert.equal(result.multiWriter.enabled, DEFAULT_SETTINGS.multiWriter.enabled);
    });
});

// ---------------------------------------------------------------------------
// DEFAULT_SETTINGS
// ---------------------------------------------------------------------------

describe("DEFAULT_SETTINGS", () => {
    it("has bidirectional sync mode", () => {
        assert.equal(DEFAULT_SETTINGS.syncMode, "bidirectional");
    });

    it("has 32 max peers", () => {
        assert.equal(DEFAULT_SETTINGS.swarm.maxPeers, 32);
    });

    it("has relay enabled", () => {
        assert.equal(DEFAULT_SETTINGS.swarm.relay, true);
    });

    it("has json value encoding", () => {
        assert.equal(DEFAULT_SETTINGS.core.valueEncoding, "json");
    });

    it("has multi-writer enabled", () => {
        assert.equal(DEFAULT_SETTINGS.multiWriter.enabled, true);
    });

    it("has indexing enabled", () => {
        assert.equal(DEFAULT_SETTINGS.indexing.enabled, true);
    });

    it("has expected index fields", () => {
        assert.deepEqual(
            DEFAULT_SETTINGS.indexing.indexFields,
            ["source", "target", "predicate", "author"],
        );
    });

    it("has disabled dual-language by default", () => {
        assert.equal(DEFAULT_SETTINGS.dualLanguage.enabled, false);
    });
});

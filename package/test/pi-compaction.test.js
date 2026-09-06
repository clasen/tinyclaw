import test from "node:test";
import assert from "node:assert/strict";
import { createPiSettingsManager } from "../src/core/agent/agent-manager.js";
import { applyConfigDefaults, piConfigDefaults } from "../src/core/config/config-defaults.js";

test("provides Pi compaction defaults through Arisa config", () => {
  const config = applyConfigDefaults({ pi: {} });

  assert.deepEqual(config.pi.compaction, {
    enabled: true,
    reserveTokens: 120_000,
    keepRecentTokens: 20_000
  });
  assert.deepEqual(config.pi.compaction, piConfigDefaults.compaction);
});

test("merges partial resident session cache overrides with defaults", () => {
  const config = applyConfigDefaults({ pi: { sessionCache: { maxSessions: 2 } } });

  assert.deepEqual(config.pi.sessionCache, {
    maxSessions: 2,
    maxPersistedBytes: 48 * 1024 * 1024
  });
});

test("merges partial session rotation overrides with defaults", () => {
  const config = applyConfigDefaults({ pi: { sessionRotation: { enabled: false } } });

  assert.deepEqual(config.pi.sessionRotation, {
    enabled: false,
    compactAtPersistedBytes: 24 * 1024 * 1024,
    maxPersistedBytes: 32 * 1024 * 1024
  });
});

test("merges partial exclusive turn coordinator overrides with defaults", () => {
  const config = applyConfigDefaults({ pi: { turnCoordinator: { backgroundQueueTtlMs: 30_000 } } });

  assert.deepEqual(config.pi.turnCoordinator, {
    enabled: true,
    backgroundQueueTtlMs: 30_000,
    interactiveQueueTtlMs: 0,
    interactiveQuietMs: 2_000,
    maxQueued: 100
  });
});

test("merges partial Pi compaction overrides with defaults", () => {
  const config = applyConfigDefaults({
    pi: { compaction: { reserveTokens: 8_192 } }
  });

  assert.deepEqual(config.pi.compaction, {
    enabled: true,
    reserveTokens: 8_192,
    keepRecentTokens: 20_000
  });
});

test("passes Arisa compaction config to Pi settings", () => {
  const config = applyConfigDefaults({
    pi: {
      compaction: {
        enabled: false,
        reserveTokens: 12_000,
        keepRecentTokens: 18_000
      }
    }
  });

  const settingsManager = createPiSettingsManager(config);

  assert.deepEqual(settingsManager.getCompactionSettings(), config.pi.compaction);
});

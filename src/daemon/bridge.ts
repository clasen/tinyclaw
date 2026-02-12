/**
 * @module daemon/bridge
 * @role HTTP client from Daemon to Core with smart fallback to local AI CLI.
 * @responsibilities
 *   - POST messages to Core via Unix socket
 *   - Respect Core lifecycle state (starting/up/down)
 *   - Wait for Core during startup, fallback only when truly down
 *   - Serialize fallback calls (one CLI process at a time)
 * @dependencies shared/config, shared/types, daemon/fallback, daemon/lifecycle
 * @effects Network (HTTP to Core), may spawn AI CLI process
 */

import { config } from "../shared/config";
import { createLogger } from "../shared/logger";
import type { IncomingMessage, CoreResponse } from "../shared/types";
import { fallbackClaude } from "./fallback";
import { getCoreState, getCoreError, waitForCoreReady } from "./lifecycle";

const log = createLogger("daemon");

const CORE_URL = "http://localhost/core";
const STARTUP_WAIT_MS = 15_000;
const RETRY_DELAY = 3000;

type StatusCallback = (text: string) => Promise<void>;

// Serialize fallback calls — only one fallback CLI process at a time
let fallbackQueue: Promise<string> = Promise.resolve("");

export async function sendToCore(
  message: IncomingMessage,
  onStatus?: StatusCallback,
): Promise<CoreResponse> {
  const state = getCoreState();

  if (state === "starting") {
    return await handleStarting(message, onStatus);
  }

  if (state === "up") {
    return await handleUp(message, onStatus);
  }

  // state === "down" — go straight to fallback
  log.warn("Core is down, using fallback");
  return await runFallback(message, onStatus);
}

/**
 * Core is starting — wait for it, then send.
 */
async function handleStarting(
  message: IncomingMessage,
  onStatus?: StatusCallback,
): Promise<CoreResponse> {
  log.info("Core is starting, waiting for it to be ready...");
  await onStatus?.("Core starting, please wait...");

  const ready = await waitForCoreReady(STARTUP_WAIT_MS);

  if (ready) {
    try {
      return await postToCore(message);
    } catch {
      log.warn("Core ready but request failed, retrying...");
      await sleep(RETRY_DELAY);
      try {
        return await postToCore(message);
      } catch {
        // Fall through to fallback
      }
    }
  }

  log.warn("Core didn't start in time, using fallback");
  return await runFallback(message, onStatus);
}

/**
 * Core is up — normal path with one retry.
 */
async function handleUp(
  message: IncomingMessage,
  onStatus?: StatusCallback,
): Promise<CoreResponse> {
  try {
    return await postToCore(message);
  } catch {
    // First failure
  }

  log.warn("Core unreachable, retrying in 3s...");
  await onStatus?.("Core not responding, retrying...");
  await sleep(RETRY_DELAY);

  try {
    return await postToCore(message);
  } catch {
    // Still down
  }

  log.warn("Core still unreachable after retry, using fallback");
  return await runFallback(message, onStatus);
}

/**
 * Fallback: call local CLI directly (Claude -> Codex). Serialized so only one runs at a time.
 */
async function runFallback(
  message: IncomingMessage,
  onStatus?: StatusCallback,
): Promise<CoreResponse> {
  const coreError = getCoreError();

  if (coreError) {
    const preview = coreError.length > 300 ? coreError.slice(-300) : coreError;
    await onStatus?.(`Core is down. Error:\n<pre>${escapeHtml(preview)}</pre>\nFalling back to direct CLI (Claude/Codex)...`);
  } else {
    await onStatus?.("Core is down. Falling back to direct CLI (Claude/Codex)...");
  }

  const text = message.text || "[non-text message — media not available in fallback mode]";

  // Chain onto the queue so only one fallback CLI runs at a time
  const result = fallbackQueue.then(() => fallbackClaude(text, coreError ?? undefined));
  fallbackQueue = result.catch(() => "");

  const response = await result;
  return { text: response };
}

async function postToCore(message: IncomingMessage): Promise<CoreResponse> {
  const response = await fetch(`${CORE_URL}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(config.claudeTimeout + 5000),
    unix: config.coreSocket,
  } as any);

  if (!response.ok) {
    throw new Error(`Core returned ${response.status}`);
  }

  return (await response.json()) as CoreResponse;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function isCoreHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${CORE_URL}/health`, {
      signal: AbortSignal.timeout(2000),
      unix: config.coreSocket,
    } as any);
    return response.ok;
  } catch {
    return false;
  }
}

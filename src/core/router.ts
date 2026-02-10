/**
 * @module core/router
 * @role Decide which Claude model to use based on message complexity.
 * @responsibilities
 *   - Analyze incoming message text for complexity patterns
 *   - Return model ID, timeout, and reason for logging
 * @dependencies shared/types
 * @effects None (pure function)
 * @contract (message: string) => ModelConfig
 */

import type { ModelConfig } from "../shared/types";

const HAIKU_PATTERNS = [
  /^\s*\/reset\s*$/i,
  /^\s*\S{1,12}\s*[.!]?\s*$/i, // Single short word replies (ok, yes, thanks, dale, etc.)
];

const OPUS_PATTERNS = [
  /\b(debug|fix|bug|error|refactor|deploy|architect|migration)\b/i,
  /\b(code|file|function|class|module|component|endpoint|api)\b/i,
  /```[\s\S]*```/,
];

// Recency-aware state: prevent haiku downgrade during active conversations
const RECENCY_WINDOW = 5 * 60 * 1000; // 5 minutes
let lastModel: string | null = null;
let lastCallAt = 0;

export function resetRouterState(): void {
  lastModel = null;
  lastCallAt = 0;
}

export function selectModel(message: string): ModelConfig {
  const stripped = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  let candidate: ModelConfig;

  const isHaiku = HAIKU_PATTERNS.some((p) => p.test(stripped));
  const isOpus = OPUS_PATTERNS.some((p) => p.test(stripped) || p.test(message));

  if (isHaiku) {
    candidate = { model: "haiku", timeout: 30_000, reason: "simple/acknowledgment" };
  } else if (isOpus) {
    candidate = { model: "opus", timeout: 180_000, reason: "code/complex task" };
  } else {
    candidate = { model: "sonnet", timeout: 120_000, reason: "general conversation" };
  }

  // Don't downgrade to haiku if there's a recent conversation on a higher model
  if (
    candidate.model === "haiku" &&
    lastModel &&
    lastModel !== "haiku" &&
    Date.now() - lastCallAt < RECENCY_WINDOW
  ) {
    candidate = { model: lastModel, timeout: lastModel === "opus" ? 180_000 : 120_000, reason: "keeping context (was: simple/acknowledgment)" };
  }

  lastModel = candidate.model;
  lastCallAt = Date.now();
  return candidate;
}

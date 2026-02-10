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
  /^\s*(si|no|ok|dale|listo|gracias|genial|perfecto|yes|yeah|nope|thanks|cool|great)\s*[.!]?\s*$/i,
];

const OPUS_PATTERNS = [
  /\b(cambi[aá]|modific[aá]|refactore[aá]|arregl[aá]|implement[aá]|cre[aá]|escrib[ií]|agreg[aá]|elimin[aá]|borr[aá]|mové|mov[eé]|renombr[aá])\b/i,
  /\b(debug|fix|bug|error|refactor|deploy|architect|migration)\b/i,
  /\b(código|code|archivo|file|función|function|clase|class|módulo|module)\b/i,
  /```[\s\S]*```/,
];

export function selectModel(message: string): ModelConfig {
  const stripped = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  for (const pattern of HAIKU_PATTERNS) {
    if (pattern.test(stripped)) {
      return { model: "haiku", timeout: 30_000, reason: "simple/acknowledgment" };
    }
  }

  for (const pattern of OPUS_PATTERNS) {
    if (pattern.test(stripped) || pattern.test(message)) {
      return { model: "opus", timeout: 180_000, reason: "code/complex task" };
    }
  }

  return { model: "sonnet", timeout: 120_000, reason: "general conversation" };
}

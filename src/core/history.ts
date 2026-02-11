/**
 * @module core/history
 * @role Shared conversation history across backends (Claude/Codex).
 * @responsibilities
 *   - Log each user↔backend exchange with backend tag
 *   - Provide "foreign" context: exchanges from the OTHER backend
 *     that the current backend hasn't seen
 *   - Persist to disk, load on startup
 * @dependencies shared/config
 * @effects Reads/writes runtime history.jsonl
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { config } from "../shared/config";
import { createLogger } from "../shared/logger";

const log = createLogger("core");

const HISTORY_PATH = join(config.arisaDir, "history.jsonl");
const MAX_ENTRIES_PER_CHAT = 50;
const FOREIGN_CONTEXT_MAX_AGE_MS = 30 * 60 * 1000;

interface Exchange {
  ts: number;
  chatId: string;
  user: string;
  response: string;
  backend: "claude" | "codex";
}

let history: Exchange[] = [];

// Load persisted history on import
try {
  if (existsSync(HISTORY_PATH)) {
    const lines = readFileSync(HISTORY_PATH, "utf8").split("\n").filter(Boolean);
    history = lines.map((l) => JSON.parse(l));
    log.info(`Loaded ${history.length} history entries`);
  }
} catch (e) {
  log.warn(`Failed to load history: ${e}`);
}

export function addExchange(
  chatId: string,
  user: string,
  response: string,
  backend: "claude" | "codex",
) {
  const normalizedResponse = normalizeResponse(response);
  const entry: Exchange = { ts: Date.now(), chatId, user, response: normalizedResponse, backend };
  history.push(entry);

  // Prune old entries per chat
  const chatEntries = history.filter((e) => e.chatId === chatId);
  if (chatEntries.length > MAX_ENTRIES_PER_CHAT) {
    const toRemove = chatEntries.length - MAX_ENTRIES_PER_CHAT;
    let removed = 0;
    history = history.filter((e) => {
      if (e.chatId === chatId && removed < toRemove) {
        removed++;
        return false;
      }
      return true;
    });
  }

  // Persist
  try {
    const dir = dirname(HISTORY_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Rewrite full file after prune to keep it clean
    writeFileSync(HISTORY_PATH, history.map((e) => JSON.stringify(e)).join("\n") + "\n");
  } catch (e) {
    log.warn(`Failed to persist history: ${e}`);
  }
}

/**
 * Returns context string with exchanges from the OTHER backend
 * that happened since the current backend was last used.
 * Returns empty string if there's nothing to inject.
 */
export function getForeignContext(
  chatId: string,
  currentBackend: "claude" | "codex",
  limit = 10,
): string {
  const chatHistory = history.filter((e) => e.chatId === chatId);
  if (chatHistory.length === 0) return "";

  // Find last exchange handled by current backend
  let lastOwnIdx = -1;
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    if (chatHistory[i].backend === currentBackend) {
      lastOwnIdx = i;
      break;
    }
  }

  const cutoff = Date.now() - FOREIGN_CONTEXT_MAX_AGE_MS;

  // Get foreign exchanges since then
  const foreign = chatHistory
    .slice(lastOwnIdx + 1)
    .filter((e) => e.backend !== currentBackend && e.ts >= cutoff);

  if (foreign.length === 0) return "";

  const otherName = currentBackend === "claude" ? "Codex" : "Claude";
  const lines = foreign
    .slice(-limit)
    .map((e) => `User: ${e.user}\n${otherName}: ${e.response}`)
    .join("\n\n");

  return `[Contexto previo con ${otherName}]\n${lines}\n[Fin del contexto previo]\n\n`;
}

/**
 * Returns recent conversation history for this chat, formatted as User/Assistant pairs.
 * Trims oldest entries first if total exceeds maxChars.
 * Returns "" for new conversations.
 */
export function getRecentHistory(
  chatId: string,
  limit = 10,
  maxChars = 8000,
): string {
  const chatHistory = history.filter((e) => e.chatId === chatId);
  if (chatHistory.length === 0) return "";

  const recent = chatHistory.slice(-limit);

  // Format exchanges
  const formatted = recent.map(
    (e) => `User: ${e.user}\nAssistant: ${e.response}`,
  );

  // Trim oldest entries if total exceeds maxChars
  let total = formatted.join("\n\n").length;
  while (formatted.length > 1 && total > maxChars) {
    formatted.shift();
    total = formatted.join("\n\n").length;
  }

  if (formatted.length === 0) return "";

  return `[Conversation history]\n${formatted.join("\n\n")}\n[End of conversation history]\n\n`;
}

/**
 * Removes all history entries for this chat from memory and disk.
 */
export function clearHistory(chatId: string): void {
  const before = history.length;
  history = history.filter((e) => e.chatId !== chatId);
  const removed = before - history.length;

  if (removed > 0) {
    log.info(`Cleared ${removed} history entries for chat ${chatId}`);
    try {
      writeFileSync(HISTORY_PATH, history.map((e) => JSON.stringify(e)).join("\n") + "\n");
    } catch (e) {
      log.warn(`Failed to persist history after clear: ${e}`);
    }
  }
}

function normalizeResponse(response: string): string {
  return response.replace(/\n---CHUNK---\n/g, "\n").trim();
}

/**
 * @module core/onboarding
 * @role First-message onboarding: check CLIs and API keys, guide the user.
 * @responsibilities
 *   - Detect installed CLIs (claude, codex) via Bun.which
 *   - Check OPENAI_API_KEY config
 *   - Track onboarded chats in runtime storage
 *   - Build platform-specific install instructions
 * @dependencies shared/config
 * @effects Reads/writes onboarded state in deepbase
 */

import { config } from "../shared/config";
import { createLogger } from "../shared/logger";
import { getOnboardedUsers, addOnboarded as dbAddOnboarded, isOnboarded as dbIsOnboarded } from "../shared/db";

const log = createLogger("core");

let onboardedChats: Set<string> = new Set();

async function loadOnboarded() {
  try {
    const users = await getOnboardedUsers();
    onboardedChats = new Set(users);
  } catch (error) {
    log.warn(`Failed to load onboarded state: ${error}`);
  }
}

// Load immediately
loadOnboarded();

export interface DepsStatus {
  claude: boolean;
  codex: boolean;
  openaiKey: boolean;
  os: string;
}

export function checkDeps(): DepsStatus {
  const os =
    process.platform === "darwin"
      ? "macOS"
      : process.platform === "win32"
        ? "Windows"
        : "Linux";

  return {
    claude: Bun.which("claude") !== null,
    codex: Bun.which("codex") !== null,
    openaiKey: !!config.openaiApiKey,
    os,
  };
}

export function isOnboarded(chatId: string): boolean {
  return onboardedChats.has(chatId);
}

export async function markOnboarded(chatId: string) {
  onboardedChats.add(chatId);
  await dbAddOnboarded(chatId);
}

/**
 * Returns onboarding message for first-time users, or null if everything is set up.
 * Only blocks if NO CLI is available at all.
 */
export async function getOnboarding(chatId: string): Promise<{ message: string; blocking: boolean } | null> {
  if (isOnboarded(chatId)) return null;

  const deps = checkDeps();

  // Everything set up — skip onboarding
  if (deps.claude && deps.codex && deps.openaiKey) {
    await markOnboarded(chatId);
    return null;
  }

  // No CLI at all — block
  if (!deps.claude && !deps.codex) {
    const lines = [
      "<b>Welcome to Arisa!</b>\n",
      "Neither Claude CLI nor Codex CLI found. You need at least one.\n",
    ];
    if (deps.os === "macOS") {
      lines.push("Claude: <code>brew install claude-code</code>");
    } else {
      lines.push("Claude: <code>npm install -g @anthropic-ai/claude-code</code>");
    }
    lines.push("Codex: <code>npm install -g @openai/codex</code>\n");
    lines.push("Install one and message me again.");
    return { message: lines.join("\n"), blocking: true };
  }

  // At least one CLI — inform and continue
  await markOnboarded(chatId);

  const using = deps.claude ? "Claude" : "Codex";
  const lines = [`<b>Arisa</b> — using <b>${using}</b>`];

  if (!deps.claude) {
    lines.push("Claude CLI not installed. Add it with <code>npm install -g @anthropic-ai/claude-code</code>");
  } else if (!deps.codex) {
    lines.push("Codex CLI not installed. Add it with <code>npm install -g @openai/codex</code>");
  } else {
    lines.push("Use /codex or /claude to switch backend.");
  }

  if (!deps.openaiKey) {
    lines.push("No OpenAI API key — voice and image processing disabled. Add <code>OPENAI_API_KEY</code> to <code>~/.arisa/.env</code> to enable.");
  }

  return { message: lines.join("\n"), blocking: false };
}

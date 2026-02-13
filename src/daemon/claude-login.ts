/**
 * @module daemon/claude-login
 * @role Trigger Claude setup-token (OAuth) flow from Daemon when auth errors are detected.
 * @responsibilities
 *   - Detect Claude auth-required signals in Core responses
 *   - Run `claude setup-token` with piped I/O
 *   - Parse OAuth URL from output, send to pending Telegram chats
 *   - Accept OAuth code from user message and pipe it to the waiting process stdin
 * @effects Spawns claude CLI process, writes to daemon logs/terminal
 */

import { config } from "../shared/config";
import { createLogger } from "../shared/logger";
import { buildBunWrappedAgentCliCommand } from "../shared/ai-cli";

const log = createLogger("daemon");

const AUTH_HINT_PATTERNS = [
  /not logged in/i,
  /please run \/login/i,
  /invalid.*api.?key/i,
  /authentication.*failed/i,
  /not authenticated/i,
  /ANTHROPIC_API_KEY/,
  /api key not found/i,
  /invalid x-api-key/i,
];

const RETRY_COOLDOWN_MS = 30_000;

let loginInProgress = false;
let lastLoginAttemptAt = 0;
const pendingChatIds = new Set<string>();

// The running setup-token process, so we can pipe the code to stdin
let pendingProc: ReturnType<typeof Bun.spawn> | null = null;
let urlSent = false;

type NotifyFn = (chatId: string, text: string) => Promise<void>;
let notifyFn: NotifyFn | null = null;

export function setClaudeLoginNotify(fn: NotifyFn) {
  notifyFn = fn;
}

function needsClaudeLogin(text: string): boolean {
  return AUTH_HINT_PATTERNS.some((pattern) => pattern.test(text));
}

export function maybeStartClaudeSetupToken(rawCoreText: string, chatId?: string): void {
  if (!rawCoreText || !needsClaudeLogin(rawCoreText)) return;
  if (chatId) pendingChatIds.add(chatId);

  if (loginInProgress) {
    log.info("Claude setup-token already in progress; skipping duplicate trigger");
    return;
  }

  const now = Date.now();
  if (now - lastLoginAttemptAt < RETRY_COOLDOWN_MS) {
    log.info("Claude setup-token trigger ignored (cooldown active)");
    return;
  }

  lastLoginAttemptAt = now;
  loginInProgress = true;
  void runClaudeSetupToken().finally(() => {
    loginInProgress = false;
    pendingProc = null;
  });
}

/**
 * Start Claude setup-token proactively (e.g. during onboarding).
 */
export function startClaudeSetupToken(chatId: string): void {
  pendingChatIds.add(chatId);

  if (loginInProgress) {
    log.info("Claude setup-token already in progress");
    return;
  }

  loginInProgress = true;
  lastLoginAttemptAt = Date.now();
  void runClaudeSetupToken().finally(() => {
    loginInProgress = false;
    pendingProc = null;
  });
}

/**
 * Check if we're waiting for an OAuth code from this chat.
 * If the message looks like a code, pipe it to the waiting setup-token process.
 * Returns true if the message was consumed as a code.
 */
export function maybeFeedClaudeCode(chatId: string, text: string): boolean {
  if (!pendingProc || !pendingChatIds.has(chatId)) return false;

  const trimmed = text.trim();
  // OAuth codes are typically short alphanumeric strings or URL params
  // Reject obvious non-codes (long messages, commands, etc.)
  if (trimmed.length > 200 || trimmed.startsWith("/") || trimmed.includes(" ")) return false;

  log.info("Feeding OAuth code to claude setup-token process");
  try {
    const writer = pendingProc.stdin as WritableStream<Uint8Array>;
    const w = writer.getWriter();
    void w.write(new TextEncoder().encode(trimmed + "\n")).then(() => w.releaseLock());
  } catch (e) {
    log.error(`Failed to write to claude setup-token stdin: ${e}`);
  }
  return true;
}

async function notifyPending(text: string): Promise<void> {
  if (!notifyFn || pendingChatIds.size === 0) return;
  const chats = Array.from(pendingChatIds);
  await Promise.all(
    chats.map(async (chatId) => {
      try { await notifyFn?.(chatId, text); } catch (e) {
        log.error(`Failed to notify ${chatId}: ${e}`);
      }
    }),
  );
}

async function runClaudeSetupToken(): Promise<void> {
  log.warn("Claude auth required. Starting `claude setup-token`.");
  urlSent = false;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(buildBunWrappedAgentCliCommand("claude", ["setup-token"], { skipPreload: true }), {
      cwd: config.projectDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BROWSER: "echo" }, // Prevent browser auto-open on headless servers
    });
    pendingProc = proc;
  } catch (error) {
    log.error(`Failed to start claude setup-token: ${error}`);
    return;
  }

  // Read stdout incrementally to detect URL early and send to Telegram
  const readAndNotify = async (stream: ReadableStream<Uint8Array> | null, target: NodeJS.WriteStream): Promise<string> => {
    if (!stream) return "";
    const chunks: string[] = [];
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        chunks.push(text);
        target.write(text);

        // Try to parse and send URL as soon as we see it
        if (!urlSent) {
          const allText = chunks.join("");
          const urlMatch = allText.match(/(https:\/\/claude\.ai\/oauth\/authorize\S+)/);
          if (urlMatch) {
            urlSent = true;
            const msg = [
              "<b>Claude login required</b>\n",
              `1. Open this link:\n${urlMatch[1]}\n`,
              "2. Authorize and copy the code",
              "3. Reply here with the code",
            ].join("\n");
            await notifyPending(msg);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    return chunks.join("");
  };

  await Promise.all([
    readAndNotify(proc.stdout, process.stdout),
    readAndNotify(proc.stderr, process.stderr),
  ]);

  const exitCode = await proc.exited;
  if (exitCode === 0) {
    log.info("Claude setup-token completed successfully.");
    await notifySuccess();
  } else {
    log.error(`Claude setup-token finished with exit code ${exitCode}`);
  }
}

async function notifySuccess(): Promise<void> {
  if (!notifyFn || pendingChatIds.size === 0) return;

  const text = "<b>Claude login completed.</b>\nTry again.";
  const chats = Array.from(pendingChatIds);
  pendingChatIds.clear();

  await Promise.all(
    chats.map(async (chatId) => {
      try { await notifyFn?.(chatId, text); } catch (e) {
        log.error(`Failed to send Claude login success notice to ${chatId}: ${e}`);
      }
    }),
  );
}

export function isClaudeLoginPending(): boolean {
  return loginInProgress;
}

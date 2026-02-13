/**
 * @module daemon/codex-login
 * @role Trigger Codex device auth flow from Daemon when auth errors are detected.
 * @responsibilities
 *   - Detect codex auth-required signals in Core responses
 *   - Run `codex login --device-auth` (wrapped via Bun) in background from daemon process
 *   - Avoid duplicate runs with in-progress lock + cooldown
 * @effects Spawns codex CLI process, writes to daemon logs/terminal
 */

import { config } from "../shared/config";
import { createLogger } from "../shared/logger";
import { buildBunWrappedAgentCliCommand } from "../shared/ai-cli";

const log = createLogger("daemon");

const AUTH_HINT_PATTERNS = [
  /codex login is required/i,
  /codex.*login --device-auth/i,
  /codex is not authenticated on this server/i,
  /missing bearer authentication in header/i,
];

const RETRY_COOLDOWN_MS = 30_000;

let loginInProgress = false;
let lastLoginAttemptAt = 0;
const pendingChatIds = new Set<string>();

type NotifyFn = (chatId: string, text: string) => Promise<void>;
let notifyFn: NotifyFn | null = null;

export function setCodexLoginNotify(fn: NotifyFn) {
  notifyFn = fn;
}

function needsCodexLogin(text: string): boolean {
  return AUTH_HINT_PATTERNS.some((pattern) => pattern.test(text));
}

export function maybeStartCodexDeviceAuth(rawCoreText: string, chatId?: string): void {
  if (!rawCoreText || !needsCodexLogin(rawCoreText)) return;
  if (chatId) pendingChatIds.add(chatId);

  if (loginInProgress) {
    log.info("Codex device auth already in progress; skipping duplicate trigger");
    return;
  }

  const now = Date.now();
  if (now - lastLoginAttemptAt < RETRY_COOLDOWN_MS) {
    log.info("Codex device auth trigger ignored (cooldown active)");
    return;
  }

  lastLoginAttemptAt = now;
  loginInProgress = true;
  void runCodexDeviceAuth().finally(() => {
    loginInProgress = false;
  });
}

async function readStreamAndEcho(stream: ReadableStream<Uint8Array> | null, target: NodeJS.WriteStream): Promise<string> {
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
      target.write(text); // Echo to console for server admins
    }
  } finally {
    reader.releaseLock();
  }
  return chunks.join("");
}

function parseAuthInfo(output: string): { url: string; code: string } | null {
  const urlMatch = output.match(/(https:\/\/auth\.openai\.com\/\S+)/);
  const codeMatch = output.match(/([A-Z0-9]{4}-[A-Z0-9]{5})/);
  if (urlMatch && codeMatch) return { url: urlMatch[1], code: codeMatch[1] };
  return null;
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

let authInfoSent = false;

async function runCodexDeviceAuth(): Promise<void> {
  log.warn("Codex auth required. Starting `bun --bun <path-to-codex> login --device-auth` now.");
  authInfoSent = false;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(buildBunWrappedAgentCliCommand("codex", ["login", "--device-auth"], { skipPreload: true }), {
      cwd: config.projectDir,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
  } catch (error) {
    log.error(`Failed to start codex login: ${error}`);
    return;
  }

  // Read stdout and stderr in parallel, echoing to console
  const [stdoutText, stderrText] = await Promise.all([
    readStreamAndEcho(proc.stdout, process.stdout),
    readStreamAndEcho(proc.stderr, process.stderr),
  ]);

  // Parse auth info from combined output and send to Telegram
  const combined = stdoutText + "\n" + stderrText;
  if (!authInfoSent) {
    const auth = parseAuthInfo(combined);
    if (auth) {
      authInfoSent = true;
      const msg = [
        "<b>Codex login required</b>\n",
        `1. Open: ${auth.url}`,
        `2. Enter code: <code>${auth.code}</code>`,
      ].join("\n");
      await notifyPending(msg);
    }
  }

  const exitCode = await proc.exited;
  if (exitCode === 0) {
    log.info("Codex device auth finished successfully.");
    await notifySuccess();
  } else {
    log.error(`Codex device auth finished with exit code ${exitCode}`);
    pendingChatIds.clear();
  }
}

async function notifySuccess(): Promise<void> {
  if (!notifyFn || pendingChatIds.size === 0) return;

  const text = [
    "<b>Codex login completed successfully.</b>",
    "Then try again.",
  ].join("\n");

  const chats = Array.from(pendingChatIds);
  pendingChatIds.clear();

  await Promise.all(
    chats.map(async (chatId) => {
      try {
        await notifyFn?.(chatId, text);
      } catch (error) {
        log.error(`Failed to send Codex login success notice to ${chatId}: ${error}`);
      }
    }),
  );
}

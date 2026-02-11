/**
 * @module daemon/codex-login
 * @role Trigger Codex device auth flow from Daemon when auth errors are detected.
 * @responsibilities
 *   - Detect codex auth-required signals in Core responses
 *   - Run `codex login --device-auth` in background from daemon process
 *   - Avoid duplicate runs with in-progress lock + cooldown
 * @effects Spawns codex CLI process, writes to daemon logs/terminal
 */

import { config } from "../shared/config";
import { createLogger } from "../shared/logger";

const log = createLogger("daemon");

const AUTH_HINT_PATTERNS = [
  /codex login --device-auth/i,
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

async function runCodexDeviceAuth(): Promise<void> {
  log.warn("Codex auth required. Starting `codex login --device-auth` now.");
  log.warn("Complete device auth using the URL/code printed below in this Arisa terminal.");

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["codex", "login", "--device-auth"], {
      cwd: config.projectDir,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env },
    });
  } catch (error) {
    log.error(`Failed to start codex login: ${error}`);
    return;
  }

  const exitCode = await proc.exited;
  if (exitCode === 0) {
    log.info("Codex device auth finished successfully. You can retry your message.");
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

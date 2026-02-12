/**
 * @module daemon/lifecycle
 * @role Spawn and manage the Core process with --watch for hot reload.
 * @responsibilities
 *   - Start Core as a child process with `bun --watch`
 *   - Capture stdout+stderr, detect errors in real-time
 *   - When errors detected: notify via Telegram, trigger autofix
 *   - Track Core state: starting → up → down
 *   - Health-check loop to detect when Core is ready
 * @dependencies shared/config, daemon/autofix
 * @effects Spawns child process, manages process lifecycle
 */

import { config } from "../shared/config";
import { createLogger } from "../shared/logger";
import { attemptAutoFix } from "./autofix";
import { join } from "path";

const log = createLogger("daemon");

export type CoreState = "starting" | "up" | "down";

let coreProcess: ReturnType<typeof Bun.spawn> | null = null;
let shouldRun = true;
let coreState: CoreState = "down";
let lastError: string | null = null;
let crashCount = 0;
let lastCrashAt = 0;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let autofixInProgress = false;

const BUF_MAX = 2000;
const HEALTH_CHECK_INTERVAL = 1000;

// Patterns that indicate real errors in Core STDERR output
const ERROR_PATTERNS = [
  /error:/i,
  /SyntaxError/,
  /TypeError/,
  /ReferenceError/,
  /ENOENT/,
  /EACCES/,
  /JSON Parse error/,
  /Cannot find module/,
  /Module not found/,
];

// --- Notification callback (set by index.ts) ---
type NotifyFn = (text: string) => Promise<void>;
let notifyFn: NotifyFn | null = null;

export function setLifecycleNotify(fn: NotifyFn) {
  notifyFn = fn;
}

// --- State getters ---

export function getCoreState(): CoreState {
  return coreState;
}

export function getCoreError(): string | null {
  return lastError;
}

export function waitForCoreReady(timeoutMs: number): Promise<boolean> {
  if (coreState === "up") return Promise.resolve(true);
  if (coreState === "down") return Promise.resolve(false);

  return new Promise((resolve) => {
    const start = Date.now();
    const check = setInterval(() => {
      if (coreState === "up") {
        clearInterval(check);
        resolve(true);
      } else if (coreState === "down" || Date.now() - start > timeoutMs) {
        clearInterval(check);
        resolve(false);
      }
    }, 500);
  });
}

// --- Health check ---

function startHealthCheck() {
  stopHealthCheck();
  healthCheckTimer = setInterval(async () => {
    if (coreState !== "starting") {
      stopHealthCheck();
      return;
    }
    try {
      const res = await fetch("http://localhost/core/health", {
        signal: AbortSignal.timeout(2000),
        unix: config.coreSocket,
      } as any);
      if (res.ok) {
        coreState = "up";
        log.info("Core is ready (health check passed)");
        stopHealthCheck();
      }
    } catch {
      // Still starting
    }
  }, HEALTH_CHECK_INTERVAL);
}

function stopHealthCheck() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

// --- Core process management ---

export function startCore() {
  if (!shouldRun) return;

  const coreEntry = join(config.projectDir, "src", "core", "index.ts");
  log.info(`Starting Core: bun --watch ${coreEntry}`);

  if (crashCount > 3) {
    coreState = "down";
  } else {
    coreState = "starting";
  }

  // Output buffers
  const stdoutBuf = { data: "" };
  const stderrBuf = { data: "" };

  // Error detection state (per spawn — resets each time Core restarts)
  let errorHandled = false;
  let errorDebounce: ReturnType<typeof setTimeout> | null = null;

  // Called when an error pattern is detected in the output stream
  function onErrorDetected() {
    if (errorHandled || autofixInProgress || !shouldRun) return;
    errorHandled = true;

    // Wait 3s for full stack trace to accumulate, then act
    if (errorDebounce) clearTimeout(errorDebounce);
    errorDebounce = setTimeout(() => {
      const combined = (stderrBuf.data + "\n" + stdoutBuf.data).trim();
      lastError = combined.slice(-BUF_MAX);
      handleError(lastError);
    }, 3000);
  }

  coreProcess = Bun.spawn(["bun", "--watch", coreEntry], {
    cwd: config.projectDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
    onExit(proc, exitCode, signalCode) {
      log.warn(`Core exited (code=${exitCode}, signal=${signalCode})`);
      coreProcess = null;
      coreState = "down";
      stopHealthCheck();
      if (errorDebounce) clearTimeout(errorDebounce);

      // Save last error
      const combined = (stderrBuf.data + "\n" + stdoutBuf.data).trim();
      if (combined) lastError = combined.slice(-BUF_MAX);

      const now = Date.now();
      if (now - lastCrashAt < 10_000) {
        crashCount++;
      } else {
        crashCount = 1;
      }
      lastCrashAt = now;

      if (!shouldRun) return;

      // On 2nd+ rapid crash and error not yet handled: autofix
      if (crashCount >= 2 && !autofixInProgress && !errorHandled) {
        log.error(`Core crash loop (${crashCount}x). Triggering auto-fix...`);
        errorHandled = true;
        handleError(lastError || `Core crashed with exit code ${exitCode}`);
      } else if (!autofixInProgress) {
        log.info("Restarting Core in 2s...");
        setTimeout(() => startCore(), 2000);
      }
    },
  });

  // Capture streams: print to console + accumulate + detect errors
  if (coreProcess.stdout && typeof coreProcess.stdout !== "number") {
    pipeAndWatch(coreProcess.stdout, process.stdout, stdoutBuf, onErrorDetected, false);
  }
  if (coreProcess.stderr && typeof coreProcess.stderr !== "number") {
    pipeAndWatch(coreProcess.stderr, process.stderr, stderrBuf, onErrorDetected, true);
  }

  if (coreState === "starting") {
    startHealthCheck();
  }

  log.info(`Core spawned (pid=${coreProcess.pid})`);
}

/**
 * Pipe a stream to a target, accumulate into buffer, call onError when error patterns detected.
 */
function pipeAndWatch(
  stream: ReadableStream<Uint8Array>,
  target: NodeJS.WriteStream,
  buf: { data: string },
  onError: () => void,
  watchErrors: boolean,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        target.write(chunk);
        buf.data += chunk;
        if (buf.data.length > BUF_MAX) {
          buf.data = buf.data.slice(-BUF_MAX);
        }

        // Check for fatal/runtime-like patterns only when explicitly watching this stream.
        if (watchErrors && ERROR_PATTERNS.some((p) => p.test(chunk))) {
          onError();
        }
      }
    } catch {
      // stream closed
    }
  })();
}

/**
 * Central error handler: notify user via Telegram, then try autofix.
 */
async function handleError(error: string) {
  autofixInProgress = true;

  try {
    // 1. Notify immediately
    const preview = error.length > 500 ? error.slice(-500) : error;
    log.warn("Core error detected, notifying and attempting auto-fix...");
    await notifyFn?.(
      `Core error detected:\n<pre>${escapeHtml(preview)}</pre>\nAttempting auto-fix...`
    );

    // 2. Run autofix
    const fixed = await attemptAutoFix(error);

    // 3. Notify result
    if (fixed) {
      await notifyFn?.("Auto-fix applied. Core will restart automatically.");
    } else {
      await notifyFn?.("Auto-fix could not resolve the error. Please check manually.");
    }
  } catch (err) {
    log.error(`handleError threw: ${err}`);
  } finally {
    autofixInProgress = false;
    // If Core exited while we were fixing, restart it
    if (shouldRun && coreProcess === null) {
      log.info("Restarting Core after auto-fix...");
      startCore();
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function stopCore() {
  shouldRun = false;
  stopHealthCheck();
  if (coreProcess) {
    log.info("Stopping Core...");
    coreProcess.kill();
    coreProcess = null;
  }
  coreState = "down";
}

/**
 * @module daemon/autofix
 * @role Auto-diagnose and fix Core crashes using available AI CLI.
 * @responsibilities
 *   - Spawn Claude/Codex CLI to analyze crash errors and edit code
 *   - Rate-limit attempts (cooldown + max attempts)
 *   - Notify via callback (Telegram)
 * @dependencies shared/config
 * @effects Spawns AI CLI process which may edit project files
 */

import { config } from "../shared/config";
import { createLogger } from "../shared/logger";
import { getAgentCliLabel, runWithCliFallback } from "./agent-cli";

const log = createLogger("daemon");

let lastAttemptAt = 0;
let attemptCount = 0;

const COOLDOWN_MS = 120_000; // 2min between batches
const MAX_ATTEMPTS = 3;
const AUTOFIX_TIMEOUT = 180_000; // 3min for autofix

type NotifyFn = (text: string) => Promise<void>;
let notifyFn: NotifyFn | null = null;

export function setAutoFixNotify(fn: NotifyFn) {
  notifyFn = fn;
}

/**
 * Attempt to auto-fix a Core crash. Returns true if any CLI produced a usable result.
 */
export async function attemptAutoFix(error: string): Promise<boolean> {
  const now = Date.now();

  // Reset attempts after cooldown
  if (now - lastAttemptAt > COOLDOWN_MS) {
    attemptCount = 0;
  }

  if (attemptCount >= MAX_ATTEMPTS) {
    log.warn(`Auto-fix: max attempts (${MAX_ATTEMPTS}) reached, waiting for cooldown`);
    return false;
  }

  attemptCount++;
  lastAttemptAt = now;

  log.info(`Auto-fix: attempt ${attemptCount}/${MAX_ATTEMPTS}`);
  await notifyFn?.(`Auto-fix: intento ${attemptCount}/${MAX_ATTEMPTS}. Analizando error...`);

  // Extract file paths from the error to help the fallback model focus
  const projectPathPattern = new RegExp(`${escapeRegExp(config.projectDir)}[^\\s:)]+`, "g");
  const fileRefs = error.match(projectPathPattern) || [];
  const uniqueFiles = [...new Set(fileRefs)].slice(0, 5);
  const fileHint = uniqueFiles.length > 0
    ? `\nKey files from the stack trace: ${uniqueFiles.join(", ")}`
    : "";

  const prompt = `Arisa Core error on startup. Fix it.

Error:
\`\`\`
${error.slice(-1500)}
\`\`\`
${fileHint}

Rules:
- If it's a corrupted JSON/data file: delete or recreate it
- If it's a bad import: fix the import
- If it's a code bug: fix the minimal code
- Do NOT refactor, improve, or change anything beyond the fix
- Be fast — read only the files mentioned in the error`;

  try {
    const outcome = await runWithCliFallback(prompt, AUTOFIX_TIMEOUT);
    const result = outcome.result;

    if (!result) {
      if (outcome.attempted.length === 0) {
        log.error("Auto-fix: no AI CLI available (claude/codex)");
        await notifyFn?.("Auto-fix: no hay CLI disponible (Claude/Codex).");
      } else {
        const detail = outcome.failures.join(" | ").slice(0, 400);
        log.error(`Auto-fix: all CLIs failed: ${detail}`);
        await notifyFn?.("Auto-fix: both Claude and Codex failed. Check the logs.");
      }
      return false;
    }

    const cli = getAgentCliLabel(result.cli);
    const summary = result.output.slice(0, 300);
    if (result.partial) {
      log.warn(`Auto-fix: ${cli} produced output but exited with code ${result.exitCode}`);
    } else {
      log.info(`Auto-fix: ${cli} completed successfully`);
    }

    await notifyFn?.(`Auto-fix applied with ${cli}. Core restarting...\n<pre>${escapeHtml(summary)}</pre>`);
    return true;
  } catch (err) {
    log.error(`Auto-fix: error: ${err}`);
    await notifyFn?.("Auto-fix: internal error. Check the logs.");
    return false;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

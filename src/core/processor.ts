/**
 * @module core/processor
 * @role Execute Claude CLI with model routing and conversation context.
 * @responsibilities
 *   - Build claude CLI command with appropriate flags
 *   - Execute via async Bun.spawn (non-blocking)
 *   - Serialize calls through a queue (only one Claude at a time)
 *   - Handle errors and truncate responses
 * @dependencies core/router, core/context, shared/config
 * @effects Spawns claude CLI process, reads/writes conversation state
 * @contract (message: string) => Promise<string>
 */

import { selectModel } from "./router";
import { getRecentHistory } from "./history";
import { shouldContinue } from "./context";
import { config } from "../shared/config";
import { createLogger } from "../shared/logger";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "fs";
import { join } from "path";

const log = createLogger("core");
const ACTIVITY_LOG = join(config.logsDir, "activity.log");

function logActivity(backend: string, model: string | null, durationMs: number, status: string) {
  try {
    if (!existsSync(config.logsDir)) mkdirSync(config.logsDir, { recursive: true });
    const ts = new Date().toISOString();
    const entry = { ts, backend, model, durationMs, status };
    appendFileSync(ACTIVITY_LOG, JSON.stringify(entry) + "\n");
  } catch {}
}
const SOUL_PATH = join(config.projectDir, "SOUL.md");

// Load SOUL.md once at startup — shared personality for all backends
let soulPrompt = "";
try {
  if (existsSync(SOUL_PATH)) {
    soulPrompt = readFileSync(SOUL_PATH, "utf8").trim();
    log.info("SOUL.md loaded");
  }
} catch (e) {
  log.warn(`Failed to load SOUL.md: ${e}`);
}

function withSoul(message: string): string {
  if (!soulPrompt) return message;
  return `[System instructions]\n${soulPrompt}\n[End system instructions]\n\n${message}`;
}

// Serialize Claude calls — only one at a time
let processing = false;
const queue: Array<{
  message: string;
  chatId: string;
  resolve: (result: string) => void;
}> = [];

export async function processWithClaude(message: string, chatId: string): Promise<string> {
  return new Promise((resolve) => {
    queue.push({ message, chatId, resolve });
    processNext();
  });
}

async function processNext() {
  if (processing || queue.length === 0) return;
  processing = true;

  const { message, chatId, resolve } = queue.shift()!;

  try {
    const result = await runClaude(message, chatId);
    resolve(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Claude execution error: ${msg}`);
    resolve("Error processing your message. Please try again.");
  } finally {
    processing = false;
    processNext();
  }
}

async function runClaude(message: string, chatId: string): Promise<string> {
  const model = selectModel(message);
  const historyContext = getRecentHistory(chatId);
  const start = Date.now();

  const historyCount = historyContext ? historyContext.split("\nUser: ").length - 1 : 0;
  log.info(`Model: ${model.model} (${model.reason}) | History: ${historyCount} exchanges`);

  const args = ["--dangerously-skip-permissions"];

  args.push("--model", model.model);
  args.push("-p", withSoul(historyContext + message));

  const proc = Bun.spawn(["claude", ...args], {
    cwd: config.projectDir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => {
    log.warn(`Claude timed out after ${model.timeout}ms, killing process`);
    proc.kill();
  }, model.timeout);

  const exitCode = await proc.exited;
  clearTimeout(timeout);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const duration = Date.now() - start;

  if (exitCode !== 0) {
    log.error(`Claude exited with code ${exitCode}: ${stderr.substring(0, 200)}`);
    logActivity("claude", model.model, duration, `error:${exitCode}`);
    if (isRateLimit(stdout + stderr)) {
      return "Claude hit its rate limit. Try again in a few minutes.";
    }
    return "Error processing your message. Please try again.";
  }

  const response = stdout.trim();
  logActivity("claude", model.model, duration, response ? "ok" : "empty");

  if (!response) {
    log.warn("Claude returned empty response");
    return "Claude returned an empty response.";
  }

  if (response.length > config.maxResponseLength) {
    return response.substring(0, config.maxResponseLength - 100) + "\n\n[Response truncated...]";
  }

  return response;
}

export async function processWithCodex(message: string): Promise<string> {
  const continueFlag = shouldContinue();
  const start = Date.now();

  log.info(`Codex | Continue: ${continueFlag}`);

  const args: string[] = [];

  if (continueFlag) {
    args.push("exec", "resume", "--last", "--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("exec", "--dangerously-bypass-approvals-and-sandbox", "-C", config.projectDir);
  }

  args.push(message);

  const proc = Bun.spawn(["codex", ...args], {
    cwd: config.projectDir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => {
    log.warn("Codex timed out after 180s, killing process");
    proc.kill();
  }, 180_000);

  const exitCode = await proc.exited;
  clearTimeout(timeout);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const duration = Date.now() - start;

  if (exitCode !== 0) {
    log.error(`Codex exited with code ${exitCode}: ${stderr.substring(0, 200)}`);
    logActivity("codex", null, duration, `error:${exitCode}`);
    return "Error processing with Codex. Please try again.";
  }

  const response = stdout.trim();
  logActivity("codex", null, duration, response ? "ok" : "empty");

  if (!response) {
    log.warn("Codex returned empty response");
    return "Codex returned an empty response.";
  }

  if (response.length > config.maxResponseLength) {
    return response.substring(0, config.maxResponseLength - 100) + "\n\n[Response truncated...]";
  }

  return response;
}

function isRateLimit(output: string): boolean {
  return /you'?ve hit your limit|rate limit|quota|credits.*(exceeded|exhausted)/i.test(output);
}

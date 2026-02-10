/**
 * @module core/intent
 * @role Use a fast model to detect scheduling intents from any language.
 * @responsibilities
 *   - Classify messages as schedule requests or regular messages
 *   - Extract schedule type (once/cron), timing, and reminder text
 *   - Works with whatever CLI is available (claude or codex)
 * @dependencies shared/config
 * @effects Spawns claude or codex CLI
 */

import { config } from "../shared/config";
import { createLogger } from "../shared/logger";

const log = createLogger("core");

export interface ScheduleIntent {
  type: "once" | "cron" | "cancel";
  delaySeconds?: number;
  cron?: string;
  message: string;
  confirmation: string;
}

const INTENT_PROMPT = `You are a scheduling intent detector. Analyze the user message and determine if they want to schedule a reminder, recurring notification, or cancel/stop existing tasks.

If it IS a scheduling request, respond with ONLY this JSON (no markdown, no explanation):
For one-time reminders:
{"type":"once","delaySeconds":300,"message":"the reminder text","confirmation":"I'll remind you in 5 minutes"}

For recurring reminders:
{"type":"cron","cron":"*/5 * * * *","message":"the reminder text","confirmation":"I'll remind you every 5 minutes"}

For cancelling/stopping tasks:
{"type":"cancel","message":"","confirmation":"All tasks cancelled."}

If it is NOT a scheduling or cancellation request, respond with ONLY:
{"type":"none"}

Rules:
- One-time: "in X seconds/minutes/hours" or equivalent in any language → once
- Recurring: "every X seconds/minutes/hours" or equivalent in any language → cron
- Cancel: "stop/cancel/remove all tasks/reminders" or equivalent in any language → cancel
- For seconds-based cron, use 6-field format: */N * * * * *
- For minutes-based cron: */N * * * *
- For hours-based cron: 0 */N * * *
- Extract the actual reminder content, not the scheduling instruction
- Write the confirmation in the same language as the user's message
- Support any language
- Only detect clear scheduling intent, not vague mentions of time`;

function buildCmd(cli: "claude" | "codex", prompt: string): string[] {
  if (cli === "claude") {
    return ["claude", "--dangerously-skip-permissions", "--model", "haiku", "-p", prompt];
  }
  return ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "-C", config.projectDir, prompt];
}

// Track which CLI actually works (not just Bun.which, which can find broken shims)
let verifiedCli: "claude" | "codex" | null = null;

async function trySpawn(prompt: string, cli: "claude" | "codex"): Promise<string | null> {
  const cmd = buildCmd(cli, prompt);
  const proc = Bun.spawn(cmd, { cwd: config.projectDir, stdout: "pipe", stderr: "pipe" });

  const timeout = setTimeout(() => proc.kill(), 15_000);
  const exitCode = await proc.exited;
  clearTimeout(timeout);

  if (exitCode !== 0) return null;

  return (await new Response(proc.stdout).text()).trim();
}

function getCliOrder(): Array<"claude" | "codex"> {
  if (verifiedCli) return [verifiedCli];
  const order: Array<"claude" | "codex"> = [];
  if (Bun.which("claude") !== null) order.push("claude");
  if (Bun.which("codex") !== null) order.push("codex");
  return order;
}

export async function detectScheduleIntent(message: string): Promise<ScheduleIntent | null> {
  const clis = getCliOrder();
  if (clis.length === 0) return null;

  const fullPrompt = `${INTENT_PROMPT}\n\nUser message: ${message}`;

  for (const cli of clis) {
    try {
      const raw = await trySpawn(fullPrompt, cli);
      if (raw === null) continue;

      // This CLI works — remember it
      verifiedCli = cli;

      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.type === "none") return null;
      if (parsed.type !== "once" && parsed.type !== "cron" && parsed.type !== "cancel") return null;

      return parsed as ScheduleIntent;
    } catch (e) {
      log.warn(`Intent detection with ${cli} failed: ${e}`);
      // Try next CLI
    }
  }

  return null;
}

/**
 * @module core/intent
 * @role Use a fast model (haiku) to detect scheduling intents from any language.
 * @responsibilities
 *   - Classify messages as schedule requests or regular messages
 *   - Extract schedule type (once/cron), timing, and reminder text
 * @dependencies shared/config
 * @effects Spawns claude CLI (haiku)
 */

import { config } from "../shared/config";
import { createLogger } from "../shared/logger";

const log = createLogger("core");

export interface ScheduleIntent {
  type: "once" | "cron";
  delaySeconds?: number;
  cron?: string;
  message: string;
  confirmation: string;
}

const INTENT_PROMPT = `You are a scheduling intent detector. Analyze the user message and determine if they want to schedule a reminder or recurring notification.

If it IS a scheduling request, respond with ONLY this JSON (no markdown, no explanation):
For one-time reminders:
{"type":"once","delaySeconds":300,"message":"the reminder text","confirmation":"Te aviso en 5 minutos"}

For recurring reminders:
{"type":"cron","cron":"*/5 * * * *","message":"the reminder text","confirmation":"Te aviso cada 5 minutos"}

If it is NOT a scheduling request, respond with ONLY:
{"type":"none"}

Rules:
- "in X seconds/minutes/hours", "en X segundos/minutos/horas", etc → once
- "every X seconds/minutes/hours", "cada X segundos/minutos/horas", etc → cron
- For seconds-based cron, use 6-field format: */N * * * * *
- For minutes-based cron: */N * * * *
- For hours-based cron: 0 */N * * *
- Extract the actual reminder content, not the scheduling instruction
- Write the confirmation message in the same language as the user
- Support any language
- Only detect clear scheduling intent, not vague mentions of time`;

export async function detectScheduleIntent(message: string): Promise<ScheduleIntent | null> {
  try {
    const proc = Bun.spawn(
      ["claude", "--dangerously-skip-permissions", "--model", "haiku", "-p", `${INTENT_PROMPT}\n\nUser message: ${message}`],
      { cwd: config.projectDir, stdout: "pipe", stderr: "pipe" },
    );

    const timeout = setTimeout(() => proc.kill(), 15_000);
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    if (exitCode !== 0) return null;

    const raw = (await new Response(proc.stdout).text()).trim();

    // Extract JSON from response (model might wrap it in markdown)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.type === "none") return null;
    if (parsed.type !== "once" && parsed.type !== "cron") return null;

    return parsed as ScheduleIntent;
  } catch (e) {
    log.warn(`Intent detection failed: ${e}`);
    return null;
  }
}

/**
 * @module shared/config
 * @role Centralized configuration from env vars and .tinyclaw/.env file.
 * @responsibilities
 *   - Load env vars (TELEGRAM_BOT_TOKEN, OPENAI_API_KEY)
 *   - Define ports, paths, timeouts
 * @dependencies None
 * @effects Reads .tinyclaw/.env from disk on import
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

const PROJECT_DIR = join(import.meta.dir, "..", "..");
const ENV_PATH = join(PROJECT_DIR, ".tinyclaw", ".env");

function loadEnvFile(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const content = readFileSync(ENV_PATH, "utf8");
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (match) {
      vars[match[1]] = match[2].trim();
    }
  }
  return vars;
}

const envFile = loadEnvFile();

function env(key: string): string | undefined {
  return process.env[key] || envFile[key];
}

export const config = {
  projectDir: PROJECT_DIR,
  tinyclawDir: join(PROJECT_DIR, ".tinyclaw"),

  corePort: 51777,
  daemonPort: 51778,

  telegramBotToken: env("TELEGRAM_BOT_TOKEN") || "",
  openaiApiKey: env("OPENAI_API_KEY") || "",
  elevenlabsApiKey: env("ELEVENLABS_API_KEY") || "",
  elevenlabsVoiceId: "AkQ5y6bnGscgSIAsRlwZ",

  logsDir: join(PROJECT_DIR, ".tinyclaw", "logs"),
  tasksFile: join(PROJECT_DIR, ".tinyclaw", "scheduler", "tasks.json"),
  resetFlagPath: join(PROJECT_DIR, ".tinyclaw", "reset_flag"),
  voiceTempDir: join(PROJECT_DIR, ".tinyclaw", "voice_temp"),
  attachmentsDir: join(PROJECT_DIR, ".tinyclaw", "attachments"),
  attachmentMaxAgeDays: 30,

  claudeTimeout: 120_000,
  maxResponseLength: 4000,
} as const;

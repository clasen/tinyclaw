/**
 * @module daemon/setup
 * @role Interactive first-run setup. Prompts for missing config via stdin.
 * @responsibilities
 *   - Check required config (TELEGRAM_BOT_TOKEN)
 *   - Check optional config (OPENAI_API_KEY)
 *   - Prompt user interactively and save to runtime .env
 * @dependencies shared/paths (avoids importing config to prevent module caching issues)
 * @effects Reads stdin, writes runtime .env
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { dataDir } from "../shared/paths";

const ENV_PATH = join(dataDir, ".env");

function loadExistingEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (match) vars[match[1]] = match[2].trim();
  }
  return vars;
}

function saveEnv(vars: Record<string, string>) {
  const dir = dirname(ENV_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";
  writeFileSync(ENV_PATH, content);
}

async function prompt(question: string): Promise<string> {
  process.stdout.write(question);
  for await (const line of console) {
    return line.trim();
  }
  return "";
}

export async function runSetup(): Promise<boolean> {
  const vars = loadExistingEnv();
  let changed = false;

  // Required: TELEGRAM_BOT_TOKEN
  if (!vars.TELEGRAM_BOT_TOKEN && !process.env.TELEGRAM_BOT_TOKEN) {
    console.log("\n🔧 Arisa Setup\n");
    console.log("Telegram Bot Token required. Get one from @BotFather on Telegram.");
    const token = await prompt("TELEGRAM_BOT_TOKEN: ");
    if (!token) {
      console.log("No token provided. Cannot start without Telegram Bot Token.");
      return false;
    }
    vars.TELEGRAM_BOT_TOKEN = token;
    changed = true;
  }

  // Optional: OPENAI_API_KEY
  if (!vars.OPENAI_API_KEY && !process.env.OPENAI_API_KEY) {
    if (!changed) console.log("\n🔧 Arisa Setup\n");
    console.log("\nOpenAI API Key (optional — enables voice transcription + image analysis).");
    const key = await prompt("OPENAI_API_KEY (enter to skip): ");
    if (key) {
      vars.OPENAI_API_KEY = key;
      changed = true;
    }
  }

  if (changed) {
    saveEnv(vars);
    console.log(`\nConfig saved to ${ENV_PATH}\n`);
  }

  return true;
}

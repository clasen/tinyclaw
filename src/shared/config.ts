/**
 * @module shared/config
 * @role Centralized configuration from encrypted secrets + env vars fallback
 * @responsibilities
 *   - Load API keys from encrypted secrets DB (with .env fallback)
 *   - Define ports, paths, timeouts
 * @dependencies secrets.ts
 * @effects Reads encrypted secrets on first access
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { secrets } from "./secrets";
import { dataDir, legacyDataDir, preferredDataDir, projectDir } from "./paths";

const ENV_PATH_CANDIDATES = Array.from(new Set([
  join(dataDir, ".env"),
  join(preferredDataDir, ".env"),
  join(legacyDataDir, ".env"),
]));

function loadEnvFile(): Record<string, string> {
  for (const envPath of ENV_PATH_CANDIDATES) {
    if (!existsSync(envPath)) continue;

    const content = readFileSync(envPath, "utf8");
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
      if (match) {
        vars[match[1]] = match[2].trim();
      }
    }
    return vars;
  }

  return {};
}

const envFile = loadEnvFile();

// Inject .env vars into process.env so child processes inherit them
for (const [key, value] of Object.entries(envFile)) {
  if (!process.env[key]) process.env[key] = value;
}

function env(key: string): string | undefined {
  return process.env[key] || envFile[key];
}

/**
 * Lazy-loaded API keys from encrypted secrets with fallback to .env
 */
class SecureConfig {
  private _telegramBotToken?: string;
  private _openaiApiKey?: string;
  private _elevenlabsApiKey?: string;
  private _initialized = false;

  async initialize(): Promise<void> {
    if (this._initialized) return;

    // Load all secrets in parallel
    const [telegram, openai, elevenlabs] = await Promise.all([
      secrets.telegram(),
      secrets.openai(),
      secrets.elevenlabs(),
    ]);

    this._telegramBotToken = telegram || env("TELEGRAM_BOT_TOKEN") || "";
    this._openaiApiKey = openai || env("OPENAI_API_KEY") || "";
    this._elevenlabsApiKey = elevenlabs || env("ELEVENLABS_API_KEY") || "";
    this._initialized = true;
  }

  async getTelegramBotToken(): Promise<string> {
    await this.initialize();
    return this._telegramBotToken!;
  }

  async getOpenaiApiKey(): Promise<string> {
    await this.initialize();
    return this._openaiApiKey!;
  }

  async getElevenlabsApiKey(): Promise<string> {
    await this.initialize();
    return this._elevenlabsApiKey!;
  }

  // Synchronous getters for backwards compatibility (will use cached values)
  get telegramBotToken(): string {
    return this._telegramBotToken || "";
  }

  get openaiApiKey(): string {
    return this._openaiApiKey || "";
  }

  get elevenlabsApiKey(): string {
    return this._elevenlabsApiKey || "";
  }
}

const secureConfig = new SecureConfig();

export const config = {
  projectDir,
  arisaDir: dataDir,
  // Backward-compatible alias for existing modules.
  tinyclawDir: dataDir,

  corePort: 51777,
  daemonPort: 51778,
  coreSocket: join(dataDir, "core.sock"),
  daemonSocket: join(dataDir, "daemon.sock"),

  // API keys - use async getters for first load
  get telegramBotToken() { return secureConfig.telegramBotToken; },
  get openaiApiKey() { return secureConfig.openaiApiKey; },
  get elevenlabsApiKey() { return secureConfig.elevenlabsApiKey; },

  elevenlabsVoiceId: "BpjGufoPiobT79j2vtj4",

  logsDir: join(dataDir, "logs"),
  tasksFile: join(dataDir, "scheduler", "tasks.json"),
  resetFlagPath: join(dataDir, "reset_flag"),
  voiceTempDir: join(dataDir, "voice_temp"),
  attachmentsDir: join(dataDir, "attachments"),
  attachmentMaxAgeDays: 30,

  claudeTimeout: 120_000,
  maxResponseLength: 4000,

  // Async API key loaders
  secrets: secureConfig,
} as const;

/**
 * @module shared/secrets
 * @role Encrypted secrets storage using DeepbaseSecure
 * @responsibilities
 *   - Generate/load encryption key
 *   - Store API keys encrypted at rest
 *   - Provide type-safe getters for secrets
 * @dependencies DeepbaseSecure, crypto-js
 */

import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "fs";
import CryptoJS from "crypto-js";
import { DeepbaseSecure } from "./deepbase-secure";
import { dataDir } from "./paths";

const ARISA_DIR = dataDir;
const ENCRYPTION_KEY_PATH = join(ARISA_DIR, ".encryption_key");
const SECRETS_DB_PATH = join(ARISA_DIR, "db");

// Ensure runtime data and db dirs exist
mkdirSync(join(ARISA_DIR, "db"), { recursive: true });

/**
 * Load or generate encryption key
 */
function getEncryptionKey(): string {
  if (existsSync(ENCRYPTION_KEY_PATH)) {
    return readFileSync(ENCRYPTION_KEY_PATH, "utf8").trim();
  }

  // Generate random 256-bit key
  const key = CryptoJS.lib.WordArray.random(256 / 8).toString(CryptoJS.enc.Hex);
  writeFileSync(ENCRYPTION_KEY_PATH, key, { mode: 0o600 });
  return key;
}

const encryptionKey = getEncryptionKey();
let secretsDb = createSecretsDb();

function createSecretsDb(): DeepbaseSecure {
  return new DeepbaseSecure({
    path: SECRETS_DB_PATH,
    name: "secrets",
    encryptionKey,
  });
}

// Initialize connection
let connectionPromise: Promise<void> | null = null;
let recoveredOnce = false;

function looksCorrupted(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message}\n${err.stack || ""}` : String(err);
  return /Malformed UTF-8 data|Unexpected token|JSON|decrypt|invalid/i.test(msg);
}

function backupCorruptSecretsDb(): void {
  try {
    const timestamp = Date.now();
    for (const file of readdirSync(SECRETS_DB_PATH)) {
      if (!file.startsWith("secrets")) continue;
      const src = join(SECRETS_DB_PATH, file);
      const dst = join(SECRETS_DB_PATH, `${file}.corrupt.${timestamp}`);
      try {
        renameSync(src, dst);
      } catch {
        // Best-effort backup; ignore per-file failures.
      }
    }
  } catch {
    // Ignore backup errors; recovery will still retry with a fresh DB handle.
  }
}

async function ensureConnected(): Promise<void> {
  if (!connectionPromise) {
    connectionPromise = (async () => {
      try {
        await secretsDb.connect();
      } catch (err) {
        if (!recoveredOnce && looksCorrupted(err)) {
          recoveredOnce = true;
          console.warn("[secrets] Encrypted secrets DB looks corrupted; backing up and recreating it.");
          backupCorruptSecretsDb();
          secretsDb = createSecretsDb();
          await secretsDb.connect();
          return;
        }
        throw err;
      }
    })().catch((err) => {
      connectionPromise = null;
      throw err;
    });
  }
  await connectionPromise;
}

/**
 * Get a secret by key
 */
export async function getSecret(key: string): Promise<string | undefined> {
  try {
    await ensureConnected();
    return await secretsDb.get("secrets", key);
  } catch (err) {
    console.warn(`[secrets] Could not read ${key} from encrypted DB: ${err}`);
    return undefined;
  }
}

/**
 * Set a secret by key
 */
export async function setSecret(key: string, value: string): Promise<void> {
  await ensureConnected();
  await secretsDb.set("secrets", key, value);
}

/**
 * Delete a secret by key
 */
export async function deleteSecret(key: string): Promise<void> {
  await ensureConnected();
  await secretsDb.del("secrets", key);
}

/**
 * Type-safe getters for known secrets
 */
export const secrets = {
  telegram: () => getSecret("TELEGRAM_BOT_TOKEN"),
  openai: () => getSecret("OPENAI_API_KEY"),
  elevenlabs: () => getSecret("ELEVENLABS_API_KEY"),
};

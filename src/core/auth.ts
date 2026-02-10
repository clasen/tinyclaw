/**
 * @module core/auth
 * @role Gate access to the bot via a one-time token shown in the console.
 * @responsibilities
 *   - Generate and persist an auth token on first run
 *   - Track authorized chat IDs in .tinyclaw/authorized.json
 *   - Validate tokens from new chats
 * @dependencies shared/config
 * @effects Disk I/O (.tinyclaw/auth_token, .tinyclaw/authorized.json), console output
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { config } from "../shared/config";
import { createLogger } from "../shared/logger";

const log = createLogger("auth");
const TOKEN_PATH = join(config.tinyclawDir, "auth_token");
const AUTHORIZED_PATH = join(config.tinyclawDir, "authorized.json");

let authToken = "";
let authorizedChats: Set<string> = new Set();

function ensureDir(filePath: string) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadToken(): string {
  if (existsSync(TOKEN_PATH)) {
    return readFileSync(TOKEN_PATH, "utf8").trim();
  }
  const token = crypto.randomUUID().split("-")[0]; // Short 8-char hex token
  ensureDir(TOKEN_PATH);
  writeFileSync(TOKEN_PATH, token);
  return token;
}

function loadAuthorized(): Set<string> {
  if (!existsSync(AUTHORIZED_PATH)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(AUTHORIZED_PATH, "utf8")));
  } catch {
    return new Set();
  }
}

function saveAuthorized() {
  ensureDir(AUTHORIZED_PATH);
  writeFileSync(AUTHORIZED_PATH, JSON.stringify([...authorizedChats]));
}

export function initAuth() {
  authToken = loadToken();
  authorizedChats = loadAuthorized();
  log.info(`Auth token: ${authToken}`);
  console.log(`\n🔑 Auth token: ${authToken}\n   Send this token to the bot on Telegram to authorize a chat.\n`);
}

export function isAuthorized(chatId: string): boolean {
  return authorizedChats.has(chatId);
}

export function tryAuthorize(chatId: string, message: string): boolean {
  if (message.trim() === authToken) {
    authorizedChats.add(chatId);
    saveAuthorized();
    log.info(`Chat ${chatId} authorized`);
    return true;
  }
  return false;
}

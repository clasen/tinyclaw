/**
 * @module core/auth
 * @role Gate access to the bot via a one-time token shown in the console.
 * @responsibilities
 *   - Generate and persist an auth token via deepbase (settings.auth_token)
 *   - Track authorized chat IDs via deepbase (authorized collection)
 *   - Validate tokens from new chats
 * @dependencies shared/db
 * @effects deepbase writes, console output
 */

import { createLogger } from "../shared/logger";
import { getAuthorizedUsers, addAuthorized, getSetting, setSetting } from "../shared/db";

const log = createLogger("auth");

let authToken = "";
let authorizedChats: Set<string> = new Set();

async function loadToken(): Promise<string> {
  const existing = await getSetting("auth_token");
  if (existing) return existing;

  const token = crypto.randomUUID().split("-")[0];
  await setSetting("auth_token", token);
  return token;
}

async function loadAuthorized(): Promise<Set<string>> {
  try {
    const users = await getAuthorizedUsers();
    return new Set(users);
  } catch (error) {
    log.error(`Failed to load authorized users: ${error}`);
    return new Set();
  }
}

export async function initAuth() {
  authToken = await loadToken();
  authorizedChats = await loadAuthorized();
  log.info(`Auth token: ${authToken}`);
  console.log(`\n🔑 Auth token: ${authToken}\n   Send this token to the bot on Telegram to authorize a chat.\n`);
}

export function isAuthorized(chatId: string): boolean {
  return authorizedChats.has(chatId);
}

export async function tryAuthorize(chatId: string, message: string): Promise<boolean> {
  if (message.trim() === authToken) {
    authorizedChats.add(chatId);
    await addAuthorized(chatId);
    log.info(`Chat ${chatId} authorized`);
    return true;
  }
  return false;
}

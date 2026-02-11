/**
 * @module shared/db
 * @role Unified persistence layer using deepbase
 * @responsibilities
 *   - Persist scheduled tasks, authorized users, onboarded users, queue messages
 *   - Provide type-safe operations with JSON storage
 *   - Auto-connect on first operation
 * @dependencies deepbase, shared/types, shared/config
 * @effects Disk I/O (runtime db directory)
 */

import DeepBase from "deepbase";
import { config } from "./config";
import type { ScheduledTask, AttachmentRecord, MessageRecord } from "./types";
import { DeepbaseSecure } from "./deepbase-secure";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs";
import { randomBytes } from "crypto";
import { dirname } from "path";

const DB_PATH = `${config.arisaDir}/db`;
const ARISA_DB_FILE = `${DB_PATH}/arisa.json`;
const LEGACY_DB_FILE = `${DB_PATH}/tinyclaw.json`;

function readDbJson(path: string): Record<string, any> {
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function mergeLegacyIntoArisa(): void {
  if (!existsSync(LEGACY_DB_FILE)) return;

  // If arisa DB doesn't exist yet, seed it from legacy and keep legacy file as backup/history.
  if (!existsSync(ARISA_DB_FILE)) {
    try {
      mkdirSync(DB_PATH, { recursive: true });
      copyFileSync(LEGACY_DB_FILE, ARISA_DB_FILE);
    } catch {
      // Best-effort migration; if copy fails, app can still run on a fresh arisa DB.
    }
    return;
  }

  const arisa = readDbJson(ARISA_DB_FILE);
  const legacy = readDbJson(LEGACY_DB_FILE);
  let changed = false;

  for (const [collection, legacyCollection] of Object.entries(legacy)) {
    if (!legacyCollection || typeof legacyCollection !== "object") continue;

    const arisaCollection = arisa[collection];
    if (!arisaCollection || typeof arisaCollection !== "object") {
      arisa[collection] = legacyCollection;
      changed = true;
      continue;
    }

    for (const [key, value] of Object.entries(legacyCollection as Record<string, any>)) {
      if (!(key in arisaCollection)) {
        arisaCollection[key] = value;
        changed = true;
      }
    }
  }

  if (changed) {
    try {
      writeFileSync(ARISA_DB_FILE, JSON.stringify(arisa, null, 4));
    } catch {
      // Ignore write failures; runtime will continue with current DB state.
    }
  }
}

// Ensure legacy data is available in arisa DB before DeepBase picks a file.
mergeLegacyIntoArisa();

// Initialize deepbase with the storage directory
const db = new DeepBase({
  path: DB_PATH,
  name: "arisa",
});

// Initialize encrypted secrets database
function getOrCreateEncryptionKey(): string {
  const keyPath = `${config.arisaDir}/.encryption_key`;
  const keyDir = dirname(keyPath);

  if (!existsSync(keyDir)) {
    mkdirSync(keyDir, { recursive: true });
  }

  if (existsSync(keyPath)) {
    return readFileSync(keyPath, 'utf-8').trim();
  }

  const key = randomBytes(32).toString('hex');
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

const secretsDb = new DeepbaseSecure({
  path: DB_PATH,
  name: "secrets",
  encryptionKey: getOrCreateEncryptionKey(),
});

/**
 * Helper functions for common operations
 */

// Tasks
export async function getTasks(): Promise<ScheduledTask[]> {
  const tasks = await db.values("tasks");
  return tasks || [];
}

export async function getTask(id: string): Promise<ScheduledTask | null> {
  return await db.get("tasks", id);
}

export async function addTask(task: ScheduledTask): Promise<void> {
  await db.set("tasks", task.id, task);
}

export async function updateTask(id: string, updates: Partial<ScheduledTask>): Promise<void> {
  const existing = await db.get("tasks", id);
  if (existing) {
    await db.set("tasks", id, { ...existing, ...updates });
  }
}

export async function deleteTask(id: string): Promise<void> {
  await db.del("tasks", id);
}

export async function deleteTasks(filter: Partial<ScheduledTask>): Promise<number> {
  const tasks = await getTasks();
  let deleted = 0;

  for (const task of tasks) {
    const matches = Object.entries(filter).every(([key, value]) => {
      return task[key as keyof ScheduledTask] === value;
    });

    if (matches) {
      await db.del("tasks", task.id);
      deleted++;
    }
  }

  return deleted;
}

// Authorized users
export async function isAuthorized(userId: string): Promise<boolean> {
  const user = await db.get("authorized", userId);
  return user !== null && user !== undefined;
}

export async function addAuthorized(userId: string): Promise<void> {
  await db.set("authorized", userId, { userId });
}

export async function getAuthorizedUsers(): Promise<string[]> {
  const users = await db.keys("authorized");
  return users || [];
}

// Onboarded users
export async function isOnboarded(userId: string): Promise<boolean> {
  const user = await db.get("onboarded", userId);
  return user !== null && user !== undefined;
}

export async function addOnboarded(userId: string): Promise<void> {
  await db.set("onboarded", userId, { userId });
}

export async function getOnboardedUsers(): Promise<string[]> {
  const users = await db.keys("onboarded");
  return users || [];
}

// Queue operations
export async function enqueueMessage(message: {
  id: string;
  chatId: string | number;
  text: string;
  type: "heartbeat" | "message";
}): Promise<void> {
  await db.set("queue", message.id, {
    ...message,
    timestamp: Date.now(),
  });
}

export async function dequeueMessages(limit?: number): Promise<any[]> {
  const messages = await db.values("queue");
  if (!messages || messages.length === 0) return [];

  const sorted = messages.sort((a: any, b: any) => a.timestamp - b.timestamp);
  const batch = limit ? sorted.slice(0, limit) : sorted;

  // Delete the dequeued messages
  for (const msg of batch) {
    await db.del("queue", msg.id);
  }

  return batch;
}

export async function getQueueSize(): Promise<number> {
  const messages = await db.keys("queue");
  return messages ? messages.length : 0;
}

export async function clearQueue(): Promise<void> {
  const keys = await db.keys("queue");
  if (keys) {
    for (const key of keys) {
      await db.del("queue", key);
    }
  }
}

// Settings (auth token, etc.)
export async function getSetting(key: string): Promise<string | null> {
  const val = await db.get("settings", key);
  return val?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db.set("settings", key, { value });
}

// Attachments
export async function addAttachment(record: AttachmentRecord): Promise<void> {
  await db.set("attachments", record.id, record);
}

export async function getAttachments(chatId?: string): Promise<AttachmentRecord[]> {
  const all = (await db.values("attachments")) || [];
  if (!chatId) return all;
  return all.filter((a: AttachmentRecord) => a.chatId === chatId);
}

export async function getAttachment(id: string): Promise<AttachmentRecord | null> {
  return await db.get("attachments", id);
}

export async function deleteAttachment(id: string): Promise<void> {
  await db.del("attachments", id);
}

export async function getExpiredAttachments(maxAgeDays: number): Promise<AttachmentRecord[]> {
  const all = (await db.values("attachments")) || [];
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  return all.filter((a: AttachmentRecord) => a.createdAt < cutoff);
}

// Messages (ledger)
export async function saveMessageRecord(record: MessageRecord): Promise<void> {
  await db.set("messages", record.id, record);
}

export async function getMessageRecord(chatId: string, messageId: number): Promise<MessageRecord | null> {
  return await db.get("messages", `${chatId}_${messageId}`);
}

export async function cleanupOldMessages(maxAgeDays: number): Promise<number> {
  const all = (await db.values("messages")) || [];
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const record of all) {
    if ((record as MessageRecord).timestamp < cutoff) {
      await db.del("messages", (record as MessageRecord).id);
      deleted++;
    }
  }
  return deleted;
}

// Secrets (API keys stored encrypted)
export async function getSecret(key: string): Promise<string | null> {
  const val = await secretsDb.get("secrets", key);
  return val?.value ?? null;
}

export async function setSecret(key: string, value: string): Promise<void> {
  await secretsDb.set("secrets", key, { value });
}

export async function deleteSecret(key: string): Promise<void> {
  await secretsDb.del("secrets", key);
}

export { db, secretsDb };

/**
 * @module shared/db
 * @role Unified persistence layer using deepbase
 * @responsibilities
 *   - Persist scheduled tasks, authorized users, onboarded users, queue messages
 *   - Provide type-safe operations with JSON storage
 *   - Auto-connect on first operation
 * @dependencies deepbase, shared/types, shared/config
 * @effects Disk I/O (.tinyclaw/db/)
 */

import DeepBase from "deepbase";
import { config } from "./config";
import type { ScheduledTask, AttachmentRecord, MessageRecord } from "./types";

// Initialize deepbase with the storage directory
const db = new DeepBase({
  path: `${config.tinyclawDir}/db`,
  name: "tinyclaw",
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

export { db };

/**
 * @module core/attachments
 * @role Persist media attachments so the model can access them later.
 * @responsibilities
 *   - Save base64 attachments to .tinyclaw/attachments/{chatId}/
 *   - Track metadata in deepbase (collection: "attachments")
 *   - Clean up files older than configured max age
 * @dependencies shared/config, shared/db
 * @effects Disk I/O in .tinyclaw/attachments/, deepbase writes
 */

import { mkdirSync, existsSync, unlinkSync, rmdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { config } from "../shared/config";
import { createLogger } from "../shared/logger";
import { addAttachment, getExpiredAttachments, deleteAttachment, cleanupOldMessages } from "../shared/db";
import type { AttachmentRecord } from "../shared/types";

const log = createLogger("core");

const EXT_MAP: Record<string, string> = {
  image: "jpg",
  audio: "ogg",
  document: "bin",
};

export async function initAttachments(): Promise<void> {
  if (!existsSync(config.attachmentsDir)) {
    mkdirSync(config.attachmentsDir, { recursive: true });
  }
  await cleanupOldAttachments();
  const msgsCleaned = await cleanupOldMessages(config.attachmentMaxAgeDays);
  if (msgsCleaned > 0) {
    log.info(`Cleaned up ${msgsCleaned} expired message record(s)`);
  }
}

export async function saveAttachment(
  chatId: string,
  type: "image" | "audio" | "document",
  base64: string,
  filename?: string,
  mimeType?: string,
): Promise<string> {
  const chatDir = join(config.attachmentsDir, chatId);
  if (!existsSync(chatDir)) {
    mkdirSync(chatDir, { recursive: true });
  }

  const ext = filename ? filename.split(".").pop() || EXT_MAP[type] : EXT_MAP[type];
  const hex = Math.random().toString(16).slice(2, 6);
  const prefix = type === "image" ? "img" : type === "audio" ? "aud" : "doc";
  const outName = `${prefix}_${Date.now()}_${hex}.${ext}`;
  const outPath = join(chatDir, outName);

  const buffer = Buffer.from(base64, "base64");
  await Bun.write(outPath, buffer);

  const relPath = `.tinyclaw/attachments/${chatId}/${outName}`;

  const record: AttachmentRecord = {
    id: `${chatId}_${outName}`,
    chatId,
    type,
    filename: filename || outName,
    relPath,
    mimeType,
    sizeBytes: buffer.length,
    createdAt: Date.now(),
  };
  await addAttachment(record);

  log.info(`Saved ${type} attachment: ${relPath} (${buffer.length} bytes)`);
  return relPath;
}

async function cleanupOldAttachments(): Promise<void> {
  const expired = await getExpiredAttachments(config.attachmentMaxAgeDays);
  if (expired.length === 0) return;

  let cleaned = 0;
  for (const record of expired) {
    const absPath = join(config.projectDir, record.relPath);
    try {
      if (existsSync(absPath)) {
        unlinkSync(absPath);
      }
      // Remove empty chat dir
      const dir = dirname(absPath);
      if (existsSync(dir) && readdirSync(dir).length === 0) {
        rmdirSync(dir);
      }
    } catch {
      // File already gone — just clean the record
    }
    await deleteAttachment(record.id);
    cleaned++;
  }

  log.info(`Cleaned up ${cleaned} expired attachment(s)`);
}

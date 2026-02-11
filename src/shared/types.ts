/**
 * @module shared/types
 * @role Define all shared interfaces for Daemon ↔ Core communication.
 * @responsibilities
 *   - IncomingMessage: what a channel adapter produces
 *   - CoreRequest/CoreResponse: HTTP payloads between Daemon and Core
 *   - SendRequest: Core → Daemon push (scheduler, etc.)
 *   - ScheduledTask: persisted task for croner/one-time
 *   - ModelConfig: router output
 * @dependencies None
 * @effects None (types only)
 */

export interface IncomingMessage {
  chatId: string;
  sender: string;
  senderId: string;
  text?: string;
  audio?: { base64: string; filename: string };
  image?: { base64: string; caption?: string };
  document?: { base64: string; filename: string; mimeType: string; caption?: string };
  command?: string;
  messageId?: number;
  timestamp: number;
  replyTo?: {
    messageId?: number;
    text?: string;
    sender: string;
    timestamp: number;
  };
}

export interface CoreRequest {
  message: IncomingMessage;
}

export interface CoreResponse {
  text: string;
  files?: string[];
  audio?: string;
}

export interface SendRequest {
  chatId: string;
  text: string;
  files?: string[];
}

export interface ScheduledTask {
  id: string;
  chatId: string;
  sender: string;
  senderId: string;
  type: "once" | "cron";
  origin?: "cron" | "recurring";
  message: string;
  originalMessage: string;
  createdAt: number;
  runAt?: number;
  cron?: string;
  lastRunAt?: number;
  status?: "pending" | "done";
}

export interface AttachmentRecord {
  id: string;
  chatId: string;
  type: "image" | "audio" | "document";
  filename: string;
  relPath: string;
  mimeType?: string;
  sizeBytes: number;
  createdAt: number;
}

export interface ModelConfig {
  model: string;
  timeout: number;
  reason: string;
}

export interface MessageRecord {
  id: string;                 // "{chatId}_{messageId}"
  chatId: string;
  messageId: number;          // Telegram message_id
  direction: "in" | "out";
  sender: string;
  timestamp: number;
  text?: string;
  mediaType?: "image" | "audio" | "document";
  attachmentPath?: string;
  mediaDescription?: string;
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => void): void;
  send(chatId: string, text: string, parseMode?: "HTML" | "plain"): Promise<number | undefined>;
  sendFile(chatId: string, filePath: string): Promise<void>;
  sendAudio?(chatId: string, filePath: string): Promise<void>;
  sendTyping(chatId: string): Promise<void>;
}

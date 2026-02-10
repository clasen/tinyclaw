/**
 * @module daemon/channels/telegram
 * @role Telegram channel adapter using grammy.
 * @responsibilities
 *   - Connect to Telegram Bot API
 *   - Receive text, voice, and photo messages
 *   - Download media from Telegram servers as buffers
 *   - Send text (HTML) and file messages back
 *   - Extract commands from text and forward to Core
 * @dependencies grammy, shared/config
 * @effects Network (Telegram API), spawns long-polling connection
 * @contract Implements Channel interface
 */

import { Bot, GrammyError, HttpError, InputFile } from "grammy";
import type { Channel, IncomingMessage } from "./base";
import { config } from "../../shared/config";
import { createLogger } from "../../shared/logger";

const log = createLogger("telegram");

export class TelegramChannel implements Channel {
  name = "telegram";
  private bot: Bot;
  private handler: ((msg: IncomingMessage) => void) | null = null;

  constructor() {
    if (!config.telegramBotToken) {
      throw new Error("TELEGRAM_BOT_TOKEN not configured");
    }
    this.bot = new Bot(config.telegramBotToken);

    this.bot.catch((err) => {
      const e = err.error;
      if (e instanceof GrammyError) {
        log.error(`Telegram API error: ${e.description}`);
      } else if (e instanceof HttpError) {
        log.error(`Telegram HTTP error: ${e}`);
      } else {
        log.error(`Telegram unknown error: ${e}`);
      }
    });
  }

  async connect(): Promise<void> {
    // All text messages — commands are extracted and forwarded to Core
    this.bot.on("message:text", async (ctx) => {
      if (ctx.chat.type !== "private") return;
      const text = ctx.message.text;
      if (!text?.trim()) return;

      // Extract command if message starts with /
      let command: string | undefined;
      if (text.startsWith("/")) {
        const match = text.match(/^\/(\w+)/);
        if (match) command = `/${match[1].toLowerCase()}`;
      }

      log.info(`${command ? `Cmd ${command}` : "Text"} from ${ctx.from!.first_name}: ${text.substring(0, 60)}`);
      if (!command) await ctx.api.sendChatAction(ctx.chat.id, "typing");

      // Capture reply_to_message if present
      let replyTo: IncomingMessage["replyTo"];
      if (ctx.message.reply_to_message) {
        const reply = ctx.message.reply_to_message;
        replyTo = {
          messageId: reply.message_id,
          text: "text" in reply ? reply.text : undefined,
          sender: reply.from ? this.getSenderName({ from: reply.from }) : "Unknown",
          timestamp: reply.date * 1000,
        };
      }

      this.handler?.({
        chatId: String(ctx.chat.id),
        sender: this.getSenderName(ctx),
        senderId: String(ctx.from!.id),
        text,
        command,
        messageId: ctx.message.message_id,
        timestamp: Date.now(),
        replyTo,
      });
    });

    // Voice messages
    this.bot.on("message:voice", async (ctx) => {
      if (ctx.chat.type !== "private") return;

      const voice = ctx.message.voice;
      log.info(`Voice from ${ctx.from!.first_name} (${voice.duration}s)`);
      await ctx.api.sendChatAction(ctx.chat.id, "typing");

      // Capture reply_to_message if present
      let replyTo: IncomingMessage["replyTo"];
      if (ctx.message.reply_to_message) {
        const reply = ctx.message.reply_to_message;
        replyTo = {
          messageId: reply.message_id,
          text: "text" in reply ? reply.text : undefined,
          sender: reply.from ? this.getSenderName({ from: reply.from }) : "Unknown",
          timestamp: reply.date * 1000,
        };
      }

      try {
        const file = await ctx.api.getFile(voice.file_id);
        if (!file.file_path) {
          await ctx.reply("No se pudo descargar el audio.");
          return;
        }
        const buffer = await this.downloadFile(file.file_path);
        this.handler?.({
          chatId: String(ctx.chat.id),
          sender: this.getSenderName(ctx),
          senderId: String(ctx.from!.id),
          audio: { base64: buffer.toString("base64"), filename: `voice_${Date.now()}.ogg` },
          messageId: ctx.message.message_id,
          timestamp: Date.now(),
          replyTo,
        });
      } catch (error) {
        log.error(`Voice download error: ${error}`);
        await ctx.reply("Could not download the audio. Try again.");
      }
    });

    // Photo messages
    this.bot.on("message:photo", async (ctx) => {
      if (ctx.chat.type !== "private") return;

      const photos = ctx.message.photo;
      const photo = photos[photos.length - 1];
      const caption = ctx.message.caption || "";

      log.info(`Photo from ${ctx.from!.first_name} (${photo.width}x${photo.height})`);
      await ctx.api.sendChatAction(ctx.chat.id, "typing");

      // Capture reply_to_message if present
      let replyTo: IncomingMessage["replyTo"];
      if (ctx.message.reply_to_message) {
        const reply = ctx.message.reply_to_message;
        replyTo = {
          messageId: reply.message_id,
          text: "text" in reply ? reply.text : undefined,
          sender: reply.from ? this.getSenderName({ from: reply.from }) : "Unknown",
          timestamp: reply.date * 1000,
        };
      }

      try {
        const file = await ctx.api.getFile(photo.file_id);
        if (!file.file_path) {
          await ctx.reply("No se pudo descargar la imagen.");
          return;
        }
        const buffer = await this.downloadFile(file.file_path);
        this.handler?.({
          chatId: String(ctx.chat.id),
          sender: this.getSenderName(ctx),
          senderId: String(ctx.from!.id),
          image: { base64: buffer.toString("base64"), caption: caption || undefined },
          messageId: ctx.message.message_id,
          timestamp: Date.now(),
          replyTo,
        });
      } catch (error) {
        log.error(`Photo download error: ${error}`);
        await ctx.reply("Could not download the image. Try again.");
      }
    });

    // Document messages (PDFs, files, etc.)
    this.bot.on("message:document", async (ctx) => {
      if (ctx.chat.type !== "private") return;

      const doc = ctx.message.document;
      const caption = ctx.message.caption || "";

      log.info(`Document from ${ctx.from!.first_name}: ${doc.file_name} (${doc.mime_type})`);
      await ctx.api.sendChatAction(ctx.chat.id, "typing");

      // Capture reply_to_message if present
      let replyTo: IncomingMessage["replyTo"];
      if (ctx.message.reply_to_message) {
        const reply = ctx.message.reply_to_message;
        replyTo = {
          messageId: reply.message_id,
          text: "text" in reply ? reply.text : undefined,
          sender: reply.from ? this.getSenderName({ from: reply.from }) : "Unknown",
          timestamp: reply.date * 1000,
        };
      }

      try {
        const file = await ctx.api.getFile(doc.file_id);
        if (!file.file_path) {
          await ctx.reply("Could not download the document.");
          return;
        }
        const buffer = await this.downloadFile(file.file_path);
        this.handler?.({
          chatId: String(ctx.chat.id),
          sender: this.getSenderName(ctx),
          senderId: String(ctx.from!.id),
          document: {
            base64: buffer.toString("base64"),
            filename: doc.file_name || `file_${Date.now()}`,
            mimeType: doc.mime_type || "application/octet-stream",
            caption: caption || undefined,
          },
          messageId: ctx.message.message_id,
          timestamp: Date.now(),
          replyTo,
        });
      } catch (error) {
        log.error(`Document download error: ${error}`);
        await ctx.reply("Could not download the document. Try again.");
      }
    });

    await this.bot.start({
      onStart: (botInfo) => {
        log.info(`Telegram bot connected as @${botInfo.username}`);
      },
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }

  async send(chatId: string, text: string, parseMode: "HTML" | "plain" = "HTML"): Promise<number | undefined> {
    try {
      if (parseMode === "HTML") {
        try {
          const sent = await this.bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
          return sent.message_id;
        } catch (error) {
          if (error instanceof GrammyError && error.description?.includes("can't parse entities")) {
            log.warn("HTML parse failed, falling back to plain text");
          } else {
            throw error;
          }
        }
      }
      // Strip HTML tags and unescape entities for plain text
      const plain = text
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"');
      const sent = await this.bot.api.sendMessage(chatId, plain);
      return sent.message_id;
    } catch (error) {
      log.error(`Send error to ${chatId}: ${error}`);
      throw error;
    }
  }

  async sendFile(chatId: string, filePath: string): Promise<void> {
    try {
      await this.bot.api.sendDocument(chatId, new InputFile(filePath));
      log.info(`Sent file to ${chatId}: ${filePath}`);
    } catch (error) {
      log.error(`File send error: ${error}`);
      throw error;
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      await this.bot.api.sendChatAction(chatId, "typing");
    } catch {
      // Non-critical — ignore
    }
  }

  private getSenderName(ctx: { from?: { first_name: string; last_name?: string; username?: string; id: number } }): string {
    if (!ctx.from) return "Unknown";
    return (
      ctx.from.first_name + (ctx.from.last_name ? " " + ctx.from.last_name : "") ||
      ctx.from.username ||
      String(ctx.from.id)
    );
  }

  private async downloadFile(filePath: string): Promise<Buffer> {
    const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

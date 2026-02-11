/**
 * @module daemon/index
 * @role Entry point for the Daemon process.
 * @responsibilities
 *   - Run interactive setup if config is missing
 *   - Start the Telegram channel adapter
 *   - Spawn Core process with --watch
 *   - Run HTTP server on :7778 for Core → Daemon pushes (scheduler)
 *   - Route incoming messages to Core via bridge
 *   - Route Core responses back to channel
 * @dependencies All daemon/* modules, shared/*
 * @effects Network (Telegram, HTTP servers), spawns Core process
 */

// Setup runs first — no config dependency, writes .env if needed
import { runSetup } from "./setup";
const ready = await runSetup();
if (!ready) process.exit(1);

// Dynamic imports so config loads AFTER setup has written .env
const { config } = await import("../shared/config");

// Initialize encrypted secrets
await config.secrets.initialize();
const { createLogger } = await import("../shared/logger");
const { serveWithRetry, claimProcess, releaseProcess } = await import("../shared/ports");
const { TelegramChannel } = await import("./channels/telegram");
const { sendToCore } = await import("./bridge");
const { startCore, stopCore, setLifecycleNotify } = await import("./lifecycle");
const { setAutoFixNotify } = await import("./autofix");
const { chunkMessage, markdownToTelegramHtml } = await import("../core/format");
const { saveMessageRecord } = await import("../shared/db");

const log = createLogger("daemon");

// --- Claim process: kill previous daemon, write our PID ---
claimProcess("daemon");

// --- Track known chatIds in memory (no deepbase dependency) ---
const knownChatIds = new Set<string>();

// Pre-seed from DB (best-effort — won't crash if DB is corrupt)
try {
  const { getAuthorizedUsers } = await import("../shared/db");
  const chatIds = await getAuthorizedUsers();
  for (const id of chatIds) knownChatIds.add(id);
} catch {
  log.warn("Could not pre-load authorized chatIds (DB may be corrupt)");
}

// --- Channel setup ---
const telegram = new TelegramChannel();

// --- Wire up notifications (lifecycle + autofix → Telegram) ---
const sendToAllChats = async (text: string) => {
  for (const chatId of knownChatIds) {
    await telegram.send(chatId, text).catch(() => {});
  }
};

setLifecycleNotify(sendToAllChats);
setAutoFixNotify(sendToAllChats);

telegram.onMessage(async (msg) => {
  knownChatIds.add(msg.chatId);
  // Keep typing indicator alive while Core processes (expires every ~5s)
  const typingInterval = setInterval(() => telegram.sendTyping(msg.chatId), 4000);

  try {
    const response = await sendToCore(msg, async (statusText) => {
      try {
        await telegram.send(msg.chatId, statusText);
      } catch (e) {
        log.error(`Failed to send status message: ${e}`);
      }
    });
    clearInterval(typingInterval);

    const raw = response.text || "";
    const messageParts = raw.split(/\n---CHUNK---\n/g);
    let sentText = false;

    // Send audio first if present (voice messages should arrive before text)
    if (response.audio) {
      try {
        await telegram.sendAudio(msg.chatId, response.audio);
      } catch (error) {
        log.error(`Audio send failed: ${error}`);
      }
    }

    // Convert markdown to HTML first, then chunk the HTML
    // (chunking must happen after HTML conversion so tag-aware splitting works)
    for (const part of messageParts) {
      if (!part.trim()) continue;
      const html = markdownToTelegramHtml(part);
      const chunks = chunkMessage(html);

      log.info(`Format | rawChars: ${part.length} | htmlChars: ${html.length} | chunks: ${chunks.length}`);
      log.debug(`Format raw >>>>\n${part}\n<<<<`);
      log.debug(`Format html >>>>\n${html}\n<<<<`);

      for (const chunk of chunks) {
        log.debug(`Sending chunk (${chunk.length} chars) >>>>\n${chunk}\n<<<<`);
        const sentId = await telegram.send(msg.chatId, chunk);
        if (sentId) {
          saveMessageRecord({
            id: `${msg.chatId}_${sentId}`,
            chatId: msg.chatId,
            messageId: sentId,
            direction: "out",
            sender: "TinyClaw",
            timestamp: Date.now(),
            text: chunk,
          }).catch((e) => log.error(`Failed to save outgoing message record: ${e}`));
        }
      }
      sentText = true;
    }

    if (response.files) {
      for (const filePath of response.files) {
        await telegram.sendFile(msg.chatId, filePath);
      }
    }

    // If neither text nor audio was sent, don't leave the user hanging
    if (!sentText && !response.audio) {
      log.warn("Empty response from Core — no text or audio to send");
    }
  } catch (error) {
    clearInterval(typingInterval);
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error(`Failed to process message from ${msg.sender}: ${errMsg}`);
    try {
      const summary = errMsg.length > 200 ? errMsg.slice(0, 200) + "..." : errMsg;
      await telegram.send(msg.chatId, `Error: ${summary}`, "plain");
    } catch {
      log.error("Failed to send error message back to user");
    }
  }
});

// --- HTTP server for Core → Daemon pushes (scheduler) ---
const pushServer = await serveWithRetry({
  port: config.daemonPort,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/send" && req.method === "POST") {
      try {
        const body = await req.json() as { chatId: string; text: string; files?: string[] };
        if (!body.chatId || !body.text) {
          return Response.json({ error: "Missing chatId or text" }, { status: 400 });
        }

        const html = markdownToTelegramHtml(body.text);
        const chunks = chunkMessage(html);
        for (const chunk of chunks) {
          const sentId = await telegram.send(body.chatId, chunk);
          if (sentId) {
            saveMessageRecord({
              id: `${body.chatId}_${sentId}`,
              chatId: body.chatId,
              messageId: sentId,
              direction: "out",
              sender: "TinyClaw",
              timestamp: Date.now(),
              text: chunk,
            }).catch((e) => log.error(`Failed to save outgoing message record: ${e}`));
          }
        }

        if (body.files) {
          for (const filePath of body.files) {
            await telegram.sendFile(body.chatId, filePath);
          }
        }

        return Response.json({ ok: true });
      } catch (error) {
        log.error(`Push send error: ${error}`);
        return Response.json({ error: "Send failed" }, { status: 500 });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

log.info(`Daemon push server listening on port ${config.daemonPort}`);

// --- Start Core process ---
startCore();

// --- Connect Telegram ---
telegram.connect().catch((error) => {
  log.error(`Telegram connection failed: ${error}`);
  process.exit(1);
});

// --- Graceful shutdown ---
function shutdown() {
  log.info("Shutting down Daemon...");
  stopCore();
  releaseProcess("daemon");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

log.info("Daemon started");

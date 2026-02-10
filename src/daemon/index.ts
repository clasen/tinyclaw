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
const { createLogger } = await import("../shared/logger");
const { serveWithRetry, claimProcess, releaseProcess } = await import("../shared/ports");
const { TelegramChannel } = await import("./channels/telegram");
const { sendToCore } = await import("./bridge");
const { startCore, stopCore } = await import("./lifecycle");
const { chunkMessage } = await import("../core/format");

const log = createLogger("daemon");

// --- Claim process: kill previous daemon, write our PID ---
claimProcess("daemon");

// --- Channel setup ---
const telegram = new TelegramChannel();

telegram.onMessage(async (msg) => {
  // Keep typing indicator alive while Core processes (expires every ~5s)
  const typingInterval = setInterval(() => telegram.sendTyping(msg.chatId), 4000);

  try {
    const response = await sendToCore(msg);
    clearInterval(typingInterval);

    const chunks = response.text.includes("---CHUNK---")
      ? response.text.split("\n---CHUNK---\n")
      : chunkMessage(response.text);

    for (const chunk of chunks) {
      await telegram.send(msg.chatId, chunk);
    }

    if (response.files) {
      for (const filePath of response.files) {
        await telegram.sendFile(msg.chatId, filePath);
      }
    }
  } catch (error) {
    clearInterval(typingInterval);
    log.error(`Failed to process message from ${msg.sender}: ${error}`);
    try {
      await telegram.send(msg.chatId, "Error processing your message. Please try again.", "plain");
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

        const chunks = chunkMessage(body.text);
        for (const chunk of chunks) {
          await telegram.send(body.chatId, chunk);
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

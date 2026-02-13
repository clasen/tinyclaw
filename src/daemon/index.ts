/**
 * @module daemon/index
 * @role Single-process entry point: Daemon + Core in one bun runtime.
 * @responsibilities
 *   - Run interactive setup if config is missing
 *   - Start the Telegram channel adapter
 *   - Load Core in-process (HTTP server, Claude CLI, scheduler)
 *   - Run HTTP server for Core → Daemon pushes (scheduler)
 *   - Route incoming messages to Core via bridge
 *   - Route Core responses back to channel
 * @dependencies All daemon/* modules, core/*, shared/*
 * @effects Network (Telegram, HTTP servers), spawns Claude CLI
 */

// Log version at startup
import { readFileSync } from "fs";
import { join, dirname } from "path";
const pkgPath = join(dirname(new URL(import.meta.url).pathname), "..", "package.json");
try { const pkg = JSON.parse(readFileSync(pkgPath, "utf8")); console.log(`Arisa v${pkg.version}`); } catch {}

// Setup runs first — no config dependency, writes .env if needed
import { runSetup } from "./setup";
const ready = await runSetup();
if (!ready) process.exit(1);

// Dynamic imports so config loads AFTER setup has written .env
const { config } = await import("../shared/config");

// Initialize encrypted secrets
await config.secrets.initialize();
const { createLogger } = await import("../shared/logger");
const { serveWithRetry, claimProcess, releaseProcess, cleanupSocket } = await import("../shared/ports");
const { TelegramChannel } = await import("./channels/telegram");
const { sendToCore } = await import("./bridge");
// lifecycle/autofix removed — Core runs in-process, --watch handles restarts
const { autoInstallMissingClis, setAutoInstallNotify } = await import("./auto-install");
const { chunkMessage, markdownToTelegramHtml } = await import("../core/format");
// Message records are saved via Core's /record endpoint to avoid dual-writer
// conflicts (Daemon and Core sharing the same arisa.json through separate
// in-memory DeepBase instances would cause one to overwrite the other's data).
async function saveRecordViaCore(record: {
  id: string;
  chatId: string;
  messageId: number;
  direction: "in" | "out";
  sender: string;
  timestamp: number;
  text: string;
}) {
  try {
    await fetch("http://localhost/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
      unix: config.coreSocket,
    } as any);
  } catch (e) {
    log.error(`Failed to save record via Core: ${e}`);
  }
}

const log = createLogger("daemon");

// Log version
try {
  const _pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  log.info(`Arisa v${_pkg.version}`);
} catch {}

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

setAutoInstallNotify(sendToAllChats);

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
          saveRecordViaCore({
            id: `${msg.chatId}_${sentId}`,
            chatId: msg.chatId,
            messageId: sentId,
            direction: "out",
            sender: "Arisa",
            timestamp: Date.now(),
            text: chunk,
          });
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
  unix: config.daemonSocket,
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
            saveRecordViaCore({
              id: `${body.chatId}_${sentId}`,
              chatId: body.chatId,
              messageId: sentId,
              direction: "out",
              sender: "Arisa",
              timestamp: Date.now(),
              text: chunk,
            });
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

log.info(`Daemon push server listening on ${config.daemonSocket}`);

// --- Load Core in-process (single bun process, no child spawn) ---
log.info("Loading Core...");
await import("../core/index.ts");
const { setCoreState } = await import("./lifecycle");
setCoreState("up");
log.info("Core loaded");

// --- Auto-install missing CLIs (delayed to avoid peak memory) ---
setTimeout(() => void autoInstallMissingClis(), 5000);

// --- Connect Telegram (with retry for 409 conflict from stale polling sessions) ---
(async function connectTelegram(maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await telegram.connect();
      return; // connected — polling continues in background
    } catch (error) {
      const is409 = String(error).includes("409");
      if (is409 && attempt < maxRetries) {
        const wait = attempt * 5;
        log.warn(`Telegram 409 conflict (attempt ${attempt}/${maxRetries}), retrying in ${wait}s...`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      log.error(`Telegram connection failed: ${error}`);
      process.exit(1);
    }
  }
})();

// --- Graceful shutdown ---
function shutdown() {
  log.info("Shutting down...");
  cleanupSocket(config.daemonSocket);
  cleanupSocket(config.coreSocket);
  releaseProcess("daemon");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

log.info("Daemon started");

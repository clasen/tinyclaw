/**
 * @module core/index
 * @role HTTP server entry point for Core process.
 * @responsibilities
 *   - Listen on :7777 for messages from Daemon
 *   - Route /message requests through media → processor → file-detector → format
 *   - Expose /health endpoint for Daemon health checks
 *   - Handle /reset, scheduler parsing, and command dispatch
 *   - Initialize scheduler on startup
 * @dependencies All core/* modules, shared/*
 * @effects Network (HTTP server), spawns Claude CLI, disk I/O
 */

import { config } from "../shared/config";
import { createLogger } from "../shared/logger";
import { serveWithRetry, claimProcess } from "../shared/ports";
import type { IncomingMessage, CoreResponse, ScheduledTask } from "../shared/types";
import { processWithClaude, processWithCodex } from "./processor";
import { transcribeAudio, describeImage, isMediaConfigured } from "./media";
import { detectFiles } from "./file-detector";
import { chunkMessage } from "./format";
import { addExchange, getForeignContext } from "./history";
import { getOnboarding, checkDeps } from "./onboarding";
import { initScheduler, addTask } from "./scheduler";
import { detectScheduleIntent } from "./intent";
import { initAuth, isAuthorized, tryAuthorize } from "./auth";

const log = createLogger("core");

// Kill previous Core if still running, write our PID
claimProcess("core");

// Per-chat backend state — default based on what's installed (claude > codex)
const backendState = new Map<string, "claude" | "codex">();

function defaultBackend(): "claude" | "codex" {
  const deps = checkDeps();
  return deps.claude ? "claude" : "codex";
}

function getBackend(chatId: string): "claude" | "codex" {
  return backendState.get(chatId) || defaultBackend();
}

// Initialize auth + scheduler
initAuth();
initScheduler();

const server = await serveWithRetry({
  port: config.corePort,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({ status: "ok", timestamp: Date.now() });
    }

    if (url.pathname === "/message" && req.method === "POST") {
      try {
        const body = await req.json();
        const msg: IncomingMessage = body.message;

        if (!msg) {
          return Response.json({ error: "Missing message" }, { status: 400 });
        }

        log.info(`Message from ${msg.sender}: ${(msg.text || "[media]").substring(0, 60)}`);

        // Auth gate: require token before anything else
        if (!isAuthorized(msg.chatId)) {
          if (msg.text && tryAuthorize(msg.chatId, msg.text)) {
            return Response.json({ text: "Authorized. Welcome to TinyClaw!" } as CoreResponse);
          }
          return Response.json({ text: "Send the auth token to start. Check the server console." } as CoreResponse);
        }

        // Onboarding: first message from this chat
        const onboarding = getOnboarding(msg.chatId);
        if (onboarding?.blocking) {
          return Response.json({ text: onboarding.message } as CoreResponse);
        }

        // Initialize message text
        let messageText = msg.text || "";

        // Handle /reset command
        if (msg.command === "/reset") {
          const { writeFileSync } = await import("fs");
          writeFileSync(config.resetFlagPath, "reset");
          const response: CoreResponse = { text: "Conversation reset! Next message will start a fresh conversation." };
          return Response.json(response);
        }

        // Handle /codex command — switch to codex backend
        if (msg.command === "/codex") {
          const deps = checkDeps();
          if (!deps.codex) {
            const hint = deps.os === "macOS"
              ? "<code>npm install -g @openai/codex</code>"
              : "<code>npm install -g @openai/codex</code>";
            return Response.json({ text: `Codex CLI is not installed.\n${hint}` } as CoreResponse);
          }
          backendState.set(msg.chatId, "codex");
          log.info(`Backend switched to codex for chat ${msg.chatId}`);
          const response: CoreResponse = { text: "Codex mode activated. Use /claude to switch back." };
          return Response.json(response);
        }

        // Handle /claude command — switch to claude backend
        if (msg.command === "/claude") {
          const deps = checkDeps();
          if (!deps.claude) {
            const hint = deps.os === "macOS"
              ? "<code>brew install claude-code</code> o <code>npm install -g @anthropic-ai/claude-code</code>"
              : "<code>npm install -g @anthropic-ai/claude-code</code>";
            return Response.json({ text: `Claude CLI is not installed.\n${hint}` } as CoreResponse);
          }
          backendState.set(msg.chatId, "claude");
          log.info(`Backend switched to claude for chat ${msg.chatId}`);
          const response: CoreResponse = { text: "Claude mode activated. Use /codex to switch back." };
          return Response.json(response);
        }

        // Process media first

        if (msg.audio) {
          if (isMediaConfigured()) {
            try {
              const transcription = await transcribeAudio(msg.audio.base64, msg.audio.filename);
              if (transcription.trim()) {
                messageText = `[Voice message transcription]: ${transcription}`;
              } else {
                messageText = `[The user sent a voice message but transcription returned empty. Ask them to try again or send text.]`;
              }
            } catch (error) {
              log.error(`Transcription failed: ${error}`);
              messageText = `[The user sent a voice message but transcription failed. Ask them to try again or send text.]`;
            }
          } else {
            messageText = `[The user sent a voice message but it cannot be transcribed because OPENAI_API_KEY is not configured. Let them know and ask them to send text instead.]`;
          }
        }

        if (msg.image) {
          const caption = msg.image.caption || "";
          if (isMediaConfigured()) {
            try {
              const description = await describeImage(msg.image.base64, caption);
              if (description.trim()) {
                messageText = caption
                  ? `[Image attached with text: "${caption}"]\n[Image description: ${description}]`
                  : `[Image attached]\n[Image description: ${description}]`;
              } else {
                messageText = caption
                  ? `[Image attached with text: "${caption}"]\n[Image content could not be interpreted]`
                  : `[Image attached]\n[Image content could not be interpreted]`;
              }
            } catch (error) {
              log.error(`Image analysis failed: ${error}`);
              messageText = caption
                ? `[Image attached with text: "${caption}"]\n[Error analyzing the image]`
                : `[Image attached]\n[Error analyzing the image]`;
            }
          } else {
            messageText = caption
              ? `[Image attached with text: "${caption}"]\n[Cannot interpret the image because OPENAI_API_KEY is not configured. Respond based on the user's text.]`
              : `[Image attached without text]\n[Cannot interpret the image because OPENAI_API_KEY is not configured. Let the user know you can't see images, but ask how you can help.]`;
          }
        }

        if (!messageText) {
          const response: CoreResponse = { text: "Empty message received." };
          return Response.json(response);
        }

        // Detect scheduling intent via haiku (language-agnostic)
        const scheduleIntent = await detectScheduleIntent(messageText);
        if (scheduleIntent) {
          const taskId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
          const task: ScheduledTask = {
            id: taskId,
            chatId: msg.chatId,
            sender: msg.sender,
            senderId: msg.senderId,
            type: scheduleIntent.type,
            message: scheduleIntent.message,
            originalMessage: messageText,
            createdAt: Date.now(),
            ...(scheduleIntent.type === "once" && scheduleIntent.delaySeconds
              ? { runAt: Date.now() + scheduleIntent.delaySeconds * 1000 }
              : {}),
            ...(scheduleIntent.type === "cron" && scheduleIntent.cron
              ? { cron: scheduleIntent.cron }
              : {}),
          };
          addTask(task);
          const response: CoreResponse = { text: scheduleIntent.confirmation };
          return Response.json(response);
        }

        // Route based on current backend state
        const backend = getBackend(msg.chatId);
        const deps = checkDeps();
        const canFallback = backend === "codex" ? deps.claude : deps.codex;
        let agentResponse: string;
        let usedBackend: "claude" | "codex" = backend;

        // Inject cross-backend context if switching
        const foreignCtx = getForeignContext(msg.chatId, backend);
        const enrichedMessage = foreignCtx ? foreignCtx + messageText : messageText;

        if (backend === "codex") {
          try {
            agentResponse = await processWithCodex(enrichedMessage);
            if (agentResponse.startsWith("Error processing with Codex") && canFallback) {
              log.warn("Codex failed, falling back to Claude");
              agentResponse = await processWithClaude(enrichedMessage);
              usedBackend = "claude";
            }
          } catch (error) {
            if (canFallback) {
              log.warn(`Codex threw, falling back to Claude: ${error}`);
              agentResponse = await processWithClaude(enrichedMessage);
              usedBackend = "claude";
            } else {
              agentResponse = "Error processing with Codex. Please try again.";
            }
          }
        } else {
          try {
            agentResponse = await processWithClaude(enrichedMessage);
          } catch (error) {
            if (canFallback) {
              log.warn(`Claude threw, falling back to Codex: ${error}`);
              agentResponse = await processWithCodex(enrichedMessage);
              usedBackend = "codex";
            } else {
              agentResponse = "Error processing your message. Please try again.";
            }
          }
        }

        // Log exchange for shared history
        addExchange(msg.chatId, messageText, agentResponse, usedBackend);

        // Prepend onboarding info if first message (non-blocking)
        const fullResponse = onboarding
          ? onboarding.message + "\n\n---CHUNK---\n" + agentResponse
          : agentResponse;

        const files = detectFiles(agentResponse);
        const chunks = chunkMessage(fullResponse);

        const response: CoreResponse = {
          text: chunks.join("\n---CHUNK---\n"),
          files: files.length > 0 ? files : undefined,
        };

        return Response.json(response);
      } catch (error) {
        log.error(`Request processing error: ${error}`);
        return Response.json({ error: "Internal error" }, { status: 500 });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

log.info(`Core server listening on port ${config.corePort}`);

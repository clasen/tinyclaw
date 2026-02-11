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
import { transcribeAudio, describeImage, generateSpeech, isMediaConfigured, isSpeechConfigured } from "./media";
import { detectFiles } from "./file-detector";

import { addExchange, getForeignContext, clearHistory } from "./history";
import { getOnboarding, checkDeps } from "./onboarding";
import { initScheduler, addTask, cancelAllChatTasks } from "./scheduler";
import { detectScheduleIntent } from "./intent";
import { initAuth, isAuthorized, tryAuthorize } from "./auth";
import { initAttachments, saveAttachment } from "./attachments";
import { saveMessageRecord, getMessageRecord } from "../shared/db";

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

// Initialize auth + scheduler + attachments
await initAuth();
await initScheduler();
await initAttachments();

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
          if (msg.text && await tryAuthorize(msg.chatId, msg.text)) {
            return Response.json({ text: "Authorized. Welcome to TinyClaw!" } as CoreResponse);
          }
          return Response.json({ text: "Send the auth token to start. Check the server console." } as CoreResponse);
        }

        // Onboarding: first message from this chat
        const onboarding = await getOnboarding(msg.chatId);
        if (onboarding?.blocking) {
          return Response.json({ text: onboarding.message } as CoreResponse);
        }

        // Initialize message text
        let messageText = msg.text || "";

        // Prepend reply context if message quotes another message
        if (msg.replyTo) {
          let quotedText = msg.replyTo.text || "";
          let quotedSender = msg.replyTo.sender;
          let quotedDate = new Date(msg.replyTo.timestamp).toLocaleString("es-AR");
          let attachmentInfo = "";

          // Try ledger lookup for richer context
          if (msg.replyTo.messageId) {
            const ledger = await getMessageRecord(msg.chatId, msg.replyTo.messageId);
            if (ledger) {
              quotedText = ledger.text || quotedText;
              quotedSender = ledger.sender;
              quotedDate = new Date(ledger.timestamp).toLocaleString("es-AR");
              if (ledger.mediaDescription) {
                attachmentInfo += `\nMedia description: ${ledger.mediaDescription}`;
              }
              if (ledger.attachmentPath) {
                attachmentInfo += `\nAttachment: ${ledger.attachmentPath}`;
              }
            }
          }

          if (!quotedText && !attachmentInfo) {
            quotedText = "[media or unknown content]";
          }

          messageText = `━━━ QUOTED MESSAGE ━━━
From: ${quotedSender}
Date: ${quotedDate}
Content: "${quotedText}"${attachmentInfo}
━━━━━━━━━━━━━━━━━━━━

${messageText}`;
        }

        // Handle /reset command
        if (msg.command === "/reset") {
          const { writeFileSync } = await import("fs");
          writeFileSync(config.resetFlagPath, "reset");
          clearHistory(msg.chatId);
          const { resetRouterState } = await import("./router");
          resetRouterState();
          const response: CoreResponse = { text: "Conversation reset! Next message will start a fresh conversation." };
          return Response.json(response);
        }

        // Handle /cancel command — stop all scheduled tasks
        if (msg.command === "/cancel") {
          const removed = await cancelAllChatTasks(msg.chatId);
          const text = removed > 0
            ? `Cancelled ${removed} task${removed > 1 ? "s" : ""}.`
            : "No active tasks to cancel.";
          return Response.json({ text } as CoreResponse);
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

        // Handle /speak command — generate speech via ElevenLabs
        if (msg.command === "/speak") {
          if (!config.elevenlabsApiKey) {
            return Response.json({ text: "ELEVENLABS_API_KEY not configured. Add it to .tinyclaw/.env" } as CoreResponse);
          }
          const textToSpeak = messageText.replace(/^\/speak\s*/, "").trim();
          if (!textToSpeak) {
            return Response.json({ text: "Usage: /speak <text to convert to speech>" } as CoreResponse);
          }
          try {
            const audioPath = await generateSpeech(textToSpeak);
            const response: CoreResponse = {
              text: "",
              audio: audioPath,
            };
            return Response.json(response);
          } catch (error) {
            log.error(`Speech generation failed: ${error}`);
            return Response.json({ text: "Failed to generate speech. Check logs for details." } as CoreResponse);
          }
        }

        // Process media first — track metadata for message ledger
        let ledgerMediaType: "image" | "audio" | "document" | undefined;
        let ledgerAttachmentPath: string | undefined;
        let ledgerMediaDescription: string | undefined;

        if (msg.audio) {
          const audioPath = await saveAttachment(msg.chatId, "audio", msg.audio.base64, msg.audio.filename);
          ledgerMediaType = "audio";
          ledgerAttachmentPath = audioPath;
          if (isMediaConfigured()) {
            try {
              const transcription = await transcribeAudio(msg.audio.base64, msg.audio.filename);
              if (transcription.trim()) {
                ledgerMediaDescription = transcription;
                messageText = `[Audio saved to ${audioPath}]\n[Voice message transcription]: ${transcription}`;
              } else {
                messageText = `[Audio saved to ${audioPath}]\n[Transcription returned empty. Ask the user to try again or send text.]`;
              }
            } catch (error) {
              log.error(`Transcription failed: ${error}`);
              messageText = `[Audio saved to ${audioPath}]\n[Transcription failed. The audio file is still accessible at the path above.]`;
            }
          } else {
            messageText = `[Audio saved to ${audioPath}]\n[Cannot transcribe because OPENAI_API_KEY is not configured. The audio file is still accessible at the path above.]`;
          }
        }

        if (msg.image) {
          const caption = msg.image.caption || "";
          const imgPath = await saveAttachment(msg.chatId, "image", msg.image.base64);
          ledgerMediaType = "image";
          ledgerAttachmentPath = imgPath;

          if (caption && isMediaConfigured()) {
            // User sent text with the image → describe it via Vision
            try {
              const description = await describeImage(msg.image.base64, caption);
              if (description.trim()) {
                ledgerMediaDescription = description;
                messageText = `[Image saved to ${imgPath}]\n[Image description: ${description}]\n${caption}`;
              } else {
                messageText = `[Image saved to ${imgPath}]\n[Image content could not be interpreted]\n${caption}`;
              }
            } catch (error) {
              log.error(`Image analysis failed: ${error}`);
              messageText = `[Image saved to ${imgPath}]\n[Error analyzing the image]\n${caption}`;
            }
          } else if (caption) {
            // Has caption but no OpenAI key
            messageText = `[Image saved to ${imgPath}]\n[Cannot describe image — OPENAI_API_KEY not configured. The image file is accessible at the path above.]\n${caption}`;
          } else {
            // No caption → just save, no GPT call
            messageText = `[Image saved to ${imgPath}]`;
          }
        }

        if (msg.document) {
          const docPath = await saveAttachment(msg.chatId, "document", msg.document.base64, msg.document.filename, msg.document.mimeType);
          ledgerMediaType = "document";
          ledgerAttachmentPath = docPath;
          const caption = msg.document.caption || "";
          messageText = caption
            ? `[Document saved to ${docPath}] (${msg.document.mimeType})\n${caption}`
            : `[Document saved to ${docPath}] (${msg.document.mimeType})`;
        }

        if (!messageText) {
          const response: CoreResponse = { text: "Empty message received." };
          return Response.json(response);
        }

        // Save incoming message to ledger (after media processing so we have descriptions)
        if (msg.messageId) {
          saveMessageRecord({
            id: `${msg.chatId}_${msg.messageId}`,
            chatId: msg.chatId,
            messageId: msg.messageId,
            direction: "in",
            sender: msg.sender,
            timestamp: msg.timestamp,
            text: messageText,
            mediaType: ledgerMediaType,
            attachmentPath: ledgerAttachmentPath,
            mediaDescription: ledgerMediaDescription,
          }).catch((e) => log.error(`Failed to save incoming message record: ${e}`));
        }

        // Detect scheduling intent via haiku (language-agnostic)
        const scheduleIntent = await detectScheduleIntent(messageText);
        if (scheduleIntent) {
          if (scheduleIntent.type === "cancel") {
            const removed = await cancelAllChatTasks(msg.chatId);
            const text = removed > 0
              ? scheduleIntent.confirmation
              : "No active tasks to cancel.";
            return Response.json({ text } as CoreResponse);
          }

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
          await addTask(task);
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

        log.info(`Routing | backend: ${backend} | foreignCtx: ${!!foreignCtx} | enrichedChars: ${enrichedMessage.length}`);

        if (backend === "codex") {
          try {
            agentResponse = await processWithCodex(enrichedMessage);
            if (agentResponse.startsWith("Error processing with Codex") && canFallback) {
              log.warn("Codex failed, falling back to Claude");
              agentResponse = await processWithClaude(enrichedMessage, msg.chatId);
              usedBackend = "claude";
            }
          } catch (error) {
            if (canFallback) {
              log.warn(`Codex threw, falling back to Claude: ${error}`);
              agentResponse = await processWithClaude(enrichedMessage, msg.chatId);
              usedBackend = "claude";
            } else {
              agentResponse = "Error processing with Codex. Please try again.";
            }
          }
        } else {
          try {
            agentResponse = await processWithClaude(enrichedMessage, msg.chatId);
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            if (canFallback) {
              log.warn(`Claude threw, falling back to Codex: ${errMsg}`);
              agentResponse = await processWithCodex(enrichedMessage);
              usedBackend = "codex";
            } else {
              agentResponse = `Error de Claude: ${errMsg.slice(0, 200)}`;
            }
          }
        }

        // Log exchange for shared history
        addExchange(msg.chatId, messageText, agentResponse, usedBackend);

        log.info(`Response | backend: ${usedBackend} | responseChars: ${agentResponse.length}`);
        log.debug(`Response raw >>>>\n${agentResponse}\n<<<<`);

        // Detect [VOICE]...[/VOICE] tags — generate speech via ElevenLabs
        let audioPath: string | undefined;
        let textResponse = agentResponse;

        const voiceMatch = agentResponse.match(/\[VOICE\]([\s\S]*?)\[\/VOICE\]/);
        if (voiceMatch && isSpeechConfigured()) {
          const speechText = voiceMatch[1].trim();
          textResponse = agentResponse.replace(/\[VOICE\][\s\S]*?\[\/VOICE\]/, "").trim();
          try {
            audioPath = await generateSpeech(speechText, config.elevenlabsVoiceId);
            log.info(`Speech generated for ${speechText.length} chars`);
          } catch (error) {
            log.error(`Speech generation failed: ${error}`);
            // Fallback: send the voice text as regular text so the message isn't empty
            if (!textResponse) {
              textResponse = speechText;
            }
          }
        }

        // Prepend onboarding info if first message (non-blocking)
        const fullResponse = onboarding
          ? onboarding.message + "\n\n" + textResponse
          : textResponse;

        const files = detectFiles(textResponse);

        const response: CoreResponse = {
          text: fullResponse,
          files: files.length > 0 ? files : undefined,
          audio: audioPath,
        };

        return Response.json(response);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log.error(`Request processing error: ${errMsg}`);
        const summary = errMsg.length > 200 ? errMsg.slice(0, 200) + "..." : errMsg;
        return Response.json({ text: `Error interno: ${summary}` } as CoreResponse);
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

log.info(`Core server listening on port ${config.corePort}`);

import { NonRetryableTaskError, createTaskRunner } from "../../core/tasks/task-runner.js";
import { buildAsyncEventPrompt, buildAsyncTaskPrompt } from "./prompt-builders.js";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function boundedTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.round(parsed), 60 * 60_000)
    : fallback;
}

function requireChatId(task) {
  const chatId = task.payload?.chatId;
  if (chatId == null || chatId === "") {
    throw new NonRetryableTaskError(`Task missing chatId: ${task.kind}`);
  }
  return chatId;
}

function safeErrorSummary(error) {
  return errorMessage(error)
    .replace(/(bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300) || "Unknown error";
}

function failureDestination(task) {
  const destination = task.route?.transport === "telegram" ? task.route.destination : null;
  return {
    chatId: destination?.chatId || task.payload?.chatId,
    threadId: destination?.threadId || null
  };
}

function buildFailureNotice({ task, result, error }) {
  if (result?.authBlockedNew === true) {
    return [
      "⚠️ Arisa automation paused for authentication",
      `Tool: ${result.authBlock?.toolName || task.payload?.toolName || "unknown"}`,
      `Reason: ${safeErrorSummary(error)}`,
      `Next authentication check: ${result.runAt}`
    ].join("\n");
  }
  const uncertain = result?.status === "outcome_uncertain" || result?.lastOutcome === "outcome_uncertain";
  const recurring = result?.terminalFailure === true && result?.status === "pending";
  const lines = [
    uncertain ? "⚠️ Arisa task outcome is uncertain" : "⚠️ Arisa task failed",
    `Task: ${task.kind || "unknown"} (${task.id})`,
    `Error: ${safeErrorSummary(error)}`
  ];
  if (recurring) lines.push(`Next run: ${result.runAt}`);
  else lines.push("No further retries are scheduled.");
  return lines.join("\n");
}

export function createTelegramTaskDispatcher({
  taskStore,
  sendMessage,
  enqueueAsyncPrompt,
  artifactStore,
  toolRegistry,
  resourceNotes,
  agentManager,
  taskTimeouts = {},
  logger
}) {
  const agentTimeoutMs = boundedTimeout(taskTimeouts.agentTimeoutMs, 15 * 60_000);
  const eventTimeoutMs = boundedTimeout(taskTimeouts.eventTimeoutMs, 5 * 60_000);

  const runHeadlessTool = (toolName, chatId, args) => agentManager.runTool({
    name: toolName,
    request: { args },
    chatId
  });

  function throwToolFailure(result, toolName, fallbackResolution) {
    const error = new Error(result?.error || `${toolName} failed`);
    if (result?.status === "blocked_auth" || fallbackResolution) {
      error.retryable = false;
      error.authBlocked = true;
      error.authResolution = {
        ...(result?.resolution || fallbackResolution || {}),
        toolName
      };
    } else if (result?.status === "needs_config") {
      error.retryable = false;
    } else if (result?.status === "outcome_uncertain") {
      error.retryable = false;
      error.outcomeUncertain = true;
    }
    throw error;
  }

  async function dispatchAgentTask(task, chatId) {
    if (!task.payload.prompt) throw new NonRetryableTaskError("agent_task missing prompt");
    if (task.authBlock?.toolName) {
      const probe = await runHeadlessTool(
        task.authBlock.toolName,
        chatId,
        task.authBlock.probeArgs || {}
      );
      if (probe?.ok === false) throwToolFailure(probe, task.authBlock.toolName, task.authBlock);
      logger?.log("tasks", `authentication restored for ${task.authBlock.toolName} (task ${task.id})`);
    }

    logger?.log("tasks", `running task ${task.id} for chat ${chatId}`);
    const agentTaskExecution = { blockedAuth: null };
    await enqueueAsyncPrompt({
      chatId,
      prompt: await buildAsyncTaskPrompt({ task, artifactStore, toolRegistry, resourceNotes, logger }),
      label: `scheduled task ${task.id}`,
      route: task.route,
      timeoutMs: agentTimeoutMs,
      priority: task.source?.toolName === "whatsapp-web" ? "interactive" : "background",
      agentTaskExecution
    });
    if (agentTaskExecution.blockedAuth) {
      const blocked = agentTaskExecution.blockedAuth;
      throwToolFailure({
        ok: false,
        status: "blocked_auth",
        error: blocked.error,
        resolution: blocked.resolution
      }, blocked.toolName);
    }
  }

  async function dispatchAgentEvent(task, chatId) {
    if (!task.payload?.prompt) throw new NonRetryableTaskError("agent_event missing prompt");
    logger?.log("tasks", `agent event ${task.id} for chat ${chatId}`);
    const acknowledgement = String(task.payload?.acknowledgement || "").trim();
    if (acknowledgement) {
      try {
        await sendMessage(chatId, acknowledgement);
      } catch (error) {
        logger?.log("telegram", `agent event acknowledgement failed for chat ${chatId}: ${errorMessage(error)}`);
      }
    }
    await enqueueAsyncPrompt({
      chatId,
      prompt: await buildAsyncEventPrompt(task, resourceNotes),
      label: `agent event ${task.id}`,
      route: task.route,
      timeoutMs: eventTimeoutMs,
      priority: task.source?.toolName === "process-retrospective" ? "background" : "interactive"
    });
  }

  async function dispatchPollTool(task, chatId) {
    const toolName = task.payload?.toolName;
    if (!toolName) throw new NonRetryableTaskError("poll_tool missing toolName");
    logger?.log("tasks", `polling tool ${toolName} (task ${task.id}) for chat ${chatId}`);

    const runTool = (args) => runHeadlessTool(toolName, chatId, args);

    if (task.authBlock) {
      const probe = await runTool(task.authBlock.probeArgs || {});
      if (probe?.ok === false) throwToolFailure(probe, toolName, task.authBlock);
      logger?.log("tasks", `authentication restored for ${toolName} (task ${task.id})`);
    }

    const result = await runTool(task.payload.args || {});
    if (result?.ok === false) throwToolFailure(result, toolName);
  }

  async function dispatchTask(task) {
    const chatId = requireChatId(task);
    if (task.kind === "agent_task") return dispatchAgentTask(task, chatId);
    if (task.kind === "agent_event") return dispatchAgentEvent(task, chatId);
    if (task.kind === "poll_tool") return dispatchPollTool(task, chatId);
    throw new NonRetryableTaskError(`Unsupported task: ${task.kind}`);
  }

  async function notifyTerminalFailure(details) {
    const destination = failureDestination(details.task);
    if (!destination.chatId) {
      logger?.log("tasks", `task ${details.task.id} has no Telegram failure-notification destination`);
      return;
    }
    const options = destination.threadId ? { message_thread_id: destination.threadId } : undefined;
    await sendMessage(destination.chatId, buildFailureNotice(details), options);
  }

  const runner = createTaskRunner({
    taskStore,
    dispatch: dispatchTask,
    laneKey(task) {
      if (task.kind === "poll_tool") {
        return `poll:${task.payload?.chatId}:${task.payload?.toolName || task.id}`;
      }
      const destination = task.route?.transport === "telegram" ? task.route.destination : null;
      if (!destination?.chatId || Number(destination.threadId) === 1) {
        return `agent:${task.payload?.chatId}`;
      }
      return `agent:${destination.chatId}:${destination.threadId || 0}`;
    },
    onTerminalFailure: notifyTerminalFailure,
    logger
  });
  return { dispatchTask, dispatchDueTasks: runner.dispatchDueTasks, runClaimedTask: runner.runClaimedTask };
}

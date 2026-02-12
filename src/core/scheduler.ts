/**
 * @module core/scheduler
 * @role Manage cron and one-time scheduled tasks using croner.
 * @responsibilities
 *   - Persist tasks to tasks.json, restore on startup
 *   - Execute tasks by processing through Claude, then sending result via Daemon
 *   - Schedule one-time (setTimeout) and recurring (croner) tasks
 * @dependencies croner, shared/config, shared/types
 * @effects Disk I/O (tasks.json), network (POST to Daemon), timers
 */

import { Cron } from "croner";
import { config } from "../shared/config";
import { createLogger } from "../shared/logger";
import { getTasks, updateTask, deleteTask, addTask as dbAddTask } from "../shared/db";
import { processWithClaude, flushChatQueue } from "./processor";
import type { ScheduledTask } from "../shared/types";

const log = createLogger("scheduler");

let tasks: ScheduledTask[] = [];
const activeJobs = new Map<string, Cron | ReturnType<typeof setTimeout>>();
const inFlight = new Set<string>(); // task IDs currently executing

async function loadTasks(): Promise<ScheduledTask[]> {
  try {
    return await getTasks();
  } catch (error) {
    log.error(`Failed to load tasks from db: ${error}`);
    return [];
  }
}

async function saveTask(task: ScheduledTask) {
  try {
    await updateTask(task.id, task);
  } catch (error) {
    log.error(`Failed to save task ${task.id}: ${error}`);
  }
}

async function executeTask(task: ScheduledTask) {
  // Skip if previous execution is still in-flight (prevents queue buildup)
  if (inFlight.has(task.id)) {
    log.info(`Skipping task ${task.id}: previous execution still in-flight`);
    return;
  }

  // Check task is still active (may have been cancelled)
  if (!tasks.includes(task)) return;

  log.info(`Executing task ${task.id}: ${task.message.substring(0, 60)}`);
  inFlight.add(task.id);
  try {
    // Process through Claude to get a real response (source:"task" = low priority)
    const result = await processWithClaude(task.message, task.chatId, "task");

    // Re-check: task may have been cancelled while Claude was processing
    if (!tasks.includes(task) || !result) return;

    // Send the processed result to Telegram via Daemon
    const response = await fetch("http://localhost/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: task.chatId,
        text: result,
      }),
      unix: config.daemonSocket,
    } as any);
    if (!response.ok) {
      log.error(`Daemon returned ${response.status} for task ${task.id}`);
    }
  } catch (error) {
    log.error(`Failed to execute task ${task.id}: ${error}`);
  } finally {
    inFlight.delete(task.id);
  }
}

function scheduleTask(task: ScheduledTask) {
  if (task.type === "once") {
    if (task.status === "done") return;
    const delay = (task.runAt || 0) - Date.now();
    if (delay <= 0) {
      executeTask(task).then(async () => {
        task.status = "done";
        task.lastRunAt = Date.now();
        await saveTask(task);
      });
      return;
    }
    const timer = setTimeout(() => {
      executeTask(task).then(async () => {
        task.status = "done";
        task.lastRunAt = Date.now();
        activeJobs.delete(task.id);
        await saveTask(task);
      });
    }, delay);
    activeJobs.set(task.id, timer);
    log.info(`Scheduled one-time task ${task.id} in ${Math.round(delay / 1000)}s`);
  } else if (task.type === "cron" && task.cron) {
    const job = new Cron(task.cron, async () => {
      task.lastRunAt = Date.now();
      await saveTask(task);
      executeTask(task);
    });
    activeJobs.set(task.id, job);
    log.info(`Scheduled cron task ${task.id}: ${task.cron}`);
  }
}

export async function initScheduler() {
  tasks = await loadTasks();
  log.info(`Loaded ${tasks.length} tasks`);

  // Clean old completed one-time tasks (> 7 days)
  const retentionMs = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const tasksToDelete: string[] = [];
  tasks = tasks.filter((t) => {
    if (t.type === "once" && t.status === "done") {
      const shouldKeep = now - (t.lastRunAt || t.runAt || now) < retentionMs;
      if (!shouldKeep) {
        tasksToDelete.push(t.id);
      }
      return shouldKeep;
    }
    return true;
  });

  // Delete old completed tasks from db
  for (const id of tasksToDelete) {
    await deleteTask(id);
  }

  const activeCron = tasks.filter((t) => t.type === "cron");
  if (activeCron.length > 0) {
    log.info(`Restoring ${activeCron.length} cron tasks: ${activeCron.map((t) => `"${t.message}" (${t.cron})`).join(", ")} — send /cancel to stop`);
  }

  for (const task of tasks) {
    scheduleTask(task);
  }
}

export async function addTask(task: ScheduledTask) {
  // Deduplicate: if a cron with the same message already exists for this chat, skip
  if (task.type === "cron") {
    const duplicate = tasks.find(
      (t) => t.chatId === task.chatId && t.type === "cron" && t.message === task.message,
    );
    if (duplicate) {
      log.info(`Skipping duplicate cron task for chat ${task.chatId}: "${task.message}"`);
      return;
    }
  }

  tasks.push(task);
  scheduleTask(task);
  await dbAddTask(task);
  log.info(`Added task ${task.id} (${task.type})`);
}

export async function cancelAllChatTasks(chatId: string): Promise<number> {
  let removed = 0;
  for (let i = tasks.length - 1; i >= 0; i -= 1) {
    const task = tasks[i];
    if (task.chatId !== chatId) continue;
    // Skip already-completed one-time tasks
    if (task.type === "once" && task.status === "done") continue;

    const job = activeJobs.get(task.id);
    if (job && "stop" in job && typeof job.stop === "function") {
      job.stop();
    } else if (job) {
      clearTimeout(job as ReturnType<typeof setTimeout>);
    }
    activeJobs.delete(task.id);
    inFlight.delete(task.id);
    await deleteTask(task.id);
    tasks.splice(i, 1);
    removed += 1;
  }

  // Flush any queued processWithClaude calls for this chat
  flushChatQueue(chatId);

  log.info(`Cancelled ${removed} tasks for chat ${chatId}`);
  return removed;
}

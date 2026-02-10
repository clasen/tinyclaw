/**
 * @module core/scheduler
 * @role Manage cron and one-time scheduled tasks using croner.
 * @responsibilities
 *   - Persist tasks to tasks.json, restore on startup
 *   - Execute tasks by POSTing to Daemon's /send endpoint
 *   - Schedule one-time (setTimeout) and recurring (croner) tasks
 * @dependencies croner, shared/config, shared/types
 * @effects Disk I/O (tasks.json), network (POST to Daemon), timers
 */

import { Cron } from "croner";
import { config } from "../shared/config";
import { createLogger } from "../shared/logger";
import { getTasks, updateTask, deleteTask, addTask as dbAddTask } from "../shared/db";
import type { ScheduledTask } from "../shared/types";

const log = createLogger("scheduler");

let tasks: ScheduledTask[] = [];
const activeJobs = new Map<string, Cron | ReturnType<typeof setTimeout>>();

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
  log.info(`Executing task ${task.id}: ${task.message.substring(0, 60)}`);
  try {
    const response = await fetch(`http://localhost:${config.daemonPort}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: task.chatId,
        text: task.message,
      }),
    });
    if (!response.ok) {
      log.error(`Daemon returned ${response.status} for task ${task.id}`);
    }
  } catch (error) {
    log.error(`Failed to send task ${task.id} to Daemon: ${error}`);
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

  // Delete old tasks from db
  for (const id of tasksToDelete) {
    await deleteTask(id);
  }

  for (const task of tasks) {
    scheduleTask(task);
  }
}

export async function addTask(task: ScheduledTask) {
  tasks.push(task);
  scheduleTask(task);
  await dbAddTask(task);
  log.info(`Added task ${task.id} (${task.type})`);
}

export async function cancelRecurringTasks(chatId: string): Promise<number> {
  let removed = 0;
  for (let i = tasks.length - 1; i >= 0; i -= 1) {
    const task = tasks[i];
    if (task.chatId === chatId && task.type === "cron" && task.origin === "recurring") {
      const job = activeJobs.get(task.id);
      if (job && "stop" in job && typeof job.stop === "function") {
        job.stop();
      } else if (job) {
        clearTimeout(job as ReturnType<typeof setTimeout>);
      }
      activeJobs.delete(task.id);
      await deleteTask(task.id);
      tasks.splice(i, 1);
      removed += 1;
    }
  }
  return removed;
}

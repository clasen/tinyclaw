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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { config } from "../shared/config";
import { createLogger } from "../shared/logger";
import type { ScheduledTask } from "../shared/types";

const log = createLogger("scheduler");

let tasks: ScheduledTask[] = [];
const activeJobs = new Map<string, Cron | ReturnType<typeof setTimeout>>();

function loadTasks(): ScheduledTask[] {
  if (!existsSync(config.tasksFile)) return [];
  try {
    const raw = readFileSync(config.tasksFile, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    log.error(`Failed to read tasks.json: ${error}`);
    return [];
  }
}

function saveTasks() {
  const dir = dirname(config.tasksFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = `${config.tasksFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(tasks, null, 2));
  const { renameSync } = require("fs");
  renameSync(tmp, config.tasksFile);
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
      executeTask(task).then(() => {
        task.status = "done";
        task.lastRunAt = Date.now();
        saveTasks();
      });
      return;
    }
    const timer = setTimeout(() => {
      executeTask(task).then(() => {
        task.status = "done";
        task.lastRunAt = Date.now();
        activeJobs.delete(task.id);
        saveTasks();
      });
    }, delay);
    activeJobs.set(task.id, timer);
    log.info(`Scheduled one-time task ${task.id} in ${Math.round(delay / 1000)}s`);
  } else if (task.type === "cron" && task.cron) {
    const job = new Cron(task.cron, () => {
      task.lastRunAt = Date.now();
      saveTasks();
      executeTask(task);
    });
    activeJobs.set(task.id, job);
    log.info(`Scheduled cron task ${task.id}: ${task.cron}`);
  }
}

export function initScheduler() {
  tasks = loadTasks();
  log.info(`Loaded ${tasks.length} tasks`);

  // Clean old completed one-time tasks (> 7 days)
  const retentionMs = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  tasks = tasks.filter((t) => {
    if (t.type === "once" && t.status === "done") {
      return now - (t.lastRunAt || t.runAt || now) < retentionMs;
    }
    return true;
  });

  for (const task of tasks) {
    scheduleTask(task);
  }

  saveTasks();
}

export function addTask(task: ScheduledTask) {
  tasks.push(task);
  scheduleTask(task);
  saveTasks();
  log.info(`Added task ${task.id} (${task.type})`);
}

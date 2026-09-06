import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramTaskDispatcher } from "../src/transport/telegram/task-dispatcher.js";

function createHarness(overrides = {}) {
  const calls = [];
  const taskStore = {
    async fail(...args) { calls.push(["fail", ...args]); return { status: "failed" }; },
    async complete(...args) { calls.push(["complete", ...args]); return { status: "done" }; },
    async blockAuth(taskId, error, resolution) {
      calls.push(["blockAuth", taskId, error.message, resolution]);
      return { status: "blocked_auth", authBlockedNew: true, authBlock: resolution, runAt: "2026-09-02T05:00:00.000Z" };
    },
    async retryOrFail(taskId, error, options) {
      calls.push(["retryOrFail", taskId, error.message, options]);
      return { status: options.retryable ? "pending" : "failed" };
    },
    async claimDue() { return []; },
    ...overrides.taskStore
  };
  const dispatcher = createTelegramTaskDispatcher({
    taskStore,
    sendMessage: async (...args) => calls.push(["send", ...args]),
    enqueueAsyncPrompt: async (input) => calls.push(["enqueue", input]),
    artifactStore: { forChat() { throw new Error("unexpected artifact access"); } },
    toolRegistry: {},
    resourceNotes: { async get() { return ""; } },
    agentManager: {
      async runTurn(options, work) { calls.push(["runTurn", options]); return work(); },
      async runTool(input) { calls.push(["runTool", input]); return { ok: true }; }
    },
    logger: null,
    ...overrides.dependencies
  });
  return { calls, taskStore, dispatcher };
}

test("confirms an agent task only after prompt execution resolves", async () => {
  let confirmExecution;
  const execution = new Promise((resolve) => { confirmExecution = resolve; });
  const { calls, dispatcher } = createHarness({
    dependencies: {
      enqueueAsyncPrompt: async (input) => {
        calls.push(["enqueue", input]);
        await execution;
      }
    }
  });
  const running = dispatcher.runClaimedTask({
    id: "task-1",
    kind: "agent_task",
    status: "running",
    payload: { chatId: 123, prompt: "do the thing" },
    route: { transport: "telegram", destination: { chatId: -1001, threadId: 9 } }
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0][0], "enqueue");
  assert.deepEqual(calls[0][1].route, { transport: "telegram", destination: { chatId: -1001, threadId: 9 } });
  assert.equal(calls[0][1].timeoutMs, 15 * 60_000);
  assert.equal(calls.some(([name]) => name === "complete"), false);
  confirmExecution();
  await running;
  assert.deepEqual(calls.at(-1), ["complete", "task-1"]);
});

test("passes bounded execution deadlines to scheduled prompts", async () => {
  const { calls, dispatcher } = createHarness({
    dependencies: { taskTimeouts: { agentTimeoutMs: 900, eventTimeoutMs: 300 } }
  });
  await dispatcher.runClaimedTask({
    id: "deadline-task",
    kind: "agent_task",
    payload: { chatId: 123, prompt: "work" }
  });
  await dispatcher.runClaimedTask({
    id: "deadline-event",
    kind: "agent_event",
    payload: { chatId: 123, prompt: "event" }
  });

  const enqueues = calls.filter(([name]) => name === "enqueue");
  assert.equal(enqueues[0][1].timeoutMs, 900);
  assert.equal(enqueues[0][1].priority, "background");
  assert.equal(enqueues[1][1].timeoutMs, 300);
  assert.equal(enqueues[1][1].priority, "interactive");
});

test("acknowledges an agent event before executing it", async () => {
  const { calls, dispatcher } = createHarness();
  await dispatcher.runClaimedTask({
    id: "event-1",
    kind: "agent_event",
    payload: { chatId: 123, prompt: "something happened", acknowledgement: "received" }
  });

  assert.deepEqual(calls[0], ["send", 123, "received"]);
  assert.equal(calls[1][0], "enqueue");
  assert.match(calls[1][1].prompt, /event: something happened/);
  assert.match(calls[1][1].prompt, /return exactly NO_REPLY/);
  assert.deepEqual(calls[2], ["complete", "event-1"]);
});

test("runs poll tools headlessly and confirms their result", async () => {
  const { calls, dispatcher } = createHarness();
  await dispatcher.runClaimedTask({
    id: "poll-1",
    kind: "poll_tool",
    payload: { chatId: 123, toolName: "checker", args: { cursor: "4" } }
  });

  assert.deepEqual(calls, [
    ["runTool", { name: "checker", request: { args: { cursor: "4" } }, chatId: 123 }],
    ["complete", "poll-1"]
  ]);
});

test("pauses a poll once when its tool reports terminal authentication failure", async () => {
  const resolution = {
    type: "reauthentication_required",
    retryAfterSeconds: 3600,
    probeArgs: { action: "auth-status" }
  };
  const { calls, dispatcher } = createHarness({
    dependencies: {
      agentManager: {
        async runTurn(options, work) { calls.push(["runTurn", options]); return work(); },
        async runTool(input) {
          calls.push(["runTool", input]);
          return { ok: false, status: "blocked_auth", error: "authentication expired", resolution };
        }
      }
    }
  });

  await dispatcher.runClaimedTask({
    id: "poll-auth",
    kind: "poll_tool",
    payload: { chatId: 123, toolName: "checker", args: { action: "poll" } }
  });

  assert.deepEqual(calls.at(-2), ["blockAuth", "poll-auth", "authentication expired", { ...resolution, toolName: "checker" }]);
  assert.deepEqual(calls.at(-1), [
    "send",
    123,
    "⚠️ Arisa automation paused for authentication\nTool: checker\nReason: authentication expired\nNext authentication check: 2026-09-02T05:00:00.000Z",
    undefined
  ]);
});

test("pauses a recurring agent task after a nested tool reports blocked authentication", async () => {
  const resolution = {
    type: "reauthentication_required",
    retryAfterSeconds: 3600,
    probeArgs: { action: "status" }
  };
  const { calls, dispatcher } = createHarness({
    dependencies: {
      enqueueAsyncPrompt: async (input) => {
        calls.push(["enqueue", input]);
        input.agentTaskExecution.blockedAuth = {
          toolName: "creator-scout",
          error: "authentication expired",
          resolution
        };
      }
    }
  });

  await dispatcher.runClaimedTask({
    id: "agent-auth",
    kind: "agent_task",
    payload: { chatId: 123, prompt: "run harvest" },
    recurrence: { type: "interval", everySeconds: 14400 }
  });

  assert.deepEqual(calls.at(-2), ["blockAuth", "agent-auth", "authentication expired", { ...resolution, toolName: "creator-scout" }]);
  assert.deepEqual(calls.at(-1), [
    "send",
    123,
    "⚠️ Arisa automation paused for authentication\nTool: creator-scout\nReason: authentication expired\nNext authentication check: 2026-09-02T05:00:00.000Z",
    undefined
  ]);
  assert.equal(calls.some(([name]) => name === "complete"), false);
});

test("probes a blocked agent task before starting another reasoning turn", async () => {
  const { calls, dispatcher } = createHarness();
  await dispatcher.runClaimedTask({
    id: "agent-resume",
    kind: "agent_task",
    authBlock: { toolName: "creator-scout", probeArgs: { action: "status" }, retryAfterSeconds: 3600 },
    payload: { chatId: 123, prompt: "run harvest" }
  });

  assert.deepEqual(calls[0], ["runTool", {
    name: "creator-scout",
    request: { args: { action: "status" } },
    chatId: 123
  }]);
  assert.equal(calls.filter(([name]) => name === "enqueue").length, 1);
  assert.deepEqual(calls.at(-1), ["complete", "agent-resume"]);
});

test("uses a lightweight auth probe before resuming blocked poll work", async () => {
  const { calls, dispatcher } = createHarness();
  await dispatcher.runClaimedTask({
    id: "poll-resume",
    kind: "poll_tool",
    authBlock: { probeArgs: { action: "auth-status" }, retryAfterSeconds: 3600 },
    payload: { chatId: 123, toolName: "checker", args: { action: "poll" } }
  });

  assert.deepEqual(calls.filter(([name]) => name === "runTool").map((call) => call[1].request.args), [
    { action: "auth-status" },
    { action: "poll" }
  ]);
  assert.deepEqual(calls.at(-1), ["complete", "poll-resume"]);
});

test("retries a known poll failure with backoff", async () => {
  const { calls, dispatcher } = createHarness({
    dependencies: {
      agentManager: {
        async runTurn(options, work) { calls.push(["runTurn", options]); return work(); },
        async runTool(input) {
          calls.push(["runTool", input]);
          return { ok: false, status: "failed", error: "temporary checker failure" };
        }
      }
    }
  });
  await dispatcher.runClaimedTask({
    id: "poll-failed",
    kind: "poll_tool",
    payload: { chatId: 123, toolName: "checker" }
  });

  assert.deepEqual(calls.at(-1), [
    "retryOrFail",
    "poll-failed",
    "temporary checker failure",
    { retryable: true }
  ]);
});

test("fails malformed tasks without retrying", async () => {
  const { calls, dispatcher } = createHarness();
  await dispatcher.runClaimedTask({ id: "bad-1", kind: "agent_task", payload: {} });
  await dispatcher.runClaimedTask({ id: "bad-2", kind: "other", payload: { chatId: 123 } });

  assert.deepEqual(calls, [
    ["retryOrFail", "bad-1", "Task missing chatId: agent_task", { retryable: false }],
    ["retryOrFail", "bad-2", "Unsupported task: other", { retryable: false }],
    ["send", 123, "⚠️ Arisa task failed\nTask: other (bad-2)\nError: Unsupported task: other\nNo further retries are scheduled.", undefined]
  ]);
});

test("notifies the routed Telegram topic once retries are exhausted", async () => {
  const { calls, dispatcher } = createHarness({
    taskStore: {
      async retryOrFail(taskId, error, options) {
        calls.push(["retryOrFail", taskId, error.message, options]);
        return {
          status: "pending",
          terminalFailure: true,
          runAt: "2026-08-21T00:00:00.000Z"
        };
      }
    },
    dependencies: {
      enqueueAsyncPrompt: async () => { throw new Error("token=very-secret-value queue unavailable"); }
    }
  });

  await dispatcher.runClaimedTask({
    id: "recurring-bad",
    kind: "agent_task",
    payload: { chatId: 123, prompt: "private payload must not appear" },
    route: { transport: "telegram", destination: { chatId: -1001, threadId: 87 } }
  });

  assert.deepEqual(calls.at(-1), [
    "send",
    -1001,
    "⚠️ Arisa task failed\nTask: agent_task (recurring-bad)\nError: token=[redacted] queue unavailable\nNext run: 2026-08-21T00:00:00.000Z",
    { message_thread_id: 87 }
  ]);
  assert.equal(calls.at(-1)[2].includes("private payload"), false);
});

test("serializes tasks within one destination while independent destinations continue", async () => {
  const tasks = [
    { id: "first", kind: "agent_task", payload: { chatId: 123, prompt: "first" }, route: { transport: "telegram", destination: { chatId: -1001, threadId: 87 } } },
    { id: "second", kind: "agent_task", payload: { chatId: 123, prompt: "second" }, route: { transport: "telegram", destination: { chatId: -1001, threadId: 87 } } },
    { id: "other", kind: "agent_task", payload: { chatId: 123, prompt: "other" }, route: { transport: "telegram", destination: { chatId: -1001, threadId: 23 } } }
  ];
  let releaseFirst;
  const firstExecution = new Promise((resolve) => { releaseFirst = resolve; });
  const { calls, dispatcher } = createHarness({
    taskStore: { async claimDue() { return tasks; } },
    dependencies: {
      enqueueAsyncPrompt: async (input) => {
        calls.push(["enqueue", input.label]);
        if (input.label.includes("first")) await firstExecution;
      }
    }
  });

  const dispatching = dispatcher.dispatchDueTasks();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.some((call) => call[0] === "enqueue" && call[1].includes("first")));
  assert.ok(calls.some((call) => call[0] === "enqueue" && call[1].includes("other")));
  assert.equal(calls.some((call) => call[0] === "enqueue" && call[1].includes("second")), false);

  releaseFirst();
  await dispatching;
  const enqueueOrder = calls.filter((call) => call[0] === "enqueue").map((call) => call[1]);
  assert.ok(enqueueOrder.indexOf("scheduled task first") < enqueueOrder.indexOf("scheduled task second"));
});

test("due-task dispatch retries one failure without blocking another task", async () => {
  const tasks = [
    { id: "bad", kind: "agent_task", payload: { chatId: 123, prompt: "fail" } },
    { id: "good", kind: "poll_tool", payload: { chatId: 123, toolName: "checker" } }
  ];
  const { calls, dispatcher } = createHarness({
    taskStore: { async claimDue(limit) { calls.push(["claimDue", limit]); return tasks; } },
    dependencies: {
      enqueueAsyncPrompt: async () => { throw new Error("queue unavailable"); }
    }
  });

  await dispatcher.dispatchDueTasks();

  assert.deepEqual(calls.slice(0, 2), [
    ["claimDue", 10],
    ["runTool", { name: "checker", request: { args: {} }, chatId: 123 }]
  ]);
  assert.ok(calls.some((call) => JSON.stringify(call) === JSON.stringify(["complete", "good"])));
  assert.ok(calls.some((call) => JSON.stringify(call) === JSON.stringify(["retryOrFail", "bad", "queue unavailable", { retryable: true }])));
});

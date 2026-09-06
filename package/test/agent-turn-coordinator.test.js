import assert from "node:assert/strict";
import test from "node:test";
import { AgentTurnCoordinator } from "../src/core/agent/agent-turn-coordinator.js";

test("interactive turns run before queued background turns without overlapping", async () => {
  const coordinator = new AgentTurnCoordinator();
  const releaseActive = await coordinator.acquire({ priority: "background", label: "active background" });
  let backgroundStarted = false;
  const background = coordinator.acquire({ priority: "background", label: "queued background" }).then((release) => {
    backgroundStarted = true;
    return release;
  });
  const interactive = coordinator.acquire({ priority: "interactive", label: "interactive" });

  releaseActive();
  const releaseInteractive = await interactive;
  assert.equal(backgroundStarted, false);
  assert.equal(coordinator.diagnostic().active.priority, "interactive");
  releaseInteractive();
  const releaseBackground = await background;
  assert.equal(backgroundStarted, true);
  releaseBackground();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.diagnostic().active, null);
  assert.equal(coordinator.diagnostic().completed, 3);
});

test("reserves a quiet window for interactive follow-ups before background work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 1_000;
  const coordinator = new AgentTurnCoordinator({
    config: { interactiveQuietMs: 100 },
    now: () => now
  });
  const releaseFirstInteractive = await coordinator.acquire({ priority: "interactive", label: "first" });
  releaseFirstInteractive();

  let backgroundStarted = false;
  const background = coordinator.acquire({ priority: "background", label: "background" }).then((release) => {
    backgroundStarted = true;
    return release;
  });
  assert.equal(backgroundStarted, false);

  now = 1_050;
  const releaseFollowUp = await coordinator.acquire({ priority: "interactive", label: "follow-up" });
  assert.equal(coordinator.diagnostic().active.label, "follow-up");
  releaseFollowUp();
  await Promise.resolve();
  assert.equal(backgroundStarted, false);

  now = 1_150;
  t.mock.timers.tick(100);
  const releaseBackground = await background;
  assert.equal(backgroundStarted, true);
  releaseBackground();
});

test("reports wait metrics separately for interactive and background turns", async () => {
  let now = 1_000;
  const coordinator = new AgentTurnCoordinator({ now: () => now });
  const releaseActive = await coordinator.acquire({ priority: "background" });
  const interactive = coordinator.acquire({ priority: "interactive" });
  now = 1_025;
  releaseActive();
  const releaseInteractive = await interactive;
  releaseInteractive();

  const diagnostic = coordinator.diagnostic();
  assert.equal(diagnostic.priorities.background.completed, 1);
  assert.equal(diagnostic.priorities.interactive.completed, 1);
  assert.equal(diagnostic.priorities.interactive.maxWaitMs, 25);
  assert.equal(diagnostic.priorities.interactive.averageWaitMs, 25);
});

test("background turns expire safely before execution when their queue TTL elapses", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const coordinator = new AgentTurnCoordinator();
  const releaseActive = await coordinator.acquire({ priority: "interactive", label: "active" });
  const expired = assert.rejects(
    coordinator.acquire({ priority: "background", label: "stale batch", queueTtlMs: 10 }),
    (error) => error.code === "AGENT_TURN_QUEUE_EXPIRED" && error.retryable === true && error.outcomeUncertain === false
  );
  t.mock.timers.tick(10);
  await expired;
  assert.equal(coordinator.diagnostic().expired, 1);
  releaseActive();
});

test("run releases exclusive admission after failures", async () => {
  const coordinator = new AgentTurnCoordinator();
  await assert.rejects(coordinator.run({ priority: "background" }, async () => { throw new Error("failed"); }), /failed/);
  const result = await coordinator.run({ priority: "interactive" }, async () => "ok");
  assert.equal(result, "ok");
  assert.equal(coordinator.diagnostic().completed, 2);
});

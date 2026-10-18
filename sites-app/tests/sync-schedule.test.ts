import assert from "node:assert/strict";
import test from "node:test";
import { startSyncSchedule } from "../desktop/sync-schedule";

test("stopping during a request prevents the old session from scheduling again", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: () => void;
  let calls = 0;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const stop = startSyncSchedule(async () => { calls++; await pending; }, () => 100);
  context.mock.timers.tick(100);
  assert.equal(calls, 1);
  stop();
  finish();
  await Promise.resolve();
  await Promise.resolve();
  context.mock.timers.tick(1000);
  assert.equal(calls, 1);
});

test("active schedule repeats after completion and cancels pending work on logout", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const stop = startSyncSchedule(async () => { calls++; }, () => 100);
  context.mock.timers.tick(100);
  await Promise.resolve();
  context.mock.timers.tick(100);
  assert.equal(calls, 2);
  await Promise.resolve();
  stop();
  context.mock.timers.tick(1000);
  assert.equal(calls, 2);
});

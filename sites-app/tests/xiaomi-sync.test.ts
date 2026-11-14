import assert from "node:assert/strict";
import test from "node:test";
import type { HealthRepository } from "../app/data/health-repository";
import { desktopApi } from "../desktop/integrationApi";
import { isXiaomiNightlySyncDue, pauseXiaomiForEditing, syncXiaomiHealth, xiaomiSyncBusy } from "../desktop/xiaomi-sync";
import type { XiaomiSnapshot } from "../app/xiaomi-health";

test("nightly sync runs once at Beijing 22:00 regardless of the computer timezone", () => {
  const earlier = "2026-10-26T18:28:02+08:00";
  assert.equal(isXiaomiNightlySyncDue(earlier, new Date("2026-10-26T21:59:59+08:00")), false);
  assert.equal(isXiaomiNightlySyncDue(earlier, new Date("2026-10-26T22:00:00+08:00")), true);
  const synced = "2026-10-26T22:00:00+08:00";
  assert.equal(isXiaomiNightlySyncDue(synced, new Date("2026-10-26T23:59:59+08:00")), false);
  assert.equal(isXiaomiNightlySyncDue(synced, new Date("2026-10-27T21:59:59+08:00")), false);
  assert.equal(isXiaomiNightlySyncDue(synced, new Date("2026-10-27T22:00:00+08:00")), true);
});

test("a missed nightly sync catches up once after reopening, including across a year boundary", () => {
  const earlier = "2026-12-31T18:00:00+08:00";
  assert.equal(isXiaomiNightlySyncDue(earlier, new Date("2027-01-01T08:00:00+08:00")), true);
  const caughtUp = "2027-01-01T08:00:00+08:00";
  assert.equal(isXiaomiNightlySyncDue(caughtUp, new Date("2027-01-01T09:00:00+08:00")), false);
  assert.equal(isXiaomiNightlySyncDue(caughtUp, new Date("2027-01-01T22:00:00+08:00")), true);
  assert.equal(isXiaomiNightlySyncDue("", new Date("2027-01-01T08:00:00+08:00")), true);
});

test("sync waits for an unsaved health form and does not start a cloud request", async () => {
  pauseXiaomiForEditing(true);
  try {
    await assert.rejects(() => syncXiaomiHealth({} as HealthRepository), /先保存/);
    assert.equal(xiaomiSyncBusy(), false);
  } finally { pauseXiaomiForEditing(false); }
});

test("editing that starts during a cloud request defers writes and duplicate requests are coalesced", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  const fetch = desktopApi.xiaomi.fetch;
  let release!: (value: XiaomiSnapshot) => void;
  let applied = 0, errors = 0;
  const previousAttempt = "2026-10-25T22:00:00+08:00";
  let lastAttemptAt = previousAttempt;
  desktopApi.xiaomi.fetch = () => new Promise(resolve => { release = resolve; });
  const repository = {
    getXiaomiSettings: async () => ({ lastAttemptAt }),
    saveXiaomiSettings: async (patch: {error?: string; lastAttemptAt?: string}) => {
      if (patch.error) errors += 1;
      if (patch.lastAttemptAt !== undefined) lastAttemptAt = patch.lastAttemptAt;
    },
    applyXiaomiSnapshot: async () => { applied += 1; return { days: 1, protectedDays: 0, deferredDays: 0 }; },
  } as unknown as HealthRepository;
  try {
    const first = syncXiaomiHealth(repository);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(xiaomiSyncBusy(), true);
    assert.equal(await syncXiaomiHealth(repository), null);
    pauseXiaomiForEditing(true);
    release({} as XiaomiSnapshot);
    await assert.rejects(() => first, /写入已暂缓/);
    assert.equal(applied, 0); assert.equal(errors, 1); assert.equal(xiaomiSyncBusy(), false);
    assert.equal(lastAttemptAt, previousAttempt);
  } finally {
    pauseXiaomiForEditing(false); desktopApi.xiaomi.fetch = fetch;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

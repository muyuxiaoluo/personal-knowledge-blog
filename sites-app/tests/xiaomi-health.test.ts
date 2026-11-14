import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HealthRepository } from "../app/data/health-repository";
import type { SqliteDatabase, SqliteStatement, SqliteValue } from "../app/data/sqlite-article-repository";
import { emptyHealthDailyLog } from "../app/health-types";
import { normalizeXiaomiSnapshot, type XiaomiSnapshot } from "../app/xiaomi-health";

class Adapter implements SqliteDatabase {
  beforeTransaction?: () => void;
  constructor(readonly db: DatabaseSync) {}
  async execute(sql: string, values: SqliteValue[] = []) { const result = this.db.prepare(sql).run(...values); return { rowsAffected: Number(result.changes) }; }
  async select<T>(sql: string, values: SqliteValue[] = []) { return this.db.prepare(sql).all(...values) as T[]; }
  async transaction(statements: SqliteStatement[]) {
    this.beforeTransaction?.(); this.beforeTransaction = undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try { for (const item of statements) await this.execute(item.sql, item.bindValues); this.db.exec("COMMIT"); }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
}
const seconds = (value: string) => Date.parse(value) / 1000;
function fixture(count = 1200, minutes = 450): XiaomiSnapshot {
  return { accountKey: "a".repeat(64), fromDate: "2026-10-19", toDate: "2026-10-25", fetchedAt: "2026-10-26T01:00:00Z",
    steps: [{ sid: "phone", time: seconds("2026-10-25T12:00:00+08:00"), update_time: 2, value: JSON.stringify({ steps: count }) }],
    sleep: [{ sid: "phone", time: seconds("2026-10-25T07:00:00+08:00"), value: JSON.stringify({ bedtime: seconds("2026-10-24T23:00:00+08:00"), device_wake_up_time: seconds("2026-10-25T07:00:00+08:00"), duration: minutes, sleep_awake_duration: 30, is_uncomplete: false }) }],
  };
}

test("Xiaomi normalizes minute durations, wake dates, duplicates and sparse days", () => {
  const snapshot = fixture();
  snapshot.steps.push(...snapshot.steps);
  const days = normalizeXiaomiSnapshot(snapshot);
  assert.equal(days.length, 1);
  assert.equal(days[0].steps, 1200);
  assert.deepEqual(days[0].sleep, { sleepMinutes: 450, sleepStart: "23:00", sleepEnd: "07:00", awakeMinutes: 30 });
  const zero = normalizeXiaomiSnapshot(fixture(0));
  assert.equal(zero[0].steps, 0);
  assert.equal(normalizeXiaomiSnapshot({ ...fixture(), steps: [], sleep: [] }).length, 0);
  assert.throws(() => normalizeXiaomiSnapshot(fixture(1, 450 * 60)), /数值或单位/);
});

test("Xiaomi avoids mixing sources and ignores incomplete sleep", () => {
  const snapshot = fixture();
  snapshot.steps.push({ sid: "watch", time: seconds("2026-10-25T12:00:00+08:00"), value: { steps: 20 } });
  assert.throws(() => normalizeXiaomiSnapshot(snapshot), /多个数据来源/);
  const unfinished = fixture();
  unfinished.sleep = [{ value: { is_uncomplete: true } }];
  assert.equal(normalizeXiaomiSnapshot(unfinished)[0].sleep, null);
});

test("Xiaomi preserves existing manual data and unrelated health fields", async () => {
  const db = new DatabaseSync(":memory:"), repo = new HealthRepository(new Adapter(db));
  await repo.saveDay({ ...emptyHealthDailyLog("2026-10-25"), steps: 800, sleepMinutes: 400, sleepStart: "23:30", sleepEnd: "07:10", note: "手动备注", weightKg: 60, energyLevel: 4 }, [{ date: "2026-10-25", slot: "breakfast", eatenAt: "08:00", description: "鸡蛋", updatedAt: "" }]);
  const result = await repo.applyXiaomiSnapshot(fixture());
  assert.equal(result.protectedDays, 1);
  const saved = await repo.getDaily("2026-10-25");
  assert.equal(saved.steps, 800); assert.equal(saved.sleepMinutes, 400);
  assert.equal(saved.note, "手动备注"); assert.equal(saved.weightKg, 60); assert.equal(saved.energyLevel, 4);
  assert.equal((await repo.listMeals("2026-10-25"))[0].description, "鸡蛋");
  assert.equal((await repo.getXiaomiDay("2026-10-25"))?.stepsLocked, true);
  const restored = await repo.restoreXiaomiDay("2026-10-25");
  assert.equal(restored.steps, 1200); assert.equal(restored.sleepMinutes, 450); assert.equal(restored.note, "手动备注");
  assert.equal((await repo.getXiaomiDay("2026-10-25"))?.stepsLocked, false);
  db.close();
});

test("Xiaomi refreshes automatic fields, preserves later corrections, and is idempotent", async () => {
  const db = new DatabaseSync(":memory:"), repo = new HealthRepository(new Adapter(db));
  await repo.applyXiaomiSnapshot(fixture());
  await repo.applyXiaomiSnapshot(fixture(1500, 460));
  assert.equal((await repo.getDaily("2026-10-25")).steps, 1500);
  const manual = await repo.getDaily("2026-10-25");
  await repo.saveDaily({ ...manual, steps: 1600, note: "保留", sleepMinutes: 455 });
  await repo.applyXiaomiSnapshot(fixture(1800, 470));
  await repo.applyXiaomiSnapshot(fixture(1800, 470));
  const saved = await repo.getDaily("2026-10-25");
  assert.equal(saved.steps, 1600); assert.equal(saved.sleepMinutes, 455); assert.equal(saved.note, "保留");
  assert.equal((await repo.listDaily()).length, 1);
  db.close();
});

test("editing only a note does not stop automatic source updates", async () => {
  const db = new DatabaseSync(":memory:"), repo = new HealthRepository(new Adapter(db));
  await repo.applyXiaomiSnapshot(fixture());
  await repo.saveDaily({ ...await repo.getDaily("2026-10-25"), note: "今天散步" });
  await repo.applyXiaomiSnapshot(fixture(1300));
  assert.equal((await repo.getDaily("2026-10-25")).steps, 1300);
  assert.equal((await repo.getDaily("2026-10-25")).note, "今天散步");
  db.close();
});

test("unchanged Xiaomi pulls do not rewrite health rows or create redundant sync journal changes", async () => {
  const db = new DatabaseSync(":memory:"), repo = new HealthRepository(new Adapter(db));
  await repo.applyXiaomiSnapshot(fixture());
  db.exec("CREATE TABLE write_count(value INTEGER); INSERT INTO write_count VALUES(0); CREATE TRIGGER count_health_changes AFTER UPDATE ON health_daily_logs BEGIN UPDATE write_count SET value=value+1; END");
  await repo.applyXiaomiSnapshot(fixture());
  assert.equal((db.prepare("SELECT value FROM write_count").get() as {value: number}).value, 0);
  assert.equal((await repo.getXiaomiDay("2026-10-25"))?.latest.steps, 1200);
  db.close();
});

test("Xiaomi transactions defer a concurrent field edit without advancing its provenance", async () => {
  const db = new DatabaseSync(":memory:"), adapter = new Adapter(db), repo = new HealthRepository(adapter);
  await repo.applyXiaomiSnapshot(fixture());
  adapter.beforeTransaction = () => { db.prepare("UPDATE health_daily_logs SET steps=7777 WHERE log_date='2026-10-25'").run(); };
  const result = await repo.applyXiaomiSnapshot(fixture(2000));
  assert.equal(result.deferredDays, 1);
  assert.equal((await repo.getDaily("2026-10-25")).steps, 7777);
  assert.equal((await repo.getXiaomiDay("2026-10-25"))?.latest.steps, 1200);
  db.close();
});

test("Xiaomi rolls back source data if provenance cannot be saved", async () => {
  const db = new DatabaseSync(":memory:"), repo = new HealthRepository(new Adapter(db));
  await repo.ready();
  db.exec("CREATE TRIGGER reject_source BEFORE INSERT ON health_xiaomi_days BEGIN SELECT RAISE(ABORT, 'source rejected'); END");
  await assert.rejects(() => repo.applyXiaomiSnapshot(fixture()), /source rejected/);
  assert.equal((await repo.listDaily()).length, 0);
  assert.equal((await repo.getXiaomiSettings()).lastSyncedAt, "");
  db.close();
});

test("adopting Xiaomi values preserves a concurrent unrelated note edit", async () => {
  const db = new DatabaseSync(":memory:"), adapter = new Adapter(db), repo = new HealthRepository(adapter);
  await repo.applyXiaomiSnapshot(fixture());
  await repo.saveDaily({ ...await repo.getDaily("2026-10-25"), steps: 1500, note: "旧备注" });
  adapter.beforeTransaction = () => { db.prepare("UPDATE health_daily_logs SET note='新备注' WHERE log_date='2026-10-25'").run(); };
  const restored = await repo.restoreXiaomiDay("2026-10-25");
  assert.equal(restored.steps, 1200);
  assert.equal(restored.note, "新备注");
  db.close();
});

test("switching Xiaomi accounts preserves the previously imported data", async () => {
  const db = new DatabaseSync(":memory:"), repo = new HealthRepository(new Adapter(db));
  await repo.applyXiaomiSnapshot(fixture());
  await repo.applyXiaomiSnapshot({ ...fixture(9000, 470), accountKey: "b".repeat(64) });
  assert.equal((await repo.getDaily("2026-10-25")).steps, 1200);
  assert.equal((await repo.getDaily("2026-10-25")).sleepMinutes, 450);
  db.close();
});

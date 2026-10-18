import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { HealthRepository, saveHealthDay } from "../app/data/health-repository";
import { emptyHealthDailyLog, emptyHealthProfile } from "../app/health-types";
import type { SqliteDatabase, SqliteExecuteResult, SqliteValue } from "../app/data/sqlite-article-repository";

class NodeSqliteAdapter implements SqliteDatabase {
  constructor(private readonly database: DatabaseSync) {}
  async execute(sql: string, bindValues: SqliteValue[] = []): Promise<SqliteExecuteResult> {
    const result = this.database.prepare(sql).run(...bindValues as Array<string | number | null>);
    return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
  }
  async select<T>(sql: string, bindValues: SqliteValue[] = []): Promise<T[]> {
    return this.database.prepare(sql).all(...bindValues as Array<string | number | null>) as T[];
  }
}

test("persists a private health profile and daily manual records", async () => {
  const database = new DatabaseSync(":memory:");
  let now = new Date("2026-08-31T01:00:00Z");
  const repository = new HealthRepository(new NodeSqliteAdapter(database), () => now);
  assert.deepEqual(await repository.getProfile(), emptyHealthProfile);

  const profile = await repository.saveProfile({
    ...emptyHealthProfile,
    age: 28,
    sex: "female",
    heightCm: 165,
    currentWeightKg: 60,
    targetWeightKg: 55,
    targetDate: "2026-12-31",
    dietPreferences: "家常菜",
    avoidFoods: "太辣",
    allergies: "花生",
  });
  assert.equal(profile.updatedAt, "2026-08-31T01:00:00.000Z");
  assert.equal((await repository.getProfile()).allergies, "花生");

  const daily = await repository.saveDaily({
    ...emptyHealthDailyLog("2026-08-31"),
    sleepMinutes: 445,
    sleepStart: "23:30",
    sleepEnd: "07:15",
    awakeMinutes: 10,
    sleepQuality: 4,
    energyLevel: 4,
    steps: 8_234,
    weightKg: 59.8,
    activityMinutes: 20,
    activityNote: "晚饭后散步",
  });
  assert.equal(daily.steps, 8_234);
  assert.equal((await repository.getDaily("2026-08-31")).sleepMinutes, 445);
  assert.equal((await repository.getDaily("2026-08-31")).awakeMinutes, 10);

  now = new Date("2026-08-31T02:00:00Z");
  const updated = await repository.saveDaily({ ...daily, steps: 9_000 });
  assert.equal(updated.createdAt, daily.createdAt);
  assert.equal(updated.updatedAt, "2026-08-31T02:00:00.000Z");
  assert.equal((await repository.listDaily())[0]?.steps, 9_000);
  database.close();
});

test("updates an already-saved day through a repository instance from before saveDay was added", async () => {
  const database = new DatabaseSync(":memory:");
  let now = new Date("2026-08-31T01:00:00Z");
  const repository = new HealthRepository(new NodeSqliteAdapter(database), () => now);
  const legacyRepository = repository as HealthRepository & { saveDay?: HealthRepository["saveDay"] };
  Object.defineProperty(legacyRepository, "saveDay", { value: undefined });

  const first = await saveHealthDay(legacyRepository, emptyHealthDailyLog("2026-08-31"), []);
  now = new Date("2026-08-31T12:00:00Z");
  const updated = await saveHealthDay(legacyRepository, { ...first.daily, steps: 8_500 }, []);

  assert.equal(updated.daily.steps, 8_500);
  assert.equal(updated.daily.createdAt, first.daily.createdAt);
  assert.equal((await repository.getDaily("2026-08-31")).steps, 8_500);
  database.close();
});

test("upserts meals and removes an emptied meal slot", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new HealthRepository(new NodeSqliteAdapter(database), () => new Date("2026-08-31T01:00:00Z"));
  await repository.saveMeal({ date: "2026-08-31", slot: "breakfast", eatenAt: "08:00", description: "  鸡蛋和牛奶  ", updatedAt: "" });
  assert.equal((await repository.listMeals("2026-08-31"))[0]?.description, "鸡蛋和牛奶");
  await repository.saveMeal({ date: "2026-08-31", slot: "breakfast", eatenAt: "", description: "", updatedAt: "" });
  assert.equal((await repository.listMeals("2026-08-31")).length, 0);
  database.close();
});

test("rolls back the whole day when one meal cannot be saved", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new HealthRepository(new NodeSqliteAdapter(database), () => new Date("2026-08-31T01:00:00Z"));
  await repository.ready();
  database.exec(`CREATE TRIGGER reject_lunch BEFORE INSERT ON health_meals
    WHEN NEW.slot = 'lunch' BEGIN SELECT RAISE(ABORT, 'lunch rejected'); END`);

  await assert.rejects(() => repository.saveDay(
    { ...emptyHealthDailyLog("2026-08-31"), steps: 8_000 },
    [
      { date: "2026-08-31", slot: "breakfast", eatenAt: "08:00", description: "鸡蛋", updatedAt: "" },
      { date: "2026-08-31", slot: "lunch", eatenAt: "12:00", description: "米饭", updatedAt: "" },
    ],
  ), /lunch rejected/);
  assert.equal((await repository.getDaily("2026-08-31")).updatedAt, "");
  assert.equal((await repository.listMeals("2026-08-31")).length, 0);
  database.close();
});

test("stores the latest AI report for each day", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new HealthRepository(new NodeSqliteAdapter(database), () => new Date("2026-08-31T01:00:00Z"));
  await repository.saveReport({ date: "2026-08-31", content: "第一版建议", generatedAt: "" });
  await repository.saveReport({ date: "2026-08-31", content: "更新后的建议", generatedAt: "2026-08-31T02:00:00Z" });
  assert.equal((await repository.getReport("2026-08-31"))?.content, "更新后的建议");
  database.close();
});

test("rejects incomplete sleep intervals and invalid profile values", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new HealthRepository(new NodeSqliteAdapter(database));
  await assert.rejects(() => repository.saveDaily({ ...emptyHealthDailyLog("2026-08-31"), sleepStart: "23:00" }), /一起填写/);
  await assert.rejects(() => repository.saveProfile({ ...emptyHealthProfile, age: 12 }), /年龄/);
  await assert.rejects(() => repository.getDaily("2026-02-30"), /日期/);
  database.close();
});

test("upgrades legacy health rows and keeps unknown awake time distinct from zero", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE health_daily_logs (
    log_date TEXT PRIMARY KEY NOT NULL,
    sleep_start TEXT NOT NULL DEFAULT '', sleep_end TEXT NOT NULL DEFAULT '',
    awake_minutes INTEGER NOT NULL DEFAULT 0, sleep_quality INTEGER, energy_level INTEGER,
    steps INTEGER, weight_kg REAL, activity_minutes INTEGER, activity_note TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  INSERT INTO health_daily_logs VALUES ('2026-08-30', '23:00', '07:00', 0, NULL, NULL, NULL, NULL, NULL, '', '', 'now', 'now');`);
  const repository = new HealthRepository(new NodeSqliteAdapter(database));
  const legacy = await repository.getDaily("2026-08-30");
  assert.equal(legacy.sleepMinutes, null);
  assert.equal(legacy.awakeMinutes, null);
  const saved = await repository.saveDaily({ ...legacy, sleepMinutes: 450, awakeMinutes: 0 });
  assert.equal((await repository.getDaily(saved.date)).awakeMinutes, 0);
  database.close();
});

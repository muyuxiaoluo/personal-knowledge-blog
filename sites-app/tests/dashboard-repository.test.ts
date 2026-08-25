import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DashboardRepository } from "../app/data/dashboard-repository";
import { SqliteArticleRepository, type SqliteDatabase, type SqliteExecuteResult, type SqliteValue } from "../app/data/sqlite-article-repository";

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

test("persists dashboard preferences and cached provider data", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new DashboardRepository(new NodeSqliteAdapter(database), () => new Date("2026-08-24T01:00:00Z"));
  const defaults = await repository.getPreferences();
  assert.equal(defaults.location, null);
  assert.equal(defaults.modules.aiHot, true);

  await repository.savePreferences({
    ...defaults,
    location: { name: "武侯区", admin1: "四川", admin2: "成都市", admin3: "武侯区", country: "中国", latitude: 30.64, longitude: 104.04, timezone: "Asia/Shanghai" },
    aiHighlightKeywords: ["新模型", "模型发布"],
    modules: { ...defaults.modules, morningBrief: false },
  });
  assert.equal((await repository.getPreferences()).location?.name, "武侯区");
  assert.equal((await repository.getPreferences()).location?.admin2, "成都市");
  assert.deepEqual((await repository.getPreferences()).aiHighlightKeywords, ["新模型", "模型发布"]);
  assert.equal((await repository.getPreferences()).modules.morningBrief, false);

  await repository.saveCache("weather", { temperature: 28 }, "etag-1", "2026-08-24T01:00:00Z", 2700);
  const cached = await repository.getCache<{ temperature: number }>("weather");
  assert.equal(cached?.value.temperature, 28);
  assert.equal(cached?.expiresAt, "2026-08-24T01:45:00.000Z");
  await repository.touchCache("weather", "2026-08-24T02:00:00Z", 2700);
  assert.equal((await repository.getCache("weather"))?.expiresAt, "2026-08-24T02:45:00.000Z");
  database.close();
});

test("adds district columns to preferences created by an earlier dashboard version", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE dashboard_preferences (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), city_name TEXT NOT NULL DEFAULT '',
    admin1 TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', latitude REAL, longitude REAL,
    timezone TEXT NOT NULL DEFAULT '', weather_enabled INTEGER NOT NULL DEFAULT 1,
    calendar_enabled INTEGER NOT NULL DEFAULT 1, ai_hot_enabled INTEGER NOT NULL DEFAULT 1,
    morning_brief_enabled INTEGER NOT NULL DEFAULT 1
  )`);
  const repository = new DashboardRepository(new NodeSqliteAdapter(database));
  const preferences = await repository.getPreferences();
  await repository.savePreferences({
    ...preferences,
    location: { name: "武侯区", admin1: "四川", admin2: "成都市", admin3: "武侯区", country: "中国", latitude: 30.64, longitude: 104.04, timezone: "Asia/Shanghai" },
    aiHighlightKeywords: ["新模型"],
  });
  const columns = database.prepare("PRAGMA table_info(dashboard_preferences)").all() as Array<{ name: string }>;
  assert.equal(columns.some((column) => column.name === "admin2"), true);
  assert.equal(columns.some((column) => column.name === "ai_highlight_keywords"), true);
  assert.equal((await repository.getPreferences()).location?.admin2, "成都市");
  assert.deepEqual((await repository.getPreferences()).aiHighlightKeywords, ["新模型"]);
  database.close();
});

test("creates, updates and deletes local calendar events", async () => {
  const database = new DatabaseSync(":memory:");
  let now = new Date("2026-08-24T01:00:00Z");
  const repository = new DashboardRepository(new NodeSqliteAdapter(database), () => now);
  const saved = await repository.saveEvent({
    id: "",
    title: "  家人生日  ",
    date: "",
    recurrence: "yearlyLunar",
    lunarMonth: 8,
    lunarDay: 15,
    lunarLeapMonth: false,
    important: true,
    color: "#c87557",
    reminderDays: 7,
    notes: "  提前准备礼物  ",
    createdAt: "",
    updatedAt: "",
  });
  assert.equal(saved.title, "家人生日");
  assert.equal((await repository.listEvents())[0]?.notes, "提前准备礼物");

  now = new Date("2026-08-25T01:00:00Z");
  await repository.saveEvent({ ...saved, title: "家人农历生日" });
  assert.equal((await repository.listEvents())[0]?.title, "家人农历生日");
  await repository.deleteEvent(saved.id);
  assert.equal((await repository.listEvents()).length, 0);
  database.close();
});

test("rejects invalid calendar dates instead of rolling them into another month", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new DashboardRepository(new NodeSqliteAdapter(database), () => new Date("2026-08-24T01:00:00Z"));
  await assert.rejects(() => repository.saveEvent({
    id: "",
    title: "无效日期",
    date: "2026-02-30",
    recurrence: "once",
    lunarMonth: null,
    lunarDay: null,
    lunarLeapMonth: false,
    important: true,
    color: "#c87557",
    reminderDays: 3,
    notes: "",
    createdAt: "",
    updatedAt: "",
  }), /有效日期/);
  database.close();
});

test("includes dashboard preferences and calendar events in a full database backup", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-backup-"));
  const sourcePath = path.join(directory, "source.sqlite3");
  const backupPath = path.join(directory, "backup.sqlite3");
  const restoredPath = path.join(directory, "restored.sqlite3");
  try {
    const database = new DatabaseSync(sourcePath);
    const adapter = new NodeSqliteAdapter(database);
    const dashboard = new DashboardRepository(adapter, () => new Date("2026-08-24T01:00:00Z"));
    const articles = new SqliteArticleRepository(adapter, { deviceId: "backup-test", seedArticles: [] });
    const preferences = await dashboard.getPreferences();
    await dashboard.savePreferences({
      ...preferences,
      location: { name: "成都", admin1: "四川", country: "中国", latitude: 30.67, longitude: 104.07, timezone: "Asia/Shanghai" },
    });
    await dashboard.saveEvent({
      id: "event-backup",
      title: "备份里的重要日期",
      date: "2026-10-01",
      recurrence: "once",
      lunarMonth: null,
      lunarDay: null,
      lunarLeapMonth: false,
      important: true,
      color: "#c87557",
      reminderDays: 5,
      notes: "",
      createdAt: "",
      updatedAt: "",
    });
    await articles.createBackup(backupPath);
    database.close();

    fs.copyFileSync(backupPath, restoredPath);
    const restored = new DatabaseSync(restoredPath, { readOnly: true });
    assert.equal(restored.prepare("SELECT city_name FROM dashboard_preferences WHERE id = 1").get().city_name, "成都");
    assert.equal(restored.prepare("SELECT title FROM calendar_events WHERE id = 'event-backup'").get().title, "备份里的重要日期");
    restored.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

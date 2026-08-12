import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteWorkRepository } from "../app/data/sqlite-work-repository";
import type {
  SqliteDatabase,
  SqliteExecuteResult,
  SqliteValue,
} from "../app/data/sqlite-article-repository";

class NodeSqliteAdapter implements SqliteDatabase {
  private readonly database = new DatabaseSync(":memory:");

  async execute(sql: string, bindValues: SqliteValue[] = []): Promise<SqliteExecuteResult> {
    const result = this.database.prepare(sql).run(...bindValues as Array<string | number | null>);
    return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
  }

  async select<T>(sql: string, bindValues: SqliteValue[] = []): Promise<T[]> {
    return this.database.prepare(sql).all(...bindValues as Array<string | number | null>) as T[];
  }
}

test("plans tasks and records a completed focus session", async () => {
  let now = new Date("2026-08-11T01:00:00.000Z");
  const repository = new SqliteWorkRepository(new NodeSqliteAdapter(), () => now);

  const plan = await repository.savePlan({
    taskId: "task-1",
    plannedDate: "2026-08-11",
    priority: "high",
    estimateMinutes: 45,
    sortOrder: 0,
    updatedAt: "",
  });
  assert.equal(plan.priority, "high");
  assert.equal((await repository.listPlans())[0]?.estimateMinutes, 45);
  await repository.removePlan("task-1");
  assert.equal((await repository.listPlans()).length, 0);

  await repository.savePlan(plan);

  const started = await repository.startSession({
    taskId: "task-1",
    projectId: "project-1",
    label: "验证首页任务",
  });
  assert.equal((await repository.getActiveSession())?.id, started.id);

  now = new Date("2026-08-11T01:25:00.000Z");
  const stopped = await repository.stopSession(started.id);
  assert.equal(stopped.durationSeconds, 1500);
  assert.equal(await repository.getActiveSession(), null);
  assert.equal((await repository.listSessions())[0]?.label, "验证首页任务");
});

test("persists weekly focus and daily closeout", async () => {
  const repository = new SqliteWorkRepository(
    new NodeSqliteAdapter(),
    () => new Date("2026-08-13T13:00:00.000Z"),
  );

  await repository.saveWeeklyFocus({
    weekStart: "2026-08-10",
    primaryOutcome: "完成 v0.4 正式版",
    secondaryOutcome: "验证备份恢复",
    updatedAt: "",
  });
  assert.equal((await repository.getWeeklyFocus("2026-08-10"))?.primaryOutcome, "完成 v0.4 正式版");

  await repository.saveDailyCloseout({
    date: "2026-08-13",
    result: "补齐基础闭环",
    lesson: "先保证数据一致性",
    tomorrow: "连续使用验证",
    updatedAt: "",
  });
  const closeouts = await repository.listDailyCloseouts("2026-08-10");
  assert.equal(closeouts.length, 1);
  assert.equal(closeouts[0]?.tomorrow, "连续使用验证");
});

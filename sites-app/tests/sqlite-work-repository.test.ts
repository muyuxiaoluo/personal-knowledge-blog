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
  await assert.rejects(
    () => repository.startSession({ label: "不能同时开始的第二项专注" }),
    /已经有一项专注正在进行/,
  );

  now = new Date("2026-08-11T01:25:00.000Z");
  const stopped = await repository.stopSession(started.id);
  assert.equal(stopped.durationSeconds, 1500);
  assert.equal(await repository.getActiveSession(), null);
  assert.equal((await repository.listSessions())[0]?.label, "验证首页任务");
});

test("can repair an unfinished focus session with an explicit end time", async () => {
  let now = new Date("2026-08-11T02:00:00.000Z");
  const repository = new SqliteWorkRepository(
    new NodeSqliteAdapter(),
    () => now,
  );
  const started = await repository.startSession({ label: "上次未结束的投入" });
  now = new Date("2026-08-11T03:00:00.000Z");
  const stopped = await repository.stopSession({
    id: started.id,
    endedAt: "2026-08-11T02:25:00.000Z",
  });
  assert.equal(stopped.durationSeconds, 1500);
  assert.equal(stopped.endedAt, "2026-08-11T02:25:00.000Z");
  await assert.rejects(
    async () => {
      const next = await repository.startSession({ label: "无效结束时间" });
      await repository.stopSession({ id: next.id, endedAt: "2026-08-11T01:59:00.000Z" });
    },
    /结束时间不能早于开始时间/,
  );
});

test("persists weekly focus, weekly calibration, and legacy daily closeout", async () => {
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

  await repository.saveWeeklyReview({
    weekStart: "2026-08-10",
    outcomeStatus: "partial",
    factor: "scope",
    factorNote: " 低估了收尾范围 ",
    nextStrategy: "narrow",
    adjustment: " 下周只保留发布主线 ",
    updatedAt: "",
  });
  const review = await repository.getWeeklyReview("2026-08-10");
  assert.equal(review?.outcomeStatus, "partial");
  assert.equal(review?.factorNote, "低估了收尾范围");
  assert.equal(review?.nextStrategy, "narrow");
  assert.equal(review?.adjustment, "下周只保留发布主线");

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

test("repairs completed focus records, recalculates duration and guards active records", async () => {
  let now = new Date("2026-08-11T01:00:00Z");
  const repository = new SqliteWorkRepository(new NodeSqliteAdapter(), () => now);
  const session = await repository.startSession({ taskId: "repair-task", label: "实际投入" });
  now = new Date("2026-08-11T04:00:00Z");
  await assert.rejects(() => repository.updateSession({ id: session.id, startedAt: session.startedAt, endedAt: "2026-08-11T02:00:00Z" }), /请先暂停/);
  await assert.rejects(() => repository.deleteSession(session.id), /仍在投入中/);
  assert.equal((await repository.getActiveSession())?.id, session.id);
  await repository.stopSession(session.id);
  const repaired = await repository.updateSession({ id: session.id, startedAt: "2026-08-11T01:10:00Z", endedAt: "2026-08-11T01:40:00Z" });
  assert.equal(repaired.durationSeconds, 1800);
  assert.equal(repaired.taskId, "repair-task");
  assert.equal((await repository.listSessions())[0].durationSeconds, 1800);
  for (const endedAt of ["2026-08-11T01:09:00Z", "2026-08-11T01:10:00Z", "2026-08-11T04:01:00Z", "invalid"]) {
    await assert.rejects(() => repository.updateSession({ id: session.id, startedAt: repaired.startedAt, endedAt }), /结束时间必须/);
  }
  assert.equal((await repository.listSessions())[0].durationSeconds, 1800);
  await repository.deleteSession(session.id);
  assert.deepEqual(await repository.listSessions(), []);
  await assert.rejects(() => repository.updateSession({ id: session.id, startedAt: repaired.startedAt, endedAt: repaired.endedAt! }), /没有找到/);
});

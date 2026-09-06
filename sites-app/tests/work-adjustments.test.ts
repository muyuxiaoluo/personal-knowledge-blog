import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteWorkRepository } from "../app/data/sqlite-work-repository";
import { SqliteProjectRepository } from "../app/data/sqlite-project-repository";
import { UniversalSyncRepository } from "../app/data/universal-sync-repository";
import type { SqliteDatabase, SqliteValue } from "../app/data/sqlite-article-repository";
import type { DailySituation, SituationPlanChange, TaskPlan } from "../app/work-types";
import { buildActivityDays } from "../app/activity-helpers";
import { isContinuablePlan, isValidDay } from "../app/action-planning";

class Adapter implements SqliteDatabase {
  readonly db = new DatabaseSync(":memory:");
  async execute(sql: string, values: SqliteValue[] = []) {
    const result = this.db.prepare(sql).run(...values);
    return { rowsAffected: Number(result.changes) };
  }
  async select<T>(sql: string, values: SqliteValue[] = []): Promise<T[]> { return this.db.prepare(sql).all(...values) as T[]; }
}
const now = "2026-09-05T12:00:00.000Z";
const plan = (taskId: string, date = "2026-09-04"): TaskPlan => ({ taskId, plannedDate: date, priority: "normal", estimateMinutes: 0, sortOrder: 0, updatedAt: "" });
const situation = (ids = ["reading"], date = "2026-09-04"): DailySituation => ({ date, reason: "临时协助实验", actualWork: "样品测量", tasks: ids.map((taskId) => ({ taskId, title: taskId, outcome: "not_started", progress: "" })), updatedAt: "" });
async function setup() {
  const adapter = new Adapter();
  const projects = new SqliteProjectRepository(adapter);
  await projects.ready();
  const work = new SqliteWorkRepository(adapter, () => new Date(now));
  await work.ready();
  async function task(id: string) {
    return projects.saveTask({ id, projectId: null, milestoneId: null, direction: "learning", title: "读论文", actionType: "read", definitionOfDone: "读懂方法", steps: [], currentFocus: "从方法部分开始", details: "", benefit: "", dueDate: "", status: "next", waitingFor: "", resumeAction: "", context: "anywhere", sortOrder: 0, createdAt: now, updatedAt: now, completedAt: null });
  }
  return { adapter, projects, work, task };
}

test("keeps first historical title and starting point through moving, hiding and deleting actions", async () => {
  const { adapter, projects, work, task } = await setup();
  try {
    const original = await task("reading");
    await work.savePlan(plan(original.id));
    await projects.saveTask({ ...original, title: "新的行动名", currentFocus: "新的起点" });
    await work.savePlan(plan(original.id, "2026-09-05"));
    await work.removePlan(original.id);
    await projects.removeTask(original.id);
    const history = await work.listPlanHistory();
    assert.equal(history.length, 2);
    assert.equal(history.find((item) => item.plannedDate === "2026-09-04")?.taskTitle, "读论文");
    assert.equal(history.find((item) => item.plannedDate === "2026-09-04")?.currentFocus, "从方法部分开始");
    assert.equal((await work.listPlans()).length, 0);
  } finally { adapter.db.close(); }
});

test("supplements the occurrence date without fabricating progress, and leaves the task ready to continue", async () => {
  const { adapter, work, projects, task } = await setup();
  try {
    const original = await task("reading");
    const savedPlan = await work.savePlan(plan(original.id));
    await work.saveDailySituation(situation(), [{ taskId: original.id, expectedPlan: savedPlan, plannedDate: "" }]);
    const recorded = (await work.listDailySituations())[0];
    assert.equal(recorded.date, "2026-09-04");
    assert.equal(recorded.updatedAt, now);
    assert.equal((await work.listPlans())[0].plannedDate, "");
    assert.equal(isContinuablePlan((await work.listPlans())[0], "2026-09-05"), true);
    const after = (await projects.listStandaloneTasks()).find((item) => item.id === original.id)!;
    assert.equal(after.status, original.status);
    assert.equal(after.currentFocus, original.currentFocus);
    assert.equal(after.completedAt, null);
    const activity = buildActivityDays({ tasks: [], notes: [], focusSessions: [], restDays: [], situations: [recorded] });
    assert.equal(activity.get("2026-09-04")?.intensity, 0);
    assert.equal(activity.get("2026-09-04")?.situation?.actualWork, "样品测量");
    assert.equal(activity.has("2026-09-05"), false);
    await work.saveDailySituation({ ...recorded, reason: "补充说明" });
    assert.equal((await work.listDailySituations()).length, 1);
  } finally { adapter.db.close(); }
});

test("retrospective updates protect completed, rescheduled, concurrently edited and active tasks", async () => {
  const { adapter, work, projects, task } = await setup();
  try {
    const ids = ["done", "future", "stale", "active", "safe"];
    const changes: SituationPlanChange[] = [];
    for (const id of ids) {
      await task(id);
      changes.push({ taskId: id, expectedPlan: await work.savePlan(plan(id)), plannedDate: "" });
    }
    await projects.updateTaskStatus("done", "done");
    await work.savePlan(plan("future", "2026-09-07"));
    await adapter.execute("UPDATE task_plans SET updated_at = 'newer' WHERE task_id = 'stale'");
    await work.startSession({ taskId: "active", label: "正在投入" });
    await work.saveDailySituation(situation(ids), changes);
    const plans = await work.listPlans();
    assert.equal(plans.find((item) => item.taskId === "done")?.plannedDate, "2026-09-04");
    assert.equal(plans.find((item) => item.taskId === "future")?.plannedDate, "2026-09-07");
    assert.equal(plans.find((item) => item.taskId === "stale")?.updatedAt, "newer");
    assert.equal(plans.find((item) => item.taskId === "active")?.plannedDate, "2026-09-04");
    assert.equal(plans.find((item) => item.taskId === "safe")?.plannedDate, "");
    assert.equal((await work.listDailySituations())[0].tasks.length, 5);
  } finally { adapter.db.close(); }
});

test("validates past dates and partial progress; rolls back the entire supplement if rescheduling fails", async () => {
  const { adapter, work, task } = await setup();
  try {
    assert.equal(isValidDay("2026-02-30"), false);
    await assert.rejects(work.saveDailySituation(situation([], "2026-02-30")));
    await assert.rejects(work.saveDailySituation(situation([], "2026-09-06")));
    await assert.rejects(work.saveDailySituation({ ...situation(), tasks: [{ taskId: "reading", title: "读论文", outcome: "partial", progress: "" }] }));
    await task("reading");
    const expectedPlan = await work.savePlan(plan("reading"));
    await adapter.execute("CREATE TRIGGER reject_plan BEFORE UPDATE ON task_plans BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
    await assert.rejects(work.saveDailySituation(situation(), [{ taskId: "reading", expectedPlan, plannedDate: "" }]), /simulated failure/);
    assert.equal((await work.listDailySituations()).length, 0);
    assert.equal((await work.listPlans())[0].plannedDate, "2026-09-04");
  } finally { adapter.db.close(); }
});

test("sync round-trips dated situations, history and undated continuation plans", async () => {
  const source = await setup(); const target = await setup();
  try {
    const sync = new UniversalSyncRepository(source.adapter); await sync.initialize();
    await source.task("reading");
    const expectedPlan = await source.work.savePlan(plan("reading"));
    await source.work.saveDailySituation(situation(), [{ taskId: "reading", expectedPlan, plannedDate: "" }]);
    const pending = (await sync.listPending()).filter((item) => ["task", "task_plan", "task_plan_history", "daily_situation"].includes(item.entityType));
    assert.ok(pending.some((item) => item.entityType === "daily_situation"));
    assert.ok(pending.some((item) => item.entityType === "task_plan_history"));
    const receiver = new UniversalSyncRepository(target.adapter); await receiver.initialize();
    await receiver.commit({ protocolVersion: 3, cursor: "4", hasMore: false, accepted: [], conflicts: [], failed: [], changes: pending.map((item, index) => ({ ...item, changeId: `remote-${index}`, version: 1, deletedAt: null, updatedAt: now })) });
    assert.equal((await target.work.listPlans())[0].plannedDate, "");
    assert.deepEqual(await target.work.listDailySituations(), await source.work.listDailySituations());
    assert.deepEqual(await target.work.listPlanHistory(), await source.work.listPlanHistory());
  } finally { source.adapter.db.close(); target.adapter.db.close(); }
});

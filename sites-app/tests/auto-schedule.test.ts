import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { autoScheduleStartDate } from "../app/action-planning";
import { SqliteProjectRepository } from "../app/data/sqlite-project-repository";
import { SqliteWorkRepository } from "../app/data/sqlite-work-repository";
import type { SqliteDatabase, SqliteExecuteResult, SqliteValue } from "../app/data/sqlite-article-repository";
import type { Project, ProjectTask } from "../app/project-types";

class Adapter implements SqliteDatabase {
  readonly db = new DatabaseSync(":memory:");
  async execute(sql: string, values: SqliteValue[] = []): Promise<SqliteExecuteResult> {
    const result = this.db.prepare(sql).run(...values);
    return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
  }
  async select<T>(sql: string, values: SqliteValue[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...values) as T[];
  }
}

const now = "2026-09-27T08:00:00.000Z";
function project(id: string, status: Project["status"] = "active"): Project {
  return { id, title: id, outcome: "完成", motivation: "", projectType: "main", planningMode: "direct", parentProjectId: null, supportsMilestoneId: null, status, category: "learning", sortOrder: 0, isDraft: false, sourceNote: "", targetDate: "", reviewDate: "", completedAt: null, createdAt: now, updatedAt: now };
}
function action(id: string, projectId: string | null, patch: Partial<ProjectTask> = {}): ProjectTask {
  return { id, projectId, milestoneId: null, direction: "learning", title: id, actionType: "organize", definitionOfDone: "完成", steps: [], currentFocus: "开始", details: "", benefit: "", dueDate: "2026-10-04", estimatedDays: 3, status: "next", waitingFor: "", resumeAction: "", context: "anywhere", sortOrder: 0, createdAt: now, updatedAt: now, completedAt: null, ...patch };
}

test("calendar start dates cross month and year boundaries", () => {
  assert.equal(autoScheduleStartDate("2026-10-04", 3), "2026-10-01");
  assert.equal(autoScheduleStartDate("2027-01-02", 3), "2026-12-30");
  assert.equal(autoScheduleStartDate("2028-03-01", 3), "2028-02-27");
  assert.equal(autoScheduleStartDate("2026-02-30", 3), null);
  assert.equal(autoScheduleStartDate("2026-10-04", 0), null);
});

test("upgrades existing daily plans without changing their manual meaning", async () => {
  const adapter = new Adapter();
  await adapter.execute(`CREATE TABLE task_plans(task_id TEXT PRIMARY KEY NOT NULL, planned_date TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT 'normal', estimate_minutes INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`);
  await adapter.execute("INSERT INTO task_plans VALUES ('old', '2026-10-01', 'normal', 0, 0, ?)", [now]);
  await adapter.execute(`CREATE TABLE task_plan_history(id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL, planned_date TEXT NOT NULL, task_title TEXT NOT NULL DEFAULT '', current_focus TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`);
  await adapter.execute("INSERT INTO task_plan_history VALUES ('old-day', 'old', '2026-09-30', '旧行动', '', ?)", [now]);
  const work = new SqliteWorkRepository(adapter);
  const plan = (await work.listPlans())[0];
  assert.equal(plan.source, "manual");
  assert.equal(plan.skipAutoDate, "");
  assert.equal(plan.plannedDate, "2026-10-01");
  assert.deepEqual((await work.listPlanHistory()).map((item) => item.source), ["manual", "manual"]);
});

test("automatically schedules a due next action each day while honoring manual decisions", async () => {
  const adapter = new Adapter();
  const projects = new SqliteProjectRepository(adapter, { seedProjects: [] });
  const work = new SqliteWorkRepository(adapter, () => new Date(now));
  await projects.ready();
  await work.listPlans();
  await projects.saveProject(project("active"));
  await projects.saveTask(action("due", "active"));
  assert.equal(await work.autoScheduleDueTasks("2026-09-30"), 0);
  assert.equal(await work.autoScheduleDueTasks("2026-10-01"), 1);
  assert.equal(await work.autoScheduleDueTasks("2026-10-01"), 0);
  assert.equal((await work.listPlans())[0].source, "auto");
  await work.savePlan({ ...(await work.listPlans())[0], plannedDate: "", skipAutoDate: "2026-10-01" });
  assert.equal(await work.autoScheduleDueTasks("2026-10-01"), 0, "today's closeout must stay closed");
  assert.equal(await work.autoScheduleDueTasks("2026-10-02"), 1);
  await work.pauseAutoSchedule("due", "2026-10-02");
  assert.equal(await work.autoScheduleDueTasks("2026-10-03"), 0);
  assert.equal((await projects.get("active"))?.tasks[0].autoSchedulePaused, true);
  await work.resumeAutoSchedule("due");
  assert.equal(await work.autoScheduleDueTasks("2026-10-03"), 1);
  await work.savePlan({ ...(await work.listPlans())[0], plannedDate: "2026-10-07", source: "manual" });
  assert.equal(await work.autoScheduleDueTasks("2026-10-04"), 0);
  assert.equal((await work.listPlans())[0].plannedDate, "2026-10-07");
  const changed = (await projects.get("active"))!.tasks[0];
  await projects.saveTask({ ...changed, dueDate: "2026-10-08", estimatedDays: 4 });
  assert.equal((await projects.get("active"))!.tasks[0].autoSchedulePaused, false);
});

test("only active next actions with their own deadline and estimate qualify", async () => {
  const adapter = new Adapter();
  const projects = new SqliteProjectRepository(adapter, { seedProjects: [] });
  const work = new SqliteWorkRepository(adapter, () => new Date(now));
  await projects.ready();
  await work.listPlans();
  await projects.saveProject(project("paused", "paused"));
  await projects.saveProject(project("active"));
  await projects.saveTask(action("paused-task", "paused"));
  await projects.saveTask(action("later", "active", { status: "later" }));
  await projects.saveTask(action("no-date", "active", { status: "later", dueDate: "" }));
  await projects.saveTask(action("no-estimate", "active", { status: "later", estimatedDays: 0 }));
  await projects.saveTask(action("independent", null));
  assert.equal(await work.autoScheduleDueTasks("2026-10-04"), 1);
  assert.deepEqual((await work.listPlans()).map((plan) => plan.taskId), ["independent"]);
  const saved = await projects.get("paused");
  await projects.saveTask({ ...saved!.tasks[0], dueDate: "2026-10-05", estimatedDays: 2 });
  assert.equal(await work.autoScheduleDueTasks("2026-10-04"), 0);
});

test("due and overdue actions keep appearing on later calendar days", async () => {
  const adapter = new Adapter();
  const projects = new SqliteProjectRepository(adapter, { seedProjects: [] });
  const work = new SqliteWorkRepository(adapter, () => new Date(now));
  await projects.ready();
  await work.listPlans();
  await projects.saveTask(action("due", null));
  for (const date of ["2026-10-04", "2026-10-05", "2026-11-01", "2027-01-01"]) {
    assert.equal(await work.autoScheduleDueTasks(date), 1);
    assert.equal((await work.listPlans())[0].plannedDate, date);
  }
});

test("editing a scheduled action recalculates today without changing manual plans", async () => {
  const adapter = new Adapter();
  const projects = new SqliteProjectRepository(adapter, { seedProjects: [] });
  const work = new SqliteWorkRepository(adapter, () => new Date(now));
  await projects.ready();
  await work.listPlans();
  await projects.saveTask(action("due", null, { dueDate: "2026-10-04" }));
  assert.equal(await work.autoScheduleDueTasks("2026-10-01"), 1);
  const current = (await projects.listStandaloneTasks())[0];
  await projects.saveTask({ ...current, dueDate: "2026-10-10" });
  assert.equal(await work.autoScheduleDueTasks("2026-10-01"), 1);
  assert.equal((await work.listPlans()).length, 0);
  await projects.saveTask({ ...current, dueDate: "2026-10-04" });
  assert.equal(await work.autoScheduleDueTasks("2026-10-01"), 1);
  assert.equal((await work.listPlans())[0].plannedDate, "2026-10-01");
  await work.savePlan({ ...(await work.listPlans())[0], source: "manual", plannedDate: "2026-10-01" });
  await projects.saveTask({ ...current, dueDate: "2026-10-10" });
  assert.equal(await work.autoScheduleDueTasks("2026-10-01"), 0);
  assert.equal((await work.listPlans())[0].plannedDate, "2026-10-01");
});

test("status and project changes remove an automatic plan without erasing its history", async () => {
  const adapter = new Adapter();
  const projects = new SqliteProjectRepository(adapter, { seedProjects: [] });
  const work = new SqliteWorkRepository(adapter, () => new Date(now));
  await projects.ready();
  await work.listPlans();
  await projects.saveProject(project("active"));
  await projects.saveTask(action("due", "active"));
  assert.equal(await work.autoScheduleDueTasks("2026-10-01"), 1);
  assert.equal((await work.listPlanHistory("2026-10-01")).length, 1);
  assert.equal((await work.listPlanHistory("2026-10-01"))[0].source, "auto");

  const task = (await projects.get("active"))!.tasks[0];
  await projects.saveTask({ ...task, status: "waiting", waitingFor: "回复" });
  assert.equal(await work.autoScheduleDueTasks("2026-10-01"), 1);
  assert.equal((await work.listPlans()).length, 0);
  assert.equal((await work.listPlanHistory("2026-10-01")).length, 1);

  await projects.saveTask({ ...task, status: "next" });
  assert.equal(await work.autoScheduleDueTasks("2026-10-02"), 1);
  await projects.saveProject({ ...project("active"), status: "paused" });
  assert.equal(await work.autoScheduleDueTasks("2026-10-02"), 1);
  assert.equal((await work.listPlans()).length, 0);
});

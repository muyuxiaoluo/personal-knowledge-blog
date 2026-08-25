import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initialProjectSeeds } from "../app/data/project-seeds";
import { SqliteProjectRepository } from "../app/data/sqlite-project-repository";
import { rootProjectStatusCounts } from "../app/project-selectors";
import type {
  SqliteDatabase,
  SqliteExecuteResult,
  SqliteValue,
} from "../app/data/sqlite-article-repository";

class NodeSqliteAdapter implements SqliteDatabase {
  constructor(private readonly database: DatabaseSync) {}

  async execute(
    sql: string,
    bindValues: SqliteValue[] = [],
  ): Promise<SqliteExecuteResult> {
    const result = this.database.prepare(sql).run(...bindValues);
    return {
      rowsAffected: Number(result.changes),
      lastInsertId: Number(result.lastInsertRowid),
    };
  }

  async select<T>(sql: string, bindValues: SqliteValue[] = []): Promise<T[]> {
    return this.database.prepare(sql).all(...bindValues) as T[];
  }
}

test("seeds staged projects and persists project progress", async () => {
  const database = new DatabaseSync(":memory:");
  const adapter = new NodeSqliteAdapter(database);
  const repository = new SqliteProjectRepository(adapter, {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-08-10T10:00:00.000Z"),
  });

  const seeded = await repository.list();
  assert.equal(seeded.length, 5);
  assert.deepEqual(rootProjectStatusCounts(seeded), { active: 4, waiting: 0, paused: 1, completed: 0 });
  assert.equal(seeded[0].title, "科研方向选择");
  assert.equal(seeded[0].category, "learning");
  assert.equal(seeded[0].isDraft, true);
  assert.ok(seeded[0].currentMilestone);
  assert.ok(seeded[0].nextTask);

  const workbench = await repository.get("project-life-workbench-v01");
  assert.ok(workbench);
  assert.equal(workbench.project.status, "active");
  assert.equal(workbench.milestones.length, 5);
  assert.equal(workbench.tasks.length, 1);
  assert.equal(workbench.project.reviewDate, "2026-08-19");
  assert.equal(workbench.milestones.filter((item) => item.status === "completed").length, 4);
  assert.equal(workbench.tasks[0].actionType, "organize");
  assert.ok(workbench.tasks[0].details);
  assert.deepEqual(workbench.proposals, []);

  await repository.confirmProject(workbench.project.id);
  const confirmed = await repository.get(workbench.project.id);
  assert.equal(confirmed?.project.isDraft, false);

  const savedProject = await repository.saveProject({
    ...confirmed!.project,
    outcome: "完成项目工作台并用于真实规划。",
  });
  assert.equal(savedProject.outcome, "完成项目工作台并用于真实规划。");

  const currentTask = confirmed!.tasks[0];
  await repository.completeTask(currentTask.id, `完成行动：${currentTask.title}`);
  const progressed = await repository.get(savedProject.id);
  assert.equal(progressed?.tasks[0].status, "done");
  assert.equal(progressed?.logs.length, 2);

  const nextTask = await repository.saveTask({
    ...currentTask,
    id: "",
    title: "用真实项目检查项目页是否顺手。",
    status: "next",
    completedAt: null,
  });
  assert.equal(nextTask.status, "next");

  const removableStage = await repository.saveMilestone({
    ...confirmed!.milestones[0],
    id: "",
    title: "临时验证阶段",
    status: "planned",
  });
  await repository.removeMilestone(removableStage.id);
  assert.equal((await repository.get(savedProject.id))?.milestones.some((item) => item.id === removableStage.id), false);

  const proposal = await repository.saveProposal({
    id: "",
    projectId: savedProject.id,
    title: "加入项目评审助手",
    problem: "新想法容易直接堆成任务。",
    expectedValue: "先判断价值，再决定是否进入路线。",
    cost: "需要模型调用和评审界面。",
    status: "pending",
    reviewNote: "",
    createdAt: "",
    updatedAt: "",
  });
  assert.equal(proposal.status, "pending");
  await repository.updateProposalStatus(proposal.id, "experiment", "先用手动评审流程验证。 ");
  const withProposal = await repository.get(savedProject.id);
  assert.equal(withProposal?.proposals[0].status, "experiment");
  assert.equal(withProposal?.proposals[0].reviewNote, "先用手动评审流程验证。");

  const removableProposal = await repository.saveProposal({
    ...proposal,
    id: "proposal-remove-test",
    title: "临时待删除提案",
    status: "pending",
    reviewNote: "",
  });
  await repository.removeProposal(removableProposal.id);
  const afterProposalRemoval = await repository.get(savedProject.id);
  assert.equal(afterProposalRemoval?.proposals.some((item) => item.id === removableProposal.id), false);
  assert.equal(afterProposalRemoval?.proposals.some((item) => item.id === proposal.id), true);

  await repository.updateProjectStatus(savedProject.id, "completed", `完结项目：${savedProject.title}`);
  const completedProject = await repository.get(savedProject.id);
  assert.equal(completedProject?.project.status, "completed");
  assert.equal(completedProject?.logs.some((log) => log.body === `完结项目：${savedProject.title}`), true);
  await repository.updateProjectStatus(savedProject.id, "active", `重新开启项目：${savedProject.title}`);
  assert.equal((await repository.get(savedProject.id))?.project.status, "active");

  const reopened = new SqliteProjectRepository(adapter, {
    seedProjects: initialProjectSeeds,
  });
  assert.equal((await reopened.list()).length, 5);
  assert.equal(
    (await reopened.get(savedProject.id))?.project.outcome,
    "完成项目工作台并用于真实规划。",
  );
  assert.equal((await reopened.get(savedProject.id))?.proposals[0].title, "加入项目评审助手");

  const indexes = database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'idx_project%'",
  ).all();
  assert.ok(indexes.length >= 4);
  assert.ok(indexes.some((item) => String(item.name) === "idx_project_proposals_project_status"));

  database.close();
});

test("records a project completion time and clears it when reopened", async () => {
  let now = new Date("2026-08-20T10:00:00.000Z");
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(new DatabaseSync(":memory:")), {
    seedProjects: initialProjectSeeds,
    clock: () => now,
  });
  await repository.list();
  await repository.updateProjectStatus("project-life-workbench-v01", "completed", "项目完结");
  assert.equal((await repository.get("project-life-workbench-v01"))?.project.completedAt, now.toISOString());
  now = new Date("2026-08-21T10:00:00.000Z");
  await repository.updateProjectStatus("project-life-workbench-v01", "active", "重新开启项目");
  assert.equal((await repository.get("project-life-workbench-v01"))?.project.completedAt, null);
});

test("rolls back task completion when the progress log cannot be written", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database), {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-08-13T10:00:00.000Z"),
  });
  const detail = await repository.get("project-life-workbench-v01");
  assert.ok(detail);
  database.exec(`CREATE TRIGGER reject_completion_log BEFORE INSERT ON project_logs
    WHEN NEW.body LIKE '完成行动：%'
    BEGIN SELECT RAISE(FAIL, 'test failure'); END;`);

  await assert.rejects(() => repository.completeTask(detail.tasks[0].id, `完成行动：${detail.tasks[0].title}`));
  assert.notEqual((await repository.get(detail.tasks[0].projectId))?.tasks[0].status, "done");
  database.close();
});

test("soft deletes an action, clears its plan, preserves focus history, and restores the plan", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database), {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-08-21T10:00:00.000Z"),
  });
  const detail = await repository.get("project-life-workbench-v01");
  assert.ok(detail);
  const task = detail.tasks[0];
  database.exec(`CREATE TABLE task_plans (
    task_id TEXT PRIMARY KEY, planned_date TEXT, priority TEXT,
    estimate_minutes INTEGER, sort_order INTEGER, updated_at TEXT
  )`);
  database.exec(`CREATE TABLE focus_sessions (
    id TEXT PRIMARY KEY, task_id TEXT, project_id TEXT, label TEXT,
    started_at TEXT, ended_at TEXT, duration_seconds INTEGER
  )`);
  database.prepare("INSERT INTO task_plans VALUES (?, ?, ?, ?, ?, ?)").run(task.id, "2026-08-21", "high", 30, 1, "2026-08-21T09:00:00.000Z");
  database.prepare("INSERT INTO focus_sessions VALUES (?, ?, ?, ?, ?, ?, ?)").run("focus-history", task.id, task.projectId, task.title, "2026-08-20T09:00:00.000Z", "2026-08-20T09:30:00.000Z", 1800);

  await repository.removeTask(task.id);
  assert.equal((await repository.get(task.projectId))?.tasks.some((item) => item.id === task.id), false);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM task_plans WHERE task_id = ?").get(task.id)?.count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM focus_sessions WHERE task_id = ?").get(task.id)?.count, 1);

  await repository.restoreTask(task.id);
  assert.equal((await repository.get(task.projectId))?.tasks.some((item) => item.id === task.id), true);
  const restored = database.prepare("SELECT * FROM task_plans WHERE task_id = ?").get(task.id);
  assert.equal(restored?.planned_date, "2026-08-21");
  assert.equal(restored?.priority, "high");
  database.close();
});

test("stores one-level project branches and can detach them without losing content", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database), {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-08-16T10:00:00.000Z"),
  });
  const parent = await repository.get("project-research-direction");
  assert.ok(parent);
  const currentMilestone = parent.milestones.find((milestone) => milestone.status === "current");
  assert.ok(currentMilestone);

  const branch = await repository.saveProject({
    ...parent.project,
    id: "project-deep-learning-course",
    title: "补充深度学习基础课程",
    outcome: "完成核心章节，并能解释三维检测综述中的主要网络结构。",
    motivation: "补足阅读三维目标检测论文所需的模型基础。",
    projectType: "side",
    parentProjectId: parent.project.id,
    supportsMilestoneId: currentMilestone.id,
    sourceNote: "测试创建",
    createdAt: "",
    updatedAt: "",
  });
  assert.equal(branch.projectType, "side");
  assert.equal(branch.parentProjectId, parent.project.id);
  assert.equal(branch.supportsMilestoneId, currentMilestone.id);
  assert.equal((await repository.list()).find((project) => project.id === branch.id)?.parentProjectId, parent.project.id);

  await assert.rejects(
    () => repository.saveProject({
      ...branch,
      id: "project-nested-branch",
      title: "不应创建的二级支线",
      parentProjectId: branch.id,
      supportsMilestoneId: null,
    }),
    /支线只允许一层/,
  );

  const detached = await repository.saveProject({
    ...branch,
    projectType: "main",
    parentProjectId: null,
  });
  assert.equal(detached.projectType, "main");
  assert.equal(detached.parentProjectId, null);
  assert.equal(detached.supportsMilestoneId, null);
  assert.equal(detached.outcome, branch.outcome);
  database.close();
});

test("deletes a project tree while preserving and detaching linked history", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database), {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-08-16T10:00:00.000Z"),
  });
  const parent = await repository.get("project-research-direction");
  assert.ok(parent);
  const branch = await repository.saveProject({
    ...parent.project,
    id: "project-delete-test-branch",
    title: "待随主线删除的支线",
    projectType: "side",
    parentProjectId: parent.project.id,
    supportsMilestoneId: parent.milestones[0].id,
    createdAt: "",
    updatedAt: "",
  });
  database.exec("CREATE TABLE articles (id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT '')");
  database.exec("CREATE TABLE focus_sessions (id TEXT PRIMARY KEY, project_id TEXT)");
  database.exec("CREATE TABLE task_plans (task_id TEXT PRIMARY KEY)");
  database.prepare("INSERT INTO articles(id, project_id) VALUES (?, ?), (?, ?)").run(
    "article-parent", parent.project.id, "article-branch", branch.id,
  );
  database.prepare("INSERT INTO focus_sessions(id, project_id) VALUES (?, ?)").run("focus-parent", parent.project.id);
  database.prepare("INSERT INTO task_plans(task_id) VALUES (?)").run(parent.tasks[0].id);

  await repository.removeProject(parent.project.id);

  const remaining = await repository.list();
  assert.equal(remaining.some((project) => project.id === parent.project.id), false);
  assert.equal(remaining.some((project) => project.id === branch.id), false);
  assert.equal(database.prepare("SELECT project_id FROM articles WHERE id = ?").get("article-parent")?.project_id, "");
  assert.equal(database.prepare("SELECT project_id FROM articles WHERE id = ?").get("article-branch")?.project_id, "");
  assert.equal(database.prepare("SELECT project_id FROM focus_sessions WHERE id = ?").get("focus-parent")?.project_id, null);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM task_plans").get()?.count, 0);
  assert.equal((await repository.get("project-life-workbench-v01"))?.project.title, "人生攻略库");
  database.close();
});

test("rolls back project workspace when a child record cannot be saved", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database), {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-08-13T10:00:00.000Z"),
  });
  const detail = await repository.get("project-life-workbench-v01");
  assert.ok(detail);
  const originalOutcome = detail.project.outcome;
  database.exec(`CREATE TRIGGER reject_workspace_task BEFORE UPDATE ON project_tasks
    BEGIN SELECT RAISE(FAIL, 'test failure'); END;`);

  await assert.rejects(() => repository.saveWorkspace(
    { ...detail.project, outcome: "不应保留的修改" },
    detail.milestones,
    { ...detail.tasks[0], title: "触发失败" },
  ));
  assert.equal((await repository.get(detail.project.id))?.project.outcome, originalOutcome);
  database.close();
});

test("rolls back the parent and its branches as one workspace", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database), {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-08-16T10:00:00.000Z"),
  });
  const detail = await repository.get("project-research-direction");
  assert.ok(detail);
  const originalOutcome = detail.project.outcome;
  database.exec(`CREATE TRIGGER reject_workspace_branch BEFORE INSERT ON projects
    WHEN NEW.project_type = 'side'
    BEGIN SELECT RAISE(FAIL, 'test failure'); END;`);

  await assert.rejects(() => repository.saveWorkspace(
    { ...detail.project, outcome: "不应单独保存的主线修改" },
    detail.milestones,
    detail.tasks[0],
    [{
      ...detail.project,
      id: "",
      title: "不应留下的支线",
      outcome: "支线保存失败时整体回滚。",
      projectType: "side",
      parentProjectId: detail.project.id,
      supportsMilestoneId: detail.milestones[0].id,
      createdAt: "",
      updatedAt: "",
    }],
  ));
  assert.equal((await repository.get(detail.project.id))?.project.outcome, originalOutcome);
  assert.equal((await repository.list()).some((project) => project.title === "不应留下的支线"), false);
  database.close();
});

test("rolls back the previous next action when promoting another action fails", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database), {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-08-13T10:00:00.000Z"),
  });
  const detail = await repository.get("project-life-workbench-v01");
  assert.ok(detail);
  const currentNext = detail.tasks.find((task) => task.status === "next");
  assert.ok(currentNext);
  const later = await repository.saveTask({
    ...currentNext,
    id: `${currentNext.id}-later-test`,
    title: "稍后再做的测试行动",
    status: "later",
    sortOrder: currentNext.sortOrder + 1,
    createdAt: "",
    updatedAt: "",
    completedAt: null,
  });
  database.exec(`CREATE TRIGGER reject_next_promotion BEFORE UPDATE OF status ON project_tasks
    WHEN NEW.id = '${later.id}' AND NEW.status = 'next'
    BEGIN SELECT RAISE(FAIL, 'test failure'); END;`);

  await assert.rejects(() => repository.updateTaskStatus(later.id, "next"));
  const saved = await repository.get(detail.project.id);
  assert.equal(saved?.tasks.find((task) => task.id === currentNext.id)?.status, "next");
  assert.equal(saved?.tasks.find((task) => task.id === later.id)?.status, "later");
  database.close();
});

test("project workspace removes deleted stages and detaches their actions", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database), {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-08-13T10:00:00.000Z"),
  });
  const detail = await repository.get("project-life-workbench-v01");
  assert.ok(detail);
  const currentStage = detail.milestones.find((milestone) => milestone.status === "current");
  assert.ok(currentStage);
  assert.equal(detail.tasks[0].milestoneId, currentStage.id);

  await repository.saveWorkspace(
    detail.project,
    detail.milestones.filter((milestone) => milestone.id !== currentStage.id),
    null,
  );

  const saved = await repository.get(detail.project.id);
  assert.equal(saved?.milestones.some((milestone) => milestone.id === currentStage.id), false);
  assert.equal(saved?.tasks[0].milestoneId, null);
  database.close();
});

test("adds proposal storage to an existing version 3 project database", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE app_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
  database.prepare("INSERT INTO app_meta(key, value) VALUES(?, ?)").run("project_seed_version", "3");
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database));

  assert.deepEqual(await repository.list(), []);
  const proposalTable = database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'project_proposals'",
  ).get();
  assert.ok(proposalTable);
  const projectColumns = database.prepare("PRAGMA table_info(projects)").all();
  assert.ok(projectColumns.some((column) => String(column.name) === "project_type"));
  assert.ok(projectColumns.some((column) => String(column.name) === "parent_project_id"));
  assert.ok(projectColumns.some((column) => String(column.name) === "supports_milestone_id"));
  database.close();
});

test("maps legacy project categories into the shared life domains", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE app_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
  database.prepare("INSERT INTO app_meta(key, value) VALUES(?, ?)").run("project_seed_version", "3");
  database.exec(`CREATE TABLE projects (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    outcome TEXT NOT NULL,
    motivation TEXT NOT NULL,
    status TEXT NOT NULL,
    category TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_draft INTEGER NOT NULL DEFAULT 1,
    source_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  database.prepare(`INSERT INTO projects(
    id, title, outcome, motivation, status, category, sort_order, is_draft, source_note, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "legacy-research",
    "旧科研项目",
    "保留原项目内容",
    "",
    "active",
    "research",
    10,
    0,
    "",
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
  );

  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database));
  const projects = await repository.list();
  assert.equal(projects[0].category, "learning");
  assert.equal(database.prepare("SELECT category FROM projects WHERE id = ?").get("legacy-research")?.category, "learning");
  database.close();
});

test("seed upgrades add missing records without overwriting user edits", async () => {
  const database = new DatabaseSync(":memory:");
  const adapter = new NodeSqliteAdapter(database);
  const firstRepository = new SqliteProjectRepository(adapter, {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-08-13T10:00:00.000Z"),
  });
  const detail = await firstRepository.get("project-life-workbench-v01");
  assert.ok(detail?.tasks[0]);
  const editedTaskId = detail.tasks[0].id;
  database.prepare("UPDATE project_tasks SET title = ?, details = ? WHERE id = ?")
    .run("用户自己修改的行动", "这段内容必须在升级后保留", editedTaskId);
  database.prepare("UPDATE app_meta SET value = '1' WHERE key = 'project_seed_version'").run();

  const upgradedRepository = new SqliteProjectRepository(adapter, {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-08-14T10:00:00.000Z"),
  });
  await upgradedRepository.list();

  const editedTask = database.prepare("SELECT title, details FROM project_tasks WHERE id = ?")
    .get(editedTaskId);
  assert.equal(editedTask?.title, "用户自己修改的行动");
  assert.equal(editedTask?.details, "这段内容必须在升级后保留");
  assert.equal(
    database.prepare("SELECT value FROM app_meta WHERE key = 'project_seed_version'").get()?.value,
    "3",
  );
  database.close();
});

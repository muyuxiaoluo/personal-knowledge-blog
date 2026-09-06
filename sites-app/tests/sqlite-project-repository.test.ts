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
  selectCount = 0;

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
    this.selectCount += 1;
    return this.database.prepare(sql).all(...bindValues) as T[];
  }
}

test("loads the project index in three reads and a selected project in two more", async () => {
  const adapter = new NodeSqliteAdapter(new DatabaseSync(":memory:"));
  const repository = new SqliteProjectRepository(adapter, {
    seedProjects: initialProjectSeeds,
  });
  await repository.ready();
  adapter.selectCount = 0;
  const projects = await repository.list();
  assert.equal(adapter.selectCount, 3);
  assert.ok(projects[0]);
  adapter.selectCount = 0;
  await repository.get(projects[0].id);
  assert.equal(adapter.selectCount, 2);
});

test("seeds staged projects and persists project progress", async () => {
  const database = new DatabaseSync(":memory:");
  const adapter = new NodeSqliteAdapter(database);
  const repository = new SqliteProjectRepository(adapter, {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-08-10T10:00:00.000Z"),
  });

  const seeded = await repository.list();
  assert.equal(seeded.length, 5);
  assert.deepEqual(rootProjectStatusCounts(seeded), { active: 4, paused: 1, completed: 0 });
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

test("persists structured actions and records daily progress without completing the action", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database), {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-08-25T10:00:00.000Z"),
  });
  const detail = await repository.get("project-research-direction");
  assert.ok(detail);
  const task = detail.tasks[0];
  const saved = await repository.saveTask({
    ...task,
    definitionOfDone: "能不看原文讲清研究问题、方法、证据和局限。",
    currentFocus: "读完方法部分并画出输入到输出流程",
    steps: [
      { id: "step-method", title: "读方法部分", completed: true },
      { id: "step-figure", title: "画流程图", completed: false },
    ],
  });
  assert.equal(saved.definitionOfDone, "能不看原文讲清研究问题、方法、证据和局限。");
  assert.equal(saved.currentFocus, "读完方法部分并画出输入到输出流程");
  assert.deepEqual(saved.steps, [
    { id: "step-method", title: "读方法部分", completed: true },
    { id: "step-figure", title: "画流程图", completed: false },
  ]);

  await repository.recordTaskProgress(saved.id, "读完方法部分并画出了主流程。", "核对实验设置与消融实验");
  const progressed = await repository.get(detail.project.id);
  const continuedTask = progressed?.tasks.find((item) => item.id === saved.id);
  assert.equal(continuedTask?.status, "next");
  assert.equal(continuedTask?.currentFocus, "核对实验设置与消融实验");
  assert.equal(continuedTask?.resumeAction, "核对实验设置与消融实验");
  const progressLog = progressed?.logs.find((log) => log.body.startsWith("行动推进｜"));
  assert.ok(progressLog);
  const logBody = JSON.parse(progressLog.body.slice("行动推进｜".length));
  assert.equal(logBody.result, "读完方法部分并画出了主流程。");
  assert.equal(logBody.nextFocus, "核对实验设置与消融实验");
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

test("persists lightweight projects with a target date and no stage route", async () => {
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(new DatabaseSync(":memory:")), {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-08-28T10:00:00.000Z"),
  });
  const source = await repository.get("project-research-direction");
  assert.ok(source);

  const saved = await repository.saveWorkspace({
    ...source.project,
    id: "project-teacher-exam",
    title: "教资考试冲刺",
    outcome: "完成重点复习与模拟，并按时参加考试。",
    planningMode: "direct",
    targetDate: "2026-09-12",
    createdAt: "",
    updatedAt: "",
  }, [], null);

  const detail = await repository.get(saved.id);
  assert.equal(detail?.project.targetDate, "2026-09-12");
  assert.deepEqual(detail?.milestones, []);
});

test("creates and continues a standalone action, then moves it into and out of a project", async () => {
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(new DatabaseSync(":memory:")), {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-08-28T10:00:00.000Z"),
  });
  const now = "2026-08-28T10:00:00.000Z";
  let task = await repository.saveTask({
    id: "", projectId: null, milestoneId: null, direction: "learning", title: "给导师发消息",
    actionType: "communicate", definitionOfDone: "导师已经收到开题时间确认消息", steps: [],
    currentFocus: "整理一句话并发送", details: "", benefit: "", dueDate: "", status: "next",
    waitingFor: "", resumeAction: "", context: "phone", sortOrder: 10, createdAt: now, updatedAt: now, completedAt: null,
  });
  assert.equal((await repository.listStandaloneTasks())[0]?.id, task.id);
  await repository.recordTaskProgress(task.id, "已经写好消息", "核对时间后发送");
  assert.equal((await repository.listTaskLogs(task.id))[0]?.kind, "task_progress");
  await repository.completeTask(task.id, "导师已收到消息");
  assert.equal((await repository.listStandaloneTasks())[0]?.status, "done");
  await repository.updateTaskStatus(task.id, "cancelled");
  await repository.updateTaskStatus(task.id, "later");

  const project = await repository.get("project-research-direction");
  assert.ok(project);
  task = await repository.saveTask({ ...task, projectId: project.project.id, direction: project.project.category, status: "later", completedAt: null });
  assert.equal((await repository.get(project.project.id))?.tasks.some((item) => item.id === task.id), true);
  task = await repository.saveTask({ ...task, projectId: null, milestoneId: null, direction: project.project.category });
  assert.equal(task.direction, project.project.category);
  assert.equal((await repository.listStandaloneTasks()).some((item) => item.id === task.id), true);
});

test("switches staged work to direct without deleting history and recalculates an adaptive checkpoint", async () => {
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(new DatabaseSync(":memory:")), {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-08-13T10:00:00.000Z"),
  });
  const original = await repository.get("project-research-direction");
  assert.ok(original);
  await repository.saveWorkspace({ ...original.project, planningMode: "direct" }, original.milestones, null);
  const direct = await repository.get(original.project.id);
  assert.ok(direct);
  assert.equal(direct.project.planningMode, "direct");
  assert.equal(direct.milestones.some((milestone) => milestone.status === "superseded"), true);
  assert.equal(direct.tasks.every((task) => task.milestoneId === null), true);

  const now = "2026-08-13T10:00:00.000Z";
  const current = {
    id: "", projectId: direct.project.id, title: "通过开题答辩", definitionOfDone: "答辩通过并记录修改意见",
    status: "current" as const, dueDate: "2026-08-18", sortOrder: 100, createdAt: now, updatedAt: now,
  };
  const future = { ...current, id: "", title: "完成论文主体", definitionOfDone: "形成可评审论文稿", status: "planned" as const, dueDate: "", sortOrder: 110 };
  await repository.saveWorkspace({ ...direct.project, planningMode: "adaptive", targetDate: "2026-08-30", reviewDate: "" }, [...direct.milestones, current, future], null);
  const adaptive = await repository.get(direct.project.id);
  assert.equal(adaptive?.project.planningMode, "adaptive");
  assert.equal(adaptive?.project.reviewDate, "2026-08-18");
  assert.equal(adaptive?.milestones.find((milestone) => milestone.status === "planned")?.title, "完成论文主体");
});

test("applies only selected AI adjustments atomically and records the complete revision", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database), {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-08-13T10:00:00.000Z"),
  });
  const detail = await repository.get("project-research-direction");
  assert.ok(detail);
  const oldTask = detail.tasks[0];
  const current = detail.milestones.find((milestone) => milestone.status === "current");
  assert.ok(oldTask && current);
  await repository.applyProjectAdjustment({
    projectId: detail.project.id,
    trigger: "开题提前到九月中下旬",
    model: "deepseek-v4-pro",
    tokenUsage: { inputTokens: 120, outputTokens: 80, totalTokens: 200 },
    proposal: {
      summary: "优先完成开题材料",
      projectPatch: { outcome: null, targetDate: "2026-09-20", reviewDate: null },
      milestoneChanges: [{ id: current.id, action: "postpone", title: "通过开题答辩", definitionOfDone: null, dueDate: "2026-09-20", selected: true }],
      newMilestones: [],
      taskChanges: [{ id: oldTask.id, action: "cancel", title: null, currentFocus: null, definitionOfDone: null, dueDate: null, status: "cancelled", selected: false }],
      newTasks: [{ clientId: "new-1", milestoneId: current.id, title: "向导师确认答辩材料", currentFocus: "列出材料清单并发送", definitionOfDone: "导师确认材料清单", details: "", dueDate: "2026-08-15", selected: true }],
      assumptions: [], risks: ["答辩日期仍可能微调"],
    },
  });
  const saved = await repository.get(detail.project.id);
  assert.equal(saved?.project.targetDate, "2026-09-20");
  assert.notEqual(saved?.tasks.find((task) => task.id === oldTask.id)?.status, "cancelled");
  assert.equal(saved?.tasks.some((task) => task.title === "向导师确认答辩材料"), true);
  assert.deepEqual(saved?.tasks.filter((task) => task.status === "next").map((task) => task.title), ["向导师确认答辩材料"]);
  const revision = saved?.logs.find((log) => log.kind === "plan_revision");
  assert.ok(revision?.body.includes("deepseek-v4-pro"));
  assert.ok(revision?.body.includes("开题提前到九月中下旬"));
  database.close();
});

test("completes the current stage, advances the route, and keeps unfinished actions", async () => {
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(new DatabaseSync(":memory:")), {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-08-28T10:00:00.000Z"),
  });
  const detail = await repository.get("project-research-direction");
  assert.ok(detail);
  const current = detail.milestones.find((milestone) => milestone.status === "current");
  assert.ok(current);
  const next = await repository.saveMilestone({
    ...current,
    id: "project-research-direction-milestone-next",
    title: "完成第一轮基线复现",
    status: "planned",
    sortOrder: current.sortOrder + 10,
    createdAt: "",
    updatedAt: "",
  });

  const activated = await repository.completeMilestone(current.id, `完成阶段：${current.title}`);
  const saved = await repository.get(detail.project.id);
  assert.equal(saved?.milestones.find((milestone) => milestone.id === current.id)?.status, "completed");
  assert.equal(activated?.id, next.id);
  assert.equal(saved?.milestones.find((milestone) => milestone.id === next.id)?.status, "current");
  assert.equal(saved?.tasks[0].status, "next");
  assert.equal(saved?.tasks[0].milestoneId, current.id);
  assert.ok(saved?.logs.some((log) => log.body === `完成阶段：${current.title}`));
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
    { ...detail.project, planningMode: "direct" },
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
  assert.ok(projectColumns.some((column) => String(column.name) === "target_date"));
  database.close();
});

test("rebuilds legacy action and log tables so project ids become nullable without losing rows", async () => {
  const database = new DatabaseSync(":memory:");
  const first = new SqliteProjectRepository(new NodeSqliteAdapter(database), { seedProjects: initialProjectSeeds });
  await first.ready();
  database.exec("PRAGMA foreign_keys = OFF; DROP TABLE project_logs; DROP TABLE project_tasks;");
  database.exec(`CREATE TABLE project_tasks (
    id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), milestone_id TEXT,
    title TEXT NOT NULL, action_type TEXT NOT NULL DEFAULT 'organize', definition_of_done TEXT NOT NULL DEFAULT '',
    steps_json TEXT NOT NULL DEFAULT '[]', current_focus TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '',
    benefit TEXT NOT NULL DEFAULT '', due_date TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
    waiting_for TEXT NOT NULL DEFAULT '', resume_action TEXT NOT NULL DEFAULT '', context TEXT NOT NULL DEFAULT 'anywhere',
    sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
    deleted_at TEXT, deleted_plan_json TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE project_logs (
    id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), body TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE task_plans (
    task_id TEXT PRIMARY KEY NOT NULL, planned_date TEXT NOT NULL, priority TEXT NOT NULL,
    estimate_minutes INTEGER NOT NULL, sort_order INTEGER NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE focus_sessions (
    id TEXT PRIMARY KEY NOT NULL, task_id TEXT, project_id TEXT, label TEXT NOT NULL,
    started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER NOT NULL
  );`);
  database.prepare(`INSERT INTO project_tasks(
    id, project_id, milestone_id, title, action_type, definition_of_done, steps_json, current_focus, details,
    benefit, due_date, status, waiting_for, resume_action, context, sort_order, created_at, updated_at, completed_at, deleted_at, deleted_plan_json
  ) VALUES (?, ?, NULL, ?, 'organize', '', '[]', ?, '', '', '', 'later', '', '', 'anywhere', 10, ?, ?, NULL, NULL, '')`)
    .run("legacy-task", "project-research-direction", "旧行动", "继续旧行动", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
  database.prepare("INSERT INTO project_logs(id, project_id, body, created_at) VALUES (?, ?, ?, ?)")
    .run("legacy-log", "project-research-direction", "旧记录", "2026-08-01T00:00:00.000Z");
  database.prepare("INSERT INTO task_plans VALUES (?, ?, ?, ?, ?, ?)")
    .run("legacy-task", "2026-08-15", "high", 45, 1, "2026-08-01T00:00:00.000Z");
  database.prepare("INSERT INTO focus_sessions VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("legacy-focus", "legacy-task", "project-research-direction", "旧行动", "2026-08-01T08:00:00.000Z", "2026-08-01T08:30:00.000Z", 1800);

  const migrated = new SqliteProjectRepository(new NodeSqliteAdapter(database));
  await migrated.ready();
  const taskProjectColumn = database.prepare("PRAGMA table_info(project_tasks)").all().find((column) => String(column.name) === "project_id");
  const logProjectColumn = database.prepare("PRAGMA table_info(project_logs)").all().find((column) => String(column.name) === "project_id");
  assert.equal(Number(taskProjectColumn?.notnull), 0);
  assert.equal(Number(logProjectColumn?.notnull), 0);
  assert.equal(database.prepare("SELECT title, direction FROM project_tasks WHERE id = 'legacy-task'").get()?.title, "旧行动");
  assert.equal(database.prepare("SELECT kind FROM project_logs WHERE id = 'legacy-log'").get()?.kind, "general");
  assert.equal(database.prepare("SELECT planned_date FROM task_plans WHERE task_id = 'legacy-task'").get()?.planned_date, "2026-08-15");
  assert.equal(database.prepare("SELECT duration_seconds FROM focus_sessions WHERE task_id = 'legacy-task'").get()?.duration_seconds, 1800);
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
  database.prepare(`INSERT INTO projects(
    id, title, outcome, motivation, status, category, sort_order, is_draft, source_note, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "legacy-waiting",
    "旧等待项目",
    "保留原项目内容",
    "",
    "waiting",
    "systems",
    20,
    0,
    "",
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
  );

  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database));
  const projects = await repository.list();
  assert.equal(projects.find((project) => project.id === "legacy-research")?.category, "learning");
  assert.equal(projects.find((project) => project.id === "legacy-waiting")?.status, "paused");
  assert.equal(database.prepare("SELECT category FROM projects WHERE id = ?").get("legacy-research")?.category, "learning");
  assert.equal(database.prepare("SELECT status FROM projects WHERE id = ?").get("legacy-waiting")?.status, "paused");
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

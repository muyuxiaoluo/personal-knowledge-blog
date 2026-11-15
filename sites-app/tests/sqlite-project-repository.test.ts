import assert from "node:assert/strict";
import { backup, DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initialProjectSeeds } from "../app/data/project-seeds";
import { SqliteProjectRepository } from "../app/data/sqlite-project-repository";
import { SqliteWorkRepository } from "../app/data/sqlite-work-repository";
import { DashboardRepository } from "../app/data/dashboard-repository";
import { filterProjects, projectJobGroups, projectCalendarEvents, projectProgress, projectWorkStatus, projectStatusCounts } from "../app/project-selectors";
import type { AsabaJob } from "../app/companion-types";
import { buildAsabaProgressInput, previewAsabaPlan, type AsabaPlanSave } from "../app/asaba-planning";
import { writeAsabaPlan } from "../app/save-asaba-plan";
import type {
  SqliteDatabase,
  SqliteExecuteResult,
  SqliteValue,
} from "../app/data/sqlite-article-repository";

class NodeSqliteAdapter implements SqliteDatabase {
  selectCount = 0;
  beforeTransaction?: () => void;

  constructor(private readonly database: DatabaseSync) {}

  async execute(
    sql: string,
    bindValues: SqliteValue[] = [],
  ): Promise<SqliteExecuteResult> {
    if (sql === "BEGIN IMMEDIATE") this.beforeTransaction?.();
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

test("adopts a confirmed career route atomically and preserves the current action", async () => {
  const database = new DatabaseSync(":memory:");
  const adapter = new NodeSqliteAdapter(database);
  const repository = new SqliteProjectRepository(adapter, { seedProjects: initialProjectSeeds });
  const original = (await repository.list()).find(project => project.title === "机器人岗位投递与面试迭代")!;
  const target = await repository.saveProject({ ...original, planningMode: "staged" });
  const snapshot = await repository.careerSnapshot(target.id);
  const draft = { jobId: crypto.randomUUID(), projectId: target.id, snapshot, title: "机器人岗位路线", outcome: "准备投递",
    stages: [{ title: "岗位要求对照", done: "完成五份职位要求对比" }], action: "核对现有材料", body: "依据 [s1]",
    links: ["https://example.org/jobs"] };
  adapter.beforeTransaction = () => {
    adapter.beforeTransaction = undefined;
    database.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run("2026-11-15T13:00:00.000Z", target.id);
  };
  await assert.rejects(repository.adoptCareerRoute(draft), /发生了变化/);
  assert.equal(database.prepare("SELECT count(*) AS count FROM project_accumulations WHERE id = ?").get("asaba-worker-" + draft.jobId)?.count, 0);
  const refreshed = { ...draft, snapshot: await repository.careerSnapshot(target.id) };
  assert.equal(await repository.adoptCareerRoute(refreshed), target.id);
  assert.equal(await repository.adoptCareerRoute(refreshed), target.id);
  await assert.rejects(repository.adoptCareerRoute({ ...refreshed, projectId: null }), /另一项目/);
  const existing = (await repository.get(target.id))!;
  assert.equal(existing.tasks.find(task => task.id === original.nextTask?.id)?.status, original.nextTask?.status);
  assert.equal(existing.tasks.filter(task => task.title === draft.action && task.status === "later").length, 1);
  assert.equal(existing.milestones.filter(stage => stage.title === draft.stages[0].title && stage.dueDate === "").length, 1);
  assert.equal(existing.accumulations.filter(item => item.id === "asaba-worker-" + draft.jobId).length, 1);
  const createdId = await repository.adoptCareerRoute({ ...draft, jobId: crypto.randomUUID(), projectId: null, snapshot: null });
  const created = (await repository.get(createdId))!;
  assert.equal(created.project.planningMode, "staged");
  assert.equal(created.milestones[0].status, "current");
  assert.equal(created.tasks[0].milestoneId, created.milestones[0].id);
  const direct = await repository.saveProject({ ...created.project, planningMode: "direct" });
  await repository.adoptCareerRoute({ ...draft, jobId: crypto.randomUUID(), projectId: direct.id,
    snapshot: await repository.careerSnapshot(direct.id), action: "" });
  const directResult = (await repository.get(direct.id))!;
  assert.equal(directResult.milestones.length, 1);
  assert.equal(directResult.accumulations.length, 2);
  database.close();
});

test("archives a worker report and optional action exactly once without replacing the current action", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database), { seedProjects: initialProjectSeeds });
  const project = (await repository.list()).find(item => item.title === "机器人岗位投递与面试迭代")!;
  assert.ok(project.nextTask);
  const id = crypto.randomUUID();
  const link = "https://example.org/jobs/ros";
  await repository.archiveWorkerReport(project.id, id, "ROS2 调研", "岗位 A 要求熟悉 ROS2 [s1]", [link], "核对岗位");
  await repository.archiveWorkerReport(project.id, id, "重复归档", "第二次请求", [], "重复行动");
  const detail = (await repository.get(project.id))!;
  const saved = detail.accumulations.filter(item => item.id === "asaba-worker-" + id);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].reference, link);
  assert.equal(saved[0].title, "ROS2 调研");
  const input = buildAsabaProgressInput("ROS2 调研里写了什么？", detail);
  assert.ok(input.evidence.some(item => item.id === "accumulation:" + saved[0].id && item.text.includes("岗位 A")));
  assert.equal(detail.tasks.find(task => task.id === project.nextTask?.id)?.status, "next");
  assert.equal(detail.tasks.filter(task => task.title === "核对岗位" && task.status === "later").length, 1);
  await repository.updateProjectStatus(project.id, "completed", "验收");
  await assert.rejects(repository.archiveWorkerReport(project.id, crypto.randomUUID(), "新成果", "内容", [], ""), /归档或删除/);
  database.close();
});

test("浅羽 confirms all four destinations without overwriting existing commitments on retry", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database), { seedProjects: [] });
  const notes = new Map<string, string>();
  const saveNote = async (id: string, text: string) => notes.set(id, text);
  const command: AsabaPlanSave = {
    id: crypto.randomUUID(), request: "我想为明年求职做准备", attachMilestone: false,
    draft: { kind: "new_project", title: "求职准备", outcome: "整理出可投递的求职材料", reason: "需要持续推进",
      questions: ["目标岗位？"], action: "整理已有经历", projectId: null, projectTitle: "", milestone: null },
  };
  const { projectId } = await writeAsabaPlan(repository, saveNote, command);
  assert.ok(projectId);
  await writeAsabaPlan(repository, saveNote, command);
  const project = (await repository.get(projectId))!;
  assert.equal(project.project.targetDate, "");
  assert.equal(project.tasks.length, 1);
  assert.equal(project.tasks[0].status, "next");
  const addition: AsabaPlanSave = {
    ...command, id: crypto.randomUUID(),
    draft: previewAsabaPlan({ ...command.draft, kind: "existing_project", projectId, action: "列出意向岗位" }, [project]),
  };
  await writeAsabaPlan(repository, saveNote, addition);
  await writeAsabaPlan(repository, saveNote, addition);
  assert.deepEqual((await repository.get(projectId))?.tasks.map(task => [task.title, task.status]),
    [["整理已有经历", "next"], ["列出意向岗位", "later"]]);
  assert.throws(() => previewAsabaPlan({ ...addition.draft, projectId: "unknown" }, [project]), /已不可用/);
  await repository.updateProjectStatus(projectId, "completed", "完成");
  await assert.rejects(writeAsabaPlan(repository, saveNote, { ...addition, id: crypto.randomUUID() }), /已不可用/);
  await repository.removeProject(projectId);
  await assert.rejects(writeAsabaPlan(repository, saveNote, { ...addition, id: crypto.randomUUID() }), /已不可用/);
  await writeAsabaPlan(repository, saveNote, { ...command, id: crypto.randomUUID(), draft: { ...command.draft, kind: "action" } });
  assert.equal((await repository.listStandaloneTasks())[0].title, "整理已有经历");
  await writeAsabaPlan(repository, saveNote, { ...command, draft: { ...command.draft, kind: "note" } });
  assert.equal(notes.get(command.id), command.request);
  database.close();
});

test("staged and adaptive goals can wait for a route or feedback without inventing a date", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database), { seedProjects: [] });
  const request = "建立一个可长期探索的方向";
  const { projectId } = await writeAsabaPlan(repository, async () => {}, {
    id: crypto.randomUUID(), request, attachMilestone: false,
    draft: { kind: "new_project", title: "探索主题", outcome: request, reason: "目标明确",
      questions: [], action: "", projectId: null, projectTitle: "", milestone: null },
  });
  const { project } = (await repository.get(projectId!))!;
  for (const planningMode of ["staged", "adaptive"] as const) {
    await repository.saveWorkspace({ ...project, planningMode }, [], null);
    const [summary] = await repository.list();
    assert.equal(projectProgress(summary), "路径待明确");
    assert.equal(summary.reviewDate, "");
  }
  assert.equal(projectProgress({ status: "paused", nextTask: null }), "已暂停");
  database.close();
});

test("a week draft is atomic and a stale confirmation cannot overwrite a newer arrangement", async () => {
  const database = new DatabaseSync(":memory:");
  const adapter = new NodeSqliteAdapter(database);
  const repository = new SqliteProjectRepository(adapter, { seedProjects: initialProjectSeeds });
  const work = new SqliteWorkRepository(adapter);
  await work.ready();
  await new DashboardRepository(adapter).ready();
  const detail = await repository.get("project-life-workbench-v01");
  assert.ok(detail);
  const project = { ...detail.project, id: "new-week-project", title: "学习整理表格", planningMode: "direct" as const };
  const task = { ...detail.tasks[0], id: "week-action", projectId: project.id, milestoneId: null, title: "读入表格", dueDate: "", status: "later" as const };
  const start = await repository.readProjectWeek();
  const write = {
    revision: start.revision, settings: start.settings, project, tasks: [task], reason: "",
    placements: [{ action: { id: task.id, projectId: project.id, title: task.title, due: "", date: "", minutes: 25, status: task.status, fixed: false, after: [] }, date: "2026-11-12", reason: "" }],
  };
  await assert.rejects(repository.applyProjectWeek({ ...write, tasks: [{ ...task, projectId: "missing-parent" }] }));
  assert.equal(await repository.get(project.id), null);
  await repository.applyProjectWeek(write);
  assert.equal((await work.listPlans()).find((plan) => plan.taskId === task.id)?.estimateMinutes, 25);
  assert.equal((await repository.get(project.id))?.tasks[0].autoSchedulePaused, true);
  const current = await repository.readProjectWeek();
  adapter.beforeTransaction = () => { database.prepare("UPDATE task_plans SET planned_date = ? WHERE task_id = ?").run("2026-11-16", task.id); };
  await assert.rejects(repository.applyProjectWeek({ ...write, revision: current.revision, project: undefined, tasks: [] }), /安排已变化/);
  assert.equal((await work.listPlans()).find((plan) => plan.taskId === task.id)?.plannedDate, "2026-11-16");
});

test("loads the project index in three reads and a selected project in three more", async () => {
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
  assert.equal(adapter.selectCount, 3);
});

test("planning overview reads progress and accumulations and accepts an action with only a title", async () => {
  const adapter = new NodeSqliteAdapter(new DatabaseSync(":memory:"));
  const repository = new SqliteProjectRepository(adapter, { seedProjects: initialProjectSeeds, clock: () => new Date("2026-10-22T04:00:00Z") });
  const detail = await repository.get("project-life-workbench-v01");
  assert.ok(detail);
  const action = await repository.saveTask({ ...detail.tasks[0], id: "title-only", title: "核对一个结果", currentFocus: "", definitionOfDone: "", details: "", steps: [] });
  assert.equal(action.currentFocus, "");
  assert.equal(action.definitionOfDone, "");
  await repository.recordTaskProgress(action.id, "已核对第一个结果", "稍后核对另一个");
  for (let index = 0; index < 15; index += 1) await repository.addLog(detail.project.id, `计划说明${index}`, null, "plan_revision");
  await repository.saveAccumulation({ id: "fact", projectId: detail.project.id, milestoneId: null, title: "已有结论", content: "只剩另一个结果待核对", reference: "", createdAt: "", updatedAt: "" });
  adapter.selectCount = 0;
  const overview = await repository.listPlanningDetails();
  assert.equal(adapter.selectCount, 5); // Three index reads, then two batched history reads.
  const loaded = overview.find((item) => item.project.id === detail.project.id)!;
  assert.equal(loaded.tasks.find((task) => task.id === action.id)?.definitionOfDone, "");
  assert.ok(loaded.logs.some((log) => log.kind === "task_progress" && log.body.includes("已核对第一个结果")));
  assert.equal(loaded.accumulations[0].content, "只剩另一个结果待核对");
  assert.ok(loaded.logs.length <= 15);
});

test("seeds staged projects and persists project progress", async () => {
  const database = new DatabaseSync(":memory:");
  const adapter = new NodeSqliteAdapter(database);
  const repository = new SqliteProjectRepository(adapter, {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-08-10T10:00:00.000Z"),
  });

  const seeded = await repository.list();
  assert.equal(seeded.length, 9);
  assert.deepEqual(projectStatusCounts(seeded), { active: 7, paused: 2, completed: 0 });
  assert.equal(seeded[0].title, "机器人岗位投递与面试迭代");
  assert.equal(seeded[0].category, "career");
  assert.equal(seeded[0].isDraft, false);
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

  const lidarPortfolio = await repository.get("project-ros2-lidar-uav-portfolio");
  assert.ok(lidarPortfolio);
  assert.equal(lidarPortfolio.project.targetDate, "2027-05-15");
  assert.equal(lidarPortfolio.milestones.length, 4);
  assert.equal(lidarPortfolio.tasks.length, 10);
  assert.equal(lidarPortfolio.tasks.filter((task) => task.status === "next").length, 1);
  assert.match(lidarPortfolio.tasks.find((task) => task.status === "next")?.currentFocus ?? "", /当前系统/);

  const fastLio2 = await repository.get("project-fast-lio2-depth");
  assert.ok(fastLio2);
  assert.equal(fastLio2.project.status, "paused");
  assert.equal(fastLio2.tasks.filter((task) => task.status === "next").length, 0);
  assert.match(fastLio2.logs[0]?.body ?? "", /启动规则/);

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
  assert.equal((await reopened.list()).length, 9);
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

test("switches staged work to direct without deleting history and allows adaptive work without a review date", async () => {
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
  assert.equal(adaptive?.project.reviewDate, "");
  assert.equal(adaptive?.milestones.find((milestone) => milestone.status === "planned")?.title, "完成论文主体");
});

test("applies only selected AI adjustments atomically and records the complete revision", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database), {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-08-13T10:00:00.000Z"),
  });
  await repository.confirmProject("project-research-direction");
  const detail = await repository.get("project-research-direction");
  assert.ok(detail);
  const oldTask = detail.tasks[0];
  const current = detail.milestones.find((milestone) => milestone.status === "current");
  assert.ok(oldTask && current);
  await repository.applyProjectAdjustment({
    projectId: detail.project.id,
    expectedUpdatedAt: detail.project.updatedAt,
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

test("浅羽 reads dated progress and waiting conditions from the selected project only", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database), { seedProjects: initialProjectSeeds });
  const detail = (await repository.get("project-research-direction"))!;
  const task = detail.tasks[0];
  await repository.recordTaskProgress(task.id, "完成基线核对", "整理两页说明");
  await repository.saveTask({ ...task, status: "waiting", waitingFor: "导师反馈", resumeAction: "收到意见后核对实验范围" });
  await repository.saveAccumulation({ id: "", projectId: detail.project.id, title: "对照实验", content: "已有三组对照结果", reference: "", milestoneId: null, createdAt: "", updatedAt: "" });
  const input = buildAsabaProgressInput("现在做到哪了？", (await repository.get(detail.project.id))!);
  assert.ok(input.evidence.some(item => item.kind === "progress" && item.text === "完成基线核对" && item.date));
  assert.ok(input.evidence.some(item => item.kind === "waiting" && item.text === "导师反馈 · 收到意见后核对实验范围"));
  assert.ok(input.evidence.some(item => item.kind === "accumulation" && item.text === "已有三组对照结果"));
  assert.equal(input.project.deadline, "");
  assert.ok(input.evidence.every(item => item.title !== "采集 20 个目标岗位并建立技能矩阵"));
  database.close();
});

test("plan confirmation refuses a project changed while applying the proposal", async () => {
  const database = new DatabaseSync(":memory:");
  const adapter = new NodeSqliteAdapter(database);
  const repository = new SqliteProjectRepository(adapter, { seedProjects: initialProjectSeeds });
  await repository.confirmProject("project-research-direction");
  const { project } = (await repository.get("project-research-direction"))!;
  adapter.beforeTransaction = () => {
    database.prepare("UPDATE projects SET updated_at = ?, outcome = ? WHERE id = ?")
      .run("2099-01-01T00:00:00.000Z", "用户的新目标", project.id);
  };
  await assert.rejects(repository.applyProjectAdjustment({
    projectId: project.id, expectedUpdatedAt: project.updatedAt, trigger: "导师反馈",
    model: "deepseek-flash", tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    proposal: { summary: "调整", projectPatch: { outcome: "草案旧目标", targetDate: null, reviewDate: null },
      milestoneChanges: [], newMilestones: [], taskChanges: [], newTasks: [], assumptions: [], risks: [] },
  }), /项目已发生变化/);
  assert.equal((await repository.get(project.id))?.project.outcome, "用户的新目标");
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
  const projects = await repository.list();
  assert.equal(projects.find((project) => project.id === branch.id)?.parentProjectId, parent.project.id);
  assert.equal(projectStatusCounts(projects)[branch.status], projectStatusCounts(projects.filter((item) => item.id !== branch.id))[branch.status] + 1);

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

test("deletes only the parent and preserves its detached child and the child's data", async () => {
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
    title: "保留的子项目",
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
  const childTask = await repository.saveTask({ ...parent.tasks[0], id: "child-action", projectId: branch.id, milestoneId: null });
  await repository.addLog(branch.id, "子项目记录");

  await repository.removeProject(parent.project.id);

  const remaining = await repository.list();
  assert.equal(remaining.some((project) => project.id === parent.project.id), false);
  const child = (await repository.get(branch.id))!;
  assert.equal(child.project.parentProjectId, null);
  assert.equal(child.project.supportsMilestoneId, null);
  assert.equal(child.project.projectType, "main");
  assert.equal(child.tasks[0]?.id, childTask.id);
  assert.equal(child.logs[0]?.body, "子项目记录");
  assert.equal(database.prepare("SELECT project_id FROM articles WHERE id = ?").get("article-parent")?.project_id, "");
  assert.equal(database.prepare("SELECT project_id FROM articles WHERE id = ?").get("article-branch")?.project_id, branch.id);
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
    "4",
  );
  database.close();
});

test("adaptive checkpoints and actions progress independently and survive reopening", async () => {
  const database = new DatabaseSync(":memory:");
  const adapter = new NodeSqliteAdapter(database);
  const repository = new SqliteProjectRepository(adapter, { seedProjects: initialProjectSeeds });
  const original = await repository.get("project-research-direction");
  assert.ok(original);
  const first = { ...original.milestones[0], status: "current" as const };
  const second = { ...first, id: "parallel-review", title: "写综述", sortOrder: 200 };
  const candidate = { ...first, id: "future-candidate", title: "投稿", status: "planned" as const, sortOrder: 300 };
  await repository.saveWorkspace({ ...original.project, planningMode: "adaptive" }, [first, second, candidate], null);
  await repository.saveMilestone({ ...second, dueDate: "2026-10-01" });
  const action = original.tasks[0];
  await repository.saveTask({ ...action, milestoneId: first.id, status: "next" });
  await repository.saveTask({ ...action, id: "parallel-action", milestoneId: second.id, status: "next" });
  await repository.saveTask({ ...action, id: "replacement-action", milestoneId: first.id, status: "next" });
  assert.equal((await repository.get(original.project.id))?.tasks.find((item) => item.id === action.id)?.status, "later");
  await repository.updateTaskStatus(action.id, "next");
  const reopened = new SqliteProjectRepository(adapter);
  let detail = await reopened.get(original.project.id);
  assert.equal(detail?.milestones.filter((item) => item.status === "current").length, 2);
  assert.equal(detail?.tasks.filter((item) => item.status === "next").length, 2);
  await reopened.completeMilestone(first.id, "开题完成");
  detail = await reopened.get(original.project.id);
  assert.equal(detail?.milestones.find((item) => item.id === second.id)?.status, "current");
  assert.equal(detail?.milestones.find((item) => item.id === candidate.id)?.status, "planned");
  assert.equal(detail?.tasks.find((item) => item.id === "parallel-action")?.status, "next");
});

test("preserves parent, child and their links after restart and SQLite backup", async () => {
  const database = new DatabaseSync(":memory:");
  const adapter = new NodeSqliteAdapter(database);
  const repository = new SqliteProjectRepository(adapter, { seedProjects: initialProjectSeeds });
  const parent = await repository.get("project-research-direction");
  assert.ok(parent);
  const branch = await repository.saveProject({ ...parent.project, id: "legacy-side", title: "课程学习", projectType: "side", parentProjectId: parent.project.id, supportsMilestoneId: parent.milestones[0].id });
  await repository.saveMilestone({ ...parent.milestones[0], id: "legacy-node", projectId: branch.id });
  await repository.saveTask({ ...parent.tasks[0], id: "legacy-action", projectId: branch.id, milestoneId: "legacy-node" });
  await repository.addLog(branch.id, "课程看到第三章");
  const reopened = new SqliteProjectRepository(adapter);
  const detail = await reopened.get(branch.id);
  assert.equal(detail?.project.parentProjectId, parent.project.id);
  assert.equal(detail?.project.supportsMilestoneId, parent.milestones[0].id);
  assert.equal(detail?.project.projectType, "side");
  assert.equal(detail?.milestones.length, 1);
  assert.equal(detail?.tasks[0].milestoneId, "legacy-node");
  assert.ok(detail?.logs.some((log) => log.body === "课程看到第三章"));
  const directory = await mkdtemp(join(tmpdir(), "workbench-project-backup-"));
  const snapshotPath = join(directory, "snapshot.sqlite3");
  try {
    await backup(database, snapshotPath);
    const snapshot = new DatabaseSync(snapshotPath);
    try {
      const restored = await new SqliteProjectRepository(new NodeSqliteAdapter(snapshot)).get(branch.id);
      assert.deepEqual(restored, detail);
    } finally {
      snapshot.close();
    }
  } finally {
    database.close();
    await rm(snapshotPath, { force: true });
    await rmdir(directory);
  }
});

test("persists project tags and records directional changes without rewriting the route", async () => {
  const database = new DatabaseSync(":memory:");
  const adapter = new NodeSqliteAdapter(database);
  const repository = new SqliteProjectRepository(adapter, { seedProjects: initialProjectSeeds });
  const original = (await repository.get("project-research-direction"))!;
  const project = await repository.saveProject({ ...original.project, tags: [" 学业 ", "研究", "学业", ""] });
  const revised = await repository.saveProject({ ...project, outcome: "修订后的研究目标" }, true);
  await repository.saveProject(revised, true);
  const reopened = new SqliteProjectRepository(adapter);
  const detail = (await reopened.get(project.id))!;
  assert.deepEqual(detail.project.tags, ["学业", "研究"]);
  assert.deepEqual(detail.milestones, original.milestones);
  assert.deepEqual(detail.tasks, original.tasks);
  const revisions = detail.logs.filter((log) => log.kind === "goal_revision");
  assert.equal(revisions.length, 1);
  assert.deepEqual(JSON.parse(revisions[0].body), { before: original.project.outcome, after: revised.outcome });
  const projects = await reopened.list();
  assert.deepEqual(filterProjects(projects, project.status, "修订", ["研究", "学业"]).map((item) => item.id), [project.id]);
  assert.deepEqual(filterProjects(projects, project.status, "修订", ["研究", "兴趣"]), []);
  database.exec("CREATE TRIGGER reject_goal_update BEFORE UPDATE OF outcome ON projects BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");
  await assert.rejects(() => reopened.saveProject({ ...detail.project, outcome: "应回滚的方向" }, true));
  assert.equal((await reopened.get(project.id))?.project.outcome, revised.outcome);
  assert.equal((await reopened.get(project.id))?.logs.filter((log) => log.kind === "goal_revision").length, 1);
  database.close();
});

test("keeps next actions and waiting visible while projecting milestone dates and confirmed outcomes", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database), { seedProjects: initialProjectSeeds });
  const source = (await repository.get("project-research-direction"))!;
  const project = await repository.saveProject({ ...source.project, id: "stage-two", isDraft: false, planningMode: "direct" });
  const first = await repository.saveMilestone({ ...source.milestones[0], id: "", projectId: project.id, status: "current", predecessorIds: [], dueDate: "", dueDateKind: null });
  assert.equal((await repository.get(project.id))?.project.planningMode, "staged");
  const second = await repository.saveMilestone({ ...first, id: "", title: "发表论文", dueDate: "2027-08-20", dueDateKind: "target", sortOrder: first.sortOrder + 10 }, true);
  const next = await repository.saveTask({ ...source.tasks[0], id: "stage-two-next", projectId: project.id, milestoneId: first.id, status: "next" });
  const wait = await repository.saveTask({ ...source.tasks[0], id: "stage-two-wait", projectId: project.id, milestoneId: second.id, status: "waiting", waitingFor: "外审反馈" });
  const outcome = { id: "", projectId: project.id, milestoneId: null, title: "第一篇论文", content: "已经发表", reference: "论文链接", isOutcome: true, createdAt: "", updatedAt: "" };
  await repository.saveAccumulation(outcome);
  await repository.saveAccumulation({ ...outcome, title: "第二篇论文" });
  let detail = (await repository.get(project.id))!;
  assert.equal(detail.project.planningMode, "adaptive");
  assert.equal(detail.milestones.filter((node) => node.status === "current").length, 2);
  assert.equal(detail.accumulations.filter((record) => record.isOutcome).length, 2);
  const status = projectWorkStatus(detail);
  assert.equal(status.next?.id, next.id);
  assert.equal(status.waiting[0]?.id, wait.id);
  assert.equal(status.recent?.source, "已确认成果");
  assert.deepEqual(projectCalendarEvents([detail]).map((event) => [event.date, event.milestone?.dateKind]), [["2027-08-20", "target"]]);
  await repository.saveMilestone({ ...second, dueDate: "2027-09-01", dueDateKind: "deadline" });
  detail = (await repository.get(project.id))!;
  assert.deepEqual(projectCalendarEvents([detail]).map((event) => [event.date, event.milestone?.dateKind]), [["2027-09-01", "deadline"]]);
  await repository.removeMilestone(second.id);
  assert.deepEqual(projectCalendarEvents([(await repository.get(project.id))!]), []);
  database.close();
});

test("retains the latest attempt and keeps unrelated jobs with no note id", () => {
  const job = (id: string, updatedAt: string, fields: Partial<AsabaJob> = {}): AsabaJob => ({
    id, updatedAt, noteId: "", projectId: "test", title: "委托", description: "", repository: "", agent: "codex", workspaceMode: "copy",
    hadLocalChanges: false, previousJobId: null, base: null, sessionId: null, summary: null, commands: [], diff: null, error: null, state: "failed", ...fields,
  });
  const first = job("first", "2026-10-01", { noteId: "note" });
  const retried = job("retry", "2026-10-02", { noteId: "note", state: "review", previousJobId: first.id });
  const groups = projectJobGroups([first, job("other", "2026-10-01"), retried, job("later", "2026-10-03")]);
  assert.deepEqual(groups.map(({ latest }) => latest.id), ["later", "retry", "other"]);
  assert.deepEqual(groups[1].previous.map(({ id }) => id), [first.id]);
});

test("persists fork and merge edges, preserves lanes on completion, and gates a merge on all parents", async () => {
  const adapter = new NodeSqliteAdapter(new DatabaseSync(":memory:"));
  const repository = new SqliteProjectRepository(adapter, { seedProjects: initialProjectSeeds });
  const original = await repository.get("project-research-direction");
  assert.ok(original);
  const base = { ...original.milestones[0], id: "graph-base", title: "理解领域", status: "completed" as const, predecessorIds: [], sortOrder: 10 };
  const left = { ...base, id: "graph-proposal", title: "开题报告", status: "current" as const, predecessorIds: [base.id], sortOrder: 20 };
  const right = { ...left, id: "graph-review", title: "综述写作", sortOrder: 30 };
  const merge = { ...base, id: "graph-merge", title: "整理研究方案", status: "planned" as const, predecessorIds: [left.id, right.id], sortOrder: 40 };
  await repository.saveWorkspace({ ...original.project, planningMode: "adaptive" }, [base, left, right, merge], null);
  const { routeLayers } = await import("../app/project-route");
  const before = routeLayers((await repository.get(original.project.id))!.milestones).map((row) => row.map((node) => node.id));
  assert.deepEqual(before, [[base.id], [left.id, right.id], [merge.id]]);
  await repository.completeMilestone(left.id, "开题验收");
  await assert.rejects(repository.saveMilestone({ ...merge, status: "current" }), /前置节点/);
  assert.equal((await repository.get(original.project.id))?.milestones.find((node) => node.id === right.id)?.status, "current");
  await repository.completeMilestone(right.id, "综述验收");
  await repository.saveMilestone({ ...merge, status: "current" });
  const reopened = await new SqliteProjectRepository(adapter).get(original.project.id);
  assert.ok(reopened);
  assert.deepEqual(routeLayers(reopened.milestones).map((row) => row.map((node) => node.id)), before);
  assert.deepEqual(reopened.milestones.find((node) => node.id === merge.id)?.predecessorIds, [left.id, right.id]);
  const { UniversalSyncRepository } = await import("../app/data/universal-sync-repository");
  const pending = await new UniversalSyncRepository(adapter).listPending();
  const syncedMerge = pending.find((item) => item.entityType === "milestone" && item.id === merge.id);
  assert.ok(syncedMerge);
  assert.deepEqual(JSON.parse(String(syncedMerge.payload.predecessor_ids)), [left.id, right.id]);
  await assert.rejects(repository.saveMilestone({ ...base, predecessorIds: [merge.id] }), /循环/);
  await assert.rejects(repository.saveMilestone({ ...right, predecessorIds: ["another-project-node"] }), /同一项目/);
  await assert.rejects(repository.removeMilestone(left.id), /后续任务/);
});

test("stores free-form project accumulation notes and makes a deleted checkpoint note shared", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database), {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-09-22T08:00:00.000Z"),
  });
  const detail = await repository.get("project-life-workbench-v01");
  assert.ok(detail);
  const checkpoint = detail.milestones.find((item) => item.status === "current");
  assert.ok(checkpoint);
  const saved = await repository.saveAccumulation({
    id: "",
    projectId: detail.project.id,
    milestoneId: checkpoint.id,
    title: "",
    content: "使用工作台推进一次科研任务并记录摩擦。行动编辑需要更接近当前任务线。",
    reference: "notes/real-use",
    createdAt: "",
    updatedAt: "",
  });
  assert.match((await repository.get(detail.project.id))?.accumulations[0].content ?? "", /记录摩擦/);
  database.prepare("UPDATE project_accumulations SET completed_work = ?, takeaway = ? WHERE id = ?")
    .run("旧格式完成内容", "旧格式关键结论", saved.id);
  const legacyContent = (await repository.get(detail.project.id))?.accumulations[0].content ?? "";
  assert.match(legacyContent, /旧格式完成内容/);
  assert.match(legacyContent, /旧格式关键结论/);
  await repository.saveAccumulation({ ...saved, content: "下一行动建议必须隔离并行分支" });
  assert.match((await repository.get(detail.project.id))?.accumulations[0].content ?? "", /隔离并行分支/);
  await repository.removeMilestone(checkpoint.id);
  assert.equal((await repository.get(detail.project.id))?.accumulations[0].milestoneId, null);
  await repository.removeAccumulation(saved.id);
  assert.deepEqual((await repository.get(detail.project.id))?.accumulations, []);
  database.close();
});

test("applies an AI route atomically, locks completed history and detaches work from a superseded checkpoint", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteProjectRepository(new NodeSqliteAdapter(database), {
    seedProjects: initialProjectSeeds,
    clock: () => new Date("2026-09-22T08:00:00.000Z"),
  });
  const original = await repository.get("project-life-workbench-v01");
  assert.ok(original);
  await repository.saveWorkspace({ ...original.project, planningMode: "adaptive" }, original.milestones, null);
  const adaptive = await repository.get(original.project.id);
  assert.ok(adaptive);
  const current = adaptive.milestones.find((item) => item.status === "current")!;
  const lastCompleted = adaptive.milestones.filter((item) => item.status === "completed").at(-1)!;
  await repository.applyProjectRoute({
    projectId: adaptive.project.id,
    currentSituation: "真实使用发现原检查点过于宽泛",
    requirements: "先验证新的最小闭环",
    model: "deepseek-flash",
    tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    proposal: {
      summary: "用新的验证节点替代旧检查点",
      nodes: [
        { ref: current.id, existingMilestoneId: current.id, action: "supersede", title: current.title, definitionOfDone: current.definitionOfDone, dueDate: current.dueDate, status: "planned", predecessorRefs: [] },
        { ref: "new-current", existingMilestoneId: null, action: "create", title: "验证分支隔离", definitionOfDone: "两个并行分支能分别获得行动建议", dueDate: "2026-09-30", status: "current", predecessorRefs: [lastCompleted.id] },
      ],
      assumptions: [], risks: [],
    },
  });
  const updated = await repository.get(adaptive.project.id);
  assert.ok(updated);
  assert.equal(updated.milestones.find((item) => item.id === current.id)?.status, "superseded");
  assert.equal(updated.milestones.find((item) => item.title === "验证分支隔离")?.status, "current");
  assert.equal(updated.milestones.find((item) => item.id === lastCompleted.id)?.status, "completed");
  assert.equal(updated.tasks.find((item) => item.id === `${adaptive.project.id}-task-1`)?.milestoneId, null);
  assert.ok(updated.logs.some((item) => item.kind === "plan_revision" && item.body.includes("主线规划")));
  database.close();
});

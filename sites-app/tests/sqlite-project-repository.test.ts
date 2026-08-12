import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initialProjectSeeds } from "../app/data/project-seeds";
import { SqliteProjectRepository } from "../app/data/sqlite-project-repository";
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
  assert.equal(seeded[0].title, "科研方向选择");
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
  database.close();
});

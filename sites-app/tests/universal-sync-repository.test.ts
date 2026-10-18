import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AttachmentRepository } from "../app/data/attachment-repository";
import {
  SqliteArticleRepository,
  type SqliteDatabase,
  type SqliteExecuteResult,
  type SqliteValue,
} from "../app/data/sqlite-article-repository";
import { UniversalSyncRepository } from "../app/data/universal-sync-repository";
import { SqliteProjectRepository } from "../app/data/sqlite-project-repository";
import { SqliteWorkRepository } from "../app/data/sqlite-work-repository";
import { initialProjectSeeds } from "../app/data/project-seeds";
import type { Article } from "../app/types";

class NodeSqliteAdapter implements SqliteDatabase {
  constructor(private readonly database: DatabaseSync) {}

  async execute(sql: string, values: SqliteValue[] = []): Promise<SqliteExecuteResult> {
    const result = this.database.prepare(sql).run(...values);
    return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
  }

  async select<T>(sql: string, values: SqliteValue[] = []): Promise<T[]> {
    return this.database.prepare(sql).all(...values) as T[];
  }
}

const seed: Article = {
  id: "notes/seed",
  slug: "seed",
  collection: "notes",
  collectionLabel: "笔记",
  title: "同步种子",
  created: "2026-08-30",
  updated: "2026-08-30",
  branch: "已整理",
  subbranch: "",
  stage: "常青",
  validity: "",
  category: "uncategorized",
  tags: [],
  type: "记录",
  project: "",
  projectId: "",
  confidence: "",
  source: ["自写"],
  reviewDate: "",
  summary: "同步种子",
  next: "",
  body: "正文",
};

test("focus history corrections and deletions enter the sync outbox", async () => {
  const database = new DatabaseSync(":memory:");
  const adapter = new NodeSqliteAdapter(database);
  await new SqliteArticleRepository(adapter, { seedArticles: [] }).ready();
  let now = new Date("2026-08-30T08:00:00Z");
  const work = new SqliteWorkRepository(adapter, () => now);
  await work.ready();
  const sync = new UniversalSyncRepository(adapter);
  await sync.initialize();
  const session = await work.startSession({ label: "修正同步" });
  now = new Date("2026-08-30T10:00:00Z");
  await work.stopSession(session.id);
  await work.updateSession({ id: session.id, startedAt: session.startedAt, endedAt: "2026-08-30T08:30:00Z" });
  let pending = (await sync.listPending()).find((item) => item.id === session.id);
  assert.equal(pending?.entityType, "focus_session");
  assert.equal(pending?.payload.duration_seconds, 1800);
  await work.deleteSession(session.id);
  pending = (await sync.listPending()).find((item) => item.id === session.id);
  assert.equal(pending?.operation, "delete");
  database.close();
});

test("failed uploads retain their payload and can be returned to the queue", async () => {
  const database = new DatabaseSync(":memory:");
  const adapter = new NodeSqliteAdapter(database);
  await new SqliteArticleRepository(adapter, { seedArticles: [seed] }).ready();
  const sync = new UniversalSyncRepository(adapter);
  const item = (await sync.listPending())[0];
  await sync.markError(item.changeId, "附件连接失败");
  assert.equal((await sync.getStatus()).errors, 1);
  assert.equal((await sync.listPending()).length, 0);
  await sync.retryError(item.entityType, item.id);
  assert.deepEqual((await sync.listPending())[0], item);
  assert.equal((await sync.getStatus()).errors, 0);
  database.close();
});

test("captures domain mutations into one durable v3 outbox", async () => {
  const database = new DatabaseSync(":memory:");
  const adapter = new NodeSqliteAdapter(database);
  const articles = new SqliteArticleRepository(adapter, {
    deviceId: "test-device",
    seedArticles: [seed],
    clock: () => new Date("2026-08-30T08:00:00.000Z"),
  });
  await articles.ready();
  await new AttachmentRepository(adapter).initialize();
  const sync = new UniversalSyncRepository(adapter);
  await sync.initialize();

  const bootstrapped = await sync.listPending();
  assert.equal(bootstrapped.some((item) => item.entityType === "article" && item.id === seed.id), true);

  await sync.commit({
    protocolVersion: 3,
    cursor: "1",
    hasMore: false,
    accepted: bootstrapped.map((item) => ({
      entityType: item.entityType,
      id: item.id,
      version: 1,
      changeId: item.changeId,
    })),
    conflicts: [],
    failed: [],
    changes: [],
  });
  assert.equal((await sync.listPending()).length, 0);

  const saved = await articles.save({ ...seed, title: "修改后的同步种子", storage: (await articles.list())[0].storage });
  const pending = await sync.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].baseVersion, 1);
  assert.equal(pending[0].payload.title, saved.title);

  await articles.remove(seed.id);
  const deleted = await sync.listPending();
  assert.equal(deleted[0].operation, "delete");
  assert.equal((await sync.listRecycle()).length, 1);
  database.close();
});

test("initializes capture triggers safely when startup overlaps", async () => {
  const database = new DatabaseSync(":memory:");
  const adapter = new NodeSqliteAdapter(database);
  const articles = new SqliteArticleRepository(adapter, {
    deviceId: "test-device",
    seedArticles: [],
  });
  await articles.ready();
  await new AttachmentRepository(adapter).initialize();

  const first = new UniversalSyncRepository(adapter);
  const second = new UniversalSyncRepository(adapter);
  await Promise.all([first.initialize(), second.initialize()]);

  const triggers = database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync_capture_%'").all();
  assert.ok(triggers.length > 0);
  assert.equal(new Set(triggers.map((row) => String(row.name))).size, triggers.length);
  database.close();
});

test("round-trips standalone tasks and structured logs with null project ids", async () => {
  const sourceDatabase = new DatabaseSync(":memory:");
  const sourceAdapter = new NodeSqliteAdapter(sourceDatabase);
  const sourceProjects = new SqliteProjectRepository(sourceAdapter);
  await sourceProjects.ready();
  const sourceSync = new UniversalSyncRepository(sourceAdapter);
  await sourceSync.initialize();
  const now = "2026-08-30T08:00:00.000Z";
  const task = await sourceProjects.saveTask({
    id: "standalone-sync", projectId: null, milestoneId: null, direction: "learning", title: "给导师发消息",
    actionType: "communicate", definitionOfDone: "导师收到消息", steps: [], currentFocus: "写完并发送",
    details: "", benefit: "", dueDate: "2026-09-30", estimatedDays: 3, autoSchedulePaused: true, status: "next", waitingFor: "", resumeAction: "", context: "phone",
    sortOrder: 10, createdAt: now, updatedAt: now, completedAt: null,
  });
  const log = await sourceProjects.addLog(null, "独立行动接续点", task.id, "continuation");
  const pending = await sourceSync.listPending();
  const taskChange = pending.find((item) => item.entityType === "task" && item.id === task.id);
  const logChange = pending.find((item) => item.entityType === "log" && item.id === log.id);
  assert.equal(taskChange?.payload.project_id, null);
  assert.equal(taskChange?.payload.direction, "learning");
  assert.equal(taskChange?.payload.estimated_days, 3);
  assert.equal(taskChange?.payload.auto_schedule_paused, 1);
  assert.equal(logChange?.payload.project_id, null);
  assert.equal(logChange?.payload.task_id, task.id);
  assert.equal(logChange?.payload.kind, "continuation");

  const targetDatabase = new DatabaseSync(":memory:");
  const targetAdapter = new NodeSqliteAdapter(targetDatabase);
  const targetProjects = new SqliteProjectRepository(targetAdapter);
  await targetProjects.ready();
  const targetSync = new UniversalSyncRepository(targetAdapter);
  await targetSync.initialize();
  await targetSync.commit({
    protocolVersion: 3, cursor: "2", hasMore: false, accepted: [], conflicts: [], failed: [],
    changes: [taskChange!, logChange!].map((item, index) => ({
      entityType: item.entityType, id: item.id, operation: item.operation, payload: item.payload,
      changeId: `remote-${index}`, version: 1, deletedAt: null, updatedAt: now,
    })),
  });
  assert.equal((await targetProjects.listStandaloneTasks())[0]?.id, task.id);
  assert.equal((await targetProjects.listStandaloneTasks())[0]?.estimatedDays, 3);
  assert.equal((await targetProjects.listStandaloneTasks())[0]?.autoSchedulePaused, true);
  assert.equal((await targetProjects.listTaskLogs(task.id))[0]?.kind, "continuation");
  sourceDatabase.close(); targetDatabase.close();
});

test("round-trips structured project accumulations", async () => {
  const sourceDatabase = new DatabaseSync(":memory:");
  const sourceAdapter = new NodeSqliteAdapter(sourceDatabase);
  const sourceProjects = new SqliteProjectRepository(sourceAdapter, { seedProjects: initialProjectSeeds });
  await sourceProjects.ready();
  const sourceSync = new UniversalSyncRepository(sourceAdapter);
  await sourceSync.initialize();
  const saved = await sourceProjects.saveAccumulation({
    id: "shared-accumulation",
    projectId: "project-life-workbench-v01",
    milestoneId: null,
    title: "分支需要隔离",
    content: "已经用两个并行任务线验证上下文。下一行动只读取当前分支和共享成果。",
    reference: "notes/branch-context",
    createdAt: "2026-09-22T08:00:00.000Z",
    updatedAt: "2026-09-22T08:00:00.000Z",
  });
  const change = (await sourceSync.listPending()).find((item) => item.entityType === "accumulation" && item.id === saved.id);
  assert.equal(change?.payload.kind, "other");
  assert.equal(change?.payload.milestone_id, null);

  const targetDatabase = new DatabaseSync(":memory:");
  const targetAdapter = new NodeSqliteAdapter(targetDatabase);
  const targetProjects = new SqliteProjectRepository(targetAdapter, { seedProjects: initialProjectSeeds });
  await targetProjects.ready();
  const targetSync = new UniversalSyncRepository(targetAdapter);
  await targetSync.initialize();
  await targetSync.commit({
    protocolVersion: 3, cursor: "3", hasMore: false, accepted: [], conflicts: [], failed: [],
    changes: [{ entityType: "accumulation", id: change!.id, operation: "upsert", payload: change!.payload, changeId: "remote-accumulation", version: 1, deletedAt: null, updatedAt: "2026-09-22T08:00:00.000Z" }],
  });
  assert.equal((await targetProjects.get("project-life-workbench-v01"))?.accumulations[0]?.title, "分支需要隔离");
  assert.match((await targetProjects.get("project-life-workbench-v01"))?.accumulations[0]?.content ?? "", /共享成果/);
  sourceDatabase.close(); targetDatabase.close();
});

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAiRepository } from "../app/data/sqlite-ai-repository";
import type { GlobalPlanningRecord } from "../app/global-planning";
import type { SqliteDatabase, SqliteExecuteResult, SqliteValue } from "../app/data/sqlite-article-repository";

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

test("planning history survives closing the database, supports pagination and is not expired with chats", async () => {
  const directory = mkdtempSync(join(tmpdir(), "planning-history-"));
  const path = join(directory, "history.db");
  let database: DatabaseSync | null = new DatabaseSync(path);
  const record = (index: number): GlobalPlanningRecord => ({
    id: `record-${index}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    request: `当时只有${index}分钟`, model: "deepseek-flash", titles: ["当时的行动名称"],
    proposal: { summary: `先做第${index}件事`, suggestions: [{ projectId: "deleted-project", taskId: "deleted-task", reason: "保留判断依据", nextStep: "核对一条结果" }], questions: ["是否提交？"] },
    clarifications: [{ question: "还有哪些限制？", answer: "只核对结果" }],
  });
  try {
    const repository = new SqliteAiRepository(new NodeSqliteAdapter(database));
    for (let index = 0; index < 25; index += 1) await repository.savePlanningRecord(record(index));
    await repository.savePlanningRecord(record(24));
    database.close(); database = null;
    database = new DatabaseSync(path);
    const reopened = new SqliteAiRepository(new NodeSqliteAdapter(database), () => new Date("2028-01-01"));
    await reopened.cleanupExpired();
    const first = await reopened.listPlanningHistory(20);
    assert.equal(first.length, 20);
    assert.equal(first[0].id, "record-24");
    assert.equal(first[19].id, "record-5");
    const rest = await reopened.listPlanningHistory(20, 20);
    assert.equal(rest.length, 5);
    assert.equal(rest[4].id, "record-0");
    assert.deepEqual(await reopened.getPlanningRecord("record-24"), record(24));
    assert.equal(await reopened.getPlanningRecord("missing"), null);
  } finally {
    database?.close();
    unlinkSync(path);
    rmdirSync(directory);
  }
});

test("stores ordered AI messages and remote restore state", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteAiRepository(new NodeSqliteAdapter(database), () => new Date("2026-08-21T00:00:00Z"));
  const conversation = await repository.createConversation();
  await repository.addMessage(conversation.id, "user", "如何整理今天的计划？");
  const assistant = await repository.addMessage(conversation.id, "assistant", "先选出唯一的主结果。", "先判断哪些事情真正重要。");
  await repository.updateMessageContent(assistant.id, "先选出唯一的主结果，再安排下一步行动。", "先判断优先级，再检查时间约束。");
  await repository.updateRemoteState(conversation.id, "https://chat.deepseek.com/a/chat/s/test", "restored");
  const messages = await repository.listMessages(conversation.id);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(messages[1].content, "先选出唯一的主结果，再安排下一步行动。");
  assert.equal(messages[1].reasoning, "先判断优先级，再检查时间约束。");
  const saved = (await repository.listConversations())[0];
  assert.equal(saved.title, "如何整理今天的计划？");
  assert.equal(saved.restoreState, "restored");
  assert.equal(saved.remoteRef, "https://chat.deepseek.com/a/chat/s/test");
  database.close();
});

test("adds reasoning storage to an existing AI message table", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE ai_conversations (
    id TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL, title TEXT NOT NULL,
    remote_ref TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0,
    restore_state TEXT NOT NULL DEFAULT 'local', created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, expires_at TEXT
  );
  CREATE TABLE ai_messages (
    id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, sequence_index INTEGER NOT NULL, created_at TEXT NOT NULL
  );`);
  const repository = new SqliteAiRepository(new NodeSqliteAdapter(database), () => new Date("2026-08-24T00:00:00Z"));
  const conversation = await repository.createConversation();
  await repository.addMessage(conversation.id, "assistant", "最终回答", "独立的思考过程");
  assert.equal((await repository.listMessages(conversation.id))[0].reasoning, "独立的思考过程");
  assert.ok(database.prepare("PRAGMA table_info(ai_messages)").all().some((column) => column.name === "reasoning"));
  database.close();
});

test("removes expired conversations while preserving favorites", async () => {
  const database = new DatabaseSync(":memory:");
  let now = new Date("2026-01-01T00:00:00Z");
  const repository = new SqliteAiRepository(new NodeSqliteAdapter(database), () => now);
  const expired = await repository.createConversation("会过期");
  const favorite = await repository.createConversation("收藏");
  await repository.addMessage(expired.id, "user", "普通内容");
  await repository.addMessage(favorite.id, "user", "需要保留");
  await repository.setPinned(favorite.id, true);
  now = new Date("2026-02-02T00:00:00Z");
  assert.equal(await repository.cleanupExpired(), 1);
  assert.deepEqual((await repository.listConversations()).map((item) => item.id), [favorite.id]);
  assert.equal((await repository.listMessages(favorite.id)).length, 1);
  database.close();
});

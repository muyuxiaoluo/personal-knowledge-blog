import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteAiRepository } from "../app/data/sqlite-ai-repository";
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

test("stores ordered AI messages and remote restore state", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteAiRepository(new NodeSqliteAdapter(database), () => new Date("2026-08-21T00:00:00Z"));
  const conversation = await repository.createConversation();
  await repository.addMessage(conversation.id, "user", "如何整理今天的计划？");
  const assistant = await repository.addMessage(conversation.id, "assistant", "先选出唯一的主结果。");
  await repository.updateMessageContent(assistant.id, "先选出唯一的主结果，再安排下一步行动。");
  await repository.updateRemoteState(conversation.id, "https://chat.deepseek.com/a/chat/s/test", "restored");
  const messages = await repository.listMessages(conversation.id);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(messages[1].content, "先选出唯一的主结果，再安排下一步行动。");
  const saved = (await repository.listConversations())[0];
  assert.equal(saved.title, "如何整理今天的计划？");
  assert.equal(saved.restoreState, "restored");
  assert.equal(saved.remoteRef, "https://chat.deepseek.com/a/chat/s/test");
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

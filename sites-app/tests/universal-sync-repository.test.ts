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

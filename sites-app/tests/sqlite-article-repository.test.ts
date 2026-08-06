import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SqliteArticleRepository,
  type SqliteDatabase,
  type SqliteExecuteResult,
  type SqliteValue,
} from "../app/data/sqlite-article-repository";
import type { Article } from "../app/types";

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

const seedArticle: Article = {
  id: "thoughts/seed",
  slug: "seed",
  collection: "thoughts",
  collectionLabel: "想法与随笔",
  title: "已有想法",
  created: "2026-07-01",
  updated: "2026-07-01",
  branch: "思考随笔",
  subbranch: "生活观察",
  stage: "常青",
  validity: "有效",
  category: "想法与随笔",
  tags: ["旧记录"],
  type: "思考",
  project: "",
  confidence: "中",
  source: ["迁移"],
  reviewDate: "",
  summary: "用于验证首次迁移。",
  next: "",
  body: "这是一条已有内容。",
};

test("persists articles and sync metadata in a real SQLite database", async () => {
  const database = new DatabaseSync(":memory:");
  const adapter = new NodeSqliteAdapter(database);
  const fixedTime = new Date("2026-07-31T08:30:00.000Z");
  const repository = new SqliteArticleRepository(adapter, {
    deviceId: "windows-test-device",
    seedArticles: [seedArticle],
    clock: () => fixedTime,
  });

  const seeded = await repository.list();
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].storage.syncStatus, "pending");
  assert.deepEqual(seeded[0].tags, ["旧记录"]);
  assert.equal(await repository.getDeviceId(), "windows-test-device");
  await repository.markSynced([
    { id: seeded[0].id, version: seeded[0].storage.version },
  ]);

  const created = await repository.save({
    ...seedArticle,
    id: "",
    slug: "",
    title: "新的本地想法",
    created: "",
    updated: "",
    stage: "种子",
    body: "先记录，再慢慢整理。",
  });

  assert.match(created.id, /^thoughts\/新的本地想法-/);
  assert.equal(created.storage.version, 1);
  assert.equal(created.storage.deviceId, "windows-test-device");
  assert.equal(created.storage.syncStatus, "pending");

  let pending = await repository.listPendingChanges();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].operation, "upsert");

  await repository.markSynced([
    { id: created.id, version: created.storage.version },
  ]);
  assert.equal((await repository.listPendingChanges()).length, 0);

  const updated = await repository.save({
    ...created,
    body: "这条想法已经补充了一次。",
  });
  assert.equal(updated.storage.version, 2);
  assert.equal(updated.storage.syncStatus, "pending");

  await repository.remove(updated.id);
  assert.equal((await repository.list()).length, 1);
  pending = await repository.listPendingChanges();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].operation, "delete");
  assert.ok(pending[0].article.storage.deletedAt);

  assert.equal(await repository.getSyncCursor(), "");
  await repository.setSyncCursor("server-sequence-42");
  assert.equal(await repository.getSyncCursor(), "server-sequence-42");

  const remote = {
    ...seeded[0],
    title: "来自另一台设备的版本",
    updated: "2026-07-31T09:00:00.000Z",
    storage: {
      version: 2,
      deviceId: "another-device",
      syncStatus: "synced" as const,
      deletedAt: null,
    },
  };
  const remoteResult = await repository.applyRemoteChanges([
    { article: remote, operation: "upsert" },
  ]);
  assert.equal(remoteResult.applied, 1);
  assert.equal(remoteResult.conflicts, 0);
  assert.equal(
    (await repository.list()).find((article) => article.id === remote.id)?.title,
    "来自另一台设备的版本",
  );

  const backupDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "mind-garden-backup-"),
  );
  const backupPath = path.join(backupDirectory, "backup.sqlite3");
  await repository.createBackup(backupPath);
  const backupDatabase = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal(
    backupDatabase
      .prepare("SELECT COUNT(*) AS count FROM articles")
      .get().count,
    2,
  );
  backupDatabase.close();
  fs.rmSync(backupDirectory, { recursive: true, force: true });

  database.close();
});

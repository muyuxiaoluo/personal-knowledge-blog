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
  const summaries = await repository.listSummaries();
  assert.equal(summaries[0].body, "");
  const bodyMatches = await repository.listSummaries(50, 0, "已有内容");
  assert.deepEqual(bodyMatches.map((article) => article.id), [seedArticle.id]);
  assert.equal(bodyMatches[0].body, "");
  assert.equal((await repository.get(seedArticle.id))?.body, seedArticle.body);
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
  assert.equal(
    pending[0].changeId,
    `windows-test-device:${created.id}:1:upsert`,
  );

  await repository.markSynced([
    { id: created.id, version: created.storage.version },
  ]);
  assert.equal((await repository.listPendingChanges()).length, 0);

  const updatedBody = "这条想法已经补充了一次。\n保留手动换行。\n\n";
  const updated = await repository.save({
    ...created,
    body: updatedBody,
  });
  assert.equal(updated.storage.version, 2);
  assert.equal(updated.storage.syncStatus, "pending");
  assert.equal(updated.body, updatedBody);

  await repository.remove(updated.id);
  assert.equal((await repository.list()).length, 1);
  pending = await repository.listPendingChanges();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].operation, "delete");
  assert.ok(pending[0].article.storage.deletedAt);
  const restored = await repository.restore(updated.id);
  assert.equal(restored.storage.deletedAt, null);
  assert.equal(restored.storage.version, updated.storage.version + 2);
  assert.equal((await repository.list()).length, 2);
  pending = await repository.listPendingChanges();
  assert.equal(pending[0].operation, "upsert");

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

  await assert.rejects(
    () => repository.save({
      ...seeded[0],
      title: "基于旧版本继续编辑",
      body: "这段草稿不能覆盖同步得到的新版本。",
    }),
    /当前草稿没有覆盖新版本/,
  );
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

test("commits remote changes and cursor atomically while preserving one conflict copy", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new SqliteArticleRepository(new NodeSqliteAdapter(database), {
    deviceId: "desktop-device",
    seedArticles: [seedArticle],
    clock: () => new Date("2026-08-16T08:00:00.000Z"),
  });
  const local = (await repository.list())[0];
  const remote = {
    ...local,
    title: "手机端已经更新",
    updated: "2026-08-16T07:30:00.000Z",
    storage: {
      version: 2,
      deviceId: "phone-device",
      syncStatus: "synced" as const,
      deletedAt: null,
    },
  };
  const changes = [{ article: remote, operation: "upsert" as const }];

  database.exec(`
    CREATE TRIGGER reject_sync_cursor
    BEFORE INSERT ON app_meta
    WHEN NEW.key = 'sync_cursor'
    BEGIN
      SELECT RAISE(ABORT, 'cursor write rejected');
    END;
  `);
  await assert.rejects(
    () => repository.commitSyncResult([], changes, "12"),
    /cursor write rejected/,
  );
  assert.equal(await repository.getSyncCursor(), "");
  assert.deepEqual(
    (await repository.list()).map((article) => article.title),
    ["已有想法"],
  );

  database.exec("DROP TRIGGER reject_sync_cursor");
  assert.deepEqual(await repository.commitSyncResult([], changes, "12"), {
    applied: 1,
    conflicts: 1,
  });
  const afterRetry = await repository.list();
  assert.equal(await repository.getSyncCursor(), "12");
  assert.equal(afterRetry.length, 2);
  assert.ok(afterRetry.some((article) => article.title === "手机端已经更新"));
  const conflict = afterRetry.find((article) =>
    article.title.endsWith("（冲突副本）"),
  );
  assert.match(conflict?.id || "", /#conflict-[a-z0-9]{7}$/);

  await repository.commitSyncResult([], changes, "12");
  assert.equal((await repository.list()).length, 2);
  database.close();
});

test("adds stable project ids to an existing article database", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    CREATE TABLE articles (
      id TEXT PRIMARY KEY NOT NULL, slug TEXT NOT NULL, collection TEXT NOT NULL,
      collection_label TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, branch TEXT NOT NULL, subbranch TEXT NOT NULL,
      stage TEXT NOT NULL, validity TEXT NOT NULL, category TEXT NOT NULL,
      tags_json TEXT NOT NULL, type TEXT NOT NULL, project TEXT NOT NULL,
      confidence TEXT NOT NULL, source_json TEXT NOT NULL, review_date TEXT NOT NULL,
      summary TEXT NOT NULL, next_action TEXT NOT NULL, body TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, device_id TEXT NOT NULL DEFAULT '',
      sync_status TEXT NOT NULL DEFAULT 'pending', deleted_at TEXT
    );
  `);
  database.prepare(`INSERT INTO articles(
    id, slug, collection, collection_label, title, created_at, updated_at, branch,
    subbranch, stage, validity, category, tags_json, type, project, confidence,
    source_json, review_date, summary, next_action, body, version, device_id,
    sync_status, deleted_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("legacy", "legacy", "notes", "笔记", "旧笔记", "2026-08-01", "2026-08-01", "已整理", "", "常青", "有效", "笔记", "[]", "思考", "旧项目名", "中", "[]", "", "旧摘要", "", "旧正文", 1, "old-device", "synced", null);

  const repository = new SqliteArticleRepository(new NodeSqliteAdapter(database), { deviceId: "new-device" });
  const articles = await repository.list();
  assert.equal(articles[0]?.project, "旧项目名");
  assert.equal(articles[0]?.projectId, "");
  assert.ok(database.prepare("PRAGMA table_info(articles)").all().some((column) => column.name === "project_id"));
  database.close();
});

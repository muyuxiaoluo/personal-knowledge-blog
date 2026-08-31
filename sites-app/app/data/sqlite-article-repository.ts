import type {
  Article,
  ArticleSyncStatus,
  StoredArticle,
} from "../types";
import {
  ArticleRepositoryError,
  sortArticles,
  type ArticleChange,
  type RemoteApplyResult,
  type SyncCapableArticleRepository,
  type SyncedArticleVersion,
} from "./article-repository";

export type SqliteValue = string | number | null | Uint8Array;

export type SqliteExecuteResult = {
  rowsAffected?: number;
  lastInsertId?: number;
};

export type SqliteStatement = {
  sql: string;
  bindValues?: SqliteValue[];
};

/**
 * Matches the small execute/select surface exposed by @tauri-apps/plugin-sql.
 * A Tauri Database instance can be passed directly without coupling this
 * repository to a desktop or mobile runtime.
 */
export interface SqliteDatabase {
  execute(sql: string, bindValues?: SqliteValue[]): Promise<SqliteExecuteResult>;
  select<T>(sql: string, bindValues?: SqliteValue[]): Promise<T[]>;
  transaction?(statements: SqliteStatement[]): Promise<void>;
}

export async function executeSqliteTransaction(
  database: SqliteDatabase,
  statements: SqliteStatement[],
) {
  if (database.transaction) {
    await database.transaction(statements);
    return;
  }
  await database.execute("BEGIN IMMEDIATE");
  try {
    for (const statement of statements) {
      await database.execute(statement.sql, statement.bindValues ?? []);
    }
    await database.execute("COMMIT");
  } catch (error) {
    await database.execute("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

type ArticleRow = {
  id: string;
  slug: string;
  collection: string;
  collection_label: string;
  title: string;
  created_at: string;
  updated_at: string;
  branch: string;
  subbranch: string;
  stage: string;
  validity: string;
  category: string;
  tags_json: string;
  type: string;
  project: string;
  project_id: string;
  confidence: string;
  source_json: string;
  review_date: string;
  summary: string;
  next_action: string;
  body: string;
  version: number;
  device_id: string;
  sync_status: ArticleSyncStatus;
  deleted_at: string | null;
};

const migrations = [
  `CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY NOT NULL,
    slug TEXT NOT NULL,
    collection TEXT NOT NULL,
    collection_label TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    branch TEXT NOT NULL,
    subbranch TEXT NOT NULL,
    stage TEXT NOT NULL,
    validity TEXT NOT NULL,
    category TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    type TEXT NOT NULL,
    project TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT '',
    confidence TEXT NOT NULL,
    source_json TEXT NOT NULL,
    review_date TEXT NOT NULL,
    summary TEXT NOT NULL,
    next_action TEXT NOT NULL,
    body TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    device_id TEXT NOT NULL DEFAULT '',
    sync_status TEXT NOT NULL DEFAULT 'pending',
    deleted_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS articles_updated_idx ON articles(updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS articles_sync_idx ON articles(sync_status, updated_at)",
  "CREATE INDEX IF NOT EXISTS articles_stage_idx ON articles(stage, updated_at DESC)",
] as const;

const articleColumns = `
  id, slug, collection, collection_label, title, created_at, updated_at,
  branch, subbranch, stage, validity, category, tags_json, type, project, project_id,
  confidence, source_json, review_date, summary, next_action, body,
  version, device_id, sync_status, deleted_at
`;

function parseStringList(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || "untitled";
}

function rowToArticle(row: ArticleRow): StoredArticle {
  return {
    id: row.id,
    slug: row.slug,
    collection: row.collection,
    collectionLabel: row.collection_label,
    title: row.title,
    created: row.created_at,
    updated: row.updated_at,
    branch: row.branch,
    subbranch: row.subbranch,
    stage: row.stage,
    validity: row.validity,
    category: row.category,
    tags: parseStringList(row.tags_json),
    type: row.type,
    project: row.project,
    projectId: row.project_id || "",
    confidence: row.confidence,
    source: parseStringList(row.source_json),
    reviewDate: row.review_date,
    summary: row.summary,
    next: row.next_action,
    body: row.body,
    storage: {
      version: Number(row.version || 1),
      deviceId: row.device_id,
      syncStatus: row.sync_status,
      deletedAt: row.deleted_at,
    },
  };
}

function isoDate(value: Date) {
  return value.toISOString();
}

export class SqliteArticleRepository implements SyncCapableArticleRepository {
  private initialization: Promise<void> | null = null;
  private resolvedDeviceId = "";
  private mutationQueue: Promise<void> = Promise.resolve();
  private ftsAvailable = false;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly options: {
      deviceId?: string;
      seedArticles?: Article[];
      clock?: () => Date;
    },
  ) {}

  private now() {
    return (this.options.clock ?? (() => new Date()))();
  }

  private async runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release: () => void = () => {};
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async initialize() {
    this.initialization ??= this.applyMigrationsAndSeed().catch((error) => {
      this.initialization = null;
      throw error;
    });
    await this.initialization;
  }

  private async applyMigrationsAndSeed() {
    for (const statement of migrations) {
      await this.database.execute(statement);
    }
    const articleColumns = await this.database.select<{ name: string }>("PRAGMA table_info(articles)");
    if (!articleColumns.some((column) => column.name === "project_id")) {
      await this.database.execute("ALTER TABLE articles ADD COLUMN project_id TEXT NOT NULL DEFAULT ''");
    }
    await this.database.execute(
      `INSERT INTO app_meta(key, value) VALUES('schema_version', '1')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    const existingDevice = await this.database.select<{ value: string }>(
      "SELECT value FROM app_meta WHERE key = 'device_id' LIMIT 1",
    );
    this.resolvedDeviceId =
      existingDevice[0]?.value ||
      this.options.deviceId?.trim() ||
      `device-${this.now().getTime()}-${Math.random().toString(36).slice(2, 10)}`;
    await this.database.execute(
      `INSERT INTO app_meta(key, value) VALUES('device_id', ?)
       ON CONFLICT(key) DO NOTHING`,
      [this.resolvedDeviceId],
    );

    for (const article of this.options.seedArticles ?? []) {
      await this.insertSeed(article);
    }
    await this.initializeSearchIndex();
  }

  private async initializeSearchIndex() {
    try {
      await this.database.execute(
        `CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
          id UNINDEXED, title, summary, tags, project, category, body,
          tokenize='trigram'
        )`,
      );
      await this.database.execute(`CREATE TRIGGER IF NOT EXISTS articles_fts_insert AFTER INSERT ON articles BEGIN
        INSERT INTO articles_fts(id, title, summary, tags, project, category, body)
        SELECT NEW.id, NEW.title, NEW.summary, NEW.tags_json, NEW.project, NEW.category, NEW.body
        WHERE NEW.deleted_at IS NULL;
      END`);
      await this.database.execute(`CREATE TRIGGER IF NOT EXISTS articles_fts_update AFTER UPDATE ON articles BEGIN
        DELETE FROM articles_fts WHERE id = OLD.id;
        INSERT INTO articles_fts(id, title, summary, tags, project, category, body)
        SELECT NEW.id, NEW.title, NEW.summary, NEW.tags_json, NEW.project, NEW.category, NEW.body
        WHERE NEW.deleted_at IS NULL;
      END`);
      await this.database.execute(`CREATE TRIGGER IF NOT EXISTS articles_fts_delete AFTER DELETE ON articles BEGIN
        DELETE FROM articles_fts WHERE id = OLD.id;
      END`);
      await this.database.execute(
        "DELETE FROM articles_fts WHERE id NOT IN (SELECT id FROM articles WHERE deleted_at IS NULL)",
      );
      await this.database.execute(
        `INSERT INTO articles_fts(id, title, summary, tags, project, category, body)
         SELECT article.id, article.title, article.summary, article.tags_json, article.project, article.category, article.body
         FROM articles article
         WHERE article.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM articles_fts indexed WHERE indexed.id = article.id)`,
      );
      this.ftsAvailable = true;
    } catch {
      this.ftsAvailable = false;
    }
  }

  private async insertSeed(article: Article) {
    const now = isoDate(this.now());
    const created = article.created || now.slice(0, 10);
    const updated = article.updated || created;
    await this.database.execute(
      `INSERT INTO articles (${articleColumns})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'pending', NULL)
       ON CONFLICT(id) DO NOTHING`,
      [
        article.id,
        article.slug,
        article.collection,
        article.collectionLabel,
        article.title,
        created,
        updated,
        article.branch,
        article.subbranch,
        article.stage,
        article.validity,
        article.category,
        JSON.stringify(article.tags),
        article.type,
        article.project,
        article.projectId || "",
        article.confidence,
        JSON.stringify(article.source),
        article.reviewDate,
        article.summary,
        article.next,
        article.body,
        this.resolvedDeviceId,
      ],
    );
  }

  async getDeviceId(): Promise<string> {
    await this.initialize();
    return this.resolvedDeviceId;
  }

  async list(): Promise<StoredArticle[]> {
    try {
      await this.initialize();
      await this.mutationQueue;
      const rows = await this.database.select<ArticleRow>(
        `SELECT ${articleColumns}
         FROM articles
         WHERE deleted_at IS NULL
         ORDER BY updated_at DESC`,
      );
      return sortArticles(rows.map(rowToArticle));
    } catch (error) {
      throw new ArticleRepositoryError("读取本地 SQLite 失败", "read_failed", error);
    }
  }

  async listSummaries(limit = 50, offset = 0, query = ""): Promise<StoredArticle[]> {
    try {
      await this.initialize();
      await this.mutationQueue;
      const safeLimit = Number.isSafeInteger(limit) ? Math.min(200, Math.max(1, limit)) : 50;
      const safeOffset = Number.isSafeInteger(offset) ? Math.max(0, offset) : 0;
      const search = query.trim();
      const summaryColumns = articleColumns.replace("body,", "'' AS body,");
      let rows: ArticleRow[];
      if (search && this.ftsAvailable && Array.from(search).length >= 3) {
        const expression = `"${search.replaceAll('"', '""')}"`;
        rows = await this.database.select<ArticleRow>(
          `SELECT ${summaryColumns}
           FROM articles
           WHERE deleted_at IS NULL
             AND id IN (SELECT id FROM articles_fts WHERE articles_fts MATCH ?)
           ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
          [expression, safeLimit, safeOffset],
        );
      } else if (search) {
        const like = `%${search.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
        rows = await this.database.select<ArticleRow>(
          `SELECT ${summaryColumns}
           FROM articles
           WHERE deleted_at IS NULL AND (
             title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR tags_json LIKE ? ESCAPE '\\'
             OR project LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'
           ) ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
          [like, like, like, like, like, like, safeLimit, safeOffset],
        );
      } else {
        rows = await this.database.select<ArticleRow>(
          `SELECT ${summaryColumns}
           FROM articles WHERE deleted_at IS NULL
           ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
          [safeLimit, safeOffset],
        );
      }
      return rows.map(rowToArticle);
    } catch (error) {
      throw new ArticleRepositoryError("读取笔记摘要失败", "read_failed", error);
    }
  }

  async get(id: string): Promise<StoredArticle | null> {
    try {
      await this.initialize();
      await this.mutationQueue;
      const rows = await this.database.select<ArticleRow>(
        `SELECT ${articleColumns} FROM articles WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [id],
      );
      return rows[0] ? rowToArticle(rows[0]) : null;
    } catch (error) {
      throw new ArticleRepositoryError("读取笔记正文失败", "read_failed", error);
    }
  }

  async save(article: Article): Promise<StoredArticle> {
    const title = article.title.trim();
    const body = article.body;
    if (!title || !body.trim()) {
      throw new ArticleRepositoryError("标题和正文不能为空", "invalid_data");
    }

    try {
      await this.initialize();
      return await this.runMutation(async () => {
        const now = isoDate(this.now());
        const slug = article.slug || `${slugify(title)}-${this.now().getTime()}`;
        const id = article.id || `${article.collection || "thoughts"}/${slug}`;
        const created = article.created || now.slice(0, 10);
        const collection = article.collection || "thoughts";
        const collectionLabel = article.collectionLabel || "想法与随笔";
        const expectedVersion = article.storage?.version ?? null;

        const result = await this.database.execute(
          `INSERT INTO articles (${articleColumns})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'pending', NULL)
           ON CONFLICT(id) DO UPDATE SET
             slug = excluded.slug,
             collection = excluded.collection,
             collection_label = excluded.collection_label,
             title = excluded.title,
             updated_at = excluded.updated_at,
             branch = excluded.branch,
             subbranch = excluded.subbranch,
             stage = excluded.stage,
             validity = excluded.validity,
             category = excluded.category,
             tags_json = excluded.tags_json,
             type = excluded.type,
             project = excluded.project,
             project_id = excluded.project_id,
             confidence = excluded.confidence,
             source_json = excluded.source_json,
             review_date = excluded.review_date,
             summary = excluded.summary,
             next_action = excluded.next_action,
             body = excluded.body,
             version = articles.version + 1,
             device_id = excluded.device_id,
             sync_status = 'pending',
             deleted_at = NULL
           WHERE ? IS NULL OR articles.version = ?`,
          [
            id,
            slug,
            collection,
            collectionLabel,
            title,
            created,
            now,
            article.branch || "待分类",
            article.subbranch || "",
            article.stage || "种子",
            article.validity || "待验证",
            article.category || collectionLabel,
            JSON.stringify(article.tags || []),
            article.type || "记录",
            article.project || "",
            article.projectId || "",
            article.confidence || "低",
            JSON.stringify(article.source || ["私人记录"]),
            article.reviewDate || "",
            article.summary || body.slice(0, 88),
            article.next || "",
            body,
            this.resolvedDeviceId,
            expectedVersion,
            expectedVersion,
          ],
        );

        if (expectedVersion !== null && result.rowsAffected === 0) {
          throw new ArticleRepositoryError(
            "这篇内容已在其他位置更新，当前草稿没有覆盖新版本。请复制草稿后重新打开笔记。",
            "conflict",
          );
        }

        const rows = await this.database.select<ArticleRow>(
          `SELECT ${articleColumns} FROM articles WHERE id = ? LIMIT 1`,
          [id],
        );
        if (!rows[0]) throw new Error("保存后未找到内容");
        const saved = rowToArticle(rows[0]);
        if (
          expectedVersion !== null &&
          result.rowsAffected === undefined &&
          (saved.storage.version !== expectedVersion + 1 ||
            saved.storage.deviceId !== this.resolvedDeviceId ||
            saved.storage.syncStatus !== "pending")
        ) {
          throw new ArticleRepositoryError(
            "这篇内容已在其他位置更新，当前草稿没有覆盖新版本。请复制草稿后重新打开笔记。",
            "conflict",
          );
        }
        return saved;
      });
    } catch (error) {
      if (error instanceof ArticleRepositoryError) throw error;
      throw new ArticleRepositoryError("保存到本地 SQLite 失败", "save_failed", error);
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.initialize();
      await this.runMutation(async () => {
        const now = isoDate(this.now());
        await this.database.execute(
          `UPDATE articles
           SET deleted_at = ?, updated_at = ?, version = version + 1,
               device_id = ?, sync_status = 'pending'
           WHERE id = ?`,
          [now, now, this.resolvedDeviceId, id],
        );
      });
    } catch (error) {
      throw new ArticleRepositoryError("从本地 SQLite 移除失败", "remove_failed", error);
    }
  }

  async listPendingChanges(): Promise<ArticleChange[]> {
    await this.initialize();
    await this.mutationQueue;
    const rows = await this.database.select<ArticleRow>(
      `SELECT ${articleColumns}
       FROM articles
       WHERE sync_status IN ('pending', 'conflict')
       ORDER BY updated_at ASC`,
    );
    return rows.map((row) => ({
      article: rowToArticle(row),
      operation: row.deleted_at ? "delete" : "upsert",
      changeId: `${this.resolvedDeviceId}:${row.id}:${row.version}:${
        row.deleted_at ? "delete" : "upsert"
      }`,
    }));
  }

  async markSynced(versions: SyncedArticleVersion[]): Promise<void> {
    await this.initialize();
    await this.runMutation(() =>
      executeSqliteTransaction(
        this.database,
        versions.map(markSyncedStatement),
      ),
    );
  }

  async ready() {
    await this.initialize();
  }

  async restore(id: string): Promise<StoredArticle> {
    try {
      await this.initialize();
      return await this.runMutation(async () => {
        const now = isoDate(this.now());
        const result = await this.database.execute(
          `UPDATE articles
           SET deleted_at = NULL, updated_at = ?, version = version + 1,
               device_id = ?, sync_status = 'pending'
           WHERE id = ? AND deleted_at IS NOT NULL`,
          [now, this.resolvedDeviceId, id],
        );
        if (result.rowsAffected === 0) {
          throw new ArticleRepositoryError("没有找到可恢复的内容", "invalid_data");
        }
        const rows = await this.database.select<ArticleRow>(
          `SELECT ${articleColumns} FROM articles WHERE id = ? LIMIT 1`,
          [id],
        );
        if (!rows[0]) throw new ArticleRepositoryError("没有找到可恢复的内容", "invalid_data");
        return rowToArticle(rows[0]);
      });
    } catch (error) {
      if (error instanceof ArticleRepositoryError) throw error;
      throw new ArticleRepositoryError("恢复本地内容失败", "save_failed", error);
    }
  }

  async applyRemoteChanges(
    changes: ArticleChange[],
  ): Promise<RemoteApplyResult> {
    await this.initialize();
    return this.runMutation(() => this.commitSyncResultInternal([], changes));
  }

  async commitSyncResult(
    versions: SyncedArticleVersion[],
    changes: ArticleChange[],
    cursor: string,
  ): Promise<RemoteApplyResult> {
    await this.initialize();
    return this.runMutation(() =>
      this.commitSyncResultInternal(versions, changes, cursor),
    );
  }

  private async commitSyncResultInternal(
    versions: SyncedArticleVersion[],
    changes: ArticleChange[],
    cursor?: string,
  ): Promise<RemoteApplyResult> {
    let applied = 0;
    let conflicts = 0;
    const statements = versions.map(markSyncedStatement);
    const acceptedVersions = new Map(
      versions.map((item) => [item.id, item.version]),
    );
    const latestChanges = new Map<string, ArticleChange>();
    for (const change of changes) latestChanges.set(change.article.id, change);

    for (const change of latestChanges.values()) {
      const remote = change.article;
      const rows = await this.database.select<ArticleRow>(
        `SELECT ${articleColumns} FROM articles WHERE id = ? LIMIT 1`,
        [remote.id],
      );
      const local = rows[0] ? rowToArticle(rows[0]) : null;
      const sameContent =
        local && contentFingerprint(local) === contentFingerprint(remote);
      const localWasAccepted =
        local && acceptedVersions.get(local.id) === local.storage.version;
      const effectiveStatus = localWasAccepted
        ? "synced"
        : local?.storage.syncStatus;

      if (
        local &&
        (effectiveStatus === "pending" || effectiveStatus === "conflict") &&
        !sameContent
      ) {
        statements.push(this.preserveConflictCopyStatement(local, remote));
        conflicts += 1;
      }

      if (
        local &&
        effectiveStatus === "synced" &&
        local.storage.version > remote.storage.version
      ) {
        continue;
      }

      statements.push(writeRemoteArticleStatement(remote));
      applied += 1;
    }

    if (cursor !== undefined) statements.push(syncCursorStatement(cursor));
    await executeSqliteTransaction(this.database, statements);
    return { applied, conflicts };
  }

  private preserveConflictCopyStatement(
    article: StoredArticle,
    remote: StoredArticle,
  ): SqliteStatement {
    const identity = [
      article.id,
      article.storage.deviceId,
      article.storage.version,
      remote.storage.deviceId,
      remote.storage.version,
      contentFingerprint(article),
    ].join("|");
    const suffix = stableHash(identity);
    const conflictId = `${article.id.slice(0, 270)}#conflict-${suffix}`;
    const sources = article.source.includes("同步冲突保护")
      ? article.source
      : [...article.source, "同步冲突保护"];
    return {
      sql: `INSERT INTO articles (${articleColumns})
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'conflict', NULL)
            ON CONFLICT(id) DO NOTHING`,
      bindValues: [
        conflictId,
        `${article.slug.slice(0, 60)}-conflict-${suffix}`,
        article.collection,
        article.collectionLabel,
        `${article.title}（冲突副本）`,
        article.created,
        isoDate(this.now()),
        article.branch,
        article.subbranch,
        article.stage,
        article.validity,
        article.category,
        JSON.stringify(article.tags),
        article.type,
        article.project,
        article.projectId || "",
        article.confidence,
        JSON.stringify(sources),
        article.reviewDate,
        article.summary,
        article.next,
        article.body,
        this.resolvedDeviceId,
      ],
    };
  }

  async createBackup(targetPath: string): Promise<void> {
    await this.initialize();
    if (!targetPath.trim()) {
      throw new ArticleRepositoryError("备份路径不能为空", "invalid_data");
    }
    await this.runMutation(() =>
      this.database.execute("VACUUM INTO ?", [targetPath]).then(() => undefined),
    );
  }

  async getSyncCursor(): Promise<string> {
    await this.initialize();
    await this.mutationQueue;
    const rows = await this.database.select<{ value: string }>(
      "SELECT value FROM app_meta WHERE key = 'sync_cursor' LIMIT 1",
    );
    return rows[0]?.value || "";
  }

  async setSyncCursor(cursor: string): Promise<void> {
    await this.initialize();
    await this.runMutation(() =>
      executeSqliteTransaction(this.database, [syncCursorStatement(cursor)]),
    );
  }
}

function markSyncedStatement(item: SyncedArticleVersion): SqliteStatement {
  return {
    sql: `UPDATE articles
          SET sync_status = 'synced'
          WHERE id = ? AND version = ?`,
    bindValues: [item.id, item.version],
  };
}

function syncCursorStatement(cursor: string): SqliteStatement {
  return {
    sql: `INSERT INTO app_meta(key, value) VALUES('sync_cursor', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    bindValues: [cursor],
  };
}

function writeRemoteArticleStatement(article: StoredArticle): SqliteStatement {
  return {
    sql: `INSERT INTO articles (${articleColumns})
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?)
          ON CONFLICT(id) DO UPDATE SET
            slug = excluded.slug,
            collection = excluded.collection,
            collection_label = excluded.collection_label,
            title = excluded.title,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            branch = excluded.branch,
            subbranch = excluded.subbranch,
            stage = excluded.stage,
            validity = excluded.validity,
            category = excluded.category,
            tags_json = excluded.tags_json,
            type = excluded.type,
            project = excluded.project,
            project_id = excluded.project_id,
            confidence = excluded.confidence,
            source_json = excluded.source_json,
            review_date = excluded.review_date,
            summary = excluded.summary,
            next_action = excluded.next_action,
            body = excluded.body,
            version = excluded.version,
            device_id = excluded.device_id,
            sync_status = 'synced',
            deleted_at = excluded.deleted_at`,
    bindValues: [
      article.id,
      article.slug,
      article.collection,
      article.collectionLabel,
      article.title,
      article.created,
      article.updated,
      article.branch,
      article.subbranch,
      article.stage,
      article.validity,
      article.category,
      JSON.stringify(article.tags),
      article.type,
      article.project,
      article.projectId || "",
      article.confidence,
      JSON.stringify(article.source),
      article.reviewDate,
      article.summary,
      article.next,
      article.body,
      article.storage.version,
      article.storage.deviceId,
      article.storage.deletedAt,
    ],
  };
}

function contentFingerprint(article: Article) {
  return JSON.stringify({
    id: article.id,
    slug: article.slug,
    collection: article.collection,
    collectionLabel: article.collectionLabel,
    title: article.title,
    branch: article.branch,
    subbranch: article.subbranch,
    stage: article.stage,
    validity: article.validity,
    category: article.category,
    tags: article.tags,
    type: article.type,
    project: article.project,
    projectId: article.projectId || "",
    confidence: article.confidence,
    source: article.source,
    reviewDate: article.reviewDate,
    summary: article.summary,
    next: article.next,
    body: article.body,
  });
}

function stableHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

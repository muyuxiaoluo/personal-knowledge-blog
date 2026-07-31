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

/**
 * Matches the small execute/select surface exposed by @tauri-apps/plugin-sql.
 * A Tauri Database instance can be passed directly without coupling this
 * repository to a desktop or mobile runtime.
 */
export interface SqliteDatabase {
  execute(sql: string, bindValues?: SqliteValue[]): Promise<SqliteExecuteResult>;
  select<T>(sql: string, bindValues?: SqliteValue[]): Promise<T[]>;
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
  branch, subbranch, stage, validity, category, tags_json, type, project,
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
  }

  private async insertSeed(article: Article) {
    const now = isoDate(this.now());
    const created = article.created || now.slice(0, 10);
    const updated = article.updated || created;
    await this.database.execute(
      `INSERT INTO articles (${articleColumns})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'pending', NULL)
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

  async save(article: Article): Promise<StoredArticle> {
    const title = article.title.trim();
    const body = article.body.trim();
    if (!title || !body) {
      throw new ArticleRepositoryError("标题和正文不能为空", "invalid_data");
    }

    try {
      await this.initialize();
      const now = isoDate(this.now());
      const slug = article.slug || `${slugify(title)}-${this.now().getTime()}`;
      const id = article.id || `${article.collection || "thoughts"}/${slug}`;
      const created = article.created || now.slice(0, 10);
      const collection = article.collection || "thoughts";
      const collectionLabel = article.collectionLabel || "想法与随笔";

      await this.database.execute(
        `INSERT INTO articles (${articleColumns})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'pending', NULL)
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
           confidence = excluded.confidence,
           source_json = excluded.source_json,
           review_date = excluded.review_date,
           summary = excluded.summary,
           next_action = excluded.next_action,
           body = excluded.body,
           version = articles.version + 1,
           device_id = excluded.device_id,
           sync_status = 'pending',
           deleted_at = NULL`,
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
          article.confidence || "低",
          JSON.stringify(article.source || ["私人记录"]),
          article.reviewDate || "",
          article.summary || body.slice(0, 88),
          article.next || "",
          body,
          this.resolvedDeviceId,
        ],
      );

      const rows = await this.database.select<ArticleRow>(
        `SELECT ${articleColumns} FROM articles WHERE id = ? LIMIT 1`,
        [id],
      );
      if (!rows[0]) throw new Error("保存后未找到内容");
      return rowToArticle(rows[0]);
    } catch (error) {
      if (error instanceof ArticleRepositoryError) throw error;
      throw new ArticleRepositoryError("保存到本地 SQLite 失败", "save_failed", error);
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.initialize();
      const now = isoDate(this.now());
      await this.database.execute(
        `UPDATE articles
         SET deleted_at = ?, updated_at = ?, version = version + 1,
             device_id = ?, sync_status = 'pending'
         WHERE id = ?`,
        [now, now, this.resolvedDeviceId, id],
      );
    } catch (error) {
      throw new ArticleRepositoryError("从本地 SQLite 移除失败", "remove_failed", error);
    }
  }

  async listPendingChanges(): Promise<ArticleChange[]> {
    await this.initialize();
    const rows = await this.database.select<ArticleRow>(
      `SELECT ${articleColumns}
       FROM articles
       WHERE sync_status IN ('pending', 'conflict')
       ORDER BY updated_at ASC`,
    );
    return rows.map((row) => ({
      article: rowToArticle(row),
      operation: row.deleted_at ? "delete" : "upsert",
    }));
  }

  async markSynced(versions: SyncedArticleVersion[]): Promise<void> {
    await this.initialize();
    for (const item of versions) {
      await this.database.execute(
        `UPDATE articles
         SET sync_status = 'synced'
         WHERE id = ? AND version = ?`,
        [item.id, item.version],
      );
    }
  }

  async applyRemoteChanges(
    changes: ArticleChange[],
  ): Promise<RemoteApplyResult> {
    await this.initialize();
    let applied = 0;
    let conflicts = 0;

    for (const change of changes) {
      const remote = change.article;
      const rows = await this.database.select<ArticleRow>(
        `SELECT ${articleColumns} FROM articles WHERE id = ? LIMIT 1`,
        [remote.id],
      );
      const local = rows[0] ? rowToArticle(rows[0]) : null;
      const sameContent =
        local &&
        JSON.stringify(articleContent(local)) ===
          JSON.stringify(articleContent(remote));

      if (
        local &&
        ["pending", "conflict"].includes(local.storage.syncStatus) &&
        !sameContent
      ) {
        await this.preserveConflictCopy(local);
        conflicts += 1;
      }

      if (
        local &&
        local.storage.syncStatus === "synced" &&
        local.storage.version > remote.storage.version
      ) {
        continue;
      }

      await this.writeRemoteArticle(remote);
      applied += 1;
    }

    return { applied, conflicts };
  }

  private async preserveConflictCopy(article: StoredArticle) {
    if (article.storage.deletedAt) return;
    const stamp = this.now().getTime();
    const conflictId = `${article.id}#conflict-${stamp}`;
    await this.database.execute(
      `INSERT INTO articles (${articleColumns})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'conflict', NULL)
       ON CONFLICT(id) DO NOTHING`,
      [
        conflictId,
        `${article.slug}-conflict-${stamp}`,
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
        article.confidence,
        JSON.stringify([...article.source, "同步冲突保护"]),
        article.reviewDate,
        article.summary,
        article.next,
        article.body,
        this.resolvedDeviceId,
      ],
    );
  }

  private async writeRemoteArticle(article: StoredArticle) {
    await this.database.execute(
      `INSERT INTO articles (${articleColumns})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?)
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
      [
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
    );
  }

  async createBackup(targetPath: string): Promise<void> {
    await this.initialize();
    if (!targetPath.trim()) {
      throw new ArticleRepositoryError("备份路径不能为空", "invalid_data");
    }
    await this.database.execute("VACUUM INTO ?", [targetPath]);
  }

  async getSyncCursor(): Promise<string> {
    await this.initialize();
    const rows = await this.database.select<{ value: string }>(
      "SELECT value FROM app_meta WHERE key = 'sync_cursor' LIMIT 1",
    );
    return rows[0]?.value || "";
  }

  async setSyncCursor(cursor: string): Promise<void> {
    await this.initialize();
    await this.database.execute(
      `INSERT INTO app_meta(key, value) VALUES('sync_cursor', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [cursor],
    );
  }
}

function articleContent(article: Article) {
  const { storage, ...content } = article;
  void storage;
  return content;
}

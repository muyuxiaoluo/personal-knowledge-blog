import { DatabaseSync } from "node:sqlite";
import {
  hashPassword,
  verifyPasswordAsync,
} from "./security.mjs";

const schema = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    auth_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS articles (
    user_id INTEGER NOT NULL,
    id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    version INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    deleted_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS changes (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    article_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    version INTEGER NOT NULL,
    operation TEXT NOT NULL,
    origin_device_id TEXT NOT NULL DEFAULT '',
    change_id TEXT NOT NULL DEFAULT '',
    changed_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS change_receipts (
    user_id INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    change_id TEXT NOT NULL,
    result_type TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, device_id, change_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS changes_user_sequence_idx ON changes(user_id, sequence)",
  "CREATE INDEX IF NOT EXISTS changes_user_article_sequence_idx ON changes(user_id, article_id, sequence DESC)",
  "CREATE INDEX IF NOT EXISTS articles_user_updated_idx ON articles(user_id, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS receipts_user_created_idx ON change_receipts(user_id, created_at)",
];

export class SyncDatabase {
  constructor(filename) {
    this.database = new DatabaseSync(filename);
    this.dummyPasswordHash = hashPassword("invalid-account-password");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    for (const statement of schema) this.database.exec(statement);
    ensureColumn(this.database, "users", "auth_version", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(this.database, "changes", "origin_device_id", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, "changes", "change_id", "TEXT NOT NULL DEFAULT ''");
  }

  close() {
    this.database.close();
  }

  ensureOwner(username, password) {
    const existing = this.database
      .prepare(
        "SELECT id, username, auth_version FROM users WHERE username = ? LIMIT 1",
      )
      .get(username);
    if (existing) return toAuthenticatedUser(existing);
    if (!password) {
      throw new Error(
        "数据库尚未初始化，请为首次启动提供 ADMIN_PASSWORD。",
      );
    }
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        `INSERT INTO users(username, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(username, hashPassword(password), now, now);
    return { id: Number(result.lastInsertRowid), username, authVersion: 1 };
  }

  async authenticate(username, password) {
    const user = this.database
      .prepare(
        `SELECT id, username, password_hash, auth_version
         FROM users WHERE username = ? LIMIT 1`,
      )
      .get(username);
    const verified = await verifyPasswordAsync(
      password,
      user?.password_hash || this.dummyPasswordHash,
    );
    if (!user || !verified) {
      return null;
    }
    return toAuthenticatedUser(user);
  }

  async changePassword(userId, currentPassword, nextPassword) {
    const user = this.database
      .prepare(
        "SELECT id, password_hash FROM users WHERE id = ? LIMIT 1",
      )
      .get(userId);
    if (
      !user ||
      !(await verifyPasswordAsync(currentPassword, user.password_hash))
    ) {
      return false;
    }
    this.database
      .prepare(
        `UPDATE users
         SET password_hash = ?, updated_at = ?, auth_version = auth_version + 1
         WHERE id = ?`,
      )
      .run(hashPassword(nextPassword), new Date().toISOString(), userId);
    return true;
  }

  isTokenCurrent(userId, authVersion) {
    const user = this.database
      .prepare("SELECT auth_version FROM users WHERE id = ? LIMIT 1")
      .get(userId);
    return Boolean(user) && Number(user.auth_version) === authVersion;
  }

  sync(userId, request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new ClientInputError("同步请求格式不正确");
    }
    const cursor = parseCursor(request.cursor);
    const deviceId = validateDeviceId(request.deviceId);
    const incoming = validateChanges(request.changes);
    const accepted = [];
    const conflicts = [];

    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const change of incoming) {
        const article = normalizeArticle(change, deviceId);
        const changeId = change.changeId || "";
        const receipt = changeId
          ? this.database
              .prepare(
                `SELECT result_type, result_json FROM change_receipts
                 WHERE user_id = ? AND device_id = ? AND change_id = ? LIMIT 1`,
              )
              .get(userId, deviceId, changeId)
          : null;
        if (receipt) {
          const recorded = JSON.parse(receipt.result_json);
          if (receipt.result_type === "accepted") accepted.push(recorded);
          else conflicts.push(recorded);
          continue;
        }
        const current = this.database
          .prepare(
            `SELECT payload_json, version, operation
             FROM articles WHERE user_id = ? AND id = ? LIMIT 1`,
          )
          .get(userId, article.id);

        if (current) {
          const currentArticle = JSON.parse(current.payload_json);
          if (article.storage.version < Number(current.version)) {
            const conflict = {
              article: currentArticle,
              operation: current.operation,
            };
            conflicts.push(conflict);
            this.recordReceipt(userId, deviceId, changeId, "conflict", conflict);
            continue;
          }
          if (article.storage.version === Number(current.version)) {
            if (
              current.operation === change.operation &&
              contentFingerprint(currentArticle) ===
                contentFingerprint(article)
            ) {
              const acceptedVersion = {
                id: article.id,
                version: article.storage.version,
              };
              accepted.push(acceptedVersion);
              this.recordReceipt(userId, deviceId, changeId, "accepted", acceptedVersion);
            } else {
              const conflict = {
                article: currentArticle,
                operation: current.operation,
              };
              conflicts.push(conflict);
              this.recordReceipt(userId, deviceId, changeId, "conflict", conflict);
            }
            continue;
          }
        }

        const payload = JSON.stringify(article);
        const now = new Date().toISOString();
        this.database
          .prepare(
            `INSERT INTO articles(
               user_id, id, payload_json, version, device_id,
               operation, deleted_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id, id) DO UPDATE SET
               payload_json = excluded.payload_json,
               version = excluded.version,
               device_id = excluded.device_id,
               operation = excluded.operation,
               deleted_at = excluded.deleted_at,
               updated_at = excluded.updated_at`,
          )
          .run(
            userId,
            article.id,
            payload,
            article.storage.version,
            article.storage.deviceId,
            change.operation,
            article.storage.deletedAt,
            now,
          );
        this.database
          .prepare(
            `INSERT INTO changes(
               user_id, article_id, payload_json, version, operation,
               origin_device_id, change_id, changed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            userId,
            article.id,
            payload,
            article.storage.version,
            change.operation,
            deviceId,
            changeId,
            now,
          );
        const acceptedVersion = { id: article.id, version: article.storage.version };
        accepted.push(acceptedVersion);
        this.recordReceipt(userId, deviceId, changeId, "accepted", acceptedVersion);
      }

      this.database
        .prepare(
          `DELETE FROM changes
           WHERE user_id = ?
             AND sequence NOT IN (
               SELECT MAX(sequence)
               FROM changes
               WHERE user_id = ?
               GROUP BY article_id
             )`,
        )
        .run(userId, userId);
      this.database
        .prepare(
          `DELETE FROM change_receipts
           WHERE user_id = ?
             AND julianday(created_at) < julianday('now', '-90 days')`,
        )
        .run(userId);

      const remoteRows = this.database
        .prepare(
          `SELECT sequence, payload_json, operation, origin_device_id, change_id
           FROM changes
           WHERE user_id = ? AND sequence > ?
           ORDER BY sequence ASC
           LIMIT 5001`,
        )
        .all(userId, cursor);
      const hasMore = remoteRows.length > 5000;
      const pageRows = remoteRows.slice(0, 5000);
      const changes = pageRows
        .filter((row) => row.origin_device_id !== deviceId)
        .map((row) => ({
          article: JSON.parse(row.payload_json),
          operation: row.operation,
          ...(row.change_id ? { changeId: row.change_id } : {}),
        }));
      const nextCursor = pageRows.length
        ? String(pageRows.at(-1).sequence)
        : String(cursor);
      this.database.exec("COMMIT");
      return {
        protocolVersion: 2,
        cursor: nextCursor,
        hasMore,
        accepted,
        conflicts,
        changes,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recordReceipt(userId, deviceId, changeId, resultType, result) {
    if (!changeId) return;
    this.database
      .prepare(
        `INSERT INTO change_receipts(
           user_id, device_id, change_id, result_type, result_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, device_id, change_id) DO NOTHING`,
      )
      .run(
        userId,
        deviceId,
        changeId,
        resultType,
        JSON.stringify(result),
        new Date().toISOString(),
      );
  }
}

function validateChanges(changes) {
  if (!Array.isArray(changes)) throw new ClientInputError("changes 必须是数组");
  if (changes.length > 1000) {
    throw new ClientInputError("单次同步最多包含 1000 条变更");
  }
  return changes.map((change) => {
    if (
      !change ||
      typeof change !== "object" ||
      !["upsert", "delete"].includes(change.operation) ||
      !change.article ||
      typeof change.article !== "object"
    ) {
      throw new ClientInputError("变更格式不正确");
    }
    const article = validateArticle(change.article);
    const changeId = change.changeId === undefined
      ? ""
      : validateChangeId(change.changeId);
    return { article, operation: change.operation, changeId };
  });
}

function normalizeArticle(change, fallbackDeviceId) {
  const article = structuredClone(change.article);
  const deletedAt =
    change.operation === "delete"
      ? article.storage.deletedAt || new Date().toISOString()
      : null;
  article.storage = {
    version: article.storage.version,
    deviceId: fallbackDeviceId,
    syncStatus: "synced",
    deletedAt,
  };
  return article;
}

function contentFingerprint(article) {
  return JSON.stringify({
    id: stringField(article.id),
    slug: stringField(article.slug),
    collection: stringField(article.collection),
    collectionLabel: stringField(article.collectionLabel),
    title: stringField(article.title),
    branch: stringField(article.branch),
    subbranch: stringField(article.subbranch),
    stage: stringField(article.stage),
    validity: stringField(article.validity),
    category: stringField(article.category),
    tags: stringListField(article.tags),
    type: stringField(article.type),
    project: stringField(article.project),
    projectId: stringField(article.projectId),
    confidence: stringField(article.confidence),
    source: stringListField(article.source),
    reviewDate: stringField(article.reviewDate),
    summary: stringField(article.summary),
    next: stringField(article.next),
    body: stringField(article.body),
  });
}

function validateArticle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClientInputError("文章数据不完整");
  }
  if (
    !value.storage ||
    typeof value.storage !== "object" ||
    Array.isArray(value.storage) ||
    !Number.isSafeInteger(value.storage.version) ||
    value.storage.version < 1
  ) {
    throw new ClientInputError("文章版本不正确");
  }
  return {
    id: articleString(value, "id", 300, true),
    slug: articleString(value, "slug", 300),
    collection: articleString(value, "collection", 200),
    collectionLabel: articleString(value, "collectionLabel", 200),
    title: articleString(value, "title", 2_000, true),
    created: articleString(value, "created", 100),
    updated: articleString(value, "updated", 100),
    branch: articleString(value, "branch", 500),
    subbranch: articleString(value, "subbranch", 500),
    stage: articleString(value, "stage", 200),
    validity: articleString(value, "validity", 200),
    category: articleString(value, "category", 500),
    tags: articleStringList(value, "tags", 100, 500),
    type: articleString(value, "type", 200),
    project: articleString(value, "project", 1_000),
    projectId:
      value.projectId === undefined
        ? ""
        : articleString(value, "projectId", 300),
    confidence: articleString(value, "confidence", 200),
    source: articleStringList(value, "source", 100, 2_000),
    reviewDate: articleString(value, "reviewDate", 100),
    summary: articleString(value, "summary", 10_000),
    next: articleString(value, "next", 10_000),
    body: articleString(value, "body", 2 * 1024 * 1024),
    storage: {
      version: value.storage.version,
      deviceId: "",
      syncStatus: "pending",
      deletedAt: null,
    },
  };
}

function articleString(article, field, maxBytes, required = false) {
  const value = article[field];
  if (
    typeof value !== "string" ||
    (required && !value.trim()) ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new ClientInputError(`文章字段 ${field} 不正确`);
  }
  return value;
}

function articleStringList(article, field, maxItems, maxItemBytes) {
  const value = article[field];
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        Buffer.byteLength(item, "utf8") > maxItemBytes,
    )
  ) {
    throw new ClientInputError(`文章字段 ${field} 不正确`);
  }
  return [...value];
}

function validateChangeId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 700) {
    throw new ClientInputError("changeId 不正确");
  }
  return value.trim();
}

function stringField(value) {
  return typeof value === "string" ? value : "";
}

function stringListField(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function ensureColumn(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function toAuthenticatedUser(user) {
  return {
    id: Number(user.id),
    username: user.username,
    authVersion: Number(user.auth_version || 1),
  };
}

function validateDeviceId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new ClientInputError("deviceId 不正确");
  }
  return value.trim();
}

function parseCursor(value) {
  if (value === "" || value === undefined || value === null) return 0;
  if (!/^\d+$/.test(String(value))) {
    throw new ClientInputError("同步游标不正确");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ClientInputError("同步游标过大");
  }
  return parsed;
}

export class ClientInputError extends Error {}

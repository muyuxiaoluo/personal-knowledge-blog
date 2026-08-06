import { DatabaseSync } from "node:sqlite";
import { hashPassword, verifyPassword } from "./security.mjs";

const schema = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
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
    changed_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS changes_user_sequence_idx ON changes(user_id, sequence)",
  "CREATE INDEX IF NOT EXISTS articles_user_updated_idx ON articles(user_id, updated_at DESC)",
];

export class SyncDatabase {
  constructor(filename) {
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    for (const statement of schema) this.database.exec(statement);
  }

  close() {
    this.database.close();
  }

  ensureOwner(username, password) {
    const existing = this.database
      .prepare("SELECT id, username FROM users WHERE username = ? LIMIT 1")
      .get(username);
    if (existing) return existing;
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
    return { id: Number(result.lastInsertRowid), username };
  }

  authenticate(username, password) {
    const user = this.database
      .prepare(
        "SELECT id, username, password_hash FROM users WHERE username = ? LIMIT 1",
      )
      .get(username);
    if (!user || !verifyPassword(password, user.password_hash)) return null;
    return { id: Number(user.id), username: user.username };
  }

  changePassword(userId, currentPassword, nextPassword) {
    const user = this.database
      .prepare(
        "SELECT id, password_hash FROM users WHERE id = ? LIMIT 1",
      )
      .get(userId);
    if (!user || !verifyPassword(currentPassword, user.password_hash)) {
      return false;
    }
    this.database
      .prepare(
        "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
      )
      .run(hashPassword(nextPassword), new Date().toISOString(), userId);
    return true;
  }

  sync(userId, request) {
    const cursor = parseCursor(request.cursor);
    const deviceId = validateDeviceId(request.deviceId);
    const incoming = validateChanges(request.changes);
    const accepted = [];
    const conflicts = [];

    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const change of incoming) {
        const article = normalizeArticle(change, deviceId);
        const current = this.database
          .prepare(
            `SELECT payload_json, version, operation
             FROM articles WHERE user_id = ? AND id = ? LIMIT 1`,
          )
          .get(userId, article.id);

        if (current) {
          const currentArticle = JSON.parse(current.payload_json);
          if (article.storage.version < Number(current.version)) {
            conflicts.push({
              article: currentArticle,
              operation: current.operation,
            });
            continue;
          }
          if (article.storage.version === Number(current.version)) {
            if (
              current.operation === change.operation &&
              contentFingerprint(currentArticle) ===
                contentFingerprint(article)
            ) {
              accepted.push({
                id: article.id,
                version: article.storage.version,
              });
            } else {
              conflicts.push({
                article: currentArticle,
                operation: current.operation,
              });
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
               user_id, article_id, payload_json, version, operation, changed_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            userId,
            article.id,
            payload,
            article.storage.version,
            change.operation,
            now,
          );
        accepted.push({ id: article.id, version: article.storage.version });
      }

      const remoteRows = this.database
        .prepare(
          `SELECT sequence, payload_json, operation
           FROM changes
           WHERE user_id = ? AND sequence > ?
           ORDER BY sequence ASC
           LIMIT 5000`,
        )
        .all(userId, cursor);
      const changes = remoteRows.map((row) => ({
        article: JSON.parse(row.payload_json),
        operation: row.operation,
      }));
      const nextCursor = remoteRows.length
        ? String(remoteRows.at(-1).sequence)
        : String(cursor);
      this.database.exec("COMMIT");
      return { cursor: nextCursor, accepted, conflicts, changes };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
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
    const article = change.article;
    if (
      typeof article.id !== "string" ||
      !article.id ||
      article.id.length > 300 ||
      typeof article.title !== "string" ||
      typeof article.body !== "string" ||
      !article.storage ||
      !Number.isSafeInteger(article.storage.version) ||
      article.storage.version < 1
    ) {
      throw new ClientInputError("文章数据不完整");
    }
    return change;
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
    deviceId: article.storage.deviceId || fallbackDeviceId,
    syncStatus: "synced",
    deletedAt,
  };
  return article;
}

function contentFingerprint(article) {
  const copy = structuredClone(article);
  if (copy.storage) copy.storage.syncStatus = "synced";
  return JSON.stringify(copy);
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

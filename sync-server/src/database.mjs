import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
  `CREATE TABLE IF NOT EXISTS sync_entities (
    user_id INTEGER NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    version INTEGER NOT NULL,
    operation TEXT NOT NULL,
    deleted_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, entity_type, entity_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS sync_changes (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    version INTEGER NOT NULL,
    operation TEXT NOT NULL,
    origin_device_id TEXT NOT NULL,
    change_id TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS sync_receipts (
    user_id INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    change_id TEXT NOT NULL,
    result_type TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, device_id, change_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS refresh_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    device_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    replaced_by TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS blobs (
    sha256 TEXT PRIMARY KEY NOT NULL,
    byte_length INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS user_blobs (
    user_id INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, sha256),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (sha256) REFERENCES blobs(sha256) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS changes_user_sequence_idx ON changes(user_id, sequence)",
  "CREATE INDEX IF NOT EXISTS changes_user_article_sequence_idx ON changes(user_id, article_id, sequence DESC)",
  "CREATE INDEX IF NOT EXISTS articles_user_updated_idx ON articles(user_id, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS receipts_user_created_idx ON change_receipts(user_id, created_at)",
  "CREATE INDEX IF NOT EXISTS sync_changes_user_sequence_idx ON sync_changes(user_id, sequence)",
  "CREATE INDEX IF NOT EXISTS sync_entities_user_updated_idx ON sync_entities(user_id, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS sync_receipts_user_created_idx ON sync_receipts(user_id, created_at)",
  "CREATE INDEX IF NOT EXISTS refresh_sessions_user_idx ON refresh_sessions(user_id, expires_at)",
];

export class SyncDatabase {
  constructor(filename) {
    this.database = new DatabaseSync(filename);
    this.dataDirectory = path.dirname(filename);
    this.blobDirectory = path.join(this.dataDirectory, "blobs");
    fs.mkdirSync(this.blobDirectory, { recursive: true });
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
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `UPDATE users
           SET password_hash = ?, updated_at = ?, auth_version = auth_version + 1
           WHERE id = ?`,
        )
        .run(hashPassword(nextPassword), now, userId);
      this.database
        .prepare("UPDATE refresh_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
        .run(now, userId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return true;
  }

  isTokenCurrent(userId, authVersion) {
    const user = this.database
      .prepare("SELECT auth_version FROM users WHERE id = ? LIMIT 1")
      .get(userId);
    return Boolean(user) && Number(user.auth_version) === authVersion;
  }

  createRefreshSession(user, deviceId = "") {
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const id = randomBytes(16).toString("hex");
    this.database
      .prepare(
        `INSERT INTO refresh_sessions(
           id, user_id, token_hash, device_id, expires_at,
           created_at, last_used_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        Number(user.id),
        refreshTokenHash(token),
        normalizeDeviceId(deviceId),
        expiresAt.toISOString(),
        now.toISOString(),
        now.toISOString(),
      );
    return { refreshToken: token, refreshExpiresAt: expiresAt.toISOString() };
  }

  rotateRefreshSession(token) {
    if (typeof token !== "string" || token.length < 32 || token.length > 256) return null;
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const session = this.database
        .prepare(
          `SELECT s.id, s.user_id, s.device_id, u.username, u.auth_version
           FROM refresh_sessions s
           JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
           LIMIT 1`,
        )
        .get(refreshTokenHash(token), now);
      if (!session) {
        this.database.exec("ROLLBACK");
        return null;
      }
      const user = toAuthenticatedUser({
        id: session.user_id,
        username: session.username,
        auth_version: session.auth_version,
      });
      const next = this.createRefreshSession(user, session.device_id);
      const nextSession = this.database
        .prepare("SELECT id FROM refresh_sessions WHERE token_hash = ? LIMIT 1")
        .get(refreshTokenHash(next.refreshToken));
      this.database
        .prepare(
          `UPDATE refresh_sessions
           SET revoked_at = ?, replaced_by = ?, last_used_at = ?
           WHERE id = ? AND revoked_at IS NULL`,
        )
        .run(now, nextSession.id, now, session.id);
      this.database
        .prepare(
          `DELETE FROM refresh_sessions
           WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < datetime('now', '-90 days'))`,
        )
        .run(now);
      this.database.exec("COMMIT");
      return { user, ...next };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  revokeRefreshSession(token, userId = null) {
    if (typeof token !== "string" || token.length < 32 || token.length > 256) return false;
    const statement = userId === null
      ? `UPDATE refresh_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`
      : `UPDATE refresh_sessions SET revoked_at = ? WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL`;
    const parameters = [new Date().toISOString(), refreshTokenHash(token)];
    if (userId !== null) parameters.push(Number(userId));
    return Number(this.database.prepare(statement).run(...parameters).changes) > 0;
  }

  syncV3(userId, request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new ClientInputError("同步请求格式不正确");
    }
    const cursor = parseCursor(request.cursor);
    const deviceId = validateDeviceId(request.deviceId);
    if (!Array.isArray(request.changes)) throw new ClientInputError("changes 必须是数组");
    if (request.changes.length > 200) throw new ClientInputError("单次同步最多包含 200 条变更");
    if (Buffer.byteLength(JSON.stringify(request.changes), "utf8") > 1024 * 1024) {
      throw new ClientInputError("单次同步变更不能超过 1 MiB");
    }

    const accepted = [];
    const conflicts = [];
    const failed = [];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < request.changes.length; index += 1) {
        let change;
        try {
          change = validateV3Change(request.changes[index]);
        } catch (error) {
          failed.push({
            index,
            changeId: typeof request.changes[index]?.changeId === "string"
              ? request.changes[index].changeId.slice(0, 700)
              : "",
            error: error instanceof Error ? error.message : "变更格式不正确",
          });
          continue;
        }
        const receipt = this.database
          .prepare(
            `SELECT result_type, result_json FROM sync_receipts
             WHERE user_id = ? AND device_id = ? AND change_id = ? LIMIT 1`,
          )
          .get(userId, deviceId, change.changeId);
        if (receipt) {
          const recorded = JSON.parse(receipt.result_json);
          if (receipt.result_type === "accepted") accepted.push(recorded);
          else if (receipt.result_type === "conflict") conflicts.push(recorded);
          else failed.push(recorded);
          continue;
        }

        const current = this.database
          .prepare(
            `SELECT payload_json, version, operation, deleted_at, updated_at
             FROM sync_entities
             WHERE user_id = ? AND entity_type = ? AND entity_id = ? LIMIT 1`,
          )
          .get(userId, change.entityType, change.id);
        const preferenceLastWriteWins = change.entityType === "preference";
        const currentVersion = Number(current?.version || 0);
        if (!preferenceLastWriteWins && change.baseVersion !== currentVersion) {
          const conflict = {
            changeId: change.changeId,
            entityType: change.entityType,
            id: change.id,
            remote: current ? entityFromRow(change.entityType, change.id, current) : null,
          };
          conflicts.push(conflict);
          this.recordV3Receipt(userId, deviceId, change.changeId, "conflict", conflict);
          continue;
        }

        const version = currentVersion + 1;
        const now = new Date().toISOString();
        const deletedAt = change.operation === "delete" ? now : null;
        const payloadJson = JSON.stringify(change.payload ?? {});
        this.database
          .prepare(
            `INSERT INTO sync_entities(
               user_id, entity_type, entity_id, payload_json, version,
               operation, deleted_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id, entity_type, entity_id) DO UPDATE SET
               payload_json = excluded.payload_json,
               version = excluded.version,
               operation = excluded.operation,
               deleted_at = excluded.deleted_at,
               updated_at = excluded.updated_at`,
          )
          .run(
            userId,
            change.entityType,
            change.id,
            payloadJson,
            version,
            change.operation,
            deletedAt,
            now,
          );
        this.database
          .prepare(
            `INSERT INTO sync_changes(
               user_id, entity_type, entity_id, payload_json, version,
               operation, origin_device_id, change_id, changed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            userId,
            change.entityType,
            change.id,
            payloadJson,
            version,
            change.operation,
            deviceId,
            change.changeId,
            now,
          );
        const acceptedItem = {
          entityType: change.entityType,
          id: change.id,
          version,
          changeId: change.changeId,
        };
        accepted.push(acceptedItem);
        this.recordV3Receipt(userId, deviceId, change.changeId, "accepted", acceptedItem);
        if (change.entityType === "article" && (
          change.operation === "delete"
          || (
            typeof change.payload?.body === "string"
            && !change.payload.body.includes("attachment://")
          )
        )) {
          this.dualWriteV3ArticleToV2(userId, deviceId, change, version, now);
        }
      }

      this.database
        .prepare(
          `DELETE FROM sync_receipts
           WHERE user_id = ? AND julianday(created_at) < julianday('now', '-90 days')`,
        )
        .run(userId);
      const page = this.readV3Page(userId, deviceId, cursor);
      this.database.exec("COMMIT");
      return {
        protocolVersion: 3,
        ...page,
        accepted,
        conflicts,
        failed,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  readV3Page(userId, deviceId, cursor) {
    const rows = this.database
      .prepare(
        `SELECT sequence, entity_type, entity_id, payload_json, version,
                operation, origin_device_id, change_id, changed_at
         FROM sync_changes
         WHERE user_id = ? AND sequence > ?
         ORDER BY sequence ASC
         LIMIT 501`,
      )
      .all(userId, cursor);
    const changes = [];
    let bytes = 0;
    let processed = 0;
    let nextCursor = cursor;
    for (const row of rows) {
      if (processed >= 500) break;
      const entity = entityFromChangeRow(row);
      const itemBytes = Buffer.byteLength(JSON.stringify(entity), "utf8");
      if (changes.length && row.origin_device_id !== deviceId && bytes + itemBytes > 2 * 1024 * 1024) break;
      processed += 1;
      nextCursor = Number(row.sequence);
      if (row.origin_device_id === deviceId) continue;
      changes.push(entity);
      bytes += itemBytes;
    }
    return {
      cursor: String(nextCursor),
      hasMore: processed < rows.length,
      changes,
    };
  }

  recordV3Receipt(userId, deviceId, changeId, resultType, result) {
    this.database
      .prepare(
        `INSERT INTO sync_receipts(
           user_id, device_id, change_id, result_type, result_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, device_id, change_id) DO NOTHING`,
      )
      .run(userId, deviceId, changeId, resultType, JSON.stringify(result), new Date().toISOString());
  }

  dualWriteV3ArticleToV2(userId, deviceId, change, version, now) {
    const current = this.database
      .prepare("SELECT payload_json, version FROM articles WHERE user_id = ? AND id = ? LIMIT 1")
      .get(userId, change.id);
    if (change.operation === "delete" && !current) return;
    const article = change.operation === "delete"
      ? JSON.parse(current.payload_json)
      : structuredClone(change.payload);
    const compatibleVersion = Math.max(version, Number(current?.version || 0) + 1);
    article.storage = {
      version: compatibleVersion,
      deviceId,
      syncStatus: "synced",
      deletedAt: change.operation === "delete" ? now : null,
    };
    const payload = JSON.stringify(article);
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
        change.id,
        payload,
        compatibleVersion,
        deviceId,
        change.operation,
        change.operation === "delete" ? now : null,
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
        change.id,
        payload,
        compatibleVersion,
        change.operation,
        deviceId,
        `v3:${change.changeId}`,
        now,
      );
  }

  blobPath(sha256) {
    const hash = validateSha256(sha256);
    return path.join(this.blobDirectory, hash.slice(0, 2), hash);
  }

  getBlob(userId, sha256) {
    const hash = validateSha256(sha256);
    const row = this.database
      .prepare(
        `SELECT b.byte_length, b.mime_type
         FROM user_blobs ub JOIN blobs b ON b.sha256 = ub.sha256
         WHERE ub.user_id = ? AND ub.sha256 = ? LIMIT 1`,
      )
      .get(userId, hash);
    if (!row) return null;
    const filePath = this.blobPath(hash);
    if (!fs.existsSync(filePath)) return null;
    return { path: filePath, bytes: Number(row.byte_length), mimeType: row.mime_type };
  }

  registerBlob(userId, sha256, byteLength, mimeType) {
    const hash = validateSha256(sha256);
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO blobs(sha256, byte_length, mime_type, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(sha256) DO UPDATE SET
             byte_length = excluded.byte_length,
             mime_type = excluded.mime_type`,
        )
        .run(hash, byteLength, mimeType, now);
      this.database
        .prepare(
          `INSERT INTO user_blobs(user_id, sha256, created_at) VALUES (?, ?, ?)
           ON CONFLICT(user_id, sha256) DO NOTHING`,
        )
        .run(userId, hash, now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  runMaintenance({ now = new Date(), blobGraceHours = 24, tombstoneRetentionDays = 90 } = {}) {
    const currentTime = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(currentTime.getTime())) throw new Error("maintenance time is invalid");
    const historyCutoff = new Date(currentTime.getTime() - tombstoneRetentionDays * 86_400_000).toISOString();
    const blobCutoff = new Date(currentTime.getTime() - blobGraceHours * 3_600_000).toISOString();

    const compactedChanges = Number(this.database.prepare(
      `DELETE FROM sync_changes
       WHERE changed_at < ?
         AND EXISTS (
           SELECT 1 FROM sync_changes newer
           WHERE newer.user_id = sync_changes.user_id
             AND newer.entity_type = sync_changes.entity_type
             AND newer.entity_id = sync_changes.entity_id
             AND newer.sequence > sync_changes.sequence
         )`,
    ).run(historyCutoff).changes);

    const retained = new Set();
    const attachments = this.database.prepare(
      `SELECT user_id, payload_json, operation, deleted_at
       FROM sync_entities WHERE entity_type = 'attachment'`,
    ).all();
    for (const attachment of attachments) {
      const keep = attachment.operation === "upsert"
        || !attachment.deleted_at
        || attachment.deleted_at >= historyCutoff;
      if (!keep) continue;
      try {
        const payload = JSON.parse(attachment.payload_json);
        for (const hash of [payload.original_hash, payload.preview_hash, payload.originalHash, payload.previewHash]) {
          if (typeof hash === "string" && /^[a-f\d]{64}$/i.test(hash)) {
            retained.add(`${attachment.user_id}:${hash.toLowerCase()}`);
          }
        }
      } catch {
        // Malformed entity payloads stay isolated; they must not stop maintenance.
      }
    }

    let removedUserLinks = 0;
    const candidates = this.database.prepare(
      "SELECT user_id, sha256 FROM user_blobs WHERE created_at < ?",
    ).all(blobCutoff);
    const removeUserBlob = this.database.prepare(
      "DELETE FROM user_blobs WHERE user_id = ? AND sha256 = ?",
    );
    for (const candidate of candidates) {
      if (retained.has(`${candidate.user_id}:${candidate.sha256}`)) continue;
      removedUserLinks += Number(removeUserBlob.run(candidate.user_id, candidate.sha256).changes);
    }

    let removedBlobs = 0;
    const unused = this.database.prepare(
      `SELECT blobs.sha256 FROM blobs
       LEFT JOIN user_blobs ON user_blobs.sha256 = blobs.sha256
       WHERE user_blobs.sha256 IS NULL`,
    ).all();
    const removeBlob = this.database.prepare("DELETE FROM blobs WHERE sha256 = ?");
    for (const blob of unused) {
      const filePath = this.blobPath(blob.sha256);
      try {
        fs.rmSync(filePath, { force: true });
        removedBlobs += Number(removeBlob.run(blob.sha256).changes);
      } catch {
        // Keep the database row so a transient filesystem failure can be retried later.
      }
    }
    return { compactedChanges, removedUserLinks, removedBlobs };
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
        this.dualWriteV2ArticleToV3(
          userId,
          deviceId,
          article,
          change.operation,
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

  dualWriteV2ArticleToV3(userId, deviceId, article, operation, changeId, now) {
    const current = this.database
      .prepare(
        `SELECT version FROM sync_entities
         WHERE user_id = ? AND entity_type = 'article' AND entity_id = ? LIMIT 1`,
      )
      .get(userId, article.id);
    const version = Number(current?.version || 0) + 1;
    const payload = JSON.stringify(article);
    const deletedAt = operation === "delete" ? article.storage.deletedAt || now : null;
    this.database
      .prepare(
        `INSERT INTO sync_entities(
           user_id, entity_type, entity_id, payload_json, version,
           operation, deleted_at, updated_at
         ) VALUES (?, 'article', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, entity_type, entity_id) DO UPDATE SET
           payload_json = excluded.payload_json,
           version = excluded.version,
           operation = excluded.operation,
           deleted_at = excluded.deleted_at,
           updated_at = excluded.updated_at`,
      )
      .run(userId, article.id, payload, version, operation, deletedAt, now);
    this.database
      .prepare(
        `INSERT INTO sync_changes(
           user_id, entity_type, entity_id, payload_json, version,
           operation, origin_device_id, change_id, changed_at
         ) VALUES (?, 'article', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        article.id,
        payload,
        version,
        operation,
        deviceId,
        `v2:${changeId || `${deviceId}:${article.id}:${article.storage.version}`}`,
        now,
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

const syncEntityTypes = new Set([
  "article",
  "attachment",
  "project",
  "milestone",
  "task",
  "log",
  "proposal",
  "task_plan",
  "task_plan_history",
  "daily_situation",
  "focus_session",
  "weekly_focus",
  "weekly_review",
  "daily_closeout",
  "calendar_event",
  "rest_day",
  "preference",
]);

function validateV3Change(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClientInputError("变更格式不正确");
  }
  if (typeof value.entityType !== "string" || !syncEntityTypes.has(value.entityType)) {
    throw new ClientInputError("实体类型不受支持");
  }
  if (typeof value.id !== "string" || !value.id.trim() || Buffer.byteLength(value.id, "utf8") > 300) {
    throw new ClientInputError("实体 ID 不正确");
  }
  if (!Number.isSafeInteger(value.baseVersion) || value.baseVersion < 0) {
    throw new ClientInputError("基础版本不正确");
  }
  if (!['upsert', 'delete'].includes(value.operation)) {
    throw new ClientInputError("同步操作不正确");
  }
  if (value.payload !== null && (typeof value.payload !== "object" || Array.isArray(value.payload))) {
    throw new ClientInputError("实体负载不正确");
  }
  if (Buffer.byteLength(JSON.stringify(value.payload ?? {}), "utf8") > 512 * 1024) {
    throw new ClientInputError("单条实体负载不能超过 512 KiB");
  }
  return {
    entityType: value.entityType,
    id: value.id.trim(),
    baseVersion: value.baseVersion,
    operation: value.operation,
    payload: structuredClone(value.payload ?? {}),
    changeId: validateChangeId(value.changeId),
  };
}

function entityFromRow(entityType, id, row) {
  return {
    entityType,
    id,
    payload: JSON.parse(row.payload_json),
    version: Number(row.version),
    operation: row.operation,
    deletedAt: row.deleted_at ?? null,
    updatedAt: row.updated_at,
  };
}

function entityFromChangeRow(row) {
  return {
    entityType: row.entity_type,
    id: row.entity_id,
    payload: JSON.parse(row.payload_json),
    version: Number(row.version),
    operation: row.operation,
    changeId: row.change_id,
    deletedAt: row.operation === "delete" ? row.changed_at : null,
    updatedAt: row.changed_at,
  };
}

function refreshTokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeDeviceId(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 200);
}

function validateSha256(value) {
  if (typeof value !== "string" || !/^[a-f\d]{64}$/i.test(value)) {
    throw new ClientInputError("Blob 哈希不正确");
  }
  return value.toLowerCase();
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

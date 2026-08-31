import type {
  SqliteDatabase,
  SqliteStatement,
  SqliteValue,
} from "./sqlite-article-repository";
import { executeSqliteTransaction } from "./sqlite-article-repository";

export type SyncEntityType =
  | "article"
  | "attachment"
  | "project"
  | "milestone"
  | "task"
  | "log"
  | "proposal"
  | "task_plan"
  | "focus_session"
  | "weekly_focus"
  | "weekly_review"
  | "daily_closeout"
  | "calendar_event"
  | "rest_day"
  | "preference";

export type SyncEntity = {
  entityType: SyncEntityType;
  id: string;
  baseVersion: number;
  operation: "upsert" | "delete";
  payload: Record<string, unknown>;
  changeId: string;
};

export type RemoteSyncEntity = Omit<SyncEntity, "baseVersion"> & {
  version: number;
  deletedAt: string | null;
  updatedAt: string;
};

export type SyncAccepted = {
  entityType: SyncEntityType;
  id: string;
  version: number;
  changeId: string;
};

export type SyncConflictResponse = {
  changeId: string;
  entityType: SyncEntityType;
  id: string;
  remote: Omit<RemoteSyncEntity, "changeId" | "baseVersion"> | null;
};

export type SyncFailed = { index: number; changeId: string; error: string };

export type UniversalSyncResponse = {
  protocolVersion: 3;
  cursor: string;
  hasMore: boolean;
  accepted: SyncAccepted[];
  conflicts: SyncConflictResponse[];
  failed: SyncFailed[];
  changes: RemoteSyncEntity[];
};

export type SyncConflict = {
  id: string;
  entityType: SyncEntityType;
  entityId: string;
  localPayload: Record<string, unknown>;
  remotePayload: Record<string, unknown>;
  remoteVersion: number;
  remoteOperation: "upsert" | "delete";
  createdAt: string;
};

export type SyncRecycleItem = {
  entityType: SyncEntityType;
  entityId: string;
  payload: Record<string, unknown>;
  deletedAt: string;
  purgeAfter: string;
};

export type SyncItemError = {
  entityType: SyncEntityType;
  entityId: string;
  error: string;
  updatedAt: string;
};

type EntityMapping = {
  entityType: SyncEntityType;
  table: string;
  idColumn: string;
  idPrefix?: string;
  literalId?: string;
  where?: string;
  excludedColumns?: string[];
  softDelete?: boolean;
};

type ResolvedMapping = EntityMapping & {
  columns: string[];
  payloadColumns: string[];
};

const preferenceKeys = [
  "workspace_display_name",
  "workspace_avatar_data_url",
  "workspace_quick_links_v5",
] as const;

const mappings: EntityMapping[] = [
  { entityType: "article", table: "articles", idColumn: "id", excludedColumns: ["version", "device_id", "sync_status"], softDelete: true },
  { entityType: "attachment", table: "attachments", idColumn: "id", excludedColumns: ["version", "device_id", "sync_status", "orphaned_at"], softDelete: true },
  { entityType: "project", table: "projects", idColumn: "id" },
  { entityType: "milestone", table: "project_milestones", idColumn: "id" },
  { entityType: "task", table: "project_tasks", idColumn: "id", softDelete: true },
  { entityType: "log", table: "project_logs", idColumn: "id" },
  { entityType: "proposal", table: "project_proposals", idColumn: "id" },
  { entityType: "task_plan", table: "task_plans", idColumn: "task_id" },
  { entityType: "focus_session", table: "focus_sessions", idColumn: "id" },
  { entityType: "weekly_focus", table: "weekly_focus", idColumn: "week_start" },
  { entityType: "weekly_review", table: "weekly_reviews", idColumn: "week_start" },
  { entityType: "daily_closeout", table: "daily_closeouts", idColumn: "closeout_date" },
  { entityType: "calendar_event", table: "calendar_events", idColumn: "id" },
  { entityType: "rest_day", table: "rest_days", idColumn: "rest_date" },
  { entityType: "preference", table: "dashboard_preferences", idColumn: "id", literalId: "dashboard" },
  {
    entityType: "preference",
    table: "app_meta",
    idColumn: "key",
    idPrefix: "app_meta:",
    where: `key IN (${preferenceKeys.map((key) => `'${key}'`).join(", ")})`,
  },
];

const syncMigrations = [
  `CREATE TABLE IF NOT EXISTS sync_state (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    server_version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(entity_type, entity_id)
  )`,
  `CREATE TABLE IF NOT EXISTS sync_outbox (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    base_version INTEGER NOT NULL DEFAULT 0,
    operation TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    change_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(entity_type, entity_id)
  )`,
  `CREATE TABLE IF NOT EXISTS sync_conflicts (
    id TEXT PRIMARY KEY NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    local_payload_json TEXT NOT NULL,
    remote_payload_json TEXT NOT NULL,
    remote_version INTEGER NOT NULL,
    remote_operation TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sync_recycle_bin (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    deleted_at TEXT NOT NULL,
    purge_after TEXT NOT NULL,
    PRIMARY KEY(entity_type, entity_id)
  )`,
  "CREATE INDEX IF NOT EXISTS sync_outbox_status_idx ON sync_outbox(status, updated_at)",
  "CREATE INDEX IF NOT EXISTS sync_conflicts_created_idx ON sync_conflicts(created_at DESC)",
  "CREATE INDEX IF NOT EXISTS sync_recycle_purge_idx ON sync_recycle_bin(purge_after)",
] as const;

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlText(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function randomChangeId(entityType: string, entityId: string) {
  return `${entityType}:${entityId}:${crypto.randomUUID()}`;
}

export class UniversalSyncRepository {
  private initialization: Promise<void> | null = null;
  private resolvedMappings: ResolvedMapping[] = [];

  constructor(private readonly database: SqliteDatabase) {}

  async initialize() {
    this.initialization ??= this.initializeInternal().catch((error) => {
      this.initialization = null;
      throw error;
    });
    await this.initialization;
  }

  private async initializeInternal() {
    for (const statement of syncMigrations) await this.database.execute(statement);
    this.resolvedMappings = [];
    for (const mapping of mappings) {
      const columns = await this.database.select<{ name: string }>(
        `PRAGMA table_info(${quoteIdentifier(mapping.table)})`,
      );
      if (!columns.length) continue;
      const names = columns.map((column) => column.name);
      const excluded = new Set(mapping.excludedColumns ?? []);
      const payloadColumns = names.filter((column) => !excluded.has(column));
      const resolved = { ...mapping, columns: names, payloadColumns };
      this.resolvedMappings.push(resolved);
      await this.installTriggers(resolved);
      await this.bootstrap(resolved);
    }
    await this.purgeExpiredRecycle();
  }

  private entityIdSql(mapping: EntityMapping, alias: "NEW" | "OLD") {
    if (mapping.literalId) return sqlText(mapping.literalId);
    const value = `${alias}.${quoteIdentifier(mapping.idColumn)}`;
    return mapping.idPrefix ? `(${sqlText(mapping.idPrefix)} || ${value})` : value;
  }

  private payloadSql(mapping: ResolvedMapping, alias: "NEW" | "OLD") {
    return `json_object(${mapping.payloadColumns
      .flatMap((column) => [sqlText(column), `${alias}.${quoteIdentifier(column)}`])
      .join(", ")})`;
  }

  private operationSql(mapping: ResolvedMapping, alias: "NEW" | "OLD") {
    return mapping.columns.includes("deleted_at")
      ? `CASE WHEN ${alias}.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END`
      : "'upsert'";
  }

  private triggerWhen(mapping: ResolvedMapping, alias: "NEW" | "OLD") {
    const clauses = [
      `COALESCE((SELECT value FROM app_meta WHERE key = 'sync_applying_remote'), '0') <> '1'`,
    ];
    if (mapping.where) clauses.push(mapping.where.replaceAll(mapping.idColumn, `${alias}.${mapping.idColumn}`));
    return clauses.join(" AND ");
  }

  private enqueueSql(mapping: ResolvedMapping, alias: "NEW" | "OLD", operation?: "delete") {
    const entityId = this.entityIdSql(mapping, alias);
    const operationSql = operation ? "'delete'" : this.operationSql(mapping, alias);
    const payload = this.payloadSql(mapping, alias);
    const entityType = sqlText(mapping.entityType);
    return `INSERT INTO sync_outbox(
              entity_type, entity_id, base_version, operation, payload_json,
              change_id, status, error, updated_at
            ) VALUES (
              ${entityType}, ${entityId},
              COALESCE((SELECT server_version FROM sync_state WHERE entity_type = ${entityType} AND entity_id = ${entityId}), 0),
              ${operationSql}, ${payload},
              ${entityType} || ':' || ${entityId} || ':' || lower(hex(randomblob(16))),
              'pending', NULL, datetime('now')
            )
            ON CONFLICT(entity_type, entity_id) DO UPDATE SET
              base_version = excluded.base_version,
              operation = excluded.operation,
              payload_json = excluded.payload_json,
              change_id = CASE WHEN sync_outbox.status = 'pending' THEN sync_outbox.change_id ELSE excluded.change_id END,
              status = 'pending', error = NULL, updated_at = excluded.updated_at;`;
  }

  private recycleSql(mapping: ResolvedMapping, alias: "NEW" | "OLD") {
    const entityId = this.entityIdSql(mapping, alias);
    return `INSERT INTO sync_recycle_bin(entity_type, entity_id, payload_json, deleted_at, purge_after)
            VALUES (${sqlText(mapping.entityType)}, ${entityId}, ${this.payloadSql(mapping, alias)}, datetime('now'), datetime('now', '+90 days'))
            ON CONFLICT(entity_type, entity_id) DO UPDATE SET
              payload_json = excluded.payload_json,
              deleted_at = excluded.deleted_at,
              purge_after = excluded.purge_after;`;
  }

  private async installTriggers(mapping: ResolvedMapping) {
    const name = mapping.table.replace(/[^a-z\d_]/gi, "_");
    const table = quoteIdentifier(mapping.table);
    const insertWhen = this.triggerWhen(mapping, "NEW");
    const updateWhen = `${this.triggerWhen(mapping, "NEW")} AND (${this.payloadSql(mapping, "OLD")} <> ${this.payloadSql(mapping, "NEW")} OR ${this.operationSql(mapping, "OLD")} <> ${this.operationSql(mapping, "NEW")})`;
    const deleteWhen = this.triggerWhen(mapping, "OLD");
    const removeRecycle = `DELETE FROM sync_recycle_bin WHERE entity_type = ${sqlText(mapping.entityType)} AND entity_id = ${this.entityIdSql(mapping, "NEW")} AND ${this.operationSql(mapping, "NEW")} = 'upsert';`;
    for (const suffix of ["insert", "update", "delete", "soft_delete"]) {
      await this.database.execute(`DROP TRIGGER IF EXISTS sync_capture_${name}_${suffix}`);
    }
    await this.database.execute(
      `CREATE TRIGGER sync_capture_${name}_insert AFTER INSERT ON ${table}
       WHEN ${insertWhen}
       BEGIN
         ${this.enqueueSql(mapping, "NEW")}
         ${removeRecycle}
       END`,
    );
    await this.database.execute(
      `CREATE TRIGGER sync_capture_${name}_update AFTER UPDATE ON ${table}
       WHEN ${updateWhen}
       BEGIN
         ${this.enqueueSql(mapping, "NEW")}
         ${removeRecycle}
       END`,
    );
    if (mapping.columns.includes("deleted_at")) {
      await this.database.execute(
        `CREATE TRIGGER sync_capture_${name}_soft_delete AFTER UPDATE ON ${table}
         WHEN ${this.triggerWhen(mapping, "NEW")} AND NEW.deleted_at IS NOT NULL
         BEGIN
           ${this.recycleSql(mapping, "NEW")}
         END`,
      );
    }
    await this.database.execute(
      `CREATE TRIGGER sync_capture_${name}_delete AFTER DELETE ON ${table}
       WHEN ${deleteWhen}
       BEGIN
         ${this.enqueueSql(mapping, "OLD", "delete")}
         ${this.recycleSql(mapping, "OLD")}
       END`,
    );
  }

  private async bootstrap(mapping: ResolvedMapping) {
    const rows = await this.database.select<Record<string, SqliteValue>>(
      `SELECT * FROM ${quoteIdentifier(mapping.table)}${mapping.where ? ` WHERE ${mapping.where}` : ""}`,
    );
    for (const row of rows) {
      const rawId = mapping.literalId ?? `${mapping.idPrefix ?? ""}${String(row[mapping.idColumn] ?? "")}`;
      if (!rawId) continue;
      const known = await this.database.select<{ value: number }>(
        `SELECT 1 AS value FROM sync_state WHERE entity_type = ? AND entity_id = ?
         UNION ALL SELECT 1 FROM sync_outbox WHERE entity_type = ? AND entity_id = ? LIMIT 1`,
        [mapping.entityType, rawId, mapping.entityType, rawId],
      );
      if (known.length) continue;
      const payload = Object.fromEntries(
        mapping.payloadColumns.map((column) => [column, row[column] ?? null]),
      );
      const operation = mapping.columns.includes("deleted_at") && row.deleted_at ? "delete" : "upsert";
      await this.database.execute(
        `INSERT INTO sync_outbox(
           entity_type, entity_id, base_version, operation, payload_json,
           change_id, status, updated_at
         ) VALUES (?, ?, 0, ?, ?, ?, 'pending', ?)`,
        [mapping.entityType, rawId, operation, JSON.stringify(payload), randomChangeId(mapping.entityType, rawId), new Date().toISOString()],
      );
    }
  }

  async getDeviceId() {
    await this.initialize();
    const rows = await this.database.select<{ value: string }>(
      "SELECT value FROM app_meta WHERE key = 'device_id' LIMIT 1",
    );
    if (!rows[0]?.value) throw new Error("本机同步标识尚未初始化");
    return rows[0].value;
  }

  async getCursor() {
    await this.initialize();
    const rows = await this.database.select<{ value: string }>(
      "SELECT value FROM app_meta WHERE key = 'sync_v3_cursor' LIMIT 1",
    );
    return rows[0]?.value || "";
  }

  async listPending(maxItems = 200, maxBytes = 1024 * 1024): Promise<SyncEntity[]> {
    await this.initialize();
    const rows = await this.database.select<{
      entity_type: SyncEntityType;
      entity_id: string;
      base_version: number;
      operation: "upsert" | "delete";
      payload_json: string;
      change_id: string;
    }>(
      `SELECT entity_type, entity_id, base_version, operation, payload_json, change_id
       FROM sync_outbox WHERE status = 'pending' ORDER BY updated_at ASC LIMIT ?`,
      [maxItems],
    );
    const result: SyncEntity[] = [];
    let bytes = 2;
    for (const row of rows) {
      const item: SyncEntity = {
        entityType: row.entity_type,
        id: row.entity_id,
        baseVersion: Number(row.base_version),
        operation: row.operation,
        payload: parseRecord(row.payload_json),
        changeId: row.change_id,
      };
      const itemBytes = new TextEncoder().encode(JSON.stringify(item)).byteLength + 1;
      if (result.length && bytes + itemBytes > maxBytes) break;
      result.push(item);
      bytes += itemBytes;
    }
    return result;
  }

  async getStatus() {
    await this.initialize();
    const [outbox, conflicts, recycle, cursor] = await Promise.all([
      this.database.select<{ status: string; count: number }>(
        "SELECT status, COUNT(*) AS count FROM sync_outbox GROUP BY status",
      ),
      this.database.select<{ count: number }>("SELECT COUNT(*) AS count FROM sync_conflicts"),
      this.database.select<{ count: number }>("SELECT COUNT(*) AS count FROM sync_recycle_bin"),
      this.getCursor(),
    ]);
    return {
      pending: Number(outbox.find((row) => row.status === "pending")?.count ?? 0),
      errors: Number(outbox.find((row) => row.status === "error")?.count ?? 0),
      conflicts: Number(conflicts[0]?.count ?? 0),
      recycled: Number(recycle[0]?.count ?? 0),
      cursor,
    };
  }

  async listConflicts(): Promise<SyncConflict[]> {
    await this.initialize();
    const rows = await this.database.select<{
      id: string;
      entity_type: SyncEntityType;
      entity_id: string;
      local_payload_json: string;
      remote_payload_json: string;
      remote_version: number;
      remote_operation: "upsert" | "delete";
      created_at: string;
    }>("SELECT * FROM sync_conflicts ORDER BY created_at DESC");
    return rows.map((row) => ({
      id: row.id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      localPayload: parseRecord(row.local_payload_json),
      remotePayload: parseRecord(row.remote_payload_json),
      remoteVersion: Number(row.remote_version),
      remoteOperation: row.remote_operation,
      createdAt: row.created_at,
    }));
  }

  async listRecycle(): Promise<SyncRecycleItem[]> {
    await this.initialize();
    const rows = await this.database.select<{
      entity_type: SyncEntityType;
      entity_id: string;
      payload_json: string;
      deleted_at: string;
      purge_after: string;
    }>("SELECT * FROM sync_recycle_bin ORDER BY deleted_at DESC");
    return rows.map((row) => ({
      entityType: row.entity_type,
      entityId: row.entity_id,
      payload: parseRecord(row.payload_json),
      deletedAt: row.deleted_at,
      purgeAfter: row.purge_after,
    }));
  }

  async listErrors(): Promise<SyncItemError[]> {
    await this.initialize();
    const rows = await this.database.select<{
      entity_type: SyncEntityType;
      entity_id: string;
      error: string | null;
      updated_at: string;
    }>("SELECT entity_type, entity_id, error, updated_at FROM sync_outbox WHERE status = 'error' ORDER BY updated_at DESC");
    return rows.map((row) => ({
      entityType: row.entity_type,
      entityId: row.entity_id,
      error: row.error || "未知同步错误",
      updatedAt: row.updated_at,
    }));
  }

  async retryError(entityType: SyncEntityType, entityId: string) {
    await this.initialize();
    await this.database.execute(
      "UPDATE sync_outbox SET status = 'pending', error = NULL, updated_at = ? WHERE entity_type = ? AND entity_id = ?",
      [new Date().toISOString(), entityType, entityId],
    );
  }

  async restoreRecycled(entityType: SyncEntityType, entityId: string) {
    await this.initialize();
    const item = (await this.listRecycle()).find((entry) => entry.entityType === entityType && entry.entityId === entityId);
    if (!item) throw new Error("回收站记录不存在");
    const mapping = this.mappingFor(entityType, entityId);
    if (!mapping) throw new Error("这类记录暂时无法恢复");
    const payload = { ...item.payload };
    if (mapping.columns.includes("deleted_at")) payload.deleted_at = null;
    const values = mapping.payloadColumns.filter((column) => Object.hasOwn(payload, column));
    const updates = values.filter((column) => column !== mapping.idColumn);
    await executeSqliteTransaction(this.database, [
      {
        sql: `INSERT INTO ${quoteIdentifier(mapping.table)}(${values.map(quoteIdentifier).join(", ")})
              VALUES(${values.map(() => "?").join(", ")})
              ON CONFLICT(${quoteIdentifier(mapping.idColumn)}) DO UPDATE SET
              ${updates.map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`).join(", ")}`,
        bindValues: values.map((column) => this.sqliteValue(payload[column])),
      },
      { sql: "DELETE FROM sync_recycle_bin WHERE entity_type = ? AND entity_id = ?", bindValues: [entityType, entityId] },
    ]);
  }

  private async purgeExpiredRecycle() {
    const expired = await this.database.select<{ entity_type: SyncEntityType; entity_id: string }>(
      "SELECT entity_type, entity_id FROM sync_recycle_bin WHERE purge_after < datetime('now')",
    );
    if (!expired.length) return;
    const statements: SqliteStatement[] = [
      { sql: `INSERT INTO app_meta(key, value) VALUES('sync_applying_remote', '1') ON CONFLICT(key) DO UPDATE SET value = '1'` },
    ];
    for (const item of expired) {
      const mapping = this.mappingFor(item.entity_type, item.entity_id);
      if (mapping) {
        statements.push({
          sql: `DELETE FROM ${quoteIdentifier(mapping.table)} WHERE ${quoteIdentifier(mapping.idColumn)} = ?`,
          bindValues: [this.rawEntityId(mapping, item.entity_id)],
        });
      }
      statements.push({ sql: "DELETE FROM sync_recycle_bin WHERE entity_type = ? AND entity_id = ?", bindValues: [item.entity_type, item.entity_id] });
    }
    statements.push({ sql: `DELETE FROM app_meta WHERE key = 'sync_applying_remote'` });
    await executeSqliteTransaction(this.database, statements);
  }

  async commit(response: UniversalSyncResponse) {
    await this.initialize();
    const statements: SqliteStatement[] = [
      { sql: `INSERT INTO app_meta(key, value) VALUES('sync_applying_remote', '1') ON CONFLICT(key) DO UPDATE SET value = '1'` },
    ];
    for (const item of response.accepted) {
      statements.push(
        {
          sql: `INSERT INTO sync_state(entity_type, entity_id, server_version, updated_at) VALUES(?, ?, ?, ?)
                ON CONFLICT(entity_type, entity_id) DO UPDATE SET server_version = excluded.server_version, updated_at = excluded.updated_at`,
          bindValues: [item.entityType, item.id, item.version, new Date().toISOString()],
        },
        { sql: "DELETE FROM sync_outbox WHERE entity_type = ? AND entity_id = ? AND change_id = ?", bindValues: [item.entityType, item.id, item.changeId] },
      );
    }
    for (const failure of response.failed) {
      statements.push({
        sql: "UPDATE sync_outbox SET status = 'error', error = ?, updated_at = ? WHERE change_id = ?",
        bindValues: [failure.error.slice(0, 1000), new Date().toISOString(), failure.changeId],
      });
    }
    for (const conflict of response.conflicts) {
      const local = await this.database.select<{ payload_json: string }>(
        "SELECT payload_json FROM sync_outbox WHERE entity_type = ? AND entity_id = ? LIMIT 1",
        [conflict.entityType, conflict.id],
      );
      statements.push(...this.conflictStatements(
        conflict.entityType,
        conflict.id,
        local[0]?.payload_json || "{}",
        conflict.remote,
      ));
    }
    for (const remote of response.changes) {
      const local = await this.database.select<{ payload_json: string }>(
        "SELECT payload_json FROM sync_outbox WHERE entity_type = ? AND entity_id = ? LIMIT 1",
        [remote.entityType, remote.id],
      );
      if (local[0] && remote.entityType !== "preference") {
        statements.push(...this.conflictStatements(remote.entityType, remote.id, local[0].payload_json, remote));
      } else {
        statements.push(...this.applyRemoteStatements(remote));
      }
    }
    statements.push(
      {
        sql: `INSERT INTO app_meta(key, value) VALUES('sync_v3_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        bindValues: [response.cursor],
      },
      { sql: `DELETE FROM app_meta WHERE key = 'sync_applying_remote'` },
    );
    await executeSqliteTransaction(this.database, statements);
  }

  private conflictStatements(
    entityType: SyncEntityType,
    entityId: string,
    localPayload: string,
    remote: SyncConflictResponse["remote"] | RemoteSyncEntity | null,
  ): SqliteStatement[] {
    const conflictId = `${entityType}:${entityId}:${crypto.randomUUID()}`;
    const statements: SqliteStatement[] = [{
      sql: `INSERT INTO sync_conflicts(
              id, entity_type, entity_id, local_payload_json, remote_payload_json,
              remote_version, remote_operation, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      bindValues: [
        conflictId,
        entityType,
        entityId,
        localPayload,
        JSON.stringify(remote?.payload ?? {}),
        remote?.version ?? 0,
        remote?.operation ?? "delete",
        new Date().toISOString(),
      ],
    }];
    if (remote) statements.push(...this.applyRemoteStatements(remote));
    statements.push({ sql: "DELETE FROM sync_outbox WHERE entity_type = ? AND entity_id = ?", bindValues: [entityType, entityId] });
    return statements;
  }

  private mappingFor(entityType: SyncEntityType, entityId: string) {
    return this.resolvedMappings.find((mapping) => (
      mapping.entityType === entityType
      && (mapping.literalId ? mapping.literalId === entityId : mapping.idPrefix ? entityId.startsWith(mapping.idPrefix) : true)
    ));
  }

  private applyRemoteStatements(remote: Omit<RemoteSyncEntity, "changeId" | "baseVersion"> | RemoteSyncEntity): SqliteStatement[] {
    const mapping = this.mappingFor(remote.entityType, remote.id);
    if (!mapping) return [];
    const statements: SqliteStatement[] = [];
    if (remote.operation === "delete") {
      statements.push({
        sql: `INSERT INTO sync_recycle_bin(entity_type, entity_id, payload_json, deleted_at, purge_after)
              VALUES (?, ?, ?, ?, datetime(?, '+90 days'))
              ON CONFLICT(entity_type, entity_id) DO UPDATE SET payload_json = excluded.payload_json, deleted_at = excluded.deleted_at, purge_after = excluded.purge_after`,
        bindValues: [remote.entityType, remote.id, JSON.stringify(remote.payload), remote.deletedAt || remote.updatedAt, remote.deletedAt || remote.updatedAt],
      });
      if (mapping.softDelete && mapping.columns.includes("deleted_at")) {
        statements.push({
          sql: `UPDATE ${quoteIdentifier(mapping.table)} SET deleted_at = ? WHERE ${quoteIdentifier(mapping.idColumn)} = ?`,
          bindValues: [remote.deletedAt || remote.updatedAt, this.rawEntityId(mapping, remote.id)],
        });
      } else {
        statements.push({
          sql: `DELETE FROM ${quoteIdentifier(mapping.table)} WHERE ${quoteIdentifier(mapping.idColumn)} = ?`,
          bindValues: [this.rawEntityId(mapping, remote.id)],
        });
      }
    } else {
      const values = mapping.payloadColumns
        .filter((column) => Object.hasOwn(remote.payload, column));
      if (values.includes(mapping.idColumn)) {
        const updateColumns = values.filter((column) => column !== mapping.idColumn);
        statements.push({
          sql: `INSERT INTO ${quoteIdentifier(mapping.table)}(${values.map(quoteIdentifier).join(", ")})
                VALUES(${values.map(() => "?").join(", ")})
                ON CONFLICT(${quoteIdentifier(mapping.idColumn)}) DO UPDATE SET
                ${updateColumns.map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`).join(", ")}`,
          bindValues: values.map((column) => this.sqliteValue(remote.payload[column])),
        });
      }
      statements.push({ sql: "DELETE FROM sync_recycle_bin WHERE entity_type = ? AND entity_id = ?", bindValues: [remote.entityType, remote.id] });
    }
    statements.push({
      sql: `INSERT INTO sync_state(entity_type, entity_id, server_version, updated_at) VALUES(?, ?, ?, ?)
            ON CONFLICT(entity_type, entity_id) DO UPDATE SET server_version = excluded.server_version, updated_at = excluded.updated_at`,
      bindValues: [remote.entityType, remote.id, remote.version, remote.updatedAt],
    });
    return statements;
  }

  private rawEntityId(mapping: ResolvedMapping, id: string) {
    if (mapping.literalId) return 1;
    return mapping.idPrefix ? id.slice(mapping.idPrefix.length) : id;
  }

  private sqliteValue(value: unknown): SqliteValue {
    if (value === null || typeof value === "string" || typeof value === "number") return value;
    if (typeof value === "boolean") return value ? 1 : 0;
    return JSON.stringify(value);
  }

  async resolveConflict(id: string, strategy: "local" | "remote" | "copy") {
    await this.initialize();
    const conflict = (await this.listConflicts()).find((item) => item.id === id);
    if (!conflict) throw new Error("同步冲突不存在");
    if (strategy === "remote") {
      await this.database.execute("DELETE FROM sync_conflicts WHERE id = ?", [id]);
      return;
    }
    if (strategy === "local") {
      await executeSqliteTransaction(this.database, [
        {
          sql: `INSERT INTO sync_outbox(entity_type, entity_id, base_version, operation, payload_json, change_id, status, updated_at)
                VALUES(?, ?, ?, 'upsert', ?, ?, 'pending', ?)
                ON CONFLICT(entity_type, entity_id) DO UPDATE SET base_version = excluded.base_version, operation = 'upsert', payload_json = excluded.payload_json, change_id = excluded.change_id, status = 'pending', error = NULL, updated_at = excluded.updated_at`,
          bindValues: [conflict.entityType, conflict.entityId, conflict.remoteVersion, JSON.stringify(conflict.localPayload), randomChangeId(conflict.entityType, conflict.entityId), new Date().toISOString()],
        },
        { sql: "DELETE FROM sync_conflicts WHERE id = ?", bindValues: [id] },
      ]);
      return;
    }
    const mapping = this.mappingFor(conflict.entityType, conflict.entityId);
    if (!mapping || mapping.literalId || mapping.idPrefix) throw new Error("这类冲突不能复制为新记录");
    const copyId = `${conflict.entityId}-copy-${Date.now().toString(36)}`;
    const payload = { ...conflict.localPayload, [mapping.idColumn]: copyId };
    if (typeof payload.title === "string") payload.title = `${payload.title}（本机副本）`;
    const values = mapping.payloadColumns.filter((column) => Object.hasOwn(payload, column));
    await executeSqliteTransaction(this.database, [
      {
        sql: `INSERT INTO ${quoteIdentifier(mapping.table)}(${values.map(quoteIdentifier).join(", ")}) VALUES(${values.map(() => "?").join(", ")})`,
        bindValues: values.map((column) => this.sqliteValue(payload[column])),
      },
      { sql: "DELETE FROM sync_conflicts WHERE id = ?", bindValues: [id] },
    ]);
  }
}

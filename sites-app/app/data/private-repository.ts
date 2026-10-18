import { executeSqliteTransaction, type SqliteDatabase, type SqliteStatement, type SqliteValue } from "./sqlite-article-repository";
import { PrivateCrypto, type PrivateEnvelope } from "./private-crypto";
import { FINANCE_CATEGORIES, FINANCE_BUDGET_ROLES } from "../finance-types";

const definitions = {
  health_daily_logs: { keys: ["log_date"], columns: "log_date sleep_minutes sleep_start sleep_end awake_minutes awake_minutes_known sleep_quality energy_level steps weight_kg activity_minutes activity_note note created_at updated_at".split(" ") },
  health_meals: { keys: ["meal_date", "slot"], columns: "meal_date slot eaten_at description updated_at".split(" ") },
  finance_transactions: { keys: ["id"], columns: "id occurred_at amount_cents kind direction account_id source external_transaction_id merchant merchant_normalized description payment_method status category budget_role category_confirmed budget_role_confirmed project_id life_domain import_batch_id related_transaction_id value_rating duplicate_fingerprint created_at updated_at".split(" ") },
} as const;
type Kind = keyof typeof definitions;
type Row = Record<string, string | number | null>;
export type PrivateDocument = { kind: Kind; key: string[]; row: Row | null };
type Journal = { local_id: string; document: string; revision: number };
export type WireRecord = { id: string; version: number; envelope: PrivateEnvelope };
type Outgoing = { id: string; mutationId: string; baseVersion: number; envelope: PrivateEnvelope };
type RequestRow = { local_id: string; revision: number; request: string };
type Conflict = { local_id: string; record: string; document: string };
export type PrivateResponse = { version: 4; keyId: string; cursor: number; hasMore: boolean; records: WireRecord[]; results: Array<{ mutationId: string; status: "accepted"; id: string; version: number } | { mutationId: string; status: "conflict"; record: WireRecord }> };
const localId = (d: PrivateDocument) => JSON.stringify([d.kind, d.key]);
const error = () => new Error("私人同步数据无效，已停止应用更改。");

/** Local journal triggers are in the same transaction as domain writes, including deletes. */
export class PrivateRepository {
  constructor(readonly database: SqliteDatabase) {}
  async ready() {
    const db = this.database;
    for (const sql of [
      "CREATE TABLE IF NOT EXISTS private_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS private_journal(local_id TEXT PRIMARY KEY,document TEXT NOT NULL,revision INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS private_shadow(local_id TEXT PRIMARY KEY,version INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS private_requests(local_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,request TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS private_conflicts(local_id TEXT PRIMARY KEY,record TEXT NOT NULL,document TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS private_clock(id INTEGER PRIMARY KEY CHECK(id=1),tick INTEGER NOT NULL)",
      "INSERT OR IGNORE INTO private_clock VALUES(1,0)",
      "UPDATE private_clock SET tick=MAX(tick,COALESCE((SELECT MAX(revision) FROM private_journal),0)) WHERE id=1",
      "INSERT OR IGNORE INTO private_meta VALUES ('applying','0')",
    ]) await db.execute(sql);
    for (const [kind, definition] of Object.entries(definitions)) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        const ref = operation === "DELETE" ? "OLD" : "NEW";
        const key = `json_array(${definition.keys.map(k => `${ref}.${k}`).join(",")})`;
        const id = `json_array('${kind}',${key})`;
        const row = operation === "DELETE" ? "NULL" : `json_object(${definition.columns.map(c => `'${c}',${ref}.${c}`).join(",")})`;
        const document = `json_object('kind','${kind}','key',${key},'row',${row})`;
        await db.execute(`CREATE TRIGGER IF NOT EXISTS private_${kind}_${operation.toLowerCase()} AFTER ${operation} ON ${kind}
          WHEN (SELECT value FROM private_meta WHERE key='applying')='0' ${kind === "finance_transactions" ? `AND ${ref}.import_batch_id IS NULL` : ""}
          BEGIN UPDATE private_clock SET tick=tick+1 WHERE id=1; INSERT INTO private_journal VALUES (${id},${document},(SELECT tick FROM private_clock WHERE id=1)) ON CONFLICT(local_id) DO UPDATE SET document=excluded.document,revision=excluded.revision; END`);
      }
    }
  }
  async meta(key: string) { return (await this.database.select<{ value: string }>("SELECT value FROM private_meta WHERE key=?", [key]))[0]?.value ?? ""; }
  async setMeta(key: string, value: string) { await this.database.execute("INSERT INTO private_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value]); }
  async deviceId() {
    // Reuse the ordinary sync device ID when this is the desktop database.
    const hasAppMeta = (await this.database.select("SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'")).length;
    const shared = hasAppMeta ? (await this.database.select<{ value: string }>("SELECT value FROM app_meta WHERE key='device_id'"))[0]?.value : undefined;
    if (shared) return shared;
    await this.database.execute("INSERT OR IGNORE INTO private_meta VALUES ('device_id',?)", [crypto.randomUUID()]);
    return this.meta("device_id");
  }
  async enable(binding: string, keyId: string, consent: boolean) {
    if (!consent) throw new Error("请确认历史数据同步范围。");
    const previous = await this.meta("binding");
    if (previous && previous !== binding) throw new Error("此资料库已绑定另一同步账户，请切回原账户。");
    const oldKey = await this.meta("key_id");
    if (oldKey && oldKey !== keyId) throw new Error("恢复码不匹配，请使用原恢复码。");
    const statements: SqliteStatement[] = [];
    if (!oldKey) for (const [kind, def] of Object.entries(definitions)) {
      const key = `json_array(${def.keys.join(",")})`;
      statements.push({ sql: `INSERT OR IGNORE INTO private_journal SELECT json_array('${kind}',${key}), json_object('kind','${kind}','key',${key},'row',json_object(${def.columns.map(c => `'${c}',${c}`).join(",")})),0 FROM ${kind} ${kind === "finance_transactions" ? "WHERE import_batch_id IS NULL" : ""}` });
    }
    for (const [key, value] of [["binding", binding], ["key_id", keyId], ["enabled", "1"]]) statements.push({ sql: "INSERT INTO private_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", bindValues: [key, value] });
    await executeSqliteTransaction(this.database, statements);
  }
  async status() {
    const count = async (table: string) => (await this.database.select<{ n: number }>(`SELECT count(*) n FROM ${table}`))[0].n;
    return { enabled: await this.meta("enabled") === "1", pending: await count("private_journal"), conflicts: await count("private_conflicts") };
  }
  async prepare(cipher: PrivateCrypto) {
    const rows = await this.database.select<Journal>("SELECT j.* FROM private_journal j WHERE NOT EXISTS(SELECT 1 FROM private_conflicts c WHERE c.local_id=j.local_id) AND NOT EXISTS(SELECT 1 FROM private_requests r WHERE r.local_id=j.local_id) LIMIT 100");
    for (const row of rows) {
      const document = validateDocument(JSON.parse(row.document));
      const id = await cipher.remoteId(document.kind, document.key);
      const baseVersion = (await this.database.select<{ version: number }>("SELECT version FROM private_shadow WHERE local_id=?", [row.local_id]))[0]?.version ?? 0;
      const request: Outgoing = { id, mutationId: crypto.randomUUID(), baseVersion, envelope: await cipher.encrypt(id, document) };
      await this.database.execute("INSERT OR IGNORE INTO private_requests VALUES (?,?,?)", [row.local_id, row.revision, JSON.stringify(request)]);
    }
    return (await this.database.select<RequestRow>("SELECT * FROM private_requests LIMIT 100")).map(r => JSON.parse(r.request) as Outgoing);
  }
  private async decode(record: WireRecord, cipher: PrivateCrypto) {
    if (!record || !/^[a-f0-9]{64}$/.test(record.id) || !Number.isSafeInteger(record.version) || record.version < 1) throw error();
    const document = validateDocument(await cipher.decrypt(record.id, record.envelope));
    if (await cipher.remoteId(document.kind, document.key) !== record.id) throw error();
    return document;
  }
  async receive(response: PrivateResponse, cipher: PrivateCrypto, sent: Outgoing[], cursor: number) {
    if (!response || response.version !== 4 || response.keyId !== cipher.keyId || !Number.isSafeInteger(response.cursor) || response.cursor < cursor || typeof response.hasMore !== "boolean" || !Array.isArray(response.records) || response.records.length > 100 || !Array.isArray(response.results) || response.results.length !== sent.length) throw error();
    // Authenticate and validate the entire page before touching SQLite or advancing its cursor.
    const decoded = await Promise.all(response.records.map(r => this.decode(r, cipher)));
    const requests = await this.database.select<RequestRow>("SELECT * FROM private_requests");
    const statements: SqliteStatement[] = [];
    const seen = new Set<string>();
    for (const result of response.results) {
      if (!result || seen.has(result.mutationId)) throw error();
      seen.add(result.mutationId);
      const outgoing = sent.find(r => r.mutationId === result.mutationId);
      const saved = requests.find(r => (JSON.parse(r.request) as Outgoing).mutationId === result.mutationId);
      if (!outgoing || !saved) throw error();
      if (result.status === "accepted") {
        if (result.id !== outgoing.id || result.version !== outgoing.baseVersion + 1) throw error();
        statements.push({ sql: "INSERT INTO private_shadow VALUES (?,?) ON CONFLICT(local_id) DO UPDATE SET version=MAX(version,excluded.version)", bindValues: [saved.local_id, result.version] });
        statements.push({ sql: "DELETE FROM private_journal WHERE local_id=? AND revision=?", bindValues: [saved.local_id, saved.revision] });
      } else if (result.status === "conflict") {
        if (result.record.id !== outgoing.id || result.record.version <= outgoing.baseVersion) throw error();
        const document = await this.decode(result.record, cipher);
        statements.push(this.conflictStatement(result.record, document));
      } else throw error();
      statements.push({ sql: "DELETE FROM private_requests WHERE local_id=?", bindValues: [saved.local_id] });
    }
    response.records.forEach((record, index) => {
      const document = decoded[index];
      const id = localId(document);
      const newer = "COALESCE((SELECT version FROM private_shadow WHERE local_id=?),0) < ?";
      statements.push({ sql: `INSERT INTO private_conflicts SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM private_journal WHERE local_id=?) AND ${newer} ON CONFLICT(local_id) DO UPDATE SET record=excluded.record,document=excluded.document`, bindValues: [id, JSON.stringify(record), JSON.stringify(document), id, id, record.version] });
      const guard = `NOT EXISTS(SELECT 1 FROM private_journal WHERE local_id=?) AND ${newer}`;
      statements.push(...applyStatements(document, guard, [id, id, record.version]));
      statements.push({ sql: `INSERT INTO private_shadow SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM private_journal WHERE local_id=?) ON CONFLICT(local_id) DO UPDATE SET version=MAX(version,excluded.version)`, bindValues: [id, record.version, id] });
    });
    statements.push({ sql: "INSERT INTO private_meta VALUES ('cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", bindValues: [String(response.cursor)] });
    await executeSqliteTransaction(this.database, [{ sql: "UPDATE private_meta SET value='1' WHERE key='applying'" }, ...statements, { sql: "UPDATE private_meta SET value='0' WHERE key='applying'" }]);
  }
  private conflictStatement(record: WireRecord, document: PrivateDocument): SqliteStatement {
    return { sql: "INSERT INTO private_conflicts SELECT ?,?,? WHERE COALESCE((SELECT version FROM private_shadow WHERE local_id=?),0) < ? ON CONFLICT(local_id) DO UPDATE SET record=excluded.record,document=excluded.document", bindValues: [localId(document), JSON.stringify(record), JSON.stringify(document), localId(document), record.version] };
  }
  async conflicts() { return this.database.select<Conflict>("SELECT * FROM private_conflicts"); }
  async localDocument(id: string) { return (await this.database.select<{ document: string }>("SELECT document FROM private_journal WHERE local_id=?", [id]))[0]?.document ?? ""; }
  async resolve(id: string, choice: "local" | "remote") {
    const conflict = (await this.database.select<Conflict>("SELECT * FROM private_conflicts WHERE local_id=?", [id]))[0];
    if (!conflict) return;
    const record = JSON.parse(conflict.record) as WireRecord;
    const statements: SqliteStatement[] = [{ sql: "UPDATE private_meta SET value='1' WHERE key='applying'" }];
    if (choice === "remote") {
      statements.push(...applyStatements(validateDocument(JSON.parse(conflict.document)), "1", []));
      statements.push({ sql: "DELETE FROM private_journal WHERE local_id=?", bindValues: [id] });
    }
    statements.push({ sql: "INSERT INTO private_shadow VALUES (?,?) ON CONFLICT(local_id) DO UPDATE SET version=excluded.version", bindValues: [id, record.version] }, { sql: "DELETE FROM private_requests WHERE local_id=?", bindValues: [id] }, { sql: "DELETE FROM private_conflicts WHERE local_id=?", bindValues: [id] }, { sql: "UPDATE private_meta SET value='0' WHERE key='applying'" });
    await executeSqliteTransaction(this.database, statements);
  }
}

function applyStatements(document: PrivateDocument, guard: string, params: SqliteValue[]): SqliteStatement[] {
  const def = definitions[document.kind];
  const boundary = document.kind === "finance_transactions" ? " AND import_batch_id IS NULL" : "";
  if (!document.row) return [{ sql: `DELETE FROM ${document.kind} WHERE ${def.keys.map(k => `${k}=?`).join(" AND ")}${boundary} AND (${guard})`, bindValues: [...document.key, ...params] }];
  const columns = def.columns;
  return [{ sql: `INSERT INTO ${document.kind}(${columns.join(",")}) SELECT ${columns.map(() => "?").join(",")} WHERE (${guard}) ON CONFLICT(${def.keys.join(",")}) DO UPDATE SET ${columns.filter(c => !(def.keys as readonly string[]).includes(c)).map(c => `${c}=excluded.${c}`).join(",")} ${boundary ? "WHERE finance_transactions.import_batch_id IS NULL" : ""}`, bindValues: [...columns.map(c => document.row![c]), ...params] }];
}
function validateDocument(value: unknown): PrivateDocument {
  if (!value || typeof value !== "object") throw error();
  const d = value as PrivateDocument;
  if (!Object.hasOwn(definitions, d.kind) || Object.keys(d).sort().join() !== "key,kind,row") throw error();
  const def = definitions[d.kind];
  if (!Array.isArray(d.key) || d.key.length !== def.keys.length || d.key.some(k => typeof k !== "string" || !k || k.length > 150)) throw error();
  if (d.kind !== "finance_transactions" && !validDate(d.key[0])) throw error();
  if (d.kind === "health_meals" && !["breakfast", "lunch", "dinner", "snack"].includes(d.key[1])) throw error();
  if (d.row === null) return d;
  if (!d.row || typeof d.row !== "object" || Object.keys(d.row).sort().join() !== [...def.columns].sort().join()) throw error();
  for (const v of Object.values(d.row)) if (!(v === null || typeof v === "string" && v.length <= 32000 || typeof v === "number" && Number.isFinite(v))) throw error();
  if (def.keys.some((k, i) => d.row![k] !== d.key[i])) throw error();
  const strings = d.kind === "health_daily_logs" ? "log_date sleep_start sleep_end activity_note note created_at updated_at" : d.kind === "health_meals" ? "meal_date slot eaten_at description updated_at" : "id occurred_at kind direction account_id source external_transaction_id merchant merchant_normalized description payment_method status category budget_role duplicate_fingerprint created_at updated_at";
  if (strings.split(" ").some(k => typeof d.row![k] !== "string")) throw error();
  const numberIn = (field: string, min: number, max: number, integer = true, nullable = true) => {
    const v = d.row![field];
    if (nullable && v === null) return;
    if (typeof v !== "number" || v < min || v > max || integer && !Number.isInteger(v)) throw error();
  };
  if (d.kind === "health_daily_logs") {
    numberIn("sleep_minutes", 1, 1440); numberIn("awake_minutes", 0, 720, true, false); numberIn("awake_minutes_known", 0, 1, true, false);
    numberIn("sleep_quality", 1, 5); numberIn("energy_level", 1, 5); numberIn("steps", 0, 200000); numberIn("weight_kg", 25, 400, false); numberIn("activity_minutes", 0, 1440);
  }
  const clockFields = d.kind === "health_daily_logs" ? ["sleep_start", "sleep_end"] : d.kind === "health_meals" ? ["eaten_at"] : [];
  for (const k of clockFields) if (d.row[k] !== "" && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(d.row[k]))) throw error();
  if (d.kind === "finance_transactions") {
    if (d.row.import_batch_id !== null || d.row.external_transaction_id !== "" || !["alipay", "wechat", "cash", "custom"].includes(String(d.row.source)) || d.row.account_id !== `finance-account-${d.row.source}` || !Number.isSafeInteger(d.row.amount_cents) || Number(d.row.amount_cents) < 0 || !["expense", "income", "refund", "transfer", "repayment", "adjustment"].includes(String(d.row.kind)) || !["out", "in", "neutral"].includes(String(d.row.direction))) throw error();
    if (!FINANCE_CATEGORIES.some(c => c.value === d.row!.category) || !FINANCE_BUDGET_ROLES.some(c => c.value === d.row!.budget_role) || Number.isNaN(Date.parse(String(d.row.occurred_at)))) throw error();
    for (const k of ["project_id", "life_domain", "related_transaction_id", "value_rating"]) if (d.row[k] !== null && typeof d.row[k] !== "string") throw error();
    numberIn("category_confirmed", 0, 1, true, false); numberIn("budget_role_confirmed", 0, 1, true, false);
  }
  return d;
}
function validDate(s: string) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s; }

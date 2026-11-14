import { ClientInputError } from "./database.mjs";
const invalid = () => { throw new ClientInputError("私人同步请求无效。"); };
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function initializePrivateSync(db) {
  db.exec("CREATE TABLE IF NOT EXISTS private_vaults (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, key_id TEXT NOT NULL)");
  for (const prefix of ["private", "private_photo"]) db.exec(`
    CREATE TABLE IF NOT EXISTS ${prefix}_records (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, version INTEGER NOT NULL, envelope TEXT NOT NULL, PRIMARY KEY(user_id,id));
    CREATE TABLE IF NOT EXISTS ${prefix}_changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, version INTEGER NOT NULL, envelope TEXT NOT NULL, changed_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ${prefix}_changes_cursor ON ${prefix}_changes(user_id,sequence);
    CREATE TABLE IF NOT EXISTS ${prefix}_receipts (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, mutation_id TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(user_id,mutation_id));`);
}
function validateEnvelope(e, keyId) {
  if (!e || Object.keys(e).sort().join() !== "algorithm,ciphertext,keyId,nonce,version" || e.version !== 4 || e.algorithm !== "AES-256-GCM" || e.keyId !== keyId || !/^[a-f0-9]{24}$/.test(e.nonce) || typeof e.ciphertext !== "string" || !/^[a-f0-9]{32,262144}$/.test(e.ciphertext) || e.ciphertext.length % 2) invalid();
}
export function pairPrivate(db, userId, body) {
  if (!body || !hash(body.keyId) || typeof body.create !== "boolean" || Object.keys(body).sort().join() !== "create,keyId") invalid();
  if (body.create) db.prepare("INSERT OR IGNORE INTO private_vaults VALUES (?,?)").run(userId, body.keyId);
  const vault = db.prepare("SELECT key_id FROM private_vaults WHERE user_id=?").get(userId);
  if (!vault || vault.key_id !== body.keyId) throw new ClientInputError("请先在桌面开启私人同步，并使用同一恢复码配对。");
  return { paired: true, keyId: vault.key_id };
}
export function syncPrivate(db, userId, body) {
  return syncRecords(db, userId, body, false);
}
export function syncPrivatePhotos(db, userId, body) {
  return syncRecords(db, userId, body, true);
}
function syncRecords(db, userId, body, photos) {
  const prefix = photos ? "private_photo" : "private";
  const limit = photos ? 16 : 100;
  if (!body || body.version !== 4 || !hash(body.keyId) || !Number.isSafeInteger(body.cursor) || body.cursor < 0 || !Array.isArray(body.changes) || body.changes.length > limit || typeof body.deviceId !== "string" || !/^[\w-]{1,100}$/.test(body.deviceId)) invalid();
  for (const c of body.changes) {
    if (!c || typeof c !== "object" || !hash(c.id) || typeof c.mutationId !== "string" || !/^[\w-]{1,100}$/.test(c.mutationId) || !Number.isSafeInteger(c.baseVersion) || c.baseVersion < 0 || Object.keys(c).sort().join() !== "baseVersion,envelope,id,mutationId") invalid();
    validateEnvelope(c.envelope, body.keyId);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const vault = db.prepare("SELECT key_id FROM private_vaults WHERE user_id=?").get(userId);
    if (photos && !vault) throw new ClientInputError("请先完成私人同步配对，再同步餐食照片。");
    if (vault && vault.key_id !== body.keyId) throw new ClientInputError("私人同步密钥不匹配，请使用原恢复码配对。");
    db.prepare("INSERT OR IGNORE INTO private_vaults VALUES (?,?)").run(userId, body.keyId);
    const results = body.changes.map(c => {
      const request = JSON.stringify(c);
      const receipt = db.prepare(`SELECT request,result FROM ${prefix}_receipts WHERE user_id=? AND mutation_id=?`).get(userId, c.mutationId);
      if (receipt) { if (receipt.request !== request) invalid(); return JSON.parse(receipt.result); }
      const current = db.prepare(`SELECT id,version,envelope FROM ${prefix}_records WHERE user_id=? AND id=?`).get(userId, c.id);
      let result;
      if ((current?.version ?? 0) !== c.baseVersion) {
        if (!current) invalid();
        result = { mutationId: c.mutationId, status: "conflict", record: wire(current) };
      } else {
        const version = c.baseVersion + 1;
        const envelope = JSON.stringify(c.envelope);
        db.prepare(`INSERT INTO ${prefix}_records VALUES (?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET version=excluded.version,envelope=excluded.envelope`).run(userId, c.id, version, envelope);
        db.prepare(`INSERT INTO ${prefix}_changes(user_id,id,version,envelope,changed_at) VALUES (?,?,?,?,?)`).run(userId, c.id, version, envelope, new Date().toISOString());
        result = { mutationId: c.mutationId, status: "accepted", id: c.id, version };
      }
      db.prepare(`INSERT INTO ${prefix}_receipts VALUES (?,?,?,?)`).run(userId, c.mutationId, request, JSON.stringify(result));
      return result;
    });
    const rows = db.prepare(`SELECT * FROM ${prefix}_changes WHERE user_id=? AND sequence>? ORDER BY sequence LIMIT ?`).all(userId, body.cursor, limit + 1);
    const page = rows.slice(0, limit);
    db.exec("COMMIT");
    return { version: 4, keyId: body.keyId, results, records: page.map(wire), cursor: page.at(-1)?.sequence ?? body.cursor, hasMore: rows.length > limit };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
function wire(row) { return { id: row.id, version: row.version, envelope: JSON.parse(row.envelope) }; }

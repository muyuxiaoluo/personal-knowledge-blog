import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PrivateCrypto, createRecoveryCode } from "../app/data/private-crypto";
import { PrivateRepository, type PrivateResponse } from "../app/data/private-repository";
import { PrivateRequestError, PrivateSyncClient, privateRequest } from "../app/data/private-sync-client";
import { accountBinding, type SecretStore } from "../app/data/secret-store";
import { HealthRepository } from "../app/data/health-repository";
import { FinanceRepository } from "../app/data/finance-repository";
import { emptyHealthDailyLog } from "../app/health-types";
import type { SqliteDatabase, SqliteValue } from "../app/data/sqlite-article-repository";
// The integration fixture executes the production v4 service against a third SQLite database.
// @ts-expect-error Server is a native ESM module, intentionally shared by this integration test.
import { initializePrivateSync, syncPrivate } from "../../sync-server/src/private-sync.mjs";

const sensitive = "不可见餐食蒸鳕鱼_消费秘密_活动备注";
test("mobile distinguishes wrong credentials, expired sessions, missing v4 and network failure without echoing bodies", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const [endpoint, status, expected] of [
    ["/v1/auth/login", 401, "账户或密码不正确"],
    ["/v3/auth/refresh", 401, "登录已过期"],
    ["/v4/private/pair", 404, "服务器尚未支持私人同步"],
    ["/v1/auth/login", 429, "尝试次数过多"],
  ] as const) {
    globalThis.fetch = async () => Response.json({ error: sensitive }, { status });
    await assert.rejects(privateRequest("https://example.test", endpoint, { password: sensitive }), error => error instanceof PrivateRequestError && error.message.includes(expected) && !error.message.includes(sensitive));
  }
  globalThis.fetch = async () => { throw new Error(sensitive); };
  await assert.rejects(privateRequest("https://example.test", "/v1/auth/login", {}), error => error instanceof PrivateRequestError && error.message.includes("无法连接") && !error.message.includes(sensitive));
});
const serverUrl = "https://example.test";
class Adapter implements SqliteDatabase {
  constructor(readonly db: DatabaseSync) {}
  async execute(sql: string, values: SqliteValue[] = []) { const r = this.db.prepare(sql).run(...values); return { rowsAffected: Number(r.changes) }; }
  async select<T>(sql: string, values: SqliteValue[] = []) { return this.db.prepare(sql).all(...values) as T[]; }
}
const entry = { amountCents: 9876543, occurredAt: "2026-09-07T12:30", description: sensitive, source: "custom" as const, category: "other" as const, budgetRole: "unknown" as const, projectId: null, lifeDomain: null, valueRating: null };
async function fixture(t: test.TestContext) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1); PRAGMA foreign_keys=ON;"); initializePrivateSync(db);
  const code = createRecoveryCode(); const cipher = await PrivateCrypto.fromRecoveryCode(code);
  const binding = await accountBinding(serverUrl, "owner");
  const values = new Map<string, string>(); values.set(`private_${binding}`, code);
  const secrets: SecretStore = { get: async k => values.get(k) ?? null, set: async (k, v) => { values.set(k, v); }, remove: async k => { values.delete(k); } };
  let requests = 0;
  const transport = async (_server: string, _endpoint: string, body: unknown) => { requests++; return syncPrivate(db, 1, body); };
  async function client() {
    const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close()); sqlite.exec("PRAGMA foreign_keys=ON");
    const adapter = new Adapter(sqlite); const health = new HealthRepository(adapter); const finance = new FinanceRepository(adapter);
    await health.ready(); await finance.ready(); const repository = new PrivateRepository(adapter); await repository.ready(); await repository.ready();
    const sync = new PrivateSyncClient(repository, serverUrl, "owner", async () => "access", secrets, transport);
    return { sqlite, health, finance, repository, sync, enable: () => repository.enable(binding, cipher.keyId, true) };
  }
  return { db, cipher, binding, transport, client, secrets, count: () => requests };
}

test("AES-GCM roundtrip, randomized nonce, wrong key and modified envelope/AAD reject without plaintext errors", async () => {
  const cipher = await PrivateCrypto.fromRecoveryCode(createRecoveryCode());
  const id = await cipher.remoteId("health_meals", ["2026-09-07", "breakfast"]);
  const data = { text: sensitive, amount: 9876543, date: "2026-09-07", slot: "breakfast" };
  const first = await cipher.encrypt(id, data), second = await cipher.encrypt(id, data);
  assert.deepEqual(await cipher.decrypt(id, first), data); assert.notEqual(first.nonce, second.nonce); assert.notEqual(first.ciphertext, second.ciphertext);
  assert.match(id, /^[a-f0-9]{64}$/); for (const text of [sensitive, "2026-09-07", "breakfast", "9876543"]) assert.ok(!id.includes(text));
  assert.notEqual(await cipher.remoteId("health_meals", ["ab", "c"]), await cipher.remoteId("health_meals", ["a", "bc"]));
  const other = await PrivateCrypto.fromRecoveryCode(createRecoveryCode());
  const corrupt = (v: string) => (v.startsWith("0") ? "1" : "0") + v.slice(1);
  for (const operation of [() => other.decrypt(id, first), () => cipher.decrypt(id, { ...first, ciphertext: corrupt(first.ciphertext) }), () => cipher.decrypt(id, { ...first, nonce: corrupt(first.nonce) }), () => cipher.decrypt(corrupt(id), first), () => cipher.decrypt(id, { ...first, version: 99 as 4 })]) {
    await assert.rejects(operation, e => e instanceof Error && !e.message.includes(sensitive) && !e.message.includes(first.ciphertext));
  }
});

test("two SQLite devices: offline health/meals and manual finance, bidirectional edits, tombstones, no server plaintext", async t => {
  const f = await fixture(t), phone = await f.client(), desktop = await f.client();
  await phone.health.saveDay({ ...emptyHealthDailyLog("2026-09-07"), sleepMinutes: 445, note: sensitive }, [{ date: "2026-09-07", slot: "breakfast", eatenAt: "", description: sensitive, updatedAt: "" }]);
  const tx = await phone.finance.addManualTransaction(entry);
  await phone.sync.sync(); assert.equal(f.count(), 0, "disabled private sync makes no request");
  await phone.enable(); await desktop.enable(); await phone.sync.sync(); await desktop.sync.sync();
  assert.equal((await desktop.health.getDaily("2026-09-07")).sleepMinutes, 445);
  await desktop.health.saveDaily({ ...await desktop.health.getDaily("2026-09-07"), sleepStart: "23:30", sleepEnd: "07:15" });
  await desktop.sync.sync(); await phone.sync.sync();
  const phoneSleep = await phone.health.getDaily("2026-09-07");
  assert.equal(phoneSleep.sleepStart, "23:30"); assert.equal(phoneSleep.sleepEnd, "07:15"); assert.equal(phoneSleep.sleepMinutes, 445);
  assert.equal((await desktop.health.listMeals("2026-09-07"))[0].description, sensitive);
  assert.equal((await desktop.finance.listManualTransactions()).length, 1);
  await desktop.finance.updateManualTransaction(tx.id, { ...entry, amountCents: 200 }); await desktop.sync.sync(); await phone.sync.sync();
  assert.equal((await phone.finance.listManualTransactions())[0].amountCents, 200);
  const raw = JSON.stringify(f.db.prepare("SELECT * FROM private_changes").all()) + JSON.stringify(f.db.prepare("SELECT * FROM private_records").all()) + JSON.stringify(f.db.prepare("SELECT * FROM private_receipts").all());
  for (const text of [sensitive, "9876543", "breakfast", "2026-09-07T12:30", "health_meals"]) assert.ok(!raw.includes(text));
  await phone.finance.deleteManualTransaction(tx.id); await phone.health.saveMeal({ date: "2026-09-07", slot: "breakfast", description: "", eatenAt: "", updatedAt: "" });
  await phone.sync.sync(); await desktop.sync.sync(); assert.equal((await desktop.finance.listManualTransactions()).length, 0); assert.equal((await desktop.health.listMeals("2026-09-07")).length, 0);
  assert.equal((await desktop.repository.status()).pending, 0);
});

test("lost response retries immutable request and remains idempotent even when edited during flight", async t => {
  const f = await fixture(t), a = await f.client(), b = await f.client(); await a.enable(); await b.enable();
  const tx = await a.finance.addManualTransaction(entry); const outgoing = await a.repository.prepare(f.cipher);
  const body = { version: 4, keyId: f.cipher.keyId, cursor: 0, deviceId: "phone", changes: outgoing };
  const first = syncPrivate(f.db, 1, body); const retry = syncPrivate(f.db, 1, body); assert.deepEqual(first.results, retry.results);
  await a.finance.updateManualTransaction(tx.id, { ...entry, description: "新备注" });
  assert.deepEqual(await a.repository.prepare(f.cipher), outgoing);
  await a.repository.receive(retry, f.cipher, outgoing, 0); assert.equal((await a.repository.status()).pending, 1);
  await a.sync.sync(); await b.sync.sync(); const rows = await b.finance.listManualTransactions(); assert.equal(rows.length, 1); assert.equal(rows[0].description, "新备注");
  assert.equal(f.db.prepare("SELECT count(*) n FROM private_records").get()!.n, 1);
});

test("simultaneous changes and delete/edit conflict require an explicit resolution", async t => {
  const f = await fixture(t), a = await f.client(), b = await f.client(); await a.enable(); await b.enable();
  const tx = await a.finance.addManualTransaction(entry); await a.sync.sync(); await b.sync.sync();
  await a.finance.updateManualTransaction(tx.id, { ...entry, amountCents: 100 }); await b.finance.updateManualTransaction(tx.id, { ...entry, amountCents: 200 });
  await a.sync.sync(); await b.sync.sync(); assert.equal((await b.repository.status()).conflicts, 1); assert.equal((await b.finance.listManualTransactions())[0].amountCents, 200);
  await b.repository.resolve((await b.repository.conflicts())[0].local_id, "local"); await b.sync.sync(); await a.sync.sync(); assert.equal((await a.finance.listManualTransactions())[0].amountCents, 200);
  await a.finance.deleteManualTransaction(tx.id); await b.finance.updateManualTransaction(tx.id, { ...entry, amountCents: 300 }); await a.sync.sync(); await b.sync.sync();
  await b.repository.resolve((await b.repository.conflicts())[0].local_id, "remote"); assert.equal((await b.finance.listManualTransactions()).length, 0);
});

test("tampered page and wrong key never advance cursor or write domain rows", async t => {
  const f = await fixture(t), a = await f.client(), b = await f.client(); await a.enable(); await b.enable(); await a.finance.addManualTransaction(entry); await a.sync.sync();
  const page = syncPrivate(f.db, 1, { version: 4, keyId: f.cipher.keyId, cursor: 0, deviceId: "b", changes: [] }) as PrivateResponse;
  page.records[0].envelope.ciphertext = "00" + page.records[0].envelope.ciphertext.slice(2);
  await assert.rejects(() => b.repository.receive(page, f.cipher, [], 0)); assert.equal(await b.repository.meta("cursor"), ""); assert.equal((await b.finance.listManualTransactions()).length, 0);
  assert.throws(() => syncPrivate(f.db, 1, { version: 4, keyId: "0".repeat(64), cursor: 0, deviceId: "b", changes: [] }));
});

test("imported rows, profiles and reports never enter journal; atomic rollback leaves no partial journal", async t => {
  const f = await fixture(t), a = await f.client();
  await a.health.saveReport({ date: "2026-09-07", content: sensitive, generatedAt: "" }); assert.equal((await a.repository.status()).pending, 0);
  a.sqlite.exec("BEGIN"); await a.finance.addManualTransaction(entry); a.sqlite.exec("ROLLBACK"); assert.equal((await a.repository.status()).pending, 0);
  a.sqlite.prepare("INSERT INTO finance_import_batches VALUES ('batch','alipay','a','b','hash','1','{}','now')").run();
  const tx = await a.finance.addManualTransaction(entry);
  a.sqlite.prepare("DELETE FROM private_journal").run();
  a.sqlite.prepare("UPDATE finance_transactions SET import_batch_id='batch' WHERE id=?").run(tx.id);
  await assert.rejects(a.finance.deleteManualTransaction(tx.id), /导入账单/); assert.equal((await a.finance.listManualTransactions()).length, 0); assert.equal((await a.finance.listTransactions()).length, 1);
  await a.finance.rollbackBatch("batch"); assert.equal((await a.repository.status()).pending, 0);
});

test("pagination, disabled switch, account binding and simultaneous sync calls remain isolated", async t => {
  const f = await fixture(t), a = await f.client(), b = await f.client(); await a.enable(); await b.enable();
  for (let i = 0; i < 105; i++) await a.finance.addManualTransaction({ ...entry, amountCents: i + 1 });
  await Promise.all([a.sync.sync(), a.sync.sync()]); await b.sync.sync();
  assert.equal((await b.finance.listManualTransactions(200)).length, 105);
  await assert.rejects(() => a.repository.enable("another-account", f.cipher.keyId, true));
  await a.repository.setMeta("enabled", "0"); await a.finance.addManualTransaction(entry);
  const before = f.count(); await a.sync.sync(); assert.equal(f.count(), before); assert.equal((await a.repository.status()).pending, 1);
});

test("first enable backfills historical rows and an edit during first upload cannot be acknowledged away", async t => {
  const f = await fixture(t), a = await f.client(); const tx = await a.finance.addManualTransaction(entry);
  a.sqlite.exec("DELETE FROM private_journal; UPDATE private_clock SET tick=0");
  await a.enable(); const sent = await a.repository.prepare(f.cipher);
  const response = syncPrivate(f.db, 1, { version: 4, keyId: f.cipher.keyId, cursor: 0, deviceId: "a", changes: sent });
  await a.finance.updateManualTransaction(tx.id, { ...entry, amountCents: 2 });
  await a.repository.receive(response, f.cipher, sent, 0);
  assert.equal((await a.repository.status()).pending, 1);
  await a.sync.sync(); assert.equal((await a.repository.status()).pending, 0);
});

test("private transport failure preserves local writes and ordinary tables; malformed authenticated schema is rejected", async t => {
  const f = await fixture(t), a = await f.client(); await a.enable();
  a.sqlite.exec("CREATE TABLE ordinary_data(id TEXT PRIMARY KEY,body TEXT); INSERT INTO ordinary_data VALUES('one','ordinary')");
  await a.finance.addManualTransaction(entry);
  const failing = new PrivateSyncClient(a.repository, serverUrl, "owner", async () => "token", f.secrets, async () => { throw new Error("offline"); });
  await assert.rejects(() => failing.sync());
  const requests = await a.repository.prepare(f.cipher); assert.equal(requests.length, 1);
  const document = await f.cipher.decrypt(requests[0].id, requests[0].envelope) as { row: Record<string, unknown> };
  document.row.amount_cents = "金额明文";
  const envelope = await f.cipher.encrypt(requests[0].id, document);
  await assert.rejects(() => a.repository.receive({ version: 4, keyId: f.cipher.keyId, cursor: 1, hasMore: false, results: [], records: [{ id: requests[0].id, version: 1, envelope }] }, f.cipher, [], 0));
  assert.equal(a.sqlite.prepare("SELECT body FROM ordinary_data").get()!.body, "ordinary");
  assert.equal((await a.repository.status()).pending, 1);
  assert.equal(await a.repository.meta("cursor"), "");
});

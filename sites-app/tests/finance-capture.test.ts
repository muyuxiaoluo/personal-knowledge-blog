import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { FinanceRepository } from "../app/data/finance-repository";
import { HealthRepository } from "../app/data/health-repository";
import { PrivateRepository } from "../app/data/private-repository";
import { PrivateCrypto, createRecoveryCode } from "../app/data/private-crypto";
import { captureCandidates, pendingCaptureTransactions, type FinanceCapture } from "../app/finance-capture";
import type { SqliteDatabase, SqliteValue } from "../app/data/sqlite-article-repository";

class Adapter implements SqliteDatabase {
  constructor(readonly db: DatabaseSync) {}
  async execute(sql: string, values: SqliteValue[] = []) { return { rowsAffected: Number(this.db.prepare(sql).run(...values).changes) }; }
  async select<T>(sql: string, values: SqliteValue[] = []) { return this.db.prepare(sql).all(...values) as T[]; }
}
async function fixture(t: test.TestContext) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close()); db.exec("PRAGMA foreign_keys=ON");
  const adapter = new Adapter(db), finance = new FinanceRepository(adapter), privateRepo = new PrivateRepository(adapter);
  await new HealthRepository(adapter).ready(); await finance.ready(); await privateRepo.ready();
  const insert = async (changes: Partial<FinanceCapture> = {}) => {
    const id = randomUUID(); const event: FinanceCapture = { id, event_key: createHash("sha256").update(id).digest("hex"), source: "wechat", amount_cents: 2180, received_at: "2026-10-26T17:56:00+08:00", kind: "expense", state: "pending", description: "", category: "other", transaction_id: null, duplicate_of: null, updated_at: "2026-10-26T09:56:00Z", ...changes };
    const columns = Object.keys(event); await adapter.execute(`INSERT OR IGNORE INTO finance_capture_events(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`, Object.values(event));
    return event;
  };
  return { db, adapter, finance, privateRepo, insert };
}

test("notification replay keeps one pending record; same-amount separate notifications remain separate", async t => {
  const f = await fixture(t); const a = await f.insert(); await f.insert(a); await f.insert({ received_at: "2026-10-26T17:56:05+08:00" });
  assert.equal((await f.finance.captures.list()).length, 2);
  assert.equal((await f.finance.listCalendarExpenses("2026-10")).length, 2);
  assert.equal((await f.finance.monthlySummary("2026-10")).ordinaryExpenseCents, 4360);
  await f.finance.captures.complete(a.id, "午饭", "food", "expense"); await f.insert(a);
  assert.equal((await f.finance.captures.list()).find(e => e.id === a.id)?.description, "午饭");
  assert.equal((await f.finance.monthlySummary("2026-10")).ordinaryExpenseCents, 4360);
  // A completed ledger may arrive on an earlier sync page than its evidence update.
  f.db.prepare("UPDATE finance_capture_events SET state='pending',transaction_id=NULL WHERE id=?").run(a.id);
  assert.equal((await f.finance.monthlySummary("2026-10")).ordinaryExpenseCents, 4360);
});

test("unknown money and cross-source candidates do not inflate totals; linking counts once and is reversible", async t => {
  const f = await fixture(t), a = await f.insert(), b = await f.insert({ source: "cmb", kind: "unknown" });
  assert.equal(captureCandidates(a, await f.finance.captures.list())[0].id, b.id);
  assert.equal((await f.finance.listTransactions()).length, 0);
  await f.finance.captures.link(b.id, a.id);
  assert.equal((await f.finance.listTransactions()).length, 1);
  await f.finance.captures.complete(a.id, "地铁", "transport", "expense");
  assert.equal((await f.finance.monthlySummary("2026-10")).ordinaryExpenseCents, 2180);
  await f.finance.captures.reopen(b.id); await f.finance.captures.complete(b.id, "另一次购买", "daily", "expense");
  assert.equal((await f.finance.monthlySummary("2026-10")).ordinaryExpenseCents, 4360);
});

test("confirmation is atomic, editing does not add a second expense, transfer/refund classification and ignore/reopen work", async t => {
  const f = await fixture(t), a = await f.insert({ kind: "unknown" });
  assert.equal((await f.finance.listTransactions()).length, 0);
  await assert.rejects(f.finance.captures.complete(a.id, "", "food", "expense"));
  await f.finance.captures.ignore(a.id); assert.equal((await f.finance.captures.list())[0].state, "ignored");
  await f.finance.captures.reopen(a.id);
  f.db.exec("CREATE TRIGGER fail_capture BEFORE UPDATE ON finance_capture_events BEGIN SELECT RAISE(ABORT,'test'); END");
  await assert.rejects(f.finance.captures.complete(a.id, "午饭", "food", "expense"));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM finance_transactions").get()?.n, 0);
  f.db.exec("DROP TRIGGER fail_capture");
  await f.finance.captures.complete(a.id, "午饭", "food", "expense");
  await f.finance.captures.complete(a.id, "晚饭", "food", "expense");
  assert.equal((await f.finance.listTransactions()).length, 1);
  await f.finance.captures.complete(a.id, "微信零钱充值", "other", "transfer");
  assert.equal((await f.finance.monthlySummary("2026-10")).ordinaryExpenseCents, 0);
  await f.finance.captures.complete(a.id, "退货", "other", "refund");
  assert.equal((await f.finance.listTransactions())[0].direction, "in");
});

test("pending evidence and completed ledger survive encrypted two-device roundtrip without notification bodies", async t => {
  const a = await fixture(t), b = await fixture(t);
  const event = await a.insert();
  const cipher = await PrivateCrypto.fromRecoveryCode(createRecoveryCode());
  const forward = async (from: typeof a, to: typeof b) => {
    const changes = await from.privateRepo.prepare(cipher);
    const records = changes.map(c => ({ id: c.id, version: c.baseVersion + 1, envelope: c.envelope }));
    await from.privateRepo.receive({ version: 4, keyId: cipher.keyId, cursor: 0, hasMore: false, records: [], results: changes.map(c => ({ mutationId: c.mutationId, status: "accepted" as const, id: c.id, version: c.baseVersion + 1 })) }, cipher, changes, 0);
    await to.privateRepo.receive({ version: 4, keyId: cipher.keyId, cursor: 0, hasMore: false, records, results: [] }, cipher, [], 0);
    assert.ok(!JSON.stringify(changes).includes("2180"));
  };
  await forward(a, b); assert.equal((await b.finance.captures.list())[0].id, event.id);
  await b.finance.captures.complete(event.id, "隐私用途测试", "food", "expense");
  await forward(b, a);
  assert.equal((await a.finance.captures.list())[0].state, "completed");
  assert.equal((await a.finance.listTransactions()).length, 1);
  assert.equal((await a.finance.listTransactions())[0].description, "隐私用途测试");
  assert.equal(pendingCaptureTransactions(await a.finance.captures.list()).length, 0);
});

test("opposite association directions choose the same canonical notification", async t => {
  const f = await fixture(t), a = await f.insert({ source: "wechat", kind: "unknown" }), b = await f.insert({ source: "cmb" });
  await f.finance.captures.link(a.id, b.id);
  assert.equal((await f.finance.captures.list()).find(e => e.id === a.id)?.duplicate_of, b.id);
  await f.finance.captures.reopen(a.id);
  await f.finance.captures.link(b.id, a.id);
  assert.equal((await f.finance.captures.list()).find(e => e.id === a.id)?.duplicate_of, b.id);
  assert.equal((await f.finance.captures.list()).find(e => e.id === b.id)?.state, "pending");
});

test("completed notifications can confirm spending roles and become non-consumption movements", async t => {
  const f = await fixture(t), event = await f.insert();
  await f.finance.captures.complete(event.id, "朋友借款", "other", "expense");
  const transaction = (await f.finance.listTransactions())[0];
  await f.finance.updateClassification(transaction.id, "other", "optional", false);
  assert.equal((await f.finance.listTransactions())[0].budgetRoleConfirmed, true);
  await f.finance.updateClassification(transaction.id, "other", "unknown", false, {
    projectId: null, lifeDomain: null, valueRating: null, kind: "transfer", direction: "out",
  });
  assert.equal((await f.finance.captures.list())[0].kind, "transfer");
  assert.equal((await f.finance.listTransactions())[0].direction, "out");
  assert.equal((await f.finance.listCalendarExpenses("2026-10")).length, 0);
  assert.equal((await f.finance.monthlySummary("2026-10")).ordinaryExpenseCents, 0);
  assert.equal((await f.finance.monthlySummary("2026-10")).actualIncomeCents, 0);
});

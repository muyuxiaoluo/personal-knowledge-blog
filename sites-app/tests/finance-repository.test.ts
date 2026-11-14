import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { FinanceRepository } from "../app/data/finance-repository";
import { buildFinanceInsightSnapshot, countFinanceImportRecords } from "../app/finance-analysis";
import { buildFinanceCalendar } from "../app/finance-calendar";
import { emptyFinanceBudget } from "../app/finance-types";
import { groupFinanceReview } from "../app/finance-classification";
import { financeNeedsConfirmation } from "../app/finance-consumption";
import { emptyFinanceSettings, type FinanceImportPreview, type FinanceImportRecord } from "../app/finance-types";
import type { SqliteDatabase, SqliteExecuteResult, SqliteValue } from "../app/data/sqlite-article-repository";

class NodeSqliteAdapter implements SqliteDatabase {
  constructor(private readonly database: DatabaseSync) {}
  async execute(sql: string, bindValues: SqliteValue[] = []): Promise<SqliteExecuteResult> {
    const result = this.database.prepare(sql).run(...bindValues as Array<string | number | null>);
    return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
  }
  async select<T>(sql: string, bindValues: SqliteValue[] = []): Promise<T[]> {
    return this.database.prepare(sql).all(...bindValues as Array<string | number | null>) as T[];
  }
}

function importRecord(overrides: Partial<FinanceImportRecord> = {}): FinanceImportRecord {
  return {
    rowNumber: 2,
    source: "alipay",
    occurredAt: "2026-08-12T08:00:00",
    amountCents: 2_580,
    kind: "expense",
    direction: "out",
    externalTransactionId: "ALIPAY-ANON-001",
    merchant: "匿名早餐店",
    merchantNormalized: "匿名早餐店",
    description: "早餐",
    paymentMethod: "余额",
    status: "交易成功",
    category: "other",
    budgetRole: "unknown",
    categoryConfirmed: false,
    budgetRoleConfirmed: false,
    duplicateFingerprint: "FINGERPRINT-001",
    decision: "candidate",
    reason: "",
    selected: true,
    ...overrides,
  };
}

function preview(records = [importRecord()]): FinanceImportPreview {
  return {
    source: "alipay",
    fileHash: "a".repeat(64),
    parserVersion: "finance-parser/1",
    periodStart: "2026-08-12",
    periodEnd: "2026-08-12",
    records,
    counts: countFinanceImportRecords(records),
    alreadyImported: false,
  };
}

test("monthly groups confirm selected bills atomically, retain optional judgments and learn category alone", async t => {
  const database = new DatabaseSync(":memory:"); t.after(() => database.close());
  const repository = new FinanceRepository(new NodeSqliteAdapter(database));
  await repository.confirmImport(preview([importRecord(), importRecord({ externalTransactionId: "SECOND", occurredAt: "2026-08-13T08:00:00" })]));
  const transactions = await repository.listTransactions("2026-08");
  database.prepare("UPDATE finance_transactions SET project_id='project',value_rating='worthwhile' WHERE id=?").run(transactions[0].id);
  const group = groupFinanceReview(transactions)[0];
  assert.equal(group.transactions.length, 2);
  database.exec(`CREATE TRIGGER reject_group BEFORE UPDATE ON finance_transactions WHEN OLD.id='${transactions[1].id}' BEGIN SELECT RAISE(ABORT,'disk full'); END`);
  await assert.rejects(repository.confirmClassificationGroup("2026-08", group.key, transactions.map(item => item.id), "food", true), /disk full/);
  assert.ok((await repository.listTransactions()).every(item => !item.categoryConfirmed));
  assert.equal((await repository.listRules()).length, 0);
  database.exec("DROP TRIGGER reject_group");
  await repository.confirmClassificationGroup("2026-08", group.key, [transactions[0].id], "food", true);
  const saved = (await repository.listTransactions()).find(item => item.id === transactions[0].id)!;
  assert.equal(saved.projectId, "project"); assert.equal(saved.valueRating, "worthwhile");
  assert.equal(saved.budgetRole, "unknown"); assert.equal(saved.budgetRoleConfirmed, false);
  assert.equal(financeNeedsConfirmation(saved), false);
  assert.equal(groupFinanceReview(await repository.listTransactions())[0].transactions.length, 1);
  await assert.rejects(repository.confirmClassificationGroup("2026-09", group.key, [transactions[1].id], "food", true), /已变化/);
  const next = await repository.reconcileImportPreview({ ...preview([importRecord({ externalTransactionId: "NEXT", occurredAt: "2026-09-12T08:00:00" })]), fileHash: "b".repeat(64) });
  assert.equal(next.records[0].category, "food"); assert.equal(next.records[0].categoryConfirmed, true);
  assert.equal(next.records[0].budgetRoleConfirmed, false);
});

test("platform descriptions learn separately and transport detail is recognized without guessing from a platform name", async t => {
  const database = new DatabaseSync(":memory:"); t.after(() => database.close());
  const repository = new FinanceRepository(new NodeSqliteAdapter(database));
  const record = importRecord({ merchant: "滴滴出行", merchantNormalized: "滴滴出行", description: "快车行程", category: "transport" });
  await repository.confirmImport(preview([record, { ...record, externalTransactionId: "BIKE", description: "单车骑行" }]));
  const groups = groupFinanceReview(await repository.listTransactions());
  assert.equal(groups.length, 2);
  const taxi = groups.find(group => group.category === "taxi")!;
  await repository.confirmClassificationGroup("2026-08", taxi.key, taxi.transactions.map(item => item.id), "taxi", true);
  const next = await repository.reconcileImportPreview({ ...preview([
    { ...record, externalTransactionId: "NEXT-TAXI" },
    { ...record, externalTransactionId: "NEXT-BIKE", description: "单车骑行" },
    { ...record, externalTransactionId: "UNKNOWN", description: "出行服务" },
  ]), fileHash: "b".repeat(64) });
  assert.deepEqual(next.records.map(item => [item.category, item.categoryConfirmed]), [["taxi", true], ["cycling", false], ["transport", false]]);
  assert.equal((await repository.listRules())[0].matchKind, "merchant-description");
  const summary = await repository.monthlySummary("2026-08");
  const snapshot = buildFinanceInsightSnapshot(summary, { ...emptyFinanceBudget("2026-08"), categoryLimits: { transport: 6000 } }, await repository.listCalendarExpenses("2026-08"), []);
  assert.equal(snapshot.budgetVariances[0].spentCents, 5160);
  // A stale or unrelated group must not change any transaction.
  await assert.rejects(repository.confirmClassificationGroup("2026-08", taxi.key, groups.flatMap(group => group.transactions.map(item => item.id)), "food", false), /已变化/);
});

test("single-bill category memory works while spending role remains optional", async t => {
  const database = new DatabaseSync(":memory:"); t.after(() => database.close());
  const repository = new FinanceRepository(new NodeSqliteAdapter(database));
  await repository.confirmImport(preview());
  const transaction = (await repository.listTransactions())[0];
  await repository.updateClassification(transaction.id, "food", "unknown", true);
  assert.equal((await repository.listRules())[0].budgetRole, "unknown");
  assert.equal(financeNeedsConfirmation((await repository.listTransactions())[0]), false);
});

test("rollback keeps a payment while a different import still links a refund to it", async t => {
  const database = new DatabaseSync(":memory:"); t.after(() => database.close());
  const repository = new FinanceRepository(new NodeSqliteAdapter(database));
  const batch = await repository.confirmImport(preview());
  const payment = (await repository.listTransactions())[0];
  await repository.confirmImport({ ...preview([importRecord({ externalTransactionId: "REFUND", kind: "refund", direction: "in", occurredAt: "2026-08-13T08:00:00", amountCents: 500 })]), fileHash: "b".repeat(64) });
  const refund = (await repository.listTransactions()).find(item => item.kind === "refund")!;
  await repository.updateClassification(refund.id, "food", "unknown", false, { projectId: null, lifeDomain: null, valueRating: null, relatedTransactionId: payment.id });
  await assert.rejects(repository.rollbackBatch(batch.id), /先解除退款关联/);
  assert.equal((await repository.listBatches()).length, 2);
  assert.equal((await repository.monthlySummary("2026-08")).ordinaryExpenseCents, 2080);
});

async function insertBillCapture(database: DatabaseSync, id: string, state = "pending") {
  database.prepare(`INSERT INTO finance_capture_events(id,event_key,source,amount_cents,received_at,kind,state,description,category,transaction_id,duplicate_of,updated_at)
    VALUES (?,?,'wechat',2580,'2026-08-12T08:01:00+08:00','expense',?,'','other',NULL,NULL,'2026-08-12T00:01:00Z')`).run(id, id, state);
}

test("matching a bill with notification evidence counts once and rollback restores evidence without modifying it", async t => {
  const database = new DatabaseSync(":memory:"); t.after(() => database.close()); database.exec("PRAGMA foreign_keys=ON");
  const repository = new FinanceRepository(new NodeSqliteAdapter(database)); await repository.ready();
  await insertBillCapture(database, "notification");
  const before = database.prepare("SELECT * FROM finance_capture_events").all();
  const bill = { ...preview([importRecord({ source: "wechat" })]), source: "wechat" as const };
  const reconciled = await repository.reconcileImportPreview(bill);
  assert.equal(reconciled.records[0].captureCandidates?.[0].id, "notification");
  assert.deepEqual(reconciled.records[0].matchedCaptureIds ?? [], []); // Time/amount alone never silently merge.
  reconciled.records[0].matchedCaptureIds = ["notification"];
  const batch = await repository.confirmImport(reconciled);
  assert.equal((await repository.listTransactions()).length, 1);
  assert.equal((await repository.monthlySummary("2026-08")).ordinaryExpenseCents, 2580);
  assert.equal((await repository.listCalendarExpenses("2026-08")).length, 1);
  assert.deepEqual(database.prepare("SELECT * FROM finance_capture_events").all(), before);
  assert.equal((await repository.reconcileImportPreview(bill)).records[0].decision, "duplicate");
  await repository.rollbackBatch(batch.id);
  assert.equal((await repository.listTransactions())[0].id, "finance-capture-notification");
  assert.deepEqual(await repository.matchedCaptureIds(), []);
  assert.equal((await repository.monthlySummary("2026-08")).ordinaryExpenseCents, 2580);
});

test("matched completed notification preserves classifications and refunds, and invalid associations cannot partly import", async t => {
  const database = new DatabaseSync(":memory:"); t.after(() => database.close());
  const repository = new FinanceRepository(new NodeSqliteAdapter(database)); await repository.ready();
  await insertBillCapture(database, "completed");
  await repository.captures.complete("completed", "早餐", "food", "expense");
  const capturedId = "finance-capture-completed";
  await repository.updateClassification(capturedId, "food", "quality", false, { projectId: "project", lifeDomain: "life", valueRating: "worthwhile" });
  const refundPreview = { ...preview([importRecord({ source: "wechat", externalTransactionId: "REFUND", kind: "refund", direction: "in", occurredAt: "2026-08-13T08:00:00", amountCents: 500 })]), source: "wechat" as const };
  await repository.confirmImport(refundPreview);
  const refund = (await repository.listTransactions()).find(item => item.kind === "refund")!;
  await repository.updateClassification(refund.id, "food", "unknown", false, { projectId: null, lifeDomain: null, valueRating: null, relatedTransactionId: capturedId });
  const bill = { ...preview([importRecord({ source: "wechat", matchedCaptureIds: ["completed"] })]), source: "wechat" as const, fileHash: "b".repeat(64) };
  const batch = await repository.confirmImport(bill);
  const expense = (await repository.listTransactions()).find(item => item.kind === "expense")!;
  assert.equal(expense.category, "food"); assert.equal(expense.budgetRole, "quality"); assert.equal(expense.projectId, "project");
  assert.equal(expense.valueRating, "worthwhile");
  assert.equal((await repository.listCalendarExpenses("2026-08"))[0].amountCents, 2080);
  assert.equal((await repository.monthlySummary("2026-08")).ordinaryExpenseCents, 2080);
  await assert.rejects(repository.updateClassification(expense.id, "food", "unknown", false, { projectId: null, lifeDomain: null, valueRating: null, kind: "transfer" }), /已关联退款/);
  await repository.rollbackBatch(batch.id);
  assert.equal((await repository.listTransactions()).find(item => item.kind === "refund")!.relatedTransactionId, capturedId);
  assert.equal((await repository.monthlySummary("2026-08")).ordinaryExpenseCents, 2080);
  await assert.rejects(repository.confirmImport({ ...bill, records: [{ ...bill.records[0], matchedCaptureIds: ["missing"] }] }), /关联对象已变化/);
  assert.equal((await repository.listBatches()).length, 1);
});

test("stores integer cents, settings, budgets and manual expenses locally", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new FinanceRepository(new NodeSqliteAdapter(database), () => new Date("2026-08-31T02:00:00Z"));
  assert.equal((await repository.listAccounts()).length, 4);
  const settings = await repository.saveSettings({ ...emptyFinanceSettings, stableMonthlyIncomeCents: 800_000, defaultSavingsTargetCents: 200_000 });
  await repository.addManualTransaction({
    occurredAt: "2026-08-31T10:20:00",
    amountCents: 1_288,
    description: "咖啡",
    source: "cash",
    category: "food",
    budgetRole: "optional",
    projectId: null,
    lifeDomain: "life",
    valueRating: "worthwhile",
  });
  const transactions = await repository.listTransactions("2026-08");
  assert.equal(transactions[0]?.amountCents, 1_288);
  assert.equal((await repository.monthlySummary("2026-08")).stableIncomeCents, 800_000);
  assert.equal(settings.stableMonthlyIncomeCents, 800_000);
  database.close();
});

test("calendar loads the full month beyond the transaction list limit", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new FinanceRepository(new NodeSqliteAdapter(database));
  const records = Array.from({ length: 2001 }, (_, index) => importRecord({
    rowNumber: index + 2, externalTransactionId: `calendar-${index}`, duplicateFingerprint: `calendar-${index}`,
  }));
  records.push(importRecord({ externalTransactionId: "refund", duplicateFingerprint: "refund", kind: "refund", direction: "in" }));
  records.push(importRecord({ externalTransactionId: "next-month", duplicateFingerprint: "next-month", occurredAt: "2026-09-01T00:00:00" }));
  await repository.confirmImport(preview(records));
  assert.equal((await repository.listTransactions("2026-08")).length, 2000);
  const expenses = await repository.listCalendarExpenses("2026-08");
  assert.equal(expenses.length, 2000);
  assert.ok(expenses.every((entry) => entry.kind === "expense" && entry.occurredAt.startsWith("2026-08")));
  assert.equal((await repository.listCalendarExpenses("2026-09")).length, 1);
  database.close();
});

test("rolls back settings when the matching monthly budget cannot be saved", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new FinanceRepository(new NodeSqliteAdapter(database), () => new Date("2026-08-31T02:00:00Z"));
  await repository.ready();
  database.exec(`CREATE TRIGGER reject_finance_budget BEFORE INSERT ON finance_budgets
    BEGIN SELECT RAISE(ABORT, 'budget rejected'); END`);

  await assert.rejects(() => repository.saveBudgetPlan(
    { ...emptyFinanceSettings, stableMonthlyIncomeCents: 800_000, defaultSavingsTargetCents: 200_000 },
    { month: "2026-08", savingsTargetCents: 180_000, categoryLimits: { food: 50_000 }, updatedAt: "" },
  ), /budget rejected/);
  assert.deepEqual(await repository.getSettings(), emptyFinanceSettings);
  database.close();
});

test("imports a batch atomically, detects reimport and rolls the batch back", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new FinanceRepository(new NodeSqliteAdapter(database), () => new Date("2026-08-31T02:00:00Z"));
  const batch = await repository.confirmImport(preview());
  assert.equal((await repository.listTransactions("2026-08")).length, 1);
  assert.equal((await repository.reconcileImportPreview(preview())).alreadyImported, true);

  const secondFile = preview([importRecord()]);
  secondFile.fileHash = "b".repeat(64);
  const reconciled = await repository.reconcileImportPreview(secondFile);
  assert.equal(reconciled.records[0]?.decision, "duplicate");
  assert.equal(reconciled.records[0]?.selected, false);

  await repository.rollbackBatch(batch.id);
  assert.equal((await repository.listTransactions("2026-08")).length, 0);
  assert.equal((await repository.listBatches()).length, 0);
  database.close();
});

test("marks fingerprint-only matches as suspected instead of silently dropping them", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new FinanceRepository(new NodeSqliteAdapter(database));
  await repository.confirmImport(preview([importRecord({ externalTransactionId: "" })]));
  const next = preview([importRecord({ externalTransactionId: "" })]);
  next.fileHash = "c".repeat(64);
  const reconciled = await repository.reconcileImportPreview(next);
  assert.equal(reconciled.records[0]?.decision, "suspected");
  assert.equal(reconciled.records[0]?.selected, false);
  database.close();
});

test("links an exact refund to its earlier expense and keeps both outside duplicate logic", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new FinanceRepository(new NodeSqliteAdapter(database));
  const records = [
    importRecord({ externalTransactionId: "ALIPAY-EXPENSE-001", duplicateFingerprint: "FP-EXPENSE", amountCents: 8_800 }),
    importRecord({
      rowNumber: 3,
      occurredAt: "2026-08-15T08:00:00",
      externalTransactionId: "ALIPAY-REFUND-001",
      duplicateFingerprint: "FP-REFUND",
      amountCents: 8_800,
      kind: "refund",
      direction: "in",
      status: "退款成功",
    }),
  ];
  await repository.confirmImport(preview(records));
  const saved = await repository.listTransactions("2026-08");
  const expense = saved.find((entry) => entry.kind === "expense");
  const refund = saved.find((entry) => entry.kind === "refund");
  assert.equal(refund?.relatedTransactionId, expense?.id);
  const summary = await repository.monthlySummary("2026-08");
  assert.equal(summary.ordinaryExpenseCents, 0);
  assert.equal(summary.refundCents, 8_800);
  database.close();
});

test("corrects a misread payment, nets a deposit refund with a voucher, and excludes loan movements", async t => {
  const database = new DatabaseSync(":memory:"); t.after(() => database.close());
  const repository = new FinanceRepository(new NodeSqliteAdapter(database));
  await repository.confirmImport(preview([
    importRecord({ externalTransactionId: "voucher", merchant: "美团", amountCents: 15000 }),
    importRecord({ externalTransactionId: "pot-deposit", occurredAt: "2026-08-12T17:38:00", amountCents: 11700, kind: "refund", direction: "in", status: "已部分退款(20.00元)" }),
    importRecord({ externalTransactionId: "deposit-back", occurredAt: "2026-08-12T20:00:00", amountCents: 2000, kind: "refund", direction: "in" }),
    importRecord({ externalTransactionId: "loan", merchant: "朋友", amountCents: 30000 }),
  ]));
  const initial = await repository.listTransactions("2026-08");
  const payment = initial.find(item => item.externalTransactionId === "pot-deposit")!;
  const refund = initial.find(item => item.externalTransactionId === "deposit-back")!;
  const loan = initial.find(item => item.externalTransactionId === "loan")!;
  const context = { projectId: null, lifeDomain: null, valueRating: null };
  await repository.updateClassification(payment.id, "food", "unknown", false, { ...context, kind: "expense" });
  await repository.updateClassification(refund.id, "food", "unknown", false, { ...context, kind: "refund", relatedTransactionId: payment.id });
  await repository.updateClassification(loan.id, "other", "unknown", true, { ...context, kind: "transfer", direction: "out" });
  const saved = await repository.listTransactions("2026-08");
  assert.equal(saved.find(item => item.id === payment.id)?.direction, "out");
  assert.equal(saved.find(item => item.id === payment.id)?.budgetRoleConfirmed, false);
  assert.equal(saved.find(item => item.id === refund.id)?.relatedTransactionId, payment.id);
  assert.equal(saved.find(item => item.id === loan.id)?.direction, "out");
  assert.equal((await repository.listRules()).length, 0);
  const summary = await repository.monthlySummary("2026-08");
  assert.equal(summary.ordinaryExpenseCents, 24700);
  assert.equal(summary.actualNetCents, -24700);
  assert.equal(summary.categoryTotals.food, 9700);
  assert.equal(summary.transferCents, 30000);
  const expenses = await repository.listCalendarExpenses("2026-08");
  assert.equal(expenses.find(item => item.id === payment.id)?.amountCents, 9700);
  assert.equal(buildFinanceCalendar("2026-08", expenses).totalCents, 24700);
  assert.equal(buildFinanceInsightSnapshot(summary, emptyFinanceBudget("2026-08"), saved, []).pendingConfirmation.amountCents, 15000);
  await assert.rejects(repository.updateClassification(payment.id, "food", "unknown", false, { ...context, kind: "transfer" }), /先解除/);
  await repository.updateClassification(refund.id, "food", "unknown", false, { ...context, relatedTransactionId: null });
  assert.equal((await repository.monthlySummary("2026-08")).ordinaryExpenseCents, 26700);
  assert.equal((await repository.monthlySummary("2026-08")).actualNetCents, -24700);
});

test("multiple partial refunds are bounded and cross-month refunds reduce the original consumption date", async t => {
  const database = new DatabaseSync(":memory:"); t.after(() => database.close());
  const repository = new FinanceRepository(new NodeSqliteAdapter(database));
  await repository.confirmImport(preview([
    importRecord({ externalTransactionId: "payment", occurredAt: "2026-08-31T17:00:00", amountCents: 11700 }),
    importRecord({ externalTransactionId: "refund-a", occurredAt: "2026-09-01T20:00:00", amountCents: 2000, kind: "refund", direction: "in" }),
    importRecord({ externalTransactionId: "refund-b", occurredAt: "2026-09-02T20:00:00", amountCents: 10000, kind: "refund", direction: "in" }),
  ]));
  const saved = await repository.listTransactions();
  const payment = saved.find(item => item.externalTransactionId === "payment")!;
  const refundA = saved.find(item => item.externalTransactionId === "refund-a")!;
  const refundB = saved.find(item => item.externalTransactionId === "refund-b")!;
  const context = { projectId: null, lifeDomain: null, valueRating: null, relatedTransactionId: payment.id };
  assert.ok((await repository.listRefundCandidates(refundA)).some(item => item.id === payment.id));
  await repository.updateClassification(refundA.id, "food", "unknown", false, context);
  await assert.rejects(repository.updateClassification(refundB.id, "food", "unknown", false, context), /超过原付款/);
  assert.equal((await repository.listTransactions()).find(item => item.id === refundB.id)?.relatedTransactionId, null);
  const august = await repository.monthlySummary("2026-08");
  assert.equal(august.ordinaryExpenseCents, 9700);
  assert.equal(august.actualNetCents, -11700);
  assert.equal((await repository.listCalendarExpenses("2026-08"))[0].amountCents, 9700);
  const september = await repository.monthlySummary("2026-09");
  assert.equal(september.ordinaryExpenseCents, 0);
  assert.equal(september.refundCents, 12000);
  assert.equal(september.actualNetCents, 12000);
});

test("deletes only the selected manual entry and refreshes spending totals without affecting imported bills", async t => {
  const database = new DatabaseSync(":memory:"); t.after(() => database.close());
  const repository = new FinanceRepository(new NodeSqliteAdapter(database));
  await repository.confirmImport(preview());
  const entry = { occurredAt: "2026-08-31T12:00:00", amountCents: 1700, description: "补记午饭", source: "cash" as const, category: "food" as const, budgetRole: "unknown" as const, projectId: null, lifeDomain: null, valueRating: null };
  const wrong = await repository.addManualTransaction(entry);
  const correct = await repository.addManualTransaction({ ...entry, amountCents: 1500 });
  const before = (await repository.monthlySummary("2026-08")).ordinaryExpenseCents;
  await repository.deleteManualTransaction(wrong.id);
  const remaining = await repository.listTransactions("2026-08");
  assert.equal(remaining.length, 2);
  assert.ok(remaining.some(transaction => transaction.id === correct.id));
  assert.ok(remaining.every(transaction => transaction.id !== wrong.id));
  assert.equal((await repository.monthlySummary("2026-08")).ordinaryExpenseCents, before - 1700);
  assert.equal((await repository.listCalendarExpenses("2026-08")).length, 2);
  await assert.rejects(repository.deleteManualTransaction(remaining.find(transaction => transaction.importBatchId)!.id), /导入账单/);
  await assert.rejects(repository.deleteManualTransaction(wrong.id), /没有找到/);
  assert.equal((await repository.listTransactions("2026-08")).length, 2);
});

test("manual deletion protects notification ledgers and payments with linked refunds", async t => {
  const database = new DatabaseSync(":memory:"); t.after(() => database.close());
  const repository = new FinanceRepository(new NodeSqliteAdapter(database));
  const payment = await repository.addManualTransaction({ occurredAt: "2026-08-01T12:00:00", amountCents: 11700, description: "火锅及押金", source: "cash", category: "food", budgetRole: "unknown", projectId: null, lifeDomain: null, valueRating: null });
  await repository.confirmImport(preview([importRecord({ kind: "refund", direction: "in", amountCents: 2000 })]));
  const refund = (await repository.listTransactions()).find(transaction => transaction.kind === "refund")!;
  await repository.updateClassification(refund.id, "food", "unknown", false, { projectId: null, lifeDomain: null, valueRating: null, relatedTransactionId: payment.id });
  await assert.rejects(repository.deleteManualTransaction(payment.id), /先解除退款关联/);
  assert.equal((await repository.listCalendarExpenses("2026-08"))[0].amountCents, 9700);
  database.prepare("UPDATE finance_transactions SET id = 'finance-capture-protected', related_transaction_id = NULL WHERE id = ?").run(payment.id);
  await assert.rejects(repository.deleteManualTransaction("finance-capture-protected"), /交易通知/);
  assert.ok((await repository.listTransactions()).some(transaction => transaction.id === "finance-capture-protected"));
});

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { FinanceRepository } from "../app/data/finance-repository";
import { countFinanceImportRecords } from "../app/finance-analysis";
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
  assert.equal(summary.ordinaryExpenseCents, 8_800);
  assert.equal(summary.refundCents, 8_800);
  database.close();
});

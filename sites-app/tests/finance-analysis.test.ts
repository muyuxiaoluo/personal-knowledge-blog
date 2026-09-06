import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFinanceInsightSnapshot,
  financeDuplicateFingerprint,
  summarizeFinanceMonth,
  validateFinanceAiReportContent,
} from "../app/finance-analysis";
import { emptyFinanceBudget, emptyFinanceSettings, type FinanceTransaction } from "../app/finance-types";

function transaction(overrides: Partial<FinanceTransaction>): FinanceTransaction {
  const base: FinanceTransaction = {
    id: crypto.randomUUID(),
    occurredAt: "2026-08-10T12:00:00",
    amountCents: 1_000,
    kind: "expense",
    direction: "out",
    accountId: "finance-account-alipay",
    source: "alipay",
    externalTransactionId: "",
    merchant: "示例商户",
    merchantNormalized: "示例商户",
    description: "匿名消费",
    paymentMethod: "余额",
    status: "交易成功",
    category: "food",
    budgetRole: "variable-essential",
    categoryConfirmed: true,
    budgetRoleConfirmed: true,
    projectId: null,
    lifeDomain: null,
    importBatchId: null,
    relatedTransactionId: null,
    valueRating: null,
    duplicateFingerprint: "",
    createdAt: "2026-08-31T00:00:00Z",
    updatedAt: "2026-08-31T00:00:00Z",
  };
  const next = { ...base, ...overrides };
  next.duplicateFingerprint ||= financeDuplicateFingerprint(next);
  return next;
}

test("keeps actual income separate from the stable planning baseline", () => {
  const settings = { ...emptyFinanceSettings, stableMonthlyIncomeCents: 800_000 };
  const summary = summarizeFinanceMonth("2026-08", [
    transaction({ kind: "income", direction: "in", amountCents: 920_000, budgetRoleConfirmed: false }),
    transaction({ amountCents: 100_000 }),
    transaction({ kind: "refund", direction: "in", amountCents: 5_000 }),
    transaction({ kind: "transfer", direction: "neutral", amountCents: 30_000 }),
    transaction({ kind: "repayment", direction: "out", amountCents: 20_000 }),
  ], settings);
  assert.equal(summary.actualIncomeCents, 920_000);
  assert.equal(summary.stableIncomeCents, 800_000);
  assert.equal(summary.ordinaryExpenseCents, 100_000);
  assert.equal(summary.actualNetCents, 825_000);
  assert.equal(summary.transferCents, 30_000);
  assert.equal(summary.repaymentCents, 20_000);
});

test("uses a three-month median and detects monthly recurring expenses", () => {
  const transactions = [
    transaction({ occurredAt: "2026-06-02T09:00:00", amountCents: 20_000 }),
    transaction({ occurredAt: "2026-07-02T09:00:00", amountCents: 40_000 }),
    transaction({ occurredAt: "2026-08-02T09:00:00", amountCents: 30_000 }),
    transaction({ occurredAt: "2026-06-15T09:00:00", amountCents: 1_500, merchant: "视频会员", merchantNormalized: "视频会员", budgetRole: "optional", valueRating: "regret" }),
    transaction({ occurredAt: "2026-07-15T09:00:00", amountCents: 1_500, merchant: "视频会员", merchantNormalized: "视频会员", budgetRole: "optional", valueRating: "regret" }),
    transaction({ occurredAt: "2026-08-15T09:00:00", amountCents: 1_500, merchant: "视频会员", merchantNormalized: "视频会员", budgetRole: "optional", valueRating: "regret" }),
  ];
  const summary = summarizeFinanceMonth("2026-08", transactions, emptyFinanceSettings);
  assert.equal(summary.variableEssentialBaselineCents, 30_000);
  assert.equal(summary.sampleInsufficient, false);
  assert.equal(summary.recurringCandidates[0]?.occurrences, 3);
  assert.equal(summary.savingCandidates[0]?.maximumSavingCents, 1_500);
});

test("redacts project names and rejects AI amounts outside local evidence", () => {
  const transactions = [transaction({
    projectId: "secret-project-id",
    lifeDomain: "learning",
    category: "entertainment",
    budgetRole: "optional",
    valueRating: "regret",
    amountCents: 10_000,
  })];
  const summary = summarizeFinanceMonth("2026-08", transactions, emptyFinanceSettings);
  const snapshot = buildFinanceInsightSnapshot(summary, emptyFinanceBudget("2026-08"), transactions, [{
    id: "secret-project-id",
    category: "learning",
    status: "active",
  }]);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("secret-project-id"), false);
  assert.equal(snapshot.anonymousProjects[0]?.anonymousProjectId, "P-001");
  const evidenceId = snapshot.savingCandidates[0]?.evidenceId ?? "";
  assert.throws(() => validateFinanceAiReportContent({
    overview: "概览",
    essentialStructure: "必要支出",
    pendingConfirmations: [],
    worthwhileSpending: [],
    opportunities: [{
      title: "减少一次消费",
      reason: "可选支出",
      evidenceIds: [evidenceId],
      minimumSavingCents: 1_000,
      maximumSavingCents: 20_000,
      confidence: "high",
      action: "设置上限",
      tradeoff: "体验减少",
    }],
    nextActions: [],
    questions: [],
  }, snapshot), /超出本地证据范围/);
});

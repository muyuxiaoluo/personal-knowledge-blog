import type { LifeDomain } from "./domain-taxonomy";

export type FinanceSource = "alipay" | "wechat" | "cash" | "custom";
export type FinanceImportSource = Extract<FinanceSource, "alipay" | "wechat">;
export type FinanceTransactionKind =
  | "expense"
  | "income"
  | "transfer"
  | "refund"
  | "repayment"
  | "adjustment";
export type FinanceDirection = "out" | "in" | "neutral";
export type FinanceCategory =
  | "housing"
  | "food"
  | "transport"
  | "daily"
  | "health"
  | "learning"
  | "digital"
  | "relationships"
  | "entertainment"
  | "travel"
  | "fees"
  | "other";
export type FinanceBudgetRole =
  | "fixed-essential"
  | "variable-essential"
  | "growth"
  | "quality"
  | "optional"
  | "unknown";
export type FinanceValueRating = "worthwhile" | "neutral" | "regret";

export type FinanceAccount = {
  id: string;
  name: string;
  source: FinanceSource;
  createdAt: string;
};

export type FinanceTransaction = {
  id: string;
  occurredAt: string;
  amountCents: number;
  kind: FinanceTransactionKind;
  direction: FinanceDirection;
  accountId: string;
  source: FinanceSource;
  externalTransactionId: string;
  merchant: string;
  merchantNormalized: string;
  description: string;
  paymentMethod: string;
  status: string;
  category: FinanceCategory;
  budgetRole: FinanceBudgetRole;
  categoryConfirmed: boolean;
  budgetRoleConfirmed: boolean;
  projectId: string | null;
  lifeDomain: LifeDomain | null;
  importBatchId: string | null;
  relatedTransactionId: string | null;
  valueRating: FinanceValueRating | null;
  duplicateFingerprint: string;
  createdAt: string;
  updatedAt: string;
};

export type FinanceManualEntry = {
  occurredAt: string;
  amountCents: number;
  description: string;
  source: FinanceSource;
  category: FinanceCategory;
  budgetRole: FinanceBudgetRole;
  projectId: string | null;
  lifeDomain: LifeDomain | null;
  valueRating: FinanceValueRating | null;
};

export type FinanceImportBatch = {
  id: string;
  source: FinanceImportSource;
  periodStart: string;
  periodEnd: string;
  fileHash: string;
  parserVersion: string;
  statistics: FinanceImportCounts;
  createdAt: string;
};

export type FinanceSettings = {
  stableMonthlyIncomeCents: number;
  defaultSavingsTargetCents: number;
  backupNoticeAcknowledged: boolean;
  updatedAt: string;
};

export type FinanceBudget = {
  month: string;
  savingsTargetCents: number;
  categoryLimits: Partial<Record<FinanceCategory, number>>;
  updatedAt: string;
};

export type FinanceCategoryRule = {
  id: string;
  matchKind: "merchant" | "description";
  matchValue: string;
  category: FinanceCategory;
  budgetRole: FinanceBudgetRole;
  createdAt: string;
  updatedAt: string;
};

export type FinanceImportDecision = "candidate" | "skipped" | "duplicate" | "suspected" | "uncertain";

export type FinanceImportRecord = {
  rowNumber: number;
  source: FinanceImportSource;
  occurredAt: string;
  amountCents: number;
  kind: FinanceTransactionKind;
  direction: FinanceDirection;
  externalTransactionId: string;
  merchant: string;
  merchantNormalized: string;
  description: string;
  paymentMethod: string;
  status: string;
  category: FinanceCategory;
  budgetRole: FinanceBudgetRole;
  categoryConfirmed: boolean;
  budgetRoleConfirmed: boolean;
  duplicateFingerprint: string;
  decision: FinanceImportDecision;
  reason: string;
  selected: boolean;
};

export type FinanceImportCounts = {
  expense: number;
  income: number;
  refund: number;
  transfer: number;
  repayment: number;
  adjustment: number;
  skipped: number;
  duplicate: number;
  suspected: number;
  uncertain: number;
  importable: number;
};

export type FinanceImportPreview = {
  source: FinanceImportSource;
  fileHash: string;
  parserVersion: string;
  periodStart: string;
  periodEnd: string;
  records: FinanceImportRecord[];
  counts: FinanceImportCounts;
  alreadyImported: boolean;
};

export type FinanceRecurringCandidate = {
  evidenceId: string;
  merchantKey: string;
  displayMerchant: string;
  occurrences: number;
  averageAmountCents: number;
  intervalDays: number;
  totalCents: number;
  confidence: "medium" | "high";
};

export type FinanceSavingCandidate = {
  evidenceId: string;
  category: FinanceCategory;
  budgetRole: FinanceBudgetRole;
  transactionTotalCents: number;
  minimumSavingCents: number;
  maximumSavingCents: number;
  confidence: "medium" | "high";
};

export type FinanceSpendingAnomaly = {
  evidenceId: string;
  category: FinanceCategory;
  currentAmountCents: number;
  previousMedianCents: number;
  increaseCents: number;
};

export type FinanceMonthlyTrend = {
  month: string;
  expenseCents: number;
  incomeCents: number;
  refundCents: number;
};

export type FinanceMonthlySummary = {
  month: string;
  ordinaryExpenseCents: number;
  actualIncomeCents: number;
  refundCents: number;
  transferCents: number;
  repaymentCents: number;
  actualNetCents: number;
  stableIncomeCents: number;
  fixedEssentialCents: number;
  variableEssentialBaselineCents: number;
  variableEssentialSampleMonths: number;
  sampleInsufficient: boolean;
  forecastExpenseCents: number;
  categoryTotals: Record<FinanceCategory, number>;
  budgetRoleTotals: Record<FinanceBudgetRole, number>;
  recurringCandidates: FinanceRecurringCandidate[];
  savingCandidates: FinanceSavingCandidate[];
  anomalies: FinanceSpendingAnomaly[];
  trend: FinanceMonthlyTrend[];
  scenarios: {
    currentCents: number;
    baselineCents: number;
    moderateCents: number;
    aggressiveCents: number;
  };
};

export type FinanceInsightSnapshot = {
  month: string;
  incomeBaselineCents: number;
  actualIncomeCents: number;
  expenseCents: number;
  refundCents: number;
  actualNetCents: number;
  forecastExpenseCents: number;
  budgetSavingsTargetCents: number;
  categoryTotals: Array<{ category: FinanceCategory; amountCents: number }>;
  budgetRoleTotals: Array<{ role: FinanceBudgetRole; amountCents: number }>;
  trend: FinanceMonthlyTrend[];
  recurringCandidates: Array<{
    evidenceId: string;
    occurrences: number;
    averageAmountCents: number;
    intervalDays: number;
    totalCents: number;
    confidence: "medium" | "high";
  }>;
  savingCandidates: FinanceSavingCandidate[];
  anomalies: FinanceSpendingAnomaly[];
  budgetVariances: Array<{
    category: FinanceCategory;
    spentCents: number;
    limitCents: number;
    varianceCents: number;
  }>;
  retainedSpending: Array<{
    evidenceId: string;
    category: FinanceCategory;
    amountCents: number;
  }>;
  pendingConfirmation: { count: number; amountCents: number };
  anonymousProjects: Array<{
    anonymousProjectId: string;
    domain: LifeDomain;
    status: "active" | "paused" | "completed";
    expenseCents: number;
  }>;
  evidence: Array<{
    evidenceId: string;
    amountCents: number;
    category: FinanceCategory;
    budgetRole: FinanceBudgetRole;
  }>;
  localScenarios: FinanceMonthlySummary["scenarios"];
  sampleInsufficient: boolean;
};

export type FinanceAiOpportunity = {
  title: string;
  reason: string;
  evidenceIds: string[];
  minimumSavingCents: number;
  maximumSavingCents: number;
  confidence: "low" | "medium" | "high";
  action: string;
  tradeoff: string;
};

export type FinanceAiReportContent = {
  overview: string;
  essentialStructure: string;
  pendingConfirmations: string[];
  worthwhileSpending: string[];
  opportunities: FinanceAiOpportunity[];
  scenarios: {
    currentCents: number;
    moderateCents: number;
    aggressiveCents: number;
  };
  nextActions: string[];
  questions: string[];
};

export type FinanceTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type FinanceAiApiResponse = {
  content: unknown;
  model: string;
  tokenUsage: FinanceTokenUsage;
};

export type FinanceAiReport = {
  month: string;
  content: FinanceAiReportContent;
  model: string;
  generatedAt: string;
  inputFingerprint: string;
  tokenUsage: FinanceTokenUsage;
};

export const FINANCE_CATEGORIES: Array<{ value: FinanceCategory; label: string }> = [
  { value: "housing", label: "居住" },
  { value: "food", label: "餐饮" },
  { value: "transport", label: "交通" },
  { value: "daily", label: "日用" },
  { value: "health", label: "健康" },
  { value: "learning", label: "学习成长" },
  { value: "digital", label: "数码工具" },
  { value: "relationships", label: "人情关系" },
  { value: "entertainment", label: "娱乐兴趣" },
  { value: "travel", label: "旅行" },
  { value: "fees", label: "金融费用" },
  { value: "other", label: "其他" },
];

export const FINANCE_BUDGET_ROLES: Array<{ value: FinanceBudgetRole; label: string }> = [
  { value: "fixed-essential", label: "固定必要" },
  { value: "variable-essential", label: "弹性必要" },
  { value: "growth", label: "成长投入" },
  { value: "quality", label: "生活体验" },
  { value: "optional", label: "自由消费" },
  { value: "unknown", label: "待确认" },
];

export const FINANCE_CATEGORY_LABELS = Object.fromEntries(
  FINANCE_CATEGORIES.map((entry) => [entry.value, entry.label]),
) as Record<FinanceCategory, string>;

export const FINANCE_BUDGET_ROLE_LABELS = Object.fromEntries(
  FINANCE_BUDGET_ROLES.map((entry) => [entry.value, entry.label]),
) as Record<FinanceBudgetRole, string>;

export const emptyFinanceSettings: FinanceSettings = {
  stableMonthlyIncomeCents: 0,
  defaultSavingsTargetCents: 0,
  backupNoticeAcknowledged: false,
  updatedAt: "",
};

export function emptyFinanceBudget(month: string, savingsTargetCents = 0): FinanceBudget {
  return { month, savingsTargetCents, categoryLimits: {}, updatedAt: "" };
}

export function emptyFinanceImportCounts(): FinanceImportCounts {
  return {
    expense: 0,
    income: 0,
    refund: 0,
    transfer: 0,
    repayment: 0,
    adjustment: 0,
    skipped: 0,
    duplicate: 0,
    suspected: 0,
    uncertain: 0,
    importable: 0,
  };
}

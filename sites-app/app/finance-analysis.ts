import type { LifeDomain } from "./domain-taxonomy";
import { financeConsumptionTransactions, financeNeedsConfirmation } from "./finance-consumption";
import {
  FINANCE_BUDGET_ROLES,
  FINANCE_CATEGORIES,
  emptyFinanceImportCounts,
  type FinanceAiReportContent,
  type FinanceBudget,
  type FinanceBudgetRole,
  type FinanceCategory,
  type FinanceImportCounts,
  type FinanceImportPreview,
  type FinanceInsightSnapshot,
  type FinanceMonthlySummary,
  type FinanceRecurringCandidate,
  type FinanceSavingCandidate,
  type FinanceSettings,
  type FinanceTransaction,
} from "./finance-types";

const dayMs = 24 * 60 * 60 * 1_000;

export function normalizeFinanceMerchant(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s·•,，。.!！?？()（）\[\]【】_\-—]+/g, "")
    .trim();
}

export function financeDuplicateFingerprint(input: Pick<FinanceTransaction, "occurredAt" | "amountCents" | "direction" | "merchant" | "description">) {
  return stableShortHash([
    input.occurredAt.slice(0, 19),
    String(input.amountCents),
    input.direction,
    normalizeFinanceMerchant(input.merchant),
    normalizeFinanceMerchant(input.description),
  ].join("|"));
}

export function countFinanceImportRecords(records: FinanceImportPreview["records"]): FinanceImportCounts {
  const counts = emptyFinanceImportCounts();
  for (const record of records) {
    if (record.decision === "skipped") counts.skipped += 1;
    else if (record.decision === "duplicate") counts.duplicate += 1;
    else if (record.decision === "suspected") counts.suspected += 1;
    else if (record.decision === "uncertain") counts.uncertain += 1;
    else {
      counts[record.kind] += 1;
      if (record.selected) counts.importable += 1;
    }
  }
  return counts;
}

export function financeCategorySpending(totals: Record<FinanceCategory, number>, category: FinanceCategory) {
  return category === "transport" ? totals.transport + totals.metro + totals.bus + totals.taxi + totals.cycling : totals[category];
}

export function summarizeFinanceMonth(
  month: string,
  transactions: FinanceTransaction[],
  settings: FinanceSettings,
): FinanceMonthlySummary {
  assertMonth(month);
  const current = transactions.filter((transaction) => transaction.occurredAt.startsWith(month));
  const consumption = financeConsumptionTransactions(transactions);
  const expenses = consumption.filter((transaction) => transaction.occurredAt.startsWith(month));
  const grossExpenseCents = sum(current.filter(transaction => transaction.kind === "expense").map(transaction => transaction.amountCents));
  const ordinaryExpenseCents = sum(expenses.map((transaction) => transaction.amountCents));
  const actualIncomeCents = sum(current.filter((transaction) => transaction.kind === "income").map((transaction) => transaction.amountCents));
  const refundCents = sum(current.filter((transaction) => transaction.kind === "refund").map((transaction) => transaction.amountCents));
  const transferCents = sum(current.filter((transaction) => transaction.kind === "transfer").map((transaction) => transaction.amountCents));
  const repaymentCents = sum(current.filter((transaction) => transaction.kind === "repayment").map((transaction) => transaction.amountCents));
  const fixedEssentialCents = sum(expenses
    .filter((transaction) => transaction.budgetRoleConfirmed && transaction.budgetRole === "fixed-essential")
    .map((transaction) => transaction.amountCents));
  const currentVariableEssentialCents = sum(expenses
    .filter((transaction) => transaction.budgetRoleConfirmed && transaction.budgetRole === "variable-essential")
    .map((transaction) => transaction.amountCents));
  const baselineMonths = [previousMonth(month, 2), previousMonth(month, 1), month];
  const coveredMonths = baselineMonths.filter((candidate) => transactions.some((transaction) => transaction.occurredAt.startsWith(candidate)));
  const variableSamples = coveredMonths.map((candidate) => sum(consumption
    .filter((transaction) => transaction.occurredAt.startsWith(candidate)
      && transaction.kind === "expense"
      && transaction.budgetRoleConfirmed
      && transaction.budgetRole === "variable-essential")
    .map((transaction) => transaction.amountCents)));
  const variableEssentialBaselineCents = variableSamples.length >= 3
    ? median(variableSamples)
    : currentVariableEssentialCents;
  const categoryTotals = FINANCE_CATEGORIES.reduce((totals, entry) => {
    totals[entry.value] = 0;
    return totals;
  }, {} as Record<FinanceCategory, number>);
  const budgetRoleTotals = FINANCE_BUDGET_ROLES.reduce((totals, entry) => {
    totals[entry.value] = 0;
    return totals;
  }, {} as Record<FinanceBudgetRole, number>);
  for (const transaction of expenses) {
    categoryTotals[transaction.category] += transaction.amountCents;
    budgetRoleTotals[transaction.budgetRoleConfirmed ? transaction.budgetRole : "unknown"] += transaction.amountCents;
  }
  const forecastExpenseCents = Math.max(0, ordinaryExpenseCents - currentVariableEssentialCents + variableEssentialBaselineCents);
  const recurringCandidates = findRecurringCandidates(consumption);
  const savingCandidates = findSavingCandidates(expenses);
  const anomalies = findSpendingAnomalies(month, consumption);
  const baselineCents = settings.stableMonthlyIncomeCents - forecastExpenseCents;
  const moderateSaving = sum(savingCandidates.filter((candidate) => candidate.confidence === "high").map((candidate) => candidate.minimumSavingCents));
  const aggressiveSaving = sum(savingCandidates.map((candidate) => candidate.maximumSavingCents));
  const trendMonths = [previousMonth(month, 3), previousMonth(month, 2), previousMonth(month, 1), month];
  const trend = trendMonths.map((candidate) => ({
    month: candidate,
    expenseCents: sum(consumption.filter((transaction) => transaction.occurredAt.startsWith(candidate)).map((transaction) => transaction.amountCents)),
    incomeCents: sum(transactions.filter((transaction) => transaction.occurredAt.startsWith(candidate) && transaction.kind === "income").map((transaction) => transaction.amountCents)),
    refundCents: sum(transactions.filter((transaction) => transaction.occurredAt.startsWith(candidate) && transaction.kind === "refund").map((transaction) => transaction.amountCents)),
  }));
  return {
    month,
    ordinaryExpenseCents,
    actualIncomeCents,
    refundCents,
    transferCents,
    repaymentCents,
    actualNetCents: actualIncomeCents + refundCents - grossExpenseCents,
    stableIncomeCents: settings.stableMonthlyIncomeCents,
    fixedEssentialCents,
    variableEssentialBaselineCents,
    variableEssentialSampleMonths: variableSamples.length,
    sampleInsufficient: variableSamples.length < 3,
    forecastExpenseCents,
    categoryTotals,
    budgetRoleTotals,
    recurringCandidates,
    savingCandidates,
    anomalies,
    trend,
    scenarios: {
      currentCents: actualIncomeCents + refundCents - grossExpenseCents,
      baselineCents,
      moderateCents: baselineCents + moderateSaving,
      aggressiveCents: baselineCents + aggressiveSaving,
    },
  };
}

export function buildFinanceInsightSnapshot(
  summary: FinanceMonthlySummary,
  budget: FinanceBudget,
  transactions: FinanceTransaction[],
  projects: Array<{ id: string; category: LifeDomain; status: "active" | "paused" | "completed" }>,
): FinanceInsightSnapshot {
  const currentExpenses = financeConsumptionTransactions(transactions).filter((transaction) => transaction.occurredAt.startsWith(summary.month));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const usedProjects = [...new Set(currentExpenses.map((transaction) => transaction.projectId).filter((value): value is string => Boolean(value)))]
    .sort();
  const anonymousProjectIds = new Map(usedProjects.map((id, index) => [id, `P-${String(index + 1).padStart(3, "0")}`]));
  const anonymousProjects = usedProjects.flatMap((id) => {
    const project = projectById.get(id);
    if (!project) return [];
    return [{
      anonymousProjectId: anonymousProjectIds.get(id) ?? "P-000",
      domain: project.category,
      status: project.status,
      expenseCents: sum(currentExpenses.filter((transaction) => transaction.projectId === id).map((transaction) => transaction.amountCents)),
    }];
  });
  return {
    analysisVersion: 2,
    month: summary.month,
    incomeBaselineCents: summary.stableIncomeCents,
    actualIncomeCents: summary.actualIncomeCents,
    expenseCents: summary.ordinaryExpenseCents,
    refundCents: summary.refundCents,
    actualNetCents: summary.actualNetCents,
    forecastExpenseCents: summary.forecastExpenseCents,
    budgetSavingsTargetCents: budget.savingsTargetCents,
    categoryTotals: Object.entries(summary.categoryTotals).map(([category, amountCents]) => ({ category: category as FinanceCategory, amountCents })),
    budgetRoleTotals: Object.entries(summary.budgetRoleTotals).map(([role, amountCents]) => ({ role: role as FinanceBudgetRole, amountCents })),
    trend: summary.trend,
    recurringCandidates: summary.recurringCandidates.map(({ evidenceId, occurrences, averageAmountCents, intervalDays, totalCents, confidence }) => ({
      evidenceId,
      occurrences,
      averageAmountCents,
      intervalDays,
      totalCents,
      confidence,
    })),
    savingCandidates: summary.savingCandidates,
    anomalies: summary.anomalies,
    budgetVariances: FINANCE_CATEGORIES.flatMap((entry) => {
      const limitCents = budget.categoryLimits[entry.value] ?? 0;
      if (!limitCents) return [];
      const spentCents = financeCategorySpending(summary.categoryTotals, entry.value);
      return [{ category: entry.value, spentCents, limitCents, varianceCents: spentCents - limitCents }];
    }),
    retainedSpending: FINANCE_CATEGORIES.flatMap((entry) => {
      const amountCents = sum(currentExpenses
        .filter((transaction) => transaction.category === entry.value && transaction.valueRating === "worthwhile")
        .map((transaction) => transaction.amountCents));
      return amountCents ? [{ evidenceId: `K-${stableShortHash(entry.value)}`, category: entry.value, amountCents }] : [];
    }),
    pendingConfirmation: {
      count: currentExpenses.filter(financeNeedsConfirmation).length,
      amountCents: sum(currentExpenses.filter(financeNeedsConfirmation).map((transaction) => transaction.amountCents)),
    },
    anonymousProjects,
    evidence: summary.savingCandidates.map((candidate) => ({
      evidenceId: candidate.evidenceId,
      amountCents: candidate.transactionTotalCents,
      category: candidate.category,
      budgetRole: candidate.budgetRole,
    })),
    localScenarios: summary.scenarios,
    sampleInsufficient: summary.sampleInsufficient,
  };
}

export function validateFinanceAiReportContent(value: unknown, snapshot: FinanceInsightSnapshot): FinanceAiReportContent {
  if (!isObject(value)) throw new Error("AI 返回的月报不是有效对象");
  const opportunitiesValue = readArray(value.opportunities, "节约机会");
  if (opportunitiesValue.length > 3) throw new Error("AI 月报建议过多，请重新生成最多三项重点建议");
  const caps = new Map<string, number>();
  snapshot.savingCandidates.forEach((candidate) => caps.set(candidate.evidenceId, candidate.maximumSavingCents));
  const usedEvidence = new Set<string>();
  const opportunities = opportunitiesValue.map((entry, index) => {
    if (!isObject(entry)) throw new Error(`第 ${index + 1} 条节约机会格式无效`);
    const evidenceIds = readStringArray(entry.evidenceIds, "证据编号");
    if (!evidenceIds.length || evidenceIds.some((id) => !caps.has(id))) throw new Error(`第 ${index + 1} 条节约机会引用了未知证据`);
    if (evidenceIds.some((id) => usedEvidence.has(id))) throw new Error("AI 对同一证据重复计算了节省金额");
    evidenceIds.forEach((id) => usedEvidence.add(id));
    const minimumSavingCents = readNonNegativeInteger(entry.minimumSavingCents, "节省下限");
    const maximumSavingCents = readNonNegativeInteger(entry.maximumSavingCents, "节省上限");
    const available = sum([...new Set(evidenceIds)].map((id) => caps.get(id) ?? 0));
    if (minimumSavingCents > maximumSavingCents || maximumSavingCents > available) {
      throw new Error(`第 ${index + 1} 条节约机会的金额超出本地证据范围`);
    }
    const confidence = readString(entry.confidence, "置信度");
    if (!(["low", "medium", "high"] as string[]).includes(confidence)) throw new Error("AI 返回了未知置信度");
    return {
      title: readString(entry.title, "机会标题"),
      reason: readString(entry.reason, "机会原因"),
      evidenceIds,
      minimumSavingCents,
      maximumSavingCents,
      confidence: confidence as "low" | "medium" | "high",
      action: readString(entry.action, "行动方式"),
      tradeoff: readString(entry.tradeoff, "可能代价", true),
    };
  });
  const totalOpportunityMax = sum(opportunities.map((opportunity) => opportunity.maximumSavingCents));
  const totalEvidenceCap = sum([...new Set(opportunities.flatMap((opportunity) => opportunity.evidenceIds))].map((id) => caps.get(id) ?? 0));
  if (totalOpportunityMax > totalEvidenceCap) throw new Error("AI 对同一证据重复计算了节省金额");
  const content: FinanceAiReportContent = {
    presentationVersion: 2,
    overview: readString(value.overview, "本月概览"),
    essentialStructure: readString(value.essentialStructure, "必要支出结构"),
    pendingConfirmations: readStringArray(value.pendingConfirmations, "待确认项"),
    worthwhileSpending: readStringArray(value.worthwhileSpending, "值得保留的消费"),
    opportunities,
    scenarios: {
      currentCents: snapshot.localScenarios.baselineCents,
      moderateCents: snapshot.localScenarios.moderateCents,
      aggressiveCents: snapshot.localScenarios.aggressiveCents,
    },
    nextActions: readStringArray(value.nextActions, "下月行动").slice(0, 3),
    questions: readStringArray(value.questions, "待回答问题").slice(0, 2),
  };
  assertFinanceReportLanguage(content);
  return content;
}

export function assertFinanceReportLanguage(content: FinanceAiReportContent) {
  const prose = [content.overview, content.essentialStructure, ...content.pendingConfirmations,
    ...content.worthwhileSpending, ...content.nextActions, ...content.questions,
    ...content.opportunities.flatMap((item) => [item.title, item.reason, item.action, item.tradeoff])].join("\n");
  const internalTerms = /\b(?:[a-z]+[A-Z][a-zA-Z]*|fixed-essential|variable-essential|growth|quality|optional|unknown|housing|food|transport|metro|bus|taxi|cycling|daily|health|learning|digital|relationships|entertainment|travel|fees|other|true|false)\b|\b[SKRAP]-[A-Z0-9]{3,}\b|\d[\d,，]*(?:\.\d+)?\s*分(?!钟)/;
  if (internalTerms.test(prose)) throw new Error("AI 月报仍含内部字段或未换算的金额，请重新生成；已有报告已保留");
}

export async function fingerprintFinanceSnapshot(snapshot: FinanceInsightSnapshot) {
  const bytes = new TextEncoder().encode(stableJson(snapshot));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function findRecurringCandidates(transactions: FinanceTransaction[]): FinanceRecurringCandidate[] {
  const groups = new Map<string, FinanceTransaction[]>();
  for (const transaction of transactions) {
    if (transaction.kind !== "expense" || !transaction.merchantNormalized) continue;
    const group = groups.get(transaction.merchantNormalized) ?? [];
    group.push(transaction);
    groups.set(transaction.merchantNormalized, group);
  }
  const candidates: FinanceRecurringCandidate[] = [];
  for (const [merchantKey, entries] of groups) {
    const sorted = entries.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    if (sorted.length < 3) continue;
    const amounts = sorted.map((entry) => entry.amountCents);
    const averageAmountCents = Math.round(sum(amounts) / amounts.length);
    if (Math.max(...amounts) - Math.min(...amounts) > Math.max(100, Math.round(averageAmountCents * 0.1))) continue;
    const intervals = sorted.slice(1).map((entry, index) => Math.round((new Date(entry.occurredAt).getTime() - new Date(sorted[index].occurredAt).getTime()) / dayMs));
    if (!intervals.every((days) => days >= 25 && days <= 35)) continue;
    const intervalDays = Math.round(sum(intervals) / intervals.length);
    candidates.push({
      evidenceId: `R-${stableShortHash(merchantKey)}`,
      merchantKey,
      displayMerchant: sorted.at(-1)?.merchant || "周期支出",
      occurrences: sorted.length,
      averageAmountCents,
      intervalDays,
      totalCents: sum(amounts),
      confidence: sorted.length >= 4 ? "high" : "medium",
    });
  }
  return candidates.sort((left, right) => right.totalCents - left.totalCents);
}

function findSavingCandidates(expenses: FinanceTransaction[]): FinanceSavingCandidate[] {
  const eligible = expenses.filter((transaction) => (
    transaction.budgetRoleConfirmed
    && transaction.budgetRole !== "unknown"
    && transaction.budgetRole !== "fixed-essential"
    && transaction.budgetRole !== "growth"
    && transaction.valueRating !== "worthwhile"
    && (transaction.budgetRole === "optional" || transaction.budgetRole === "variable-essential" || transaction.valueRating === "regret")
  ));
  const groups = new Map<string, FinanceTransaction[]>();
  for (const transaction of eligible) {
    const key = `${transaction.category}:${transaction.budgetRole}:${transaction.valueRating ?? "unrated"}`;
    const group = groups.get(key) ?? [];
    group.push(transaction);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, entries]) => {
    const transactionTotalCents = sum(entries.map((entry) => entry.amountCents));
    const high = entries.every((entry) => entry.budgetRole === "optional" && entry.valueRating === "regret");
    return {
      evidenceId: `S-${stableShortHash(key)}`,
      category: entries[0].category,
      budgetRole: entries[0].budgetRole,
      valueRating: entries[0].valueRating,
      transactionTotalCents,
      // Only explicitly regretted discretionary purchases have a known avoidable ceiling.
      // Necessary needs still cost money when replaced; their alternative cost is unknown.
      minimumSavingCents: 0,
      maximumSavingCents: high ? transactionTotalCents : 0,
      confidence: high ? "high" as const : "medium" as const,
    };
  }).sort((left, right) => right.maximumSavingCents - left.maximumSavingCents);
}

function findSpendingAnomalies(month: string, transactions: FinanceTransaction[]) {
  const previous = [previousMonth(month, 3), previousMonth(month, 2), previousMonth(month, 1)];
  if (!previous.every((candidate) => transactions.some((transaction) => transaction.occurredAt.startsWith(candidate)))) return [];
  return FINANCE_CATEGORIES.flatMap((entry) => {
    const historical = previous.map((candidate) => sum(transactions
      .filter((transaction) => transaction.kind === "expense" && transaction.category === entry.value && transaction.occurredAt.startsWith(candidate))
      .map((transaction) => transaction.amountCents)));
    const previousMedianCents = median(historical);
    const currentAmountCents = sum(transactions
      .filter((transaction) => transaction.kind === "expense" && transaction.category === entry.value && transaction.occurredAt.startsWith(month))
      .map((transaction) => transaction.amountCents));
    const increaseCents = currentAmountCents - previousMedianCents;
    if (increaseCents < 5_000 || currentAmountCents < Math.max(10_000, Math.round(previousMedianCents * 1.3))) return [];
    return [{
      evidenceId: `A-${stableShortHash(entry.value)}`,
      category: entry.value,
      currentAmountCents,
      previousMedianCents,
      increaseCents,
    }];
  });
}

function previousMonth(month: string, offset: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 - offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function assertMonth(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("月份格式无效");
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function stableShortHash(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(7, "0");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, field: string, optional = false) {
  if (typeof value !== "string" || (!optional && !value.trim())) throw new Error(`AI 返回的${field}无效`);
  return value.trim();
}

function readArray(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new Error(`AI 返回的${field}无效`);
  return value;
}

function readStringArray(value: unknown, field: string) {
  return readArray(value, field).map((entry) => readString(entry, field)).filter(Boolean);
}

function readNonNegativeInteger(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`AI 返回的${field}无效`);
  return value;
}

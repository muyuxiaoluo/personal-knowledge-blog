import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildFinanceInsightSnapshot, summarizeFinanceMonth } from "../app/finance-analysis";
import { emptyFinanceBudget, emptyFinanceSettings, type FinanceAiReport } from "../app/finance-types";
import { FinanceGoalSummary, FinanceReportContent } from "../desktop/WealthReport";

test("goal summary handles missing and impossible plans without claiming success", () => {
  const summary = summarizeFinanceMonth("2026-09", [], emptyFinanceSettings);
  const snapshot = buildFinanceInsightSnapshot(summary, emptyFinanceBudget("2026-09"), [], []);
  assert.match(renderToStaticMarkup(createElement(FinanceGoalSummary, { snapshot })), /先补全月收入与储蓄目标/);
  snapshot.incomeBaselineCents = 250_000;
  snapshot.budgetSavingsTargetCents = 300_000;
  assert.match(renderToStaticMarkup(createElement(FinanceGoalSummary, { snapshot })), /储蓄目标已超过规划收入/);
  snapshot.budgetSavingsTargetCents = 50_000;
  snapshot.expenseCents = 119_418;
  const html = renderToStaticMarkup(createElement(FinanceGoalSummary, { snapshot }));
  assert.match(html, /805.82/);
  assert.match(html, /需覆盖尚未入账的房租、三餐、通勤等开支/);
});

test("legacy reports do not leak old jargon and new reports keep evidence private", () => {
  const report: FinanceAiReport = {
    month: "2026-09", model: "test", generatedAt: "2026-09-16T00:00:00Z", inputFingerprint: "test",
    tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    content: {
      overview: "sampleInsufficient=true", essentialStructure: "fixed-essential 5590分",
      pendingConfirmations: [], worthwhileSpending: [], opportunities: [],
      scenarios: { currentCents: 0, moderateCents: 0, aggressiveCents: 0 }, nextActions: [], questions: [],
    },
  };
  const old = renderToStaticMarkup(createElement(FinanceReportContent, { report }));
  assert.match(old, /请重新生成/);
  assert.doesNotMatch(old, /sampleInsufficient|fixed-essential/);
  report.content.presentationVersion = 2;
  report.content.overview = "先保障生活";
  report.content.essentialStructure = "保留三餐和通勤";
  report.content.opportunities = [{ title: "比较通勤方式", reason: "如有可替代行程", action: "比较价格与额外耗时", tradeoff: "可能更费时间", evidenceIds: ["S-PRIVATE"], minimumSavingCents: 0, maximumSavingCents: 0, confidence: "low" }];
  const fresh = renderToStaticMarkup(createElement(FinanceReportContent, { report }));
  assert.match(fresh, /先确认替代方式，再计算能省多少/);
  assert.doesNotMatch(fresh, /S-PRIVATE|¥0.00|仍待确认/);
});

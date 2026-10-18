import assert from "node:assert/strict";
import test from "node:test";
import { buildFinanceCalendar } from "../app/finance-calendar";
import type { FinanceTransaction } from "../app/finance-types";

const entry = (date: string, amountCents: number, kind: FinanceTransaction["kind"] = "expense") => ({ occurredAt: `${date}T23:59:00`, amountCents, kind } as FinanceTransaction);

test("calendar keeps cents exact and excludes refunds, transfers and other months", () => {
  const calendar = buildFinanceCalendar("2026-09", [entry("2026-09-01", 360), entry("2026-09-01", 200), entry("2026-09-02", 10000), entry("2026-09-03", 400), entry("2026-09-02", 5000, "refund"), entry("2026-09-03", 9000, "transfer"), entry("2026-09-03", 9000, "repayment"), entry("2026-08-31", 500)]);
  assert.equal(calendar.days.length, 30);
  assert.equal(calendar.leadingDays, 1);
  assert.equal(calendar.days[0].amountCents, 560);
  assert.equal(calendar.days[0].transactions.length, 2);
  assert.equal(calendar.totalCents, 10960);
  assert.equal(calendar.peak?.date, "2026-09-02");
  assert.equal(calendar.topTwoShare, 10560 / 10960);
  assert.equal(calendar.spendingDays, 3);
});

test("calendar aligns Monday-first months, leap days and empty months", () => {
  assert.equal(buildFinanceCalendar("2024-02", []).days.length, 29);
  assert.equal(buildFinanceCalendar("2026-02", []).days.length, 28);
  assert.equal(buildFinanceCalendar("2026-02", []).leadingDays, 6);
  assert.equal(buildFinanceCalendar("2026-06", []).leadingDays, 0);
  assert.equal(buildFinanceCalendar("2026-12", []).days.length, 31);
  const empty = buildFinanceCalendar("2026-09", []);
  assert.equal(empty.peak, null);
  assert.equal(empty.topTwoShare, 0);
  assert.throws(() => buildFinanceCalendar("2026-13", []), /月份格式/);
});

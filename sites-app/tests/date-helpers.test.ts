import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarDayDifference,
  classifyDeadlineUrgency,
  formatRelativeDueDate,
  localDate,
} from "../app/date-helpers";

test("compares due dates by calendar day instead of time of day", () => {
  assert.equal(calendarDayDifference("2026-08-16", "2026-08-16"), 0);
  assert.equal(calendarDayDifference("2026-08-17", "2026-08-16"), 1);
  assert.equal(calendarDayDifference("2026-08-15", "2026-08-16"), -1);
  assert.equal(formatRelativeDueDate("2026-08-16", "2026-08-16"), "今天截止");
  assert.equal(formatRelativeDueDate("2026-08-17", "2026-08-16"), "明天截止");
  assert.equal(formatRelativeDueDate("2026-08-14", "2026-08-16"), "已过期 2 天");
});

test("classifies only nearby stage deadlines as urgent", () => {
  assert.equal(classifyDeadlineUrgency("2026-08-23", "2026-08-16"), null);
  assert.equal(classifyDeadlineUrgency("2026-08-19", "2026-08-16"), null);
  assert.deepEqual(classifyDeadlineUrgency("2026-08-18", "2026-08-16"), { daysRemaining: 2, tone: "soon", label: "2 天后截止" });
  assert.deepEqual(classifyDeadlineUrgency("2026-08-17", "2026-08-16"), { daysRemaining: 1, tone: "soon", label: "明天截止" });
  assert.deepEqual(classifyDeadlineUrgency("2026-08-16", "2026-08-16"), { daysRemaining: 0, tone: "today", label: "今天截止" });
  assert.deepEqual(classifyDeadlineUrgency("2026-08-14", "2026-08-16"), { daysRemaining: -2, tone: "overdue", label: "已逾期 2 天" });
  assert.equal(classifyDeadlineUrgency("not-a-date", "2026-08-16"), null);
});

test("handles calendar boundaries and invalid date input", () => {
  assert.equal(calendarDayDifference("2027-01-01", "2026-12-31"), 1);
  assert.equal(formatRelativeDueDate("2026-08-20", "2026-08-16"), "8月20日截止");
  assert.equal(formatRelativeDueDate("not-a-date", "2026-08-16"), "not-a-date");
  assert.equal(localDate(new Date("2026-08-16T12:30:00.000Z")).length, 10);
});

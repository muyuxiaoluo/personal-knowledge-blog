import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarDayDifference,
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

test("handles calendar boundaries and invalid date input", () => {
  assert.equal(calendarDayDifference("2027-01-01", "2026-12-31"), 1);
  assert.equal(formatRelativeDueDate("2026-08-20", "2026-08-16"), "8月20日截止");
  assert.equal(formatRelativeDueDate("not-a-date", "2026-08-16"), "not-a-date");
  assert.equal(localDate(new Date("2026-08-16T12:30:00.000Z")).length, 10);
});

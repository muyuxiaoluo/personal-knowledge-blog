import assert from "node:assert/strict";
import test from "node:test";
import { activityIntensity, buildActivityDays, buildActivityWeeks } from "../app/activity-helpers";

test("builds a one-year Sunday-to-Saturday activity grid ending today", () => {
  const weeks = buildActivityWeeks("2026-08-29");
  const dates = weeks.flatMap((week) => week).filter((date): date is string => Boolean(date));
  assert.equal(dates.length, 365);
  assert.equal(dates[0], "2025-08-30");
  assert.equal(dates.at(-1), "2026-08-29");
  assert.equal(weeks.every((week) => week.length === 7), true);
  assert.equal(weeks[0]?.[0], null);
});

test("keeps rest and real activity as independent signals", () => {
  const days = buildActivityDays({
    tasks: [{ id: "task-1", projectId: "project-1", projectTitle: "论文", title: "整理实验", currentFocus: "", completedAt: "2026-08-24T09:00:00" }],
    notes: [{ id: "note-1", title: "实验记录", created: "2026-08-20", updated: "2026-08-24" }],
    focusSessions: [{ id: "focus-1", taskId: "task-1", projectId: "project-1", label: "整理实验", startedAt: "2026-08-24T09:00:00", endedAt: "2026-08-24T10:00:00", durationSeconds: 3600 }],
    restDays: [{ date: "2026-08-24", note: "", createdAt: "2026-08-24T00:00:00Z", updatedAt: "2026-08-24T00:00:00Z" }],
  });
  const day = days.get("2026-08-24");
  assert.equal(day?.rest, true);
  assert.equal(day?.tasks.length, 1);
  assert.equal(day?.notes.length, 1);
  assert.equal(day?.focusSeconds, 3600);
  assert.equal(day?.intensity, 3);
});

test("caps activity intensity at four levels", () => {
  assert.equal(activityIntensity(0, 0, 0), 0);
  assert.equal(activityIntensity(0, 1, 0), 1);
  assert.equal(activityIntensity(1, 1, 1800), 2);
  assert.equal(activityIntensity(2, 1, 3600), 3);
  assert.equal(activityIntensity(4, 2, 7200), 4);
});

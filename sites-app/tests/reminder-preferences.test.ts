import assert from "node:assert/strict";
import test from "node:test";
import { emptyHealthDailyLog } from "../app/health-types";
import {
  defaultHealthReminderPreferences,
  healthReminderBody,
  missingHealthReminderItems,
  normalizeHealthReminderPreferences,
  parseHealthReminderPreferences,
} from "../app/reminder-preferences";

test("reminder preferences default to an opt-in 22:00 reminder", () => {
  assert.deepEqual(parseHealthReminderPreferences(undefined), defaultHealthReminderPreferences);
  assert.deepEqual(parseHealthReminderPreferences("not-json"), defaultHealthReminderPreferences);
  assert.deepEqual(normalizeHealthReminderPreferences({ enabled: true, time: "24:10" }), {
    enabled: true,
    time: "22:00",
  });
  assert.deepEqual(normalizeHealthReminderPreferences({ enabled: true, time: "21:35" }), {
    enabled: true,
    time: "21:35",
  });
});

test("health reminders only mention fields that are still missing", () => {
  const empty = emptyHealthDailyLog("2026-09-21");
  assert.deepEqual(missingHealthReminderItems(empty), ["sleep", "activity"]);
  assert.match(healthReminderBody(missingHealthReminderItems(empty)), /睡眠和活动/);

  assert.deepEqual(missingHealthReminderItems({
    ...empty,
    sleepMinutes: 450,
    steps: 0,
  }), []);
  assert.deepEqual(missingHealthReminderItems({
    ...empty,
    sleepStart: "23:40",
    sleepEnd: "07:20",
    activityMinutes: 0,
  }), []);
  assert.deepEqual(missingHealthReminderItems({
    ...empty,
    sleepMinutes: 420,
  }), ["activity"]);
});

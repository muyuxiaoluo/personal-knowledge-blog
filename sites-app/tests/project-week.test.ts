import assert from "node:assert/strict";
import test from "node:test";
import { affectedWeekActions, readWeekSettings, scheduleWeek, type WeekAction } from "../app/project-week";

const monday = "2026-11-09";
const wednesday = "2026-11-11";
const thursday = "2026-11-12";
const friday = "2026-11-13";

function action(id: string, patch: Partial<WeekAction> = {}): WeekAction {
  return { id, projectId: "study", title: id, status: "later", date: "", due: "", minutes: 30, after: [], fixed: false, ...patch };
}

test("week scheduling can go past a target but respects an explicit deadline", () => {
  const settings = readWeekSettings(null);
  const actions = [action("target", { target: monday }), action("deadline", { due: monday })];
  const result = scheduleWeek(wednesday, actions, new Set(["target", "deadline"]), settings, new Set());
  assert.deepEqual(result.map(({ action: item, date }) => [item.id, date]), [["deadline", ""], ["target", wednesday]]);
});

test("a lost Wednesday moves only affected work and keeps Friday in place", () => {
  const settings = readWeekSettings(null);
  settings.exceptions = { [wednesday]: 0, [thursday]: 30 };
  const actions = [action("monday", { date: monday, status: "done", fixed: true }), action("wed", { date: wednesday }),
    action("fri", { date: friday, after: ["wed"] })];
  const { affected } = affectedWeekActions(actions, wednesday, wednesday, 0);
  const result = scheduleWeek(wednesday, actions, affected, settings, new Set());
  assert.deepEqual(result.map(({ action: item, date }) => [item.id, date]), [["wed", thursday], ["fri", friday]]);
});

test("other projects, rest, deadlines, and fixed plans constrain what fits", () => {
  const settings = readWeekSettings(null);
  settings.exceptions = { [thursday]: 30 };
  const actions = [
    action("protected", { projectId: "work", date: wednesday, fixed: true }),
    action("overdue", { date: monday, due: friday }),
    action("today", { date: wednesday, due: friday }),
    action("dependent", { date: friday, after: ["today"], due: friday }),
  ];
  const { affected, excess } = affectedWeekActions(actions, wednesday, wednesday, 0);
  assert.equal(excess, 30);
  assert.ok(!affected.has("protected"));
  assert.ok(!affected.has("overdue"));
  const recovery = affectedWeekActions([...actions, action("undated")], "", wednesday, 0);
  assert.deepEqual([...recovery.affected], ["overdue"]);
  assert.equal(recovery.excess, 0);
  affected.add("overdue");
  const result = scheduleWeek(wednesday, actions, affected, settings, new Set([friday]));
  assert.deepEqual(result.map(({ action: item, date }) => [item.id, date]), [["overdue", thursday], ["today", ""], ["dependent", ""]]);
  assert.match(result[1].reason, /30 分钟/);
  assert.match(result[2].reason, /前置/);
});

test("a dependent action is scheduled after its prerequisite across two weekly previews", () => {
  const settings = readWeekSettings(null);
  const first = scheduleWeek(monday, [action("first"), action("second", { after: ["first"] })], new Set(["first", "second"]), settings, new Set());
  assert.deepEqual(first.map(({ date }) => date), [monday, wednesday]);
  const nextMonday = "2026-11-16";
  const second = scheduleWeek(nextMonday, [
    action("second", { date: wednesday, status: "done", fixed: true }),
    action("third", { after: ["second"] }),
  ], new Set(["third"]), settings, new Set());
  assert.equal(second[0].date, nextMonday);
});

test("two short dependent steps can fit in one day in prerequisite order", () => {
  const settings = readWeekSettings(null);
  const actions = [action("second", { after: ["first"], minutes: 15 }), action("first", { minutes: 15 })];
  const result = scheduleWeek(monday, actions, new Set(["first", "second"]), settings, new Set());
  assert.deepEqual(result.map(({ action: item, date }) => [item.id, date]), [["first", monday], ["second", monday]]);
});

test("an explicitly added date beyond the rolling week can receive moved work", () => {
  const settings = readWeekSettings(null);
  settings.minutes = [0, 0, 0, 0, 0, 0, 0];
  settings.exceptions["2026-11-19"] = 30;
  const actions = [action("wed", { date: "2026-11-18" })];
  const result = scheduleWeek(thursday, actions, new Set(["wed"]), settings, new Set(), ["2026-11-19"]);
  assert.equal(result[0].date, "2026-11-19");
});

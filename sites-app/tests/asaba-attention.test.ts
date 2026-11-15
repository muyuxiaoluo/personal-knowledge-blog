import assert from "node:assert/strict";
import test from "node:test";
import { attentionView, initialAttentionState, type AttentionJob, type AttentionSource } from "../app/asaba-attention";
import type { Milestone, Project, ProjectDetail, ProjectTask } from "../app/project-types";

const start = new Date(2026, 10, 15, 10);
const today = "2026-11-15";
const empty = () => initialAttentionState(start, [], []);
function project(patch: Partial<Project> = {}, milestones: Milestone[] = [], tasks: ProjectTask[] = []): ProjectDetail {
  return {
    project: { id: "prep", title: "机器人求职", status: "active", isDraft: false, ...patch } as Project,
    milestones, tasks, logs: [], proposals: [], accumulations: [],
  };
}
function source(patch: Partial<AttentionSource> = {}): AttentionSource {
  return { id: "new", title: "机器人求职面试复盘", branch: "收藏中", collection: "sources", type: "外部资料", project: "", projectId: "", tags: [], version: 1, deleted: false, ...patch };
}
function job(patch: Partial<AttentionJob> = {}): AttentionJob {
  return { id: "job", agent: "research", state: "review", title: "公开岗位调研", updatedAt: new Date(start.getTime() + 1000).toISOString(), ...patch };
}

test("groups qualifying deadlines and reviews, restores state across a missed day, and removes expired evidence", () => {
  const stage = { id: "stage", title: "投递阶段", status: "current", dueDateKind: "deadline", dueDate: today } as Milestone;
  const task = { id: "task", title: "核对材料", status: "waiting", dueDateKind: "deadline", dueDate: today } as ProjectTask;
  const prep = project({ targetDateKind: "deadline", targetDate: "2026-11-14", reviewDate: today }, [stage], [
    task,
    { ...task, id: "goal", dueDateKind: "target" },
    { ...task, id: "legacy", dueDateKind: null },
    { ...task, id: "done", status: "done" },
  ]);
  const state = initialAttentionState(start, [], [], [prep]);
  const [group] = attentionView(state, today, [prep], [], []).groups;
  assert.equal(group.title, "机器人求职");
  assert.deepEqual(group.entries.map(entry => [entry.kind, entry.title]), [
    ["deadline", "投递阶段"], ["deadline", "核对材料"], ["review", "项目回顾"],
  ]);
  const [stageEntry, taskEntry] = group.entries;
  state.disposition[stageEntry.key] = "dismissed";
  state.disposition[taskEntry.key] = "read";
  const restored = JSON.parse(JSON.stringify(state));
  const [after] = attentionView(restored, "2026-11-17", [prep], [], []).groups;
  assert.deepEqual(after.entries.map(entry => entry.unread), [false, true]);
  prep.milestones[0] = { ...stage, dueDate: "2026-11-16" };
  prep.tasks[0] = { ...task, status: "cancelled" };
  const [rescheduled] = attentionView(restored, "2026-11-17", [prep], [], []).groups;
  assert.equal(rescheduled.entries[0].unread, true);
  assert.notEqual(rescheduled.entries[0].key, stageEntry.key);
  prep.project.targetDate = "2026-11-13";
  assert.equal(attentionView(restored, "2026-11-17", [prep], [], []).groups[0].entries[0]!.unread, true);
  prep.project.status = "paused";
  assert.deepEqual(attentionView(restored, "2026-11-17", [prep], [], []).groups, []);
});

test("suppresses historical results and reports one outcome per attempt even if progress events are missed", () => {
  const oldTime = new Date(start.getTime() - 1000).toISOString();
  const baseline = job({ id: "historical", state: "failed", updatedAt: oldTime });
  const recovered = job({ id: "recovered", state: "interrupted", updatedAt: oldTime, activeAtStartup: true });
  const running = job({ id: "running", state: "running", updatedAt: oldTime });
  const state = initialAttentionState(start, [], [baseline, running, recovered]);
  const failed = job({ state: "failed" });
  const snapshot = attentionView(state, today, [], [job({ ...running, state: "review" }), baseline, failed, recovered], []);
  assert.deepEqual(snapshot.groups.map(group => group.id), ["running", "job", "recovered"]);
  state.disposition[snapshot.groups[1].entries[0].key] = "dismissed";
  const next = attentionView(state, today, [], [job({ attempt: 1 }), job({ ...running, state: "reviewed" }), baseline, job({ id: "cancelled", state: "cancelled" })], []);
  assert.deepEqual(next.groups.map(group => [group.id, group.entries[0].unread]), [["job", true]]);
});

test("matches only unique eligible new collections and respects saved history", () => {
  const tagged = source({ id: "tagged", title: "面试记录", tags: ["机器人 · 求职"] });
  const old = source({ id: "old", deleted: true });
  const state = initialAttentionState(start, [old], []);
  const projects = [project(), project({ id: "short", title: "面试" }), project({ id: "draft", isDraft: true })];
  const sources = [source(), tagged, source({ id: "linked", projectId: "prep" }), source({ id: "legacy", project: "旧项目" }),
    source({ id: "archived", branch: "已归档" }), { ...old, deleted: false }];
  const result = attentionView(state, today, projects, [], sources);
  assert.deepEqual(result.groups.map(group => group.id), ["new", "tagged"]);
  assert.deepEqual(result.groups.map(group => "basis" in group.entries[0] && group.entries[0].basis), ["title", "tag"]);
  assert.deepEqual(attentionView(state, today, [...projects, project({ id: "also-prep" })], [], sources).groups, []);
  state.disposition[result.groups[0].entries[0].key] = "dismissed";
  assert.deepEqual(attentionView(state, today, projects, [], sources).groups.map(group => group.id), ["tagged"]);
});

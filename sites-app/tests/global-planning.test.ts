import assert from "node:assert/strict";
import test from "node:test";
import { buildGlobalPlanningContext, projectAttention, validateGlobalPlanningProposal, type PlanningInput, type PlanningTask } from "../app/global-planning";
import type { ProjectDetail } from "../app/project-types";

function project(id = "p"): ProjectDetail {
  return {
    project: { id, title: id, outcome: "形成成果", motivation: "低投入", projectType: "main", planningMode: "direct", parentProjectId: null, supportsMilestoneId: null, status: "active", category: "learning", sortOrder: 0, isDraft: false, sourceNote: "", targetDate: "", reviewDate: "", completedAt: null, createdAt: "2026-10-01T04:00:00Z", updatedAt: "2026-10-22T04:00:00Z" },
    tasks: [], milestones: [], logs: [], proposals: [], accumulations: [],
  };
}
function task(projectId: string | null = "p"): PlanningTask {
  return { id: "t", projectId, milestoneId: null, direction: "learning", title: "写一页结论", currentFocus: "", definitionOfDone: "", steps: [], details: "", benefit: "", dueDate: "", status: "later", actionType: "write", waitingFor: "", resumeAction: "", context: "computer", sortOrder: 0, createdAt: "2026-10-01T04:00:00Z", updatedAt: "2026-10-22T04:00:00Z", completedAt: null, plan: null };
}
function input(): PlanningInput {
  return { today: "2026-10-22", projects: [project()], tasks: [], focusSessions: [], weeklyFocus: null, dailySituations: [] };
}

test("reminds about inactivity from progress rather than metadata edits and excludes inactive projects", () => {
  const data = input();
  const paused = project("paused"); paused.project.status = "paused";
  const completed = project("completed"); completed.project.status = "completed";
  const draft = project("draft"); draft.project.isDraft = true;
  data.projects.push(paused, completed, draft);
  data.projects[0].logs.push({ id: "edit", projectId: "p", taskId: null, kind: "plan_revision", body: "改计划", createdAt: "2026-10-22T04:00:00Z" });
  const attention = projectAttention(data);
  assert.equal(attention.length, 1);
  assert.equal(attention[0].idleDays, 21);
  assert.match(attention[0].reasons.join(), /21 天/);
  assert.match(attention[0].reasons.join(), /没有可继续/);
  data.focusSessions.push({ id: "s", projectId: "p", taskId: null, label: "写结论", startedAt: "2026-10-21T04:00:00Z", endedAt: null, durationSeconds: 0 });
  assert.equal(projectAttention(data)[0].idleDays, 1);
});

test("completed work and progress records reset inactivity; current branches without actions are noticed", () => {
  const data = input();
  const action = task(); action.status = "done"; action.completedAt = "2026-10-20T04:00:00Z";
  data.projects[0].tasks.push(action);
  data.projects[0].milestones.push({ id: "m", projectId: "p", title: "验证结论", status: "current", definitionOfDone: "", dueDate: "2026-10-21", sortOrder: 0, createdAt: "", updatedAt: "" });
  data.projects[0].project.reviewDate = "2026-10-22";
  const attention = projectAttention(data)[0];
  assert.equal(attention.idleDays, 2);
  assert.match(attention.reasons.join(), /截止日期/);
  assert.match(attention.reasons.join(), /回顾日期/);
  assert.match(attention.reasons.join(), /验证结论.*缺少下一步/);
  data.projects[0].logs.push({ id: "progress", projectId: "p", taskId: "t", kind: "task_progress", body: "核对了结果", createdAt: "2026-10-22T04:00:00Z" });
  assert.equal(projectAttention(data)[0].idleDays, 0);
});

test("global context retains all open actions, actual completion, notes and plans within explicit limits", () => {
  const data = input();
  data.tasks = [task(), { ...task(null), id: "standalone" }];
  const action = data.tasks[0];
  action.plan = { taskId: action.id, plannedDate: data.today, priority: "normal", estimateMinutes: 25, sortOrder: 0, updatedAt: "" };
  const completed = { ...task(), id: "done", status: "done" as const, completedAt: "2026-10-21T04:00:00Z" };
  data.tasks.push(completed);
  data.projects[0].tasks = [action, completed];
  data.projects[0].logs.push({ id: "l", projectId: "p", taskId: "done", kind: "task_completed", body: "还有一个结果待核对", createdAt: "2026-10-21T04:00:00Z" });
  data.projects.push(project("other"));
  const context = buildGlobalPlanningContext(data, "今天半小时");
  assert.equal(context.projects.length, 2);
  assert.equal(context.tasks.length, 3);
  assert.equal(context.tasks.find((task) => task.id === "t")?.plannedDate, data.today);
  assert.match(context.projects[0].recentRecords[0].body, /待核对/);
  assert.equal(context.projects[0].completedTaskCount, 1);
  assert.equal(context.request, "今天半小时");
  assert.match(context.coverage, /没有记录不等于没有做过/);
  data.tasks = Array.from({ length: 50 }, (_, i) => ({ ...task(), id: `${i}`, details: "中".repeat(1200) }));
  assert.throws(() => buildGlobalPlanningContext(data, ""), /读取上限/);
});

test("rejects hallucinated, mismatched, duplicate, paused and completed recommendations", () => {
  const data = input(); data.tasks = [task(), { ...task(null), id: "standalone" }];
  const suggestion = { projectId: "p", taskId: "t", reason: "已有结果待汇总", nextStep: "先看最后一次记录" };
  const proposal = { summary: "先继续一件事", suggestions: [suggestion], questions: [] };
  assert.equal(validateGlobalPlanningProposal(proposal, data), proposal);
  for (const patch of [{ projectId: "missing" }, { taskId: "missing" }, { taskId: "standalone" }, { nextStep: "" }]) {
    assert.throws(() => validateGlobalPlanningProposal({ ...proposal, suggestions: [{ ...suggestion, ...patch }] }, data));
  }
  assert.throws(() => validateGlobalPlanningProposal({ ...proposal, suggestions: [suggestion, suggestion] }, data), /重复/);
  data.tasks[0].status = "done";
  assert.throws(() => validateGlobalPlanningProposal(proposal, data));
  data.tasks[0].status = "later"; data.projects[0].project.status = "paused";
  assert.throws(() => validateGlobalPlanningProposal(proposal, data));
  assert.doesNotThrow(() => validateGlobalPlanningProposal({ ...proposal, suggestions: [{ ...suggestion, projectId: null, taskId: "standalone" }] }, data));
});

test("follow-up planning retains the original constraints and all answered questions", () => {
  const data = input();
  const previousProposal = { summary: "先汇总已有结果", suggestions: [], questions: ["报告是否已提交？", "今天能投入多久？"] };
  const followUp = { previousProposal, clarifications: [
    { question: "报告是否已提交？", answer: "  已提交，等待导师反馈。  " },
    { question: "今天能投入多久？", answer: "只剩半小时" },
    { question: "其他约束？", answer: "  " },
  ] };
  const context = buildGlobalPlanningContext(data, "优先科研，留半小时休息", followUp);
  assert.equal(context.request, "优先科研，留半小时休息");
  assert.deepEqual(context.previousProposal, previousProposal);
  assert.deepEqual(context.clarifications, [
    { question: "报告是否已提交？", answer: "已提交，等待导师反馈。" },
    { question: "今天能投入多久？", answer: "只剩半小时" },
  ]);
  assert.equal(followUp.clarifications[0].answer, "  已提交，等待导师反馈。  ");
  assert.throws(() => buildGlobalPlanningContext(data, "", { ...followUp, clarifications: [{ question: "补充？", answer: "中".repeat(24000) }] }), /读取上限/);
});

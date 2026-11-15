import assert from "node:assert/strict";
import test from "node:test";
import { buildAsabaProgressInput, resolveProjectDecision, type AsabaProgressAnswer } from "../app/asaba-planning";
import type { Milestone, ProjectDetail, ProjectTask } from "../app/project-types";

const now = "2026-09-22T08:00:00.000Z";

function milestone(id: string, title: string, predecessorIds: string[], status: Milestone["status"]): Milestone {
  return { id, projectId: "project", title, predecessorIds, definitionOfDone: `${title}完成`, status, dueDate: "", sortOrder: 10, createdAt: now, updatedAt: now };
}

function task(id: string, milestoneId: string, title: string, status: ProjectTask["status"]): ProjectTask {
  return { id, projectId: "project", milestoneId, direction: "learning", title, actionType: "experiment", definitionOfDone: "得到结果", steps: [], currentFocus: title, details: "", benefit: "", dueDate: "", status, waitingFor: "", resumeAction: "", context: "computer", sortOrder: 10, createdAt: now, updatedAt: now, completedAt: status === "done" ? now : null };
}

test("branch AI context includes ancestors and shared facts but excludes a parallel branch", () => {
  const root = milestone("root", "共同基础", [], "completed");
  const left = milestone("left", "实验 A", ["root"], "current");
  const right = milestone("right", "实验 B", ["root"], "current");
  const rootTask = task("root-task", "root", "共同完成记录", "done");
  const leftTask = task("left-task", "left", "A 的当前实验", "next");
  const rightTask = task("right-task", "right", "B 的未完成实验", "next");
  const detail: ProjectDetail = {
    project: { id: "project", title: "研究项目", outcome: "形成可靠结论", motivation: "复用已有工作", projectType: "main", planningMode: "adaptive", parentProjectId: null, supportsMilestoneId: null, status: "active", category: "learning", sortOrder: 10, isDraft: false, sourceNote: "", targetDate: "", reviewDate: "", completedAt: null, createdAt: now, updatedAt: now },
    milestones: [root, left, right],
    tasks: [rootTask, leftTask, rightTask],
    logs: [
      { id: "left-log", projectId: "project", taskId: "left-task", kind: "task_progress", body: "A 已跑通", createdAt: now },
      { id: "right-log", projectId: "project", taskId: "right-task", kind: "task_progress", body: "B 正在调参", createdAt: now },
      { id: "right-continuation", projectId: "project", taskId: null, kind: "continuation", body: "接续点｜right｜实验 B｜继续 B", createdAt: now },
    ],
    proposals: [],
    accumulations: [
      { id: "shared", projectId: "project", milestoneId: null, title: "共享论文", content: "已精读，共同方法可复用", reference: "", createdAt: now, updatedAt: now },
      { id: "root-fact", projectId: "project", milestoneId: "root", title: "共同代码", content: "基线已跑通，可复用", reference: "", createdAt: now, updatedAt: now },
      { id: "left-fact", projectId: "project", milestoneId: "left", title: "A 结果", content: "完成 A，结果有效", reference: "", createdAt: now, updatedAt: now },
      { id: "right-fact", projectId: "project", milestoneId: "right", title: "B 结果", content: "完成 B，待判断", reference: "", createdAt: now, updatedAt: now },
    ],
  };

  const input = buildAsabaProgressInput("我现在可以做什么？", detail, left);
  const serialized = JSON.stringify(input);
  assert.match(serialized, /共同基础/);
  assert.match(serialized, /A 的当前实验/);
  assert.match(serialized, /共享论文/);
  assert.match(serialized, /共同代码/);
  assert.match(serialized, /A 结果/);
  assert.doesNotMatch(serialized, /B 的未完成实验/);
  assert.doesNotMatch(serialized, /B 正在调参/);
  assert.doesNotMatch(serialized, /B 结果/);
  assert.doesNotMatch(serialized, /继续 B/);
  assert.ok(input.evidence.every(source => source.projectId === detail.project.id));
  const answer: AsabaProgressAnswer = { summary: "先做实验", unknowns: [], findings: [], nextAction: "Ａ 的当前实验。", completionCondition: "得到结果", decision: "new_action" };
  const result = resolveProjectDecision(detail, { answer, evidence: input.evidence }, left);
  assert.equal(result.answer.decision, "continue");
  assert.equal(result.existingAction?.id, leftTask.id);
  assert.equal(result.actionDraft, null);
  assert.equal(resolveProjectDecision(detail, { answer: { ...answer, nextAction: rootTask.title }, evidence: input.evidence }, left).answer.decision, "keep");
  const paused = { ...detail, project: { ...detail.project, status: "paused" as const } };
  assert.equal(resolveProjectDecision(paused, { answer: { ...answer, nextAction: "检查新输入" }, evidence: input.evidence }).actionDraft, null);
});

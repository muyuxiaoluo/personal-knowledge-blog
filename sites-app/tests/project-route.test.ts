import assert from "node:assert/strict";
import test from "node:test";
import { routeDescendants, routeLayers, validateRoute } from "../app/project-route";
import { prepareProjectRoute } from "../app/project-route-proposal";
import type { ProjectRouteProposal } from "../app/ai-api-types";
import type { Milestone, Project } from "../app/project-types";

function node(id: string, predecessorIds: string[] = []): Milestone {
  return {
    id,
    projectId: "project-1",
    title: id,
    definitionOfDone: "",
    predecessorIds,
    status: "planned",
    dueDate: "",
    sortOrder: 0,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
  };
}

test("finds every downstream node that cannot become a predecessor", () => {
  const nodes = [node("start"), node("left", ["start"]), node("right", ["start"]), node("merge", ["left", "right"]), node("later", ["merge"])];
  assert.deepEqual([...routeDescendants(nodes, "left")].sort(), ["later", "merge"]);
  assert.deepEqual([...routeDescendants(nodes, "start")].sort(), ["later", "left", "merge", "right"]);
});

test("keeps visual fork and merge layers deterministic and rejects a cycle", () => {
  const nodes = [node("start"), node("left", ["start"]), node("right", ["start"]), node("merge", ["left", "right"])];
  assert.deepEqual(routeLayers(nodes).map((layer) => layer.map((item) => item.id)), [["start"], ["left", "right"], ["merge"]]);
  assert.throws(() => validateRoute(nodes.map((item) => item.id === "start" ? { ...item, predecessorIds: ["merge"] } : item)), /循环/);
});

test("prepares an editable route while locking completed history and retaining explicit replacements", () => {
  const completed = { ...node("done"), status: "completed" as const, definitionOfDone: "历史已验收" };
  const current = { ...node("current", ["done"]), status: "current" as const, definitionOfDone: "当前完成" };
  const future = { ...node("future", ["current"]), definitionOfDone: "未来完成" };
  const project: Project = { id: "project-1", title: "项目", outcome: "结果", motivation: "", projectType: "main", planningMode: "adaptive", parentProjectId: null, supportsMilestoneId: null, status: "active", category: "learning", sortOrder: 10, isDraft: false, sourceNote: "", targetDate: "", reviewDate: "", completedAt: null, createdAt: current.createdAt, updatedAt: current.updatedAt };
  const proposal: ProjectRouteProposal = {
    summary: "保留当前，替代旧未来，并增加汇合节点",
    nodes: [
      { ref: "current", existingMilestoneId: "current", action: "update", title: "当前实验", definitionOfDone: "得到基线结果", dueDate: "", status: "current", predecessorRefs: ["done"] },
      { ref: "future", existingMilestoneId: "future", action: "supersede", title: "旧未来", definitionOfDone: "", dueDate: "", status: "planned", predecessorRefs: [] },
      { ref: "new", existingMilestoneId: null, action: "create", title: "整理结论", definitionOfDone: "形成结论表", dueDate: "", status: "planned", predecessorRefs: ["current"] },
    ],
    assumptions: [], risks: [],
  };
  const prepared = prepareProjectRoute(project, [completed, current, future], proposal, current.updatedAt, (_ref, index) => `new-${index}`);
  assert.deepEqual(prepared.supersededIds, ["future"]);
  assert.equal(prepared.milestones.find((item) => item.id === "current")?.title, "当前实验");
  assert.deepEqual(prepared.milestones.find((item) => item.id === "new-2")?.predecessorIds, ["current"]);
  assert.equal(completed.title, "done");
});

test("route proposal rejects completed edits, omissions and cycles", () => {
  const completed = { ...node("done"), status: "completed" as const, definitionOfDone: "完成" };
  const current = { ...node("current", ["done"]), status: "current" as const, definitionOfDone: "完成" };
  const project: Project = { id: "project-1", title: "项目", outcome: "结果", motivation: "", projectType: "main", planningMode: "adaptive", parentProjectId: null, supportsMilestoneId: null, status: "active", category: "learning", sortOrder: 10, isDraft: false, sourceNote: "", targetDate: "", reviewDate: "", completedAt: null, createdAt: current.createdAt, updatedAt: current.updatedAt };
  const base: ProjectRouteProposal = { summary: "", assumptions: [], risks: [], nodes: [{ ref: "current", existingMilestoneId: "current", action: "keep", title: "current", definitionOfDone: "完成", dueDate: "", status: "current", predecessorRefs: ["done"] }] };
  assert.throws(() => prepareProjectRoute(project, [completed, current], { ...base, nodes: [{ ...base.nodes[0], existingMilestoneId: "done" }] }, current.updatedAt, () => "new"), /已完成/);
  assert.throws(() => prepareProjectRoute(project, [completed, current], { ...base, nodes: [{ ref: "new", existingMilestoneId: null, action: "create", title: "新节点", definitionOfDone: "完成", dueDate: "", status: "current", predecessorRefs: [] }] }, current.updatedAt, () => "new"), /每个未完成节点/);
  assert.throws(() => prepareProjectRoute(project, [completed, current], { ...base, nodes: [{ ...base.nodes[0], predecessorRefs: ["current"] }] }, current.updatedAt, () => "new"), /前置节点|循环/);
});

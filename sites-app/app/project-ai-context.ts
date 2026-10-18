import { routeParents } from "./project-route";
import type { Milestone, ProjectDetail, ProjectLog } from "./project-types";

const MAX_INPUT_BYTES = 64 * 1024;

export function buildBranchAiContext(
  detail: ProjectDetail,
  milestone: Milestone | null,
  extra: Record<string, unknown> = {},
) {
  const milestoneIds = milestone ? collectMilestoneAndAncestors(detail.milestones, milestone.id) : new Set<string>();
  const branchTasks = detail.tasks.filter((task) => {
    if (task.status === "cancelled") return false;
    return milestone ? Boolean(task.milestoneId && milestoneIds.has(task.milestoneId)) : task.milestoneId === null;
  });
  const taskIds = new Set(branchTasks.map((task) => task.id));
  const targetIds = new Set([...milestoneIds, ...taskIds]);
  const accumulations = detail.accumulations.filter((item) => item.milestoneId === null || milestoneIds.has(item.milestoneId));
  const context = baseProjectContext(detail, {
    branch: milestone ? {
      selectedMilestoneId: milestone.id,
      milestones: detail.milestones
        .filter((item) => milestoneIds.has(item.id))
        .map(compactMilestone),
    } : null,
    tasks: branchTasks.map(compactTask),
    accumulations: accumulations.map(compactAccumulation),
    recentRecords: detail.logs.filter((log) => branchLogMatches(log, taskIds, targetIds)).slice(0, 20).map(compactLog),
    ...extra,
  });
  return fitContext(context);
}

export function buildRouteAiContext(detail: ProjectDetail, extra: Record<string, unknown> = {}) {
  const context = baseProjectContext(detail, {
    milestones: detail.milestones.map(compactMilestone),
    tasks: detail.tasks.filter((task) => task.status !== "cancelled").map(compactTask),
    accumulations: detail.accumulations.map(compactAccumulation),
    recentRecords: detail.logs.slice(0, 20).map(compactLog),
    ...extra,
  });
  return fitContext(context);
}

export function collectMilestoneAndAncestors(milestones: Milestone[], milestoneId: string) {
  const parents = routeParents(milestones);
  const selected = new Set<string>();
  const visit = (id: string) => {
    if (selected.has(id)) return;
    selected.add(id);
    for (const parentId of parents.get(id) ?? []) visit(parentId);
  };
  visit(milestoneId);
  return selected;
}

function baseProjectContext(detail: ProjectDetail, fields: Record<string, unknown>) {
  return {
    project: {
      id: detail.project.id,
      title: detail.project.title,
      outcome: detail.project.outcome,
      motivation: detail.project.motivation,
      planningMode: detail.project.planningMode,
      status: detail.project.status,
      targetDate: detail.project.targetDate,
      reviewDate: detail.project.reviewDate,
      category: detail.project.category,
    },
    ...fields,
  } as Record<string, unknown> & { recentRecords?: unknown[] };
}

function fitContext<T extends Record<string, unknown> & { recentRecords?: unknown[] }>(context: T): T {
  while (encodedSize(context) > MAX_INPUT_BYTES && context.recentRecords?.length) context.recentRecords.pop();
  if (encodedSize(context) > MAX_INPUT_BYTES) {
    throw new Error("项目目标和“已积累”内容已经超过 AI 单次读取上限，请先精简较长的积累条目；系统没有静默省略这些事实。");
  }
  return context;
}

function encodedSize(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function compactMilestone(item: Milestone) {
  return {
    id: item.id,
    predecessorIds: item.predecessorIds ?? [],
    title: item.title,
    definitionOfDone: item.definitionOfDone,
    status: item.status,
    dueDate: item.dueDate,
  };
}

function compactTask(item: ProjectDetail["tasks"][number]) {
  return {
    id: item.id,
    milestoneId: item.milestoneId,
    title: item.title,
    currentFocus: item.currentFocus,
    definitionOfDone: item.definitionOfDone,
    details: item.details,
    status: item.status,
    dueDate: item.dueDate,
    completedAt: item.completedAt,
  };
}

function compactAccumulation(item: ProjectDetail["accumulations"][number]) {
  return {
    id: item.id,
    milestoneId: item.milestoneId,
    title: item.title,
    content: item.content,
    reference: item.reference,
    updatedAt: item.updatedAt,
  };
}

function compactLog(log: ProjectLog) {
  return { id: log.id, taskId: log.taskId, kind: log.kind, createdAt: log.createdAt, body: log.body.slice(0, 6000) };
}

function branchLogMatches(log: ProjectLog, taskIds: Set<string>, targetIds: Set<string>) {
  if (log.taskId) return taskIds.has(log.taskId);
  const continuation = decodeContinuationTarget(log.body);
  return continuation ? targetIds.has(continuation) : false;
}

function decodeContinuationTarget(body: string) {
  if (!body.startsWith("接续点｜")) return null;
  const [, targetId = ""] = body.split("｜");
  return targetId || null;
}

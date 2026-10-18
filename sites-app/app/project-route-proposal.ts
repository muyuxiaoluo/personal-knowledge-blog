import type { ProjectRouteProposal } from "./ai-api-types";
import { validateRoute } from "./project-route";
import type { Milestone, Project } from "./project-types";

export type PreparedProjectRoute = {
  milestones: Milestone[];
  supersededIds: string[];
  newIdsByRef: Map<string, string>;
};

export function prepareProjectRoute(
  project: Project,
  currentMilestones: Milestone[],
  proposal: ProjectRouteProposal,
  now: string,
  createId: (ref: string, index: number) => string,
): PreparedProjectRoute {
  if (project.planningMode !== "adaptive") throw new Error("只有滚动推进项目可以采用 AI 主线草案。");
  if (!proposal.nodes.length) throw new Error("AI 主线草案至少需要保留一个未完成节点。");

  const unfinished = currentMilestones.filter((item) => item.status === "current" || item.status === "planned");
  const unfinishedIds = new Set(unfinished.map((item) => item.id));
  const completed = currentMilestones.filter((item) => item.status === "completed");
  const completedIds = new Set(completed.map((item) => item.id));
  const refs = new Set<string>();
  const seenExisting = new Set<string>();

  for (const node of proposal.nodes) {
    if (!node.ref.trim() || refs.has(node.ref)) throw new Error("AI 主线草案包含空白或重复的节点引用。");
    refs.add(node.ref);
    if (node.existingMilestoneId) {
      if (!unfinishedIds.has(node.existingMilestoneId) || seenExisting.has(node.existingMilestoneId)) {
        throw new Error("AI 主线草案试图修改已完成、其他项目或重复的节点。");
      }
      if (node.action === "create") throw new Error("已有节点不能标记为新建。");
      seenExisting.add(node.existingMilestoneId);
    } else if (node.action !== "create") {
      throw new Error("新节点必须明确标记为新建。");
    }
    if (node.action !== "supersede" && (!node.title.trim() || !node.definitionOfDone.trim())) {
      throw new Error("每个保留的主线节点都需要名称和完成标准。");
    }
    if (node.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(node.dueDate)) throw new Error("AI 主线草案包含无效日期。");
  }
  if (seenExisting.size !== unfinishedIds.size) throw new Error("AI 主线草案必须明确保留、调整或替代每个未完成节点。");

  const newIdsByRef = new Map<string, string>();
  proposal.nodes.forEach((node, index) => {
    if (!node.existingMilestoneId) newIdsByRef.set(node.ref, createId(node.ref, index));
  });
  const activeNodes = proposal.nodes.filter((node) => node.action !== "supersede");
  if (project.status === "active" && !activeNodes.some((node) => node.status === "current")) {
    throw new Error("活跃的滚动项目至少需要一个当前检查点。");
  }
  const activeRefs = new Set(activeNodes.map((node) => node.ref));
  const refToId = new Map(activeNodes.map((node) => [node.ref, node.existingMilestoneId || newIdsByRef.get(node.ref)!]));
  const existingById = new Map(unfinished.map((item) => [item.id, item]));
  const proposedMilestones = activeNodes.map((node, index): Milestone => {
    const previous = node.existingMilestoneId ? existingById.get(node.existingMilestoneId) : undefined;
    const predecessorIds = node.predecessorRefs.map((ref) => {
      if (activeRefs.has(ref)) return refToId.get(ref)!;
      if (completedIds.has(ref)) return ref;
      throw new Error("主线草案引用了未保留、已被替代或其他项目的前置节点。");
    });
    return {
      id: node.existingMilestoneId || newIdsByRef.get(node.ref)!,
      projectId: project.id,
      title: node.title.trim(),
      definitionOfDone: node.definitionOfDone.trim(),
      status: node.status,
      dueDate: node.dueDate.trim(),
      predecessorIds,
      sortOrder: (completed.length + index + 1) * 10,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };
  });
  validateRoute([...completed, ...proposedMilestones]);
  return {
    milestones: proposedMilestones,
    supersededIds: proposal.nodes.filter((node) => node.action === "supersede").map((node) => node.existingMilestoneId!),
    newIdsByRef,
  };
}

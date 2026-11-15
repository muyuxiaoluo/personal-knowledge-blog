import type { ProjectStatus, ProjectSummary } from "./project-types";

export function projectProgress(project: Pick<ProjectSummary, "status" | "nextTask">) {
  if (project.status === "paused") return "已暂停";
  if (project.status === "completed") return "已完成";
  if (project.nextTask?.status === "waiting") return "等待反馈";
  return project.nextTask ? "有行动可继续" : "路径待明确";
}

export type ProjectStatusCounts = Record<ProjectStatus, number>;

export function rootProjectStatusCounts(projects: ProjectSummary[]): ProjectStatusCounts {
  const counts: ProjectStatusCounts = { active: 0, paused: 0, completed: 0 };
  for (const project of projects) {
    if (!project.parentProjectId) counts[project.status] += 1;
  }
  return counts;
}

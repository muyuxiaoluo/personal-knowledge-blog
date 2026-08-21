import type { ProjectStatus, ProjectSummary } from "./project-types";

export type ProjectStatusCounts = Record<ProjectStatus, number>;

export function rootProjectStatusCounts(projects: ProjectSummary[]): ProjectStatusCounts {
  const counts: ProjectStatusCounts = { active: 0, waiting: 0, paused: 0, completed: 0 };
  for (const project of projects) {
    if (!project.parentProjectId) counts[project.status] += 1;
  }
  return counts;
}

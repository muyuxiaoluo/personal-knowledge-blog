import { isSourceArticle } from "./article-helpers";
import type { AsabaJob } from "./companion-types";
import { calendarDayDifference, localDate } from "./date-helpers";
import type { Project, ProjectDetail } from "./project-types";
import type { Article } from "./types";

export type AttentionSource = Pick<Article, "id" | "title" | "tags" | "projectId" | "project" | "collection" | "type" | "branch"> & {
  deleted: boolean;
  version: number;
};
export type AttentionJob = Pick<AsabaJob, "id" | "title" | "agent" | "state" | "updatedAt" | "attempt"> & { activeAtStartup?: boolean };

type AttentionEntry = {
  key: string;
  title: string;
} & (
  | { kind: "deadline" | "review"; date: string; taskId?: string }
  | { kind: "job"; state: "review" | "completed" | "failed" | "interrupted" }
  | { kind: "source"; sourceId: string; basis: "title" | "tag" }
);
export type AttentionGroup = {
  id: string;
  title: string;
  entries: Array<AttentionEntry & { unread: boolean }>;
} & ({ kind: "project" | "source"; projectId: string } | { kind: "job"; jobId: string });

export type AttentionState = {
  startDay: string;
  baselineDates?: string[];
  baselineSources: string[];
  baselineJobs: string[];
  disposition: Record<string, "read" | "dismissed">;
  showDot: boolean;
};
export type AttentionView = { groups: AttentionGroup[]; showDot: boolean };
export type AttentionCommand =
  | { kind: "get" }
  | { kind: "read" | "dismiss"; keys: string[] }
  | { kind: "showDot"; enabled: boolean }
  | { kind: "link"; key: string; sourceId: string; projectId: string };

export function attentionJobKey(job: AttentionJob) {
  return JSON.stringify(["job", job.id, job.attempt ?? 0]);
}

function jobResult(job: AttentionJob) {
  const { state } = job;
  if (state === "review" || state === "failed" || state === "interrupted" || (state === "completed" && job.agent === "codex")) return state;
  return null;
}

export function initialAttentionState(startedAt: Date, sources: AttentionSource[], jobs: AttentionJob[], projects: ProjectDetail[] = []): AttentionState {
  const startDay = localDate(startedAt);
  return {
    startDay,
    baselineDates: projects.flatMap(detail => projectAttentionDates(detail).filter(entry => entry.date < startDay).map(entry => entry.key)),
    baselineSources: sources.map(source => source.id),
    baselineJobs: jobs.filter(job => !job.activeAtStartup && (jobResult(job) || job.state === "reviewed") && Date.parse(job.updatedAt) < startedAt.getTime()).map(attentionJobKey),
    disposition: {},
    showDot: true,
  };
}

export function attentionProjectActive(project: Pick<Project, "status" | "isDraft">) {
  return project.status === "active" && !project.isDraft;
}

export function attentionSourceEligible(source: AttentionSource) {
  return !source.deleted && !source.projectId && !source.project && source.branch !== "已归档" && isSourceArticle(source);
}

const normalized = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}]/gu, "");
export const attentionSourceKey = (sourceId: string, projectId: string) => JSON.stringify(["source", sourceId, projectId]);

function projectAttentionDates({ project, milestones, tasks }: ProjectDetail) {
  const entries: Array<Extract<AttentionEntry, { date: string }>> = [];
  const add = (kind: "deadline" | "review", entity: "project" | "milestone" | "task", id: string, date: string, title: string) => {
    if (date?.length === 10 && calendarDayDifference(date) !== null) {
      entries.push({ key: JSON.stringify([kind, project.id, entity, id, date]), kind, date, title, ...(entity === "task" ? { taskId: id } : {}) });
    }
  };
  if (project.targetDateKind === "deadline") add("deadline", "project", project.id, project.targetDate, "项目目标");
  for (const milestone of milestones) {
    if (milestone.dueDateKind === "deadline" && (milestone.status === "current" || milestone.status === "planned")) {
      add("deadline", "milestone", milestone.id, milestone.dueDate, milestone.title);
    }
  }
  for (const task of tasks) {
    if (task.dueDateKind === "deadline" && task.status !== "done" && task.status !== "cancelled") {
      add("deadline", "task", task.id, task.dueDate, task.title);
    }
  }
  add("review", "project", project.id, project.reviewDate, "项目回顾");
  return entries;
}

export function attentionView(state: AttentionState, today: string, projects: ProjectDetail[], jobs: AttentionJob[], sources: AttentionSource[]): AttentionView {
  const groups: AttentionGroup[] = [];
  const activeProjects = projects.filter(detail => attentionProjectActive(detail.project));
  const visible = (entries: AttentionEntry[]) => entries
    .filter(entry => state.disposition[entry.key] !== "dismissed")
    .map(entry => ({ ...entry, unread: state.disposition[entry.key] !== "read" }));
  const baselineDates = state.baselineDates && new Set(state.baselineDates);
  for (const detail of activeProjects) {
    const { project } = detail;
    const remaining = visible(projectAttentionDates(detail).filter(entry =>
      entry.date <= today && (baselineDates ? !baselineDates.has(entry.key) : entry.date >= state.startDay)));
    if (remaining.length) groups.push({ id: project.id, kind: "project", projectId: project.id, title: project.title, entries: remaining });
  }
  const baselineJobs = new Set(state.baselineJobs);
  for (const job of jobs) {
    const result = jobResult(job);
    const key = attentionJobKey(job);
    if (!result || baselineJobs.has(key)) continue;
    const entries = visible([{ key, kind: "job", state: result, title: job.title }]);
    if (entries.length) groups.push({ id: job.id, kind: "job", jobId: job.id, title: job.title, entries });
  }
  const baselineSources = new Set(state.baselineSources);
  const names = activeProjects.map(({ project }) => ({ project, name: normalized(project.title) }))
    .filter(({ name }) => Array.from(name).length >= 4);
  for (const source of sources) {
    if (baselineSources.has(source.id) || !attentionSourceEligible(source)) continue;
    const title = normalized(source.title);
    const tags = source.tags.map(normalized);
    const matches = names.filter(({ name }) => title.includes(name) || tags.includes(name));
    if (matches.length !== 1) continue;
    const [{ project, name }] = matches;
    const entries = visible([{ key: attentionSourceKey(source.id, project.id), kind: "source", title: source.title, sourceId: source.id, basis: title.includes(name) ? "title" : "tag" }]);
    if (entries.length) groups.push({ id: source.id, kind: "source", projectId: project.id, title: project.title, entries });
  }
  const priority = { deadline: 0, review: 1, job: 2, source: 3 };
  const entryDate = (entry: AttentionEntry) => "date" in entry ? entry.date : "";
  for (const group of groups) group.entries.sort((a, b) => priority[a.kind] - priority[b.kind] || entryDate(a).localeCompare(entryDate(b)));
  groups.sort((a, b) => priority[a.entries[0].kind] - priority[b.entries[0].kind] || entryDate(a.entries[0]).localeCompare(entryDate(b.entries[0])));
  return { groups, showDot: state.showDot };
}

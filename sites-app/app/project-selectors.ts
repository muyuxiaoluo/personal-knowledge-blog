import { calendarDayDifference } from "./date-helpers";
import { decodeTaskProgressLog } from "./home-workflow";
import type { CalendarEvent } from "./dashboard-types";
import type { AsabaJob } from "./companion-types";
import type { ProjectDetail, ProjectStatus, ProjectSummary } from "./project-types";

export const suggestedProjectTags = ["个人发展", "兴趣", "学业", "个人作品"];

export function normalizeProjectTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []))];
}

export function filterProjects(projects: ProjectSummary[], status: ProjectStatus, query: string, tags: string[]) {
  const needle = query.trim().toLocaleLowerCase("zh-CN");
  return projects.filter((project) => project.status === status && tags.every((tag) => project.tags?.includes(tag)) &&
    [project.title, project.outcome, project.motivation, project.currentMilestone?.title, project.nextTask?.title, ...(project.tags ?? [])]
      .join(" ").toLocaleLowerCase("zh-CN").includes(needle));
}

export function projectWorkStatus({ project, tasks, milestones, logs, accumulations }: ProjectDetail) {
  const currentIds = new Set(milestones.filter((node) => node.status === "current").map((node) => node.id));
  const next = project.status === "active" ? tasks.find((task) => task.status === "next" && (!task.milestoneId || currentIds.has(task.milestoneId)))
    ?? tasks.find((task) => task.status === "later" && (!task.milestoneId || currentIds.has(task.milestoneId))) : undefined;
  const waiting = tasks.filter((task) => task.status === "waiting");
  const recent = [
    ...logs.flatMap((log) => {
      if (log.kind === "continuation") {
        const entry = decodeContinuationLog(log.body);
        return entry?.text ? [{ at: log.createdAt, text: entry.text, source: "接续记录" }] : [];
      }
      if (log.kind !== "task_progress" && log.kind !== "task_completed") return [];
      const text = log.kind === "task_progress" ? decodeTaskProgressLog(log.body)?.result : log.body;
      return text ? [{ at: log.createdAt, text, source: log.kind === "task_progress" ? "行动进展" : "行动完成" }] : [];
    }),
    ...tasks.filter((task) => task.status === "done" && task.completedAt).map((task) => ({ at: task.completedAt!, text: task.title, source: "行动完成" })),
    ...accumulations.filter((item) => item.isOutcome).map((item) => ({ at: item.createdAt, text: item.title || item.content, source: "已确认成果" })),
  ].sort((a, b) => b.at.localeCompare(a.at))[0];
  return { next, waiting, recent };
}

export function decodeContinuationLog(body: string) {
  if (!body.startsWith("接续点｜")) return null;
  const [, targetId = "", label = "当前推进", ...content] = body.split("｜");
  return { targetId, label, text: content.join("｜").trim() };
}

export function projectJobGroups(jobs: AsabaJob[]) {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const previousIds = new Set(jobs.flatMap((job) => job.previousJobId ? [job.previousJobId] : []));
  const groups = new Map<string, AsabaJob[]>();
  for (const job of jobs) {
    let root = job;
    const visited = new Set([root.id]);
    while (root.previousJobId && !visited.has(root.previousJobId)) {
      const previous = byId.get(root.previousJobId);
      if (!previous) break;
      root = previous;
      visited.add(root.id);
    }
    const key = root.agent === "codex" && root.noteId ? "note:" + root.noteId : "job:" + (root.previousJobId ?? root.id);
    const attempts = groups.get(key) ?? [];
    attempts.push(job);
    groups.set(key, attempts);
  }
  return Array.from(groups.values(), (attempts) => {
    attempts.sort((a, b) => Number(previousIds.has(a.id)) - Number(previousIds.has(b.id)) || b.updatedAt.localeCompare(a.updatedAt));
    return { latest: attempts[0], previous: attempts.slice(1) };
  }).sort((a, b) => b.latest.updatedAt.localeCompare(a.latest.updatedAt));
}

export function projectCalendarEvents(details: ProjectDetail[]): CalendarEvent[] {
  return details.filter(({ project }) => !project.isDraft).flatMap(({ project, milestones }) => milestones.flatMap((node) => {
    if (node.status === "superseded" || !node.dueDateKind || node.dueDate.length !== 10 || calendarDayDifference(node.dueDate) === null) return [];
    return [{
      id: `milestone:${node.id}`, title: node.title, date: node.dueDate, recurrence: "once" as const,
      lunarMonth: null, lunarDay: null, lunarLeapMonth: false, important: node.status !== "completed" && project.status === "active",
      color: node.dueDateKind === "deadline" ? "#a24855" : "#527a91", reminderDays: 0, notes: "",
      createdAt: node.createdAt, updatedAt: node.updatedAt,
      milestone: { projectId: project.id, projectTitle: project.title, dateKind: node.dueDateKind },
    }];
  }));
}

export function projectProgress(project: Pick<ProjectSummary, "status" | "nextTask">) {
  if (project.status === "paused") return "已暂停";
  if (project.status === "completed") return "已完成";
  if (project.nextTask?.status === "waiting") return "等待反馈";
  return project.nextTask ? "有行动可继续" : "路径待明确";
}

export type ProjectStatusCounts = Record<ProjectStatus, number>;

export function projectStatusCounts(projects: ProjectSummary[]): ProjectStatusCounts {
  const counts: ProjectStatusCounts = { active: 0, paused: 0, completed: 0 };
  for (const project of projects) {
    counts[project.status] += 1;
  }
  return counts;
}

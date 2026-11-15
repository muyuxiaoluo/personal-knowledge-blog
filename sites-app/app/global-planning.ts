import type { GlobalPlanningProposal } from "./ai-api-types";
import { calendarDayDifference, localDate } from "./date-helpers";
import type { ProjectDetail, ProjectTask } from "./project-types";
import type { DailySituation, FocusSession, TaskPlan, WeeklyFocus } from "./work-types";

export type PlanningTask = ProjectTask & { plan: TaskPlan | null };
export type PlanningInput = {
  today: string;
  projects: ProjectDetail[];
  tasks: PlanningTask[];
  focusSessions: FocusSession[];
  weeklyFocus: WeeklyFocus | null;
  dailySituations: DailySituation[];
};
export type ProjectAttention = { projectId: string; title: string; reasons: string[]; lastProgressDate: string; idleDays: number; rank: number };
export type PlanningClarification = { question: string; answer: string };
export type PlanningFollowUp = { previousProposal: GlobalPlanningProposal; clarifications: PlanningClarification[] };
export type GlobalPlanningRecord = {
  id: string;
  createdAt: string;
  request: string;
  clarifications: PlanningClarification[];
  proposal: GlobalPlanningProposal;
  titles: string[];
  model: string;
};
export type GlobalPlanningHistoryEntry = Pick<GlobalPlanningRecord, "id" | "createdAt" | "request" | "model"> & { summary: string };

export function projectAttention(input: PlanningInput): ProjectAttention[] {
  return input.projects.filter(({ project }) => project.status === "active" && !project.isDraft).map((detail) => {
    const { project } = detail;
    const dates = [project.createdAt,
      ...detail.logs.filter((log) => ["task_progress", "task_completed", "continuation"].includes(log.kind)).map((log) => log.createdAt),
      ...detail.tasks.map((task) => task.completedAt || ""),
      ...detail.accumulations.map((item) => item.updatedAt),
      ...input.focusSessions.filter((session) => session.projectId === project.id || detail.tasks.some((task) => task.id === session.taskId)).map((session) => session.endedAt || session.startedAt),
    ].filter((value) => value && !Number.isNaN(new Date(value).getTime())).map((value) => localDate(new Date(value))).filter((date) => date <= input.today).sort();
    const lastProgressDate = dates.at(-1) || input.today;
    const idleDays = calendarDayDifference(input.today, lastProgressDate) ?? 0;
    const open = detail.tasks.filter((task) => !["done", "cancelled"].includes(task.status));
    const reasons: string[] = [];
    let rank = 0;
    const overdue = [project.targetDateKind === "deadline" ? project.targetDate : "", ...detail.milestones.filter((m) => m.dueDateKind === "deadline" && !["completed", "superseded"].includes(m.status)).map((m) => m.dueDate), ...open.filter((task) => task.dueDateKind === "deadline").map((task) => task.dueDate)].some((date) => date && date <= input.today);
    if (overdue) { reasons.push("有项目、阶段或行动已到截止日期"); rank += 100; }
    if (project.reviewDate && project.reviewDate <= input.today) { reasons.push("到了项目回顾日期"); rank += 60; }
    if (idleDays >= 7) { reasons.push(`已 ${idleDays} 天没有记录到推进`); rank += 40; }
    if (!open.some((task) => task.status === "next" || task.status === "later")) { reasons.push(open.some((task) => task.status === "waiting") ? "行动都在等待中，可检查是否需要跟进" : "还没有可继续的行动"); rank += 30; }
    for (const milestone of detail.milestones.filter((m) => m.status === "current")) {
      if (!open.some((task) => task.milestoneId === milestone.id)) { reasons.push(`「${milestone.title}」缺少下一步`); rank += 20; }
    }
    return { projectId: project.id, title: project.title, reasons, lastProgressDate, idleDays, rank };
  }).filter((item) => item.reasons.length).sort((a, b) => b.rank - a.rank || b.idleDays - a.idleDays || a.projectId.localeCompare(b.projectId));
}

export function buildGlobalPlanningContext(input: PlanningInput, request: string, followUp?: PlanningFollowUp) {
  const relevantProjects = input.projects.filter(({ project }) => project.status !== "completed" && !project.isDraft);
  const projectIds = new Set(relevantProjects.map(({ project }) => project.id));
  const tasks = input.tasks.filter((task) => (!task.projectId || projectIds.has(task.projectId)) && task.status !== "cancelled");
  const recent = <T>(items: T[], date: (item: T) => string, limit: number) => [...items].sort((a, b) => date(b).localeCompare(date(a))).slice(0, limit);
  const context = {
    today: input.today,
    request: request.trim(),
    ...(followUp ? {
      previousProposal: followUp.previousProposal,
      clarifications: followUp.clarifications.map(({ question, answer }) => ({ question, answer: answer.trim() })).filter(({ answer }) => answer),
    } : {}),
    weeklyFocus: input.weeklyFocus,
    attention: projectAttention(input),
    coverage: "包含所有未归档且非草稿项目、所有未完成行动；每项目最多提供最近10项完成行动、12条记录、8条积累，文本字段最多1200字。没有记录不等于没有做过，推测遗漏时需说明依据与待确认之处。",
    projects: relevantProjects.map(({ project, milestones, tasks: projectTasks, logs, accumulations }) => ({
      id: project.id, title: clip(project.title), outcome: clip(project.outcome), motivation: clip(project.motivation),
      status: project.status, projectType: project.projectType, parentProjectId: project.parentProjectId, planningMode: project.planningMode,
      targetDate: project.targetDate, targetDateKind: project.targetDateKind ?? null, reviewDate: project.reviewDate,
      milestones: milestones.filter((m) => m.status !== "superseded").map((m) => ({ id: m.id, title: clip(m.title), status: m.status, definitionOfDone: clip(m.definitionOfDone), dueDate: m.dueDate, dueDateKind: m.dueDateKind ?? null, predecessorIds: m.predecessorIds || [] })),
      completedTaskCount: projectTasks.filter((task) => task.status === "done").length,
      recentRecords: recent(logs, (log) => log.createdAt, 12).map((log) => ({ taskId: log.taskId, kind: log.kind, body: clip(log.body), createdAt: log.createdAt })),
      accumulationCount: accumulations.length,
      accumulations: recent(accumulations, (item) => item.updatedAt, 8).map((item) => ({ title: clip(item.title), content: clip(item.content), milestoneId: item.milestoneId })),
    })),
    tasks: [...tasks.filter((task) => task.status !== "done"), ...relevantProjects.flatMap(({ project }) => recent(tasks.filter((task) => task.projectId === project.id && task.status === "done"), (task) => task.completedAt || "", 10))].map((task) => ({
      id: task.id, projectId: task.projectId, milestoneId: task.milestoneId, title: clip(task.title), status: task.status,
      currentFocus: clip(task.currentFocus), definitionOfDone: clip(task.definitionOfDone), details: clip(task.details), waitingFor: clip(task.waitingFor),
      steps: task.steps.map((step) => ({ title: clip(step.title), completed: step.completed })), dueDate: task.dueDate, dueDateKind: task.dueDateKind ?? null, completedAt: task.completedAt,
      plannedDate: task.plan?.plannedDate || "", estimateMinutes: task.plan?.estimateMinutes || 0,
    })),
    recentSituations: recent(input.dailySituations, (day) => day.date, 7).map((day) => ({ date: day.date, reason: clip(day.reason), actualWork: clip(day.actualWork), tasks: day.tasks.map((task) => ({ ...task, progress: clip(task.progress) })) })),
    recentFocus: recent(input.focusSessions.filter((session) => !session.projectId || projectIds.has(session.projectId)), (session) => session.startedAt, 30).map(({ taskId, projectId, startedAt, durationSeconds }) => ({ taskId, projectId, startedAt, durationSeconds })),
  };
  if (new TextEncoder().encode(JSON.stringify(context)).length > 64 * 1024) throw new Error("项目与行动内容超过本次 AI 读取上限，请先收起已不推进的项目或精简较长说明后重试。");
  return context;
}

export function validateGlobalPlanningProposal(proposal: GlobalPlanningProposal, input: PlanningInput) {
  if (!proposal || typeof proposal.summary !== "string" || !Array.isArray(proposal.suggestions) || proposal.suggestions.length > 3 || !Array.isArray(proposal.questions) || proposal.questions.length > 2 || proposal.questions.some((q) => typeof q !== "string")) throw new Error("AI 规划结果不完整，请重试。");
  const seen = new Set<string>();
  for (const item of proposal.suggestions) {
    const project = item.projectId === null ? null : input.projects.find(({ project }) => project.id === item.projectId)?.project;
    const task = item.taskId === null ? null : input.tasks.find((task) => task.id === item.taskId);
    if ((item.projectId !== null && (!project || project.status !== "active" || project.isDraft)) || (item.taskId !== null && (!task || ["done", "cancelled", "waiting"].includes(task.status) || task.projectId !== item.projectId)) || (!project && !task) || !item.reason?.trim() || !item.nextStep?.trim()) throw new Error("AI 建议引用了无效项目或行动，请重新生成。");
    const key = item.taskId || `project:${item.projectId}`;
    if (seen.has(key)) throw new Error("AI 返回了重复建议，请重新生成。");
    seen.add(key);
  }
  return proposal;
}

function clip(value: string) { return value.length > 1200 ? `${value.slice(0, 1200)}…（已截短）` : value; }

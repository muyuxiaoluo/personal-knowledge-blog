import type { TaskPlan } from "./work-types";
import { actionDeadline } from "./project-dates";
import { calendarDayDifference } from "./date-helpers";
import type { MilestoneStatus, ProjectStatus, ProjectTaskStatus } from "./project-types";

export function isConfirmedTodayPlan(plan: TaskPlan | null | undefined, today: string): boolean {
  return Boolean(plan && plan.source !== "auto" && plan.plannedDate === today);
}

export function isContinuablePlan(plan: TaskPlan | null | undefined, today: string): boolean {
  return Boolean(plan && plan.source !== "auto" && (!plan.plannedDate || plan.plannedDate < today));
}

type ActionCenterItem = Parameters<typeof actionDeadline>[0] & {
  id: string;
  status: ProjectTaskStatus;
  projectStatus: ProjectStatus | null;
  projectDraft?: boolean;
  milestoneStatus?: MilestoneStatus;
  dueDate: string;
  estimatedDays?: number;
  plan: TaskPlan | null;
  sortOrder: number;
  weekBlocked?: boolean;
};

export function actionCenterLanes<T extends ActionCenterItem>(tasks: T[], today: string, activeId?: string) {
  const pending = tasks.filter((task) => task.status !== "done" && task.status !== "cancelled");
  const available = pending.filter((task) => !task.projectDraft && (task.projectStatus === null || task.projectStatus === "active") && task.status !== "waiting");
  const schedule = available.filter((task) => isConfirmedTodayPlan(task.plan, today));
  const ready = available.filter((task) => !isConfirmedTodayPlan(task.plan, today) &&
    (task.id === activeId || (!task.weekBlocked && (task.milestoneStatus === undefined || task.milestoneStatus === "current") &&
      (!task.plan || task.plan.source === "auto" || task.plan.plannedDate <= today))));
  const closeToDate = (task: T) => {
    const deadline = actionDeadline(task);
    const days = deadline ? calendarDayDifference(deadline, today) : null;
    const expectedStart = task.dueDateKind && autoScheduleStartDate(task.dueDate, task.estimatedDays ?? 0);
    return (days !== null && days <= 2) || Boolean(expectedStart && expectedStart <= today);
  };
  ready.sort((left, right) => Number(right.id === activeId) - Number(left.id === activeId) ||
    Number(closeToDate(right)) - Number(closeToDate(left)) || Number(right.status === "next") - Number(left.status === "next") || left.sortOrder - right.sortOrder);
  schedule.sort((left, right) => (left.plan?.sortOrder ?? 0) - (right.plan?.sortOrder ?? 0));
  return { schedule, ready, pending, dateSuggestions: new Set(ready.filter(closeToDate).map((task) => task.id)) };
}

export function isValidDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function autoScheduleStartDate(dueDate: string, estimatedDays: number): string | null {
  if (!isValidDay(dueDate) || !Number.isInteger(estimatedDays) || estimatedDays < 1 || estimatedDays > 365) return null;
  const date = new Date(`${dueDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - estimatedDays);
  return date.toISOString().slice(0, 10);
}

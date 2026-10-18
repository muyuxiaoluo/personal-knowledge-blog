import type { TaskPlan } from "./work-types";

export function isContinuablePlan(plan: TaskPlan | null | undefined, today: string): boolean {
  return Boolean(plan && (!plan.plannedDate || plan.plannedDate < today));
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

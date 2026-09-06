import type { TaskPlan } from "./work-types";

export function isContinuablePlan(plan: TaskPlan | null | undefined, today: string): boolean {
  return Boolean(plan && (!plan.plannedDate || plan.plannedDate < today));
}

export function isValidDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

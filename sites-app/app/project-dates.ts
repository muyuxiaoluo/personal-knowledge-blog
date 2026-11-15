import { classifyDeadlineUrgency } from "./date-helpers";
import type { ProjectDateKind } from "./project-types";

export function scheduledProjectDate(date: string, kind?: ProjectDateKind | null) {
  return kind === "target" || kind === "deadline" ? date : "";
}

export function projectDateKind(date: string, kind?: ProjectDateKind | null) {
  return date && (kind === "target" || kind === "deadline") ? kind : null;
}

export function actionDeadline(task: {
  dueDate: string; dueDateKind?: ProjectDateKind | null;
  stageDueDate: string; stageDueDateKind?: ProjectDateKind | null;
  projectTargetDate?: string; projectTargetDateKind?: ProjectDateKind | null;
}) {
  return [task.dueDateKind === "deadline" ? task.dueDate : "", task.stageDueDateKind === "deadline" ? task.stageDueDate : "", task.projectTargetDateKind === "deadline" ? task.projectTargetDate : ""]
    .filter(Boolean).sort()[0] ?? "";
}

export function projectDateLabel(date: string, kind?: ProjectDateKind | null, today?: string) {
  if (!date) return { text: "", tone: "" };
  const urgency = kind === "deadline" ? classifyDeadlineUrgency(date, today) : null;
  const label = kind === "deadline" ? "真实截止" : kind === "target" ? "计划目标" : "日期待确认";
  return { text: urgency?.label ?? `${label} · ${date}`, tone: urgency?.tone ?? "" };
}

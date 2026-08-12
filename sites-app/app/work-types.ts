export type TaskPriority = "high" | "normal" | "low";

export type TaskPlan = {
  taskId: string;
  plannedDate: string;
  priority: TaskPriority;
  estimateMinutes: number;
  sortOrder: number;
  updatedAt: string;
};

export type FocusSession = {
  id: string;
  taskId: string | null;
  projectId: string | null;
  label: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
};

export type FocusSessionInput = {
  taskId?: string | null;
  projectId?: string | null;
  label: string;
};

export type WeeklyFocus = {
  weekStart: string;
  primaryOutcome: string;
  secondaryOutcome: string;
  updatedAt: string;
};

export type DailyCloseout = {
  date: string;
  result: string;
  lesson: string;
  tomorrow: string;
  updatedAt: string;
};

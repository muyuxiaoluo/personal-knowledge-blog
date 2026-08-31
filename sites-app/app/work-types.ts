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

export type FocusSessionStopInput = {
  id: string;
  endedAt?: string;
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

export type WeeklyReviewOutcomeStatus = "achieved" | "partial" | "missed" | "redirected";

export type WeeklyReviewFactor = "" | "scope" | "external" | "priority" | "capacity" | "approach" | "other";

export type WeeklyReviewStrategy = "continue" | "narrow" | "switch" | "pause";

export type WeeklyReview = {
  weekStart: string;
  outcomeStatus: WeeklyReviewOutcomeStatus;
  factor: WeeklyReviewFactor;
  factorNote: string;
  nextStrategy: WeeklyReviewStrategy;
  adjustment: string;
  updatedAt: string;
};

export type DailyCloseout = {
  date: string;
  result: string;
  lesson: string;
  tomorrow: string;
  updatedAt: string;
};

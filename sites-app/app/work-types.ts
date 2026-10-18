export type TaskPriority = "high" | "normal" | "low";

export type TaskPlanHistory = {
  id: string;
  taskId: string;
  plannedDate: string;
  source: "manual" | "auto";
  taskTitle: string;
  currentFocus: string;
  createdAt: string;
};

export type SituationTask = {
  taskId: string;
  title: string;
  outcome: "not_started" | "partial";
  progress: string;
};

export type DailySituation = {
  date: string;
  reason: string;
  actualWork: string;
  tasks: SituationTask[];
  updatedAt: string;
};

export type SituationPlanChange = {
  taskId: string;
  expectedPlan: TaskPlan;
  // Empty date leaves the action available to continue without a daily commitment.
  plannedDate: string;
};

export type TaskPlan = {
  taskId: string;
  plannedDate: string;
  source?: "manual" | "auto";
  skipAutoDate?: string;
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

export type FocusSessionUpdateInput = {
  id: string;
  startedAt: string;
  endedAt: string;
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

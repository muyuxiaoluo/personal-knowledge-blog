import type {
  FocusSession,
  FocusSessionInput,
  FocusSessionStopInput,
  DailyCloseout,
  TaskPlan,
  WeeklyFocus,
  WeeklyReview,
  TaskPlanHistory,
  DailySituation,
  SituationPlanChange,
} from "../work-types";

export interface WorkRepository {
  listPlanHistory(date?: string): Promise<TaskPlanHistory[]>;
  listDailySituations(): Promise<DailySituation[]>;
  saveDailySituation(situation: DailySituation, changes?: SituationPlanChange[]): Promise<void>;
  listPlans(): Promise<TaskPlan[]>;
  savePlan(plan: TaskPlan): Promise<TaskPlan>;
  removePlan(taskId: string): Promise<void>;
  listSessions(from?: string, limit?: number, before?: string): Promise<FocusSession[]>;
  getActiveSession(): Promise<FocusSession | null>;
  startSession(input: FocusSessionInput): Promise<FocusSession>;
  stopSession(input: string | FocusSessionStopInput): Promise<FocusSession>;
  getWeeklyFocus(weekStart: string): Promise<WeeklyFocus | null>;
  saveWeeklyFocus(focus: WeeklyFocus): Promise<WeeklyFocus>;
  getWeeklyReview(weekStart: string): Promise<WeeklyReview | null>;
  saveWeeklyReview(review: WeeklyReview): Promise<WeeklyReview>;
  listDailyCloseouts(from?: string): Promise<DailyCloseout[]>;
  saveDailyCloseout(closeout: DailyCloseout): Promise<DailyCloseout>;
}

export class WorkRepositoryError extends Error {
  constructor(
    message: string,
    readonly code: "read_failed" | "save_failed" | "invalid_data",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "WorkRepositoryError";
  }
}

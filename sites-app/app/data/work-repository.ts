import type {
  FocusSession,
  FocusSessionInput,
  DailyCloseout,
  TaskPlan,
  WeeklyFocus,
} from "../work-types";

export interface WorkRepository {
  listPlans(): Promise<TaskPlan[]>;
  savePlan(plan: TaskPlan): Promise<TaskPlan>;
  removePlan(taskId: string): Promise<void>;
  listSessions(from?: string): Promise<FocusSession[]>;
  getActiveSession(): Promise<FocusSession | null>;
  startSession(input: FocusSessionInput): Promise<FocusSession>;
  stopSession(id: string): Promise<FocusSession>;
  getWeeklyFocus(weekStart: string): Promise<WeeklyFocus | null>;
  saveWeeklyFocus(focus: WeeklyFocus): Promise<WeeklyFocus>;
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

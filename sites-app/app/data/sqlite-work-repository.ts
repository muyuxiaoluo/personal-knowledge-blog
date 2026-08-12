import type {
  DailyCloseout,
  FocusSession,
  FocusSessionInput,
  TaskPlan,
  TaskPriority,
  WeeklyFocus,
} from "../work-types";
import { WorkRepositoryError, type WorkRepository } from "./work-repository";
import type { SqliteDatabase } from "./sqlite-article-repository";

type TaskPlanRow = {
  task_id: string;
  planned_date: string;
  priority: TaskPriority;
  estimate_minutes: number;
  sort_order: number;
  updated_at: string;
};

type FocusSessionRow = {
  id: string;
  task_id: string | null;
  project_id: string | null;
  label: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
};

type WeeklyFocusRow = {
  week_start: string;
  primary_outcome: string;
  secondary_outcome: string;
  updated_at: string;
};

type DailyCloseoutRow = {
  closeout_date: string;
  result: string;
  lesson: string;
  tomorrow: string;
  updated_at: string;
};

const migrations = [
  `CREATE TABLE IF NOT EXISTS task_plans (
    task_id TEXT PRIMARY KEY NOT NULL,
    planned_date TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'normal',
    estimate_minutes INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS focus_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT,
    project_id TEXT,
    label TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_seconds INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS weekly_focus (
    week_start TEXT PRIMARY KEY NOT NULL,
    primary_outcome TEXT NOT NULL DEFAULT '',
    secondary_outcome TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS daily_closeouts (
    closeout_date TEXT PRIMARY KEY NOT NULL,
    result TEXT NOT NULL DEFAULT '',
    lesson TEXT NOT NULL DEFAULT '',
    tomorrow TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_task_plans_date_order ON task_plans(planned_date, sort_order)",
  "CREATE INDEX IF NOT EXISTS idx_focus_sessions_started ON focus_sessions(started_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_daily_closeouts_date ON daily_closeouts(closeout_date DESC)",
] as const;

export class SqliteWorkRepository implements WorkRepository {
  private initialization: Promise<void> | null = null;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async initialize() {
    this.initialization ??= (async () => {
      for (const statement of migrations) await this.database.execute(statement);
      await this.database.execute("PRAGMA optimize");
    })().catch((error) => {
      this.initialization = null;
      throw error;
    });
    await this.initialization;
  }

  async listPlans(): Promise<TaskPlan[]> {
    try {
      await this.initialize();
      const rows = await this.database.select<TaskPlanRow>(
        "SELECT * FROM task_plans ORDER BY planned_date ASC, sort_order ASC, updated_at DESC",
      );
      return rows.map(rowToPlan);
    } catch (error) {
      throw new WorkRepositoryError("读取任务安排失败", "read_failed", error);
    }
  }

  async savePlan(plan: TaskPlan): Promise<TaskPlan> {
    if (!plan.taskId.trim()) {
      throw new WorkRepositoryError("任务不能为空", "invalid_data");
    }
    try {
      await this.initialize();
      const saved = {
        ...plan,
        estimateMinutes: Math.max(0, Math.round(plan.estimateMinutes || 0)),
        updatedAt: this.clock().toISOString(),
      };
      await this.database.execute(
        `INSERT INTO task_plans(task_id, planned_date, priority, estimate_minutes, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           planned_date = excluded.planned_date,
           priority = excluded.priority,
           estimate_minutes = excluded.estimate_minutes,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`,
        [saved.taskId, saved.plannedDate, saved.priority, saved.estimateMinutes, saved.sortOrder, saved.updatedAt],
      );
      return saved;
    } catch (error) {
      if (error instanceof WorkRepositoryError) throw error;
      throw new WorkRepositoryError("保存任务安排失败", "save_failed", error);
    }
  }

  async removePlan(taskId: string): Promise<void> {
    if (!taskId.trim()) return;
    try {
      await this.initialize();
      await this.database.execute("DELETE FROM task_plans WHERE task_id = ?", [taskId]);
    } catch (error) {
      throw new WorkRepositoryError("移除任务安排失败", "save_failed", error);
    }
  }

  async listSessions(from = ""): Promise<FocusSession[]> {
    try {
      await this.initialize();
      const rows = from
        ? await this.database.select<FocusSessionRow>(
            "SELECT * FROM focus_sessions WHERE started_at >= ? ORDER BY started_at DESC",
            [from],
          )
        : await this.database.select<FocusSessionRow>(
            "SELECT * FROM focus_sessions ORDER BY started_at DESC LIMIT 400",
          );
      return rows.map(rowToSession);
    } catch (error) {
      throw new WorkRepositoryError("读取专注记录失败", "read_failed", error);
    }
  }

  async getActiveSession(): Promise<FocusSession | null> {
    try {
      await this.initialize();
      const rows = await this.database.select<FocusSessionRow>(
        "SELECT * FROM focus_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
      );
      return rows[0] ? rowToSession(rows[0]) : null;
    } catch (error) {
      throw new WorkRepositoryError("读取当前专注失败", "read_failed", error);
    }
  }

  async startSession(input: FocusSessionInput): Promise<FocusSession> {
    const label = input.label.trim();
    if (!label) throw new WorkRepositoryError("请先写下这次要专注的事情", "invalid_data");
    try {
      await this.initialize();
      const active = await this.getActiveSession();
      if (active) throw new WorkRepositoryError("已经有一项专注正在进行", "invalid_data");
      const startedAt = this.clock().toISOString();
      const session: FocusSession = {
        id: `focus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        taskId: input.taskId || null,
        projectId: input.projectId || null,
        label,
        startedAt,
        endedAt: null,
        durationSeconds: 0,
      };
      await this.database.execute(
        `INSERT INTO focus_sessions(id, task_id, project_id, label, started_at, ended_at, duration_seconds)
         VALUES (?, ?, ?, ?, ?, NULL, 0)`,
        [session.id, session.taskId, session.projectId, session.label, session.startedAt],
      );
      return session;
    } catch (error) {
      if (error instanceof WorkRepositoryError) throw error;
      throw new WorkRepositoryError("开始专注失败", "save_failed", error);
    }
  }

  async stopSession(id: string): Promise<FocusSession> {
    try {
      await this.initialize();
      const rows = await this.database.select<FocusSessionRow>(
        "SELECT * FROM focus_sessions WHERE id = ? LIMIT 1",
        [id],
      );
      if (!rows[0]) throw new WorkRepositoryError("没有找到这次专注", "invalid_data");
      const current = rowToSession(rows[0]);
      if (current.endedAt) return current;
      const endedAt = this.clock().toISOString();
      const durationSeconds = Math.max(
        1,
        Math.round((new Date(endedAt).getTime() - new Date(current.startedAt).getTime()) / 1000),
      );
      await this.database.execute(
        "UPDATE focus_sessions SET ended_at = ?, duration_seconds = ? WHERE id = ?",
        [endedAt, durationSeconds, id],
      );
      return { ...current, endedAt, durationSeconds };
    } catch (error) {
      if (error instanceof WorkRepositoryError) throw error;
      throw new WorkRepositoryError("结束专注失败", "save_failed", error);
    }
  }

  async getWeeklyFocus(weekStart: string): Promise<WeeklyFocus | null> {
    try {
      await this.initialize();
      const rows = await this.database.select<WeeklyFocusRow>(
        "SELECT * FROM weekly_focus WHERE week_start = ? LIMIT 1",
        [weekStart],
      );
      return rows[0] ? rowToWeeklyFocus(rows[0]) : null;
    } catch (error) {
      throw new WorkRepositoryError("读取本周聚焦失败", "read_failed", error);
    }
  }

  async saveWeeklyFocus(focus: WeeklyFocus): Promise<WeeklyFocus> {
    if (!focus.weekStart.trim()) {
      throw new WorkRepositoryError("本周开始日期不能为空", "invalid_data");
    }
    try {
      await this.initialize();
      const saved = {
        ...focus,
        primaryOutcome: focus.primaryOutcome.trim(),
        secondaryOutcome: focus.secondaryOutcome.trim(),
        updatedAt: this.clock().toISOString(),
      };
      await this.database.execute(
        `INSERT INTO weekly_focus(week_start, primary_outcome, secondary_outcome, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(week_start) DO UPDATE SET
           primary_outcome = excluded.primary_outcome,
           secondary_outcome = excluded.secondary_outcome,
           updated_at = excluded.updated_at`,
        [saved.weekStart, saved.primaryOutcome, saved.secondaryOutcome, saved.updatedAt],
      );
      return saved;
    } catch (error) {
      if (error instanceof WorkRepositoryError) throw error;
      throw new WorkRepositoryError("保存本周聚焦失败", "save_failed", error);
    }
  }

  async listDailyCloseouts(from = ""): Promise<DailyCloseout[]> {
    try {
      await this.initialize();
      const rows = from
        ? await this.database.select<DailyCloseoutRow>(
            "SELECT * FROM daily_closeouts WHERE closeout_date >= ? ORDER BY closeout_date DESC",
            [from],
          )
        : await this.database.select<DailyCloseoutRow>(
            "SELECT * FROM daily_closeouts ORDER BY closeout_date DESC LIMIT 90",
          );
      return rows.map(rowToDailyCloseout);
    } catch (error) {
      throw new WorkRepositoryError("读取每日收尾失败", "read_failed", error);
    }
  }

  async saveDailyCloseout(closeout: DailyCloseout): Promise<DailyCloseout> {
    if (!closeout.date.trim()) {
      throw new WorkRepositoryError("收尾日期不能为空", "invalid_data");
    }
    try {
      await this.initialize();
      const saved = {
        ...closeout,
        result: closeout.result.trim(),
        lesson: closeout.lesson.trim(),
        tomorrow: closeout.tomorrow.trim(),
        updatedAt: this.clock().toISOString(),
      };
      await this.database.execute(
        `INSERT INTO daily_closeouts(closeout_date, result, lesson, tomorrow, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(closeout_date) DO UPDATE SET
           result = excluded.result,
           lesson = excluded.lesson,
           tomorrow = excluded.tomorrow,
           updated_at = excluded.updated_at`,
        [saved.date, saved.result, saved.lesson, saved.tomorrow, saved.updatedAt],
      );
      return saved;
    } catch (error) {
      if (error instanceof WorkRepositoryError) throw error;
      throw new WorkRepositoryError("保存每日收尾失败", "save_failed", error);
    }
  }
}

function rowToPlan(row: TaskPlanRow): TaskPlan {
  return {
    taskId: row.task_id,
    plannedDate: row.planned_date,
    priority: row.priority,
    estimateMinutes: Number(row.estimate_minutes || 0),
    sortOrder: Number(row.sort_order || 0),
    updatedAt: row.updated_at,
  };
}

function rowToSession(row: FocusSessionRow): FocusSession {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    label: row.label,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: Number(row.duration_seconds || 0),
  };
}

function rowToWeeklyFocus(row: WeeklyFocusRow): WeeklyFocus {
  return {
    weekStart: row.week_start,
    primaryOutcome: row.primary_outcome,
    secondaryOutcome: row.secondary_outcome,
    updatedAt: row.updated_at,
  };
}

function rowToDailyCloseout(row: DailyCloseoutRow): DailyCloseout {
  return {
    date: row.closeout_date,
    result: row.result,
    lesson: row.lesson,
    tomorrow: row.tomorrow,
    updatedAt: row.updated_at,
  };
}

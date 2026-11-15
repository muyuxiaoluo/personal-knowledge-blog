import type {
  DailyCloseout,
  FocusSession,
  FocusSessionInput,
  FocusSessionStopInput,
  FocusSessionUpdateInput,
  TaskPlan,
  TaskPriority,
  WeeklyFocus,
  WeeklyReview,
  TaskPlanHistory,
  DailySituation,
  SituationPlanChange,
} from "../work-types";
import { WorkRepositoryError, type WorkRepository } from "./work-repository";
import type { SqliteDatabase } from "./sqlite-article-repository";
import { executeSqliteTransaction, type SqliteStatement } from "./sqlite-article-repository";
import { activityDateKey } from "../activity-helpers";
import { isValidDay } from "../action-planning";

type TaskPlanRow = {
  task_id: string;
  planned_date: string;
  source: "manual" | "auto";
  skip_auto_date: string;
  priority: TaskPriority;
  estimate_minutes: number;
  sort_order: number;
  updated_at: string;
};

export type FocusSessionRow = {
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

type WeeklyReviewRow = {
  week_start: string;
  outcome_status: WeeklyReview["outcomeStatus"];
  factor: WeeklyReview["factor"];
  factor_note: string;
  next_strategy: WeeklyReview["nextStrategy"];
  adjustment: string;
  updated_at: string;
};

const migrations = [
  `CREATE TABLE IF NOT EXISTS task_plan_history (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL,
    planned_date TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    task_title TEXT NOT NULL DEFAULT '',
    current_focus TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS daily_situations (
    situation_date TEXT PRIMARY KEY NOT NULL,
    reason TEXT NOT NULL,
    actual_work TEXT NOT NULL DEFAULT '',
    tasks_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS task_plans (
    task_id TEXT PRIMARY KEY NOT NULL,
    planned_date TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    skip_auto_date TEXT NOT NULL DEFAULT '',
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
  `CREATE TABLE IF NOT EXISTS weekly_reviews (
    week_start TEXT PRIMARY KEY NOT NULL,
    outcome_status TEXT NOT NULL,
    factor TEXT NOT NULL DEFAULT '',
    factor_note TEXT NOT NULL DEFAULT '',
    next_strategy TEXT NOT NULL,
    adjustment TEXT NOT NULL DEFAULT '',
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
      const planColumns = await this.database.select<{ name: string }>("PRAGMA table_info(task_plans)");
      if (!planColumns.some((column) => column.name === "source")) {
        await this.database.execute("ALTER TABLE task_plans ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
      }
      if (!planColumns.some((column) => column.name === "skip_auto_date")) {
        await this.database.execute("ALTER TABLE task_plans ADD COLUMN skip_auto_date TEXT NOT NULL DEFAULT ''");
      }
      const historyColumns = await this.database.select<{ name: string }>("PRAGMA table_info(task_plan_history)");
      if (!historyColumns.some((column) => column.name === "source")) {
        await this.database.execute("ALTER TABLE task_plan_history ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
      }
      const hasTasks = (await this.database.select<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'project_tasks'")).length > 0;
      const snapshot = (alias: string) => hasTasks
        ? `COALESCE((SELECT title FROM project_tasks WHERE id = ${alias}.task_id), ''), COALESCE((SELECT current_focus FROM project_tasks WHERE id = ${alias}.task_id), '')`
        : "'', ''";
      const remember = (alias: string) => `INSERT OR IGNORE INTO task_plan_history(id, task_id, planned_date, source, task_title, current_focus, created_at)
        SELECT ${alias}.planned_date || ':' || ${alias}.task_id, ${alias}.task_id, ${alias}.planned_date, ${alias}.source, ${snapshot(alias)}, ${alias}.updated_at
        WHERE ${alias}.planned_date != '' AND NOT EXISTS (
          SELECT 1 FROM task_plan_history WHERE id = ${alias}.planned_date || ':' || ${alias}.task_id
        );`;
      // Keep the first snapshot for each date, including plans later moved or removed.
      const triggerStatements: SqliteStatement[] = [];
      for (const [event, alias] of [["INSERT", "NEW"], ["UPDATE", "OLD"], ["DELETE", "OLD"]]) {
        triggerStatements.push(
          { sql: `DROP TRIGGER IF EXISTS remember_plan_${event.toLowerCase()}` },
          { sql: `CREATE TRIGGER remember_plan_${event.toLowerCase()} AFTER ${event} ON task_plans BEGIN ${remember(alias)} ${event === "UPDATE" ? remember("NEW") : ""} END` },
        );
      }
      await executeSqliteTransaction(this.database, triggerStatements);
      await this.database.execute(`INSERT OR IGNORE INTO task_plan_history(id, task_id, planned_date, source, task_title, current_focus, created_at)
        SELECT task_plans.planned_date || ':' || task_plans.task_id, task_plans.task_id, task_plans.planned_date, task_plans.source, ${snapshot("task_plans")}, task_plans.updated_at FROM task_plans WHERE planned_date != ''`);
      await this.database.execute("PRAGMA optimize");
    })().catch((error) => {
      this.initialization = null;
      throw error;
    });
    await this.initialization;
  }

  async ready() {
    await this.initialize();
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

  async listPlanHistory(date = ""): Promise<TaskPlanHistory[]> {
    await this.initialize();
    const rows = await this.database.select<{ id: string; task_id: string; planned_date: string; source: "manual" | "auto"; task_title: string; current_focus: string; created_at: string }>(
      "SELECT * FROM task_plan_history WHERE (? = '' OR planned_date = ?) ORDER BY planned_date DESC, created_at", [date, date],
    );
    return rows.map((row) => ({ id: row.id, taskId: row.task_id, plannedDate: row.planned_date, source: row.source === "auto" ? "auto" : "manual", taskTitle: row.task_title, currentFocus: row.current_focus, createdAt: row.created_at }));
  }

  async listDailySituations(): Promise<DailySituation[]> {
    await this.initialize();
    const rows = await this.database.select<{ situation_date: string; reason: string; actual_work: string; tasks_json: string; updated_at: string }>("SELECT * FROM daily_situations ORDER BY situation_date DESC");
    return rows.map((row) => ({ date: row.situation_date, reason: row.reason, actualWork: row.actual_work, tasks: JSON.parse(row.tasks_json), updatedAt: row.updated_at }));
  }

  async saveDailySituation(situation: DailySituation, changes: SituationPlanChange[] = []): Promise<void> {
    const today = activityDateKey(this.clock().toISOString());
    if (!isValidDay(situation.date) || situation.date > today || !situation.reason.trim()) {
      throw new WorkRepositoryError("请选择已发生的日期，并写下当天情况", "invalid_data");
    }
    const tasks = situation.tasks.map((task) => ({ ...task, title: task.title.trim(), progress: task.outcome === "partial" ? task.progress.trim() : "" }));
    if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length || tasks.some((task) => !task.taskId || !task.title || !["not_started", "partial"].includes(task.outcome) || (task.outcome === "partial" && !task.progress))) {
      throw new WorkRepositoryError("请补全受影响行动的实际进展", "invalid_data");
    }
    await this.initialize();
    const now = this.clock().toISOString();
    const statements: SqliteStatement[] = [{
      sql: `INSERT INTO daily_situations(situation_date, reason, actual_work, tasks_json, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(situation_date) DO UPDATE SET reason = excluded.reason, actual_work = excluded.actual_work, tasks_json = excluded.tasks_json, updated_at = excluded.updated_at`,
      bindValues: [situation.date, situation.reason.trim(), situation.actualWork.trim(), JSON.stringify(tasks), now],
    }];
    for (const change of changes) {
      if (!tasks.some((task) => task.taskId === change.taskId) || change.expectedPlan.taskId !== change.taskId || !change.expectedPlan.plannedDate || change.expectedPlan.plannedDate > situation.date) continue;
      if (change.plannedDate && (change.plannedDate < today || !isValidDay(change.plannedDate))) {
        throw new WorkRepositoryError("后续安排请选择今天或未来的日期", "invalid_data");
      }
      // Compare the current plan at write time so a retrospective note cannot roll back newer work.
      statements.push({
        sql: `UPDATE task_plans SET planned_date = ?, source = 'manual', skip_auto_date = CASE WHEN ? = '' THEN ? ELSE '' END, updated_at = ? WHERE task_id = ? AND planned_date = ? AND updated_at = ?
          AND EXISTS (SELECT 1 FROM project_tasks WHERE id = ? AND status NOT IN ('done', 'cancelled', 'waiting') AND deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM focus_sessions WHERE task_id = ? AND ended_at IS NULL)`,
        bindValues: [change.plannedDate, change.plannedDate, today, now, change.taskId, change.expectedPlan.plannedDate, change.expectedPlan.updatedAt, change.taskId, change.taskId],
      });
    }
    await executeSqliteTransaction(this.database, statements);
  }

  async savePlan(plan: TaskPlan): Promise<TaskPlan> {
    if (!plan.taskId.trim()) {
      throw new WorkRepositoryError("任务不能为空", "invalid_data");
    }
    try {
      await this.initialize();
      const saved = {
        ...plan,
        source: plan.source === "auto" ? "auto" as const : "manual" as const,
        skipAutoDate: plan.skipAutoDate || "",
        estimateMinutes: Math.max(0, Math.round(plan.estimateMinutes || 0)),
        updatedAt: this.clock().toISOString(),
      };
      await this.database.execute(
        `INSERT INTO task_plans(task_id, planned_date, source, skip_auto_date, priority, estimate_minutes, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           planned_date = excluded.planned_date,
           source = excluded.source,
           skip_auto_date = excluded.skip_auto_date,
           priority = excluded.priority,
           estimate_minutes = excluded.estimate_minutes,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`,
        [saved.taskId, saved.plannedDate, saved.source, saved.skipAutoDate, saved.priority, saved.estimateMinutes, saved.sortOrder, saved.updatedAt],
      );
      return saved;
    } catch (error) {
      if (error instanceof WorkRepositoryError) throw error;
      throw new WorkRepositoryError("保存任务安排失败", "save_failed", error);
    }
  }

  async autoScheduleDueTasks(today: string): Promise<number> {
    if (!isValidDay(today)) throw new WorkRepositoryError("日期无效", "invalid_data");
    await this.initialize();
    const now = this.clock().toISOString();
    const removed = await this.database.execute(
      `DELETE FROM task_plans
       WHERE source = 'auto' AND planned_date != ''
         AND NOT EXISTS (
           SELECT 1 FROM project_tasks AS task
           LEFT JOIN projects AS project ON project.id = task.project_id
           WHERE task.id = task_plans.task_id AND task.deleted_at IS NULL AND task.status = 'next'
             AND (task.project_id IS NULL OR project.status = 'active')
             AND task.due_date_kind IN ('deadline', 'target') AND task.auto_schedule_paused = 0 AND task.estimated_days BETWEEN 1 AND 365
             AND date(task.due_date, '-' || task.estimated_days || ' days') <= ?
         )`,
      [today],
    );
    const result = await this.database.execute(
      `INSERT INTO task_plans(task_id, planned_date, source, skip_auto_date, priority, estimate_minutes, sort_order, updated_at)
       SELECT task.id, ?, 'auto', '', COALESCE(plan.priority, 'normal'), COALESCE(plan.estimate_minutes, 0),
              COALESCE(plan.sort_order, 99), ?
       FROM project_tasks AS task
       LEFT JOIN projects AS project ON project.id = task.project_id
       LEFT JOIN task_plans AS plan ON plan.task_id = task.id
       WHERE task.deleted_at IS NULL AND task.status = 'next'
         AND (task.project_id IS NULL OR project.status = 'active')
         AND task.due_date_kind IN ('deadline', 'target') AND task.auto_schedule_paused = 0 AND task.estimated_days BETWEEN 1 AND 365
         AND date(task.due_date, '-' || task.estimated_days || ' days') <= ?
         AND (plan.task_id IS NULL OR plan.planned_date = '' OR plan.planned_date < ?)
         AND COALESCE(plan.skip_auto_date, '') != ?
       ON CONFLICT(task_id) DO UPDATE SET planned_date = excluded.planned_date,
         source = 'auto', skip_auto_date = '', updated_at = excluded.updated_at
       WHERE task_plans.planned_date = '' OR task_plans.planned_date < ?`,
      [today, now, today, today, today, today],
    );
    return (removed.rowsAffected || 0) + (result.rowsAffected || 0);
  }

  async pauseAutoSchedule(taskId: string, today: string): Promise<void> {
    if (!isValidDay(today)) throw new WorkRepositoryError("日期无效", "invalid_data");
    await this.initialize();
    const now = this.clock().toISOString();
    await executeSqliteTransaction(this.database, [
      { sql: "UPDATE project_tasks SET auto_schedule_paused = 1, updated_at = ? WHERE id = ?", bindValues: [now, taskId] },
      { sql: "UPDATE task_plans SET planned_date = '', updated_at = ? WHERE task_id = ? AND planned_date = ?", bindValues: [now, taskId, today] },
    ]);
  }

  async resumeAutoSchedule(taskId: string): Promise<void> {
    await this.initialize();
    await this.database.execute("UPDATE project_tasks SET auto_schedule_paused = 0, updated_at = ? WHERE id = ?", [this.clock().toISOString(), taskId]);
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

  async listSessions(from = "", limit = 500, before = ""): Promise<FocusSession[]> {
    try {
      await this.initialize();
      const safeLimit = Number.isSafeInteger(limit) ? Math.min(2000, Math.max(1, limit)) : 500;
      const rows = from || before
        ? await this.database.select<FocusSessionRow>(
            `SELECT * FROM focus_sessions
             WHERE (? = '' OR started_at >= ?) AND (? = '' OR started_at < ?)
             ORDER BY started_at DESC LIMIT ?`,
            [from, from, before, before, safeLimit],
          )
        : await this.database.select<FocusSessionRow>(
            "SELECT * FROM focus_sessions ORDER BY started_at DESC LIMIT ?",
            [safeLimit],
          );
      return rows.map(rowToSession);
    } catch (error) {
      throw new WorkRepositoryError("读取专注记录失败", "read_failed", error);
    }
  }

  async updateSession(input: FocusSessionUpdateInput): Promise<FocusSession> {
    await this.initialize();
    const { updateFocusHistory } = await import("./sqlite-focus-history");
    return updateFocusHistory(this.database, input, this.clock(), rowToSession);
  }

  async deleteSession(id: string): Promise<void> {
    await this.initialize();
    const { deleteFocusHistory } = await import("./sqlite-focus-history");
    return deleteFocusHistory(this.database, id);
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
      const result = await this.database.execute(
        `INSERT INTO focus_sessions(id, task_id, project_id, label, started_at, ended_at, duration_seconds)
         SELECT ?, ?, ?, ?, ?, NULL, 0
         WHERE NOT EXISTS (SELECT 1 FROM focus_sessions WHERE ended_at IS NULL)`,
        [session.id, session.taskId, session.projectId, session.label, session.startedAt],
      );
      if (result.rowsAffected === 0) {
        throw new WorkRepositoryError("已经有一项专注正在进行", "invalid_data");
      }
      return session;
    } catch (error) {
      if (error instanceof WorkRepositoryError) throw error;
      throw new WorkRepositoryError("开始专注失败", "save_failed", error);
    }
  }

  async stopSession(input: string | FocusSessionStopInput): Promise<FocusSession> {
    const id = typeof input === "string" ? input : input.id;
    try {
      await this.initialize();
      const rows = await this.database.select<FocusSessionRow>(
        "SELECT * FROM focus_sessions WHERE id = ? LIMIT 1",
        [id],
      );
      if (!rows[0]) throw new WorkRepositoryError("没有找到这次专注", "invalid_data");
      const current = rowToSession(rows[0]);
      if (current.endedAt) return current;
      const requestedEnd = typeof input === "string" ? "" : input.endedAt?.trim() || "";
      const endedAt = requestedEnd || this.clock().toISOString();
      const endTime = new Date(endedAt).getTime();
      const startTime = new Date(current.startedAt).getTime();
      const nowTime = this.clock().getTime();
      if (!Number.isFinite(endTime) || endTime < startTime || endTime > nowTime + 60_000) {
        throw new WorkRepositoryError("结束时间不能早于开始时间或晚于当前时间", "invalid_data");
      }
      const durationSeconds = Math.max(
        1,
        Math.round((endTime - startTime) / 1000),
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

  async getWeeklyReview(weekStart: string): Promise<WeeklyReview | null> {
    try {
      await this.initialize();
      const rows = await this.database.select<WeeklyReviewRow>(
        "SELECT * FROM weekly_reviews WHERE week_start = ? LIMIT 1",
        [weekStart],
      );
      return rows[0] ? rowToWeeklyReview(rows[0]) : null;
    } catch (error) {
      throw new WorkRepositoryError("读取本周校准失败", "read_failed", error);
    }
  }

  async saveWeeklyReview(review: WeeklyReview): Promise<WeeklyReview> {
    if (!review.weekStart.trim()) {
      throw new WorkRepositoryError("本周开始日期不能为空", "invalid_data");
    }
    if (!review.outcomeStatus || !review.nextStrategy) {
      throw new WorkRepositoryError("请先选择本周结果和下周策略", "invalid_data");
    }
    try {
      await this.initialize();
      const saved = {
        ...review,
        factorNote: review.factorNote.trim(),
        adjustment: review.adjustment.trim(),
        updatedAt: this.clock().toISOString(),
      };
      await this.database.execute(
        `INSERT INTO weekly_reviews(week_start, outcome_status, factor, factor_note, next_strategy, adjustment, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(week_start) DO UPDATE SET
           outcome_status = excluded.outcome_status,
           factor = excluded.factor,
           factor_note = excluded.factor_note,
           next_strategy = excluded.next_strategy,
           adjustment = excluded.adjustment,
           updated_at = excluded.updated_at`,
        [saved.weekStart, saved.outcomeStatus, saved.factor, saved.factorNote, saved.nextStrategy, saved.adjustment, saved.updatedAt],
      );
      return saved;
    } catch (error) {
      if (error instanceof WorkRepositoryError) throw error;
      throw new WorkRepositoryError("保存本周校准失败", "save_failed", error);
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
    source: row.source === "auto" ? "auto" : "manual",
    skipAutoDate: row.skip_auto_date || "",
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

function rowToWeeklyReview(row: WeeklyReviewRow): WeeklyReview {
  return {
    weekStart: row.week_start,
    outcomeStatus: row.outcome_status,
    factor: row.factor,
    factorNote: row.factor_note,
    nextStrategy: row.next_strategy,
    adjustment: row.adjustment,
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

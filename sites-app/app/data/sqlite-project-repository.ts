import { routeParents, validateRoute } from "../project-route";
import { prepareProjectRoute } from "../project-route-proposal";
import type {
  Milestone,
  MilestoneStatus,
  Project,
  ProjectAccumulation,
  ProjectCategory,
  ProjectDetail,
  ProjectLog,
  ProjectLogKind,
  ProjectPlanningMode,
  ProjectProposal,
  ProjectSeed,
  ProjectStatus,
  ProjectSummary,
  ProjectTask,
  ProjectTaskStatus,
  ProjectType,
  ProposalStatus,
} from "../project-types";
import type { ProjectAdjustmentDraft, ProjectRouteDraft } from "../ai-api-types";
import { normalizeLifeDomain } from "../domain-taxonomy";
import {
  ProjectRepositoryError,
  type ProjectRepository,
} from "./project-repository";
import { executeSqliteTransaction, type SqliteDatabase, type SqliteStatement } from "./sqlite-article-repository";

const PROJECT_SEED_VERSION = "4";

type ProjectRow = {
  id: string;
  title: string;
  outcome: string;
  motivation: string;
  project_type: ProjectType;
  planning_mode: ProjectPlanningMode;
  parent_project_id: string | null;
  supports_milestone_id: string | null;
  status: ProjectStatus | "waiting";
  category: ProjectCategory;
  sort_order: number;
  is_draft: number;
  source_note: string;
  target_date: string;
  review_date: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type MilestoneRow = {
  predecessor_ids: string | null;
  id: string;
  project_id: string;
  title: string;
  definition_of_done: string;
  status: MilestoneStatus;
  due_date: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type ProjectTaskRow = {
  id: string;
  project_id: string | null;
  milestone_id: string | null;
  direction: ProjectCategory;
  title: string;
  action_type: ProjectTask["actionType"];
  definition_of_done: string;
  steps_json: string;
  current_focus: string;
  details: string;
  benefit: string;
  due_date: string;
  estimated_days: number;
  auto_schedule_paused: number;
  status: ProjectTaskStatus;
  waiting_for: string;
  resume_action: string;
  context: ProjectTask["context"];
  sort_order: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  deleted_at: string | null;
  deleted_plan_json: string;
};

type TaskPlanSnapshotRow = {
  task_id: string;
  planned_date: string;
  source?: "manual" | "auto";
  skip_auto_date?: string;
  priority: string;
  estimate_minutes: number;
  sort_order: number;
  updated_at: string;
};

type ProjectLogRow = {
  id: string;
  project_id: string | null;
  task_id: string | null;
  kind: ProjectLogKind;
  body: string;
  created_at: string;
};

type ProjectProposalRow = {
  id: string;
  project_id: string;
  title: string;
  problem: string;
  expected_value: string;
  cost: string;
  status: ProposalStatus;
  review_note: string;
  created_at: string;
  updated_at: string;
};

type ProjectAccumulationRow = {
  id: string;
  project_id: string;
  milestone_id: string | null;
  kind: string;
  title: string;
  completed_work: string;
  takeaway: string;
  reference: string;
  created_at: string;
  updated_at: string;
};

const migrations = [
  `CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    outcome TEXT NOT NULL,
    motivation TEXT NOT NULL,
    project_type TEXT NOT NULL DEFAULT 'main',
    planning_mode TEXT NOT NULL DEFAULT 'direct',
    parent_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    supports_milestone_id TEXT REFERENCES project_milestones(id) ON DELETE SET NULL,
    status TEXT NOT NULL,
    category TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_draft INTEGER NOT NULL DEFAULT 1,
    source_note TEXT NOT NULL DEFAULT '',
    target_date TEXT NOT NULL DEFAULT '',
    review_date TEXT NOT NULL DEFAULT '',
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS project_milestones (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    definition_of_done TEXT NOT NULL,
    status TEXT NOT NULL,
    due_date TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS project_tasks (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    milestone_id TEXT REFERENCES project_milestones(id) ON DELETE SET NULL,
    direction TEXT NOT NULL DEFAULT 'uncategorized',
    title TEXT NOT NULL,
    action_type TEXT NOT NULL DEFAULT 'organize',
    definition_of_done TEXT NOT NULL DEFAULT '',
    steps_json TEXT NOT NULL DEFAULT '[]',
    current_focus TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    benefit TEXT NOT NULL DEFAULT '',
    due_date TEXT NOT NULL DEFAULT '',
    estimated_days INTEGER NOT NULL DEFAULT 0,
    auto_schedule_paused INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    waiting_for TEXT NOT NULL DEFAULT '',
    resume_action TEXT NOT NULL DEFAULT '',
    context TEXT NOT NULL DEFAULT 'anywhere',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    deleted_at TEXT,
    deleted_plan_json TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS project_logs (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES project_tasks(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'general',
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS project_proposals (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    problem TEXT NOT NULL DEFAULT '',
    expected_value TEXT NOT NULL DEFAULT '',
    cost TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    review_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS project_accumulations (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    milestone_id TEXT REFERENCES project_milestones(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'other',
    title TEXT NOT NULL,
    completed_work TEXT NOT NULL DEFAULT '',
    takeaway TEXT NOT NULL DEFAULT '',
    reference TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_projects_status_order ON projects(status, sort_order, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_project_milestones_project_status ON project_milestones(project_id, status, sort_order)",
  "CREATE INDEX IF NOT EXISTS idx_project_tasks_project_status ON project_tasks(project_id, status, sort_order)",
  "CREATE INDEX IF NOT EXISTS idx_project_logs_project_created ON project_logs(project_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_project_proposals_project_status ON project_proposals(project_id, status, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_project_accumulations_project_updated ON project_accumulations(project_id, updated_at DESC)",
] as const;

export class SqliteProjectRepository implements ProjectRepository {
  private initialization: Promise<void> | null = null;
  private indexCache = new Map<string, Pick<ProjectDetail, "project" | "milestones" | "tasks">>();

  constructor(
    private readonly database: SqliteDatabase,
    private readonly options: {
      seedProjects?: ProjectSeed[];
      clock?: () => Date;
    } = {},
  ) {}

  private now() {
    return (this.options.clock ?? (() => new Date()))().toISOString();
  }

  private async initialize() {
    this.initialization ??= this.applyMigrationsAndSeed().catch((error) => {
      this.initialization = null;
      throw error;
    });
    await this.initialization;
  }

  async ready() {
    await this.initialize();
  }

  private async applyMigrationsAndSeed() {
    await this.database.execute("PRAGMA foreign_keys = ON");
    for (const statement of migrations) await this.database.execute(statement);
    const planningModeAdded = await this.ensureColumn("projects", "planning_mode", "TEXT NOT NULL DEFAULT 'direct'");
    await this.ensureColumn("projects", "target_date", "TEXT NOT NULL DEFAULT ''");
    await this.ensureColumn("projects", "review_date", "TEXT NOT NULL DEFAULT ''");
    await this.ensureColumn("projects", "completed_at", "TEXT");
    await this.ensureColumn("projects", "project_type", "TEXT NOT NULL DEFAULT 'main'");
    await this.ensureColumn("projects", "parent_project_id", "TEXT");
    await this.ensureColumn("projects", "supports_milestone_id", "TEXT");
    await this.ensureColumn("project_milestones", "due_date", "TEXT NOT NULL DEFAULT ''");
    await this.ensureColumn("project_milestones", "predecessor_ids", "TEXT");
    await this.ensureColumn("project_tasks", "action_type", "TEXT NOT NULL DEFAULT 'organize'");
    await this.ensureColumn("project_tasks", "definition_of_done", "TEXT NOT NULL DEFAULT ''");
    await this.ensureColumn("project_tasks", "steps_json", "TEXT NOT NULL DEFAULT '[]'");
    await this.ensureColumn("project_tasks", "current_focus", "TEXT NOT NULL DEFAULT ''");
    await this.ensureColumn("project_tasks", "details", "TEXT NOT NULL DEFAULT ''");
    await this.ensureColumn("project_tasks", "benefit", "TEXT NOT NULL DEFAULT ''");
    await this.ensureColumn("project_tasks", "due_date", "TEXT NOT NULL DEFAULT ''");
    await this.ensureColumn("project_tasks", "estimated_days", "INTEGER NOT NULL DEFAULT 0");
    await this.ensureColumn("project_tasks", "auto_schedule_paused", "INTEGER NOT NULL DEFAULT 0");
    await this.ensureColumn("project_tasks", "deleted_at", "TEXT");
    await this.ensureColumn("project_tasks", "deleted_plan_json", "TEXT NOT NULL DEFAULT ''");
    await this.ensureColumn("project_tasks", "direction", "TEXT NOT NULL DEFAULT 'uncategorized'");
    await this.ensureColumn("project_logs", "task_id", "TEXT");
    await this.ensureColumn("project_logs", "kind", "TEXT NOT NULL DEFAULT 'general'");
    await this.ensureNullableActionTables();
    if (planningModeAdded) {
      await this.database.execute(
        `UPDATE projects
         SET planning_mode = CASE
           WHEN EXISTS(SELECT 1 FROM project_milestones WHERE project_id = projects.id) THEN 'staged'
           ELSE 'direct'
         END`,
      );
    }
    await this.database.execute("UPDATE projects SET status = 'paused' WHERE status = 'waiting'");
    await this.database.execute(
      `UPDATE projects
       SET category = CASE category
         WHEN 'research' THEN 'learning'
         WHEN 'creative' THEN 'creative'
         WHEN 'product' THEN 'systems'
         WHEN 'maintenance' THEN 'systems'
         WHEN 'support' THEN 'systems'
         WHEN 'personal' THEN 'uncategorized'
         WHEN '科研' THEN 'learning'
         WHEN '创作' THEN 'creative'
         WHEN '产品' THEN 'systems'
         ELSE category
       END`,
    );
    await this.database.execute("CREATE INDEX IF NOT EXISTS idx_projects_parent_status ON projects(parent_project_id, status, sort_order)");
    await this.database.execute(
      "UPDATE projects SET project_type = 'main', parent_project_id = NULL, supports_milestone_id = NULL, updated_at = ? WHERE parent_project_id IS NOT NULL OR project_type != 'main'",
      [this.now()],
    );
    await this.database.execute("PRAGMA optimize");

    const seeded = await this.database.select<{ value: string }>(
      "SELECT value FROM app_meta WHERE key = 'project_seed_version' LIMIT 1",
    );
    if (seeded[0]?.value === PROJECT_SEED_VERSION) { await this.migrateRouteRelations(); return; }

    for (const seed of this.options.seedProjects ?? []) {
      await this.insertSeed(seed);
    }
    await this.database.execute(
      `INSERT INTO app_meta(key, value) VALUES('project_seed_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [PROJECT_SEED_VERSION],
    );
    await this.migrateRouteRelations();
  }

  private async migrateRouteRelations() {
    const rows = await this.database.select<MilestoneRow>("SELECT * FROM project_milestones ORDER BY sort_order ASC");
    const statements: SqliteStatement[] = [];
    for (const projectId of new Set(rows.map((row) => row.project_id))) {
      const nodes = rows.filter((row) => row.project_id === projectId).map(rowToMilestone);
      const parents = routeParents(nodes);
      for (const node of nodes) if (node.predecessorIds === undefined) statements.push({
        sql: "UPDATE project_milestones SET predecessor_ids = ? WHERE id = ?",
        bindValues: [JSON.stringify(parents.get(node.id) ?? []), node.id],
      });
    }
    if (statements.length) await executeSqliteTransaction(this.database, statements);
  }

  private async ensureColumn(table: string, column: string, definition: string) {
    const columns = await this.database.select<{ name: string }>(`PRAGMA table_info(${table})`);
    if (columns.some((item) => item.name === column)) return false;
    await this.database.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }

  private async ensureNullableActionTables() {
    const taskColumns = await this.database.select<{ name: string; notnull: number }>("PRAGMA table_info(project_tasks)");
    const logColumns = await this.database.select<{ name: string; notnull: number }>("PRAGMA table_info(project_logs)");
    const taskProject = taskColumns.find((column) => column.name === "project_id");
    const logProject = logColumns.find((column) => column.name === "project_id");
    const needsTaskRebuild = Boolean(taskProject?.notnull) || !taskColumns.some((column) => column.name === "direction");
    const needsLogRebuild = needsTaskRebuild
      || Boolean(logProject?.notnull)
      || !logColumns.some((column) => column.name === "task_id")
      || !logColumns.some((column) => column.name === "kind");
    if (!needsTaskRebuild && !needsLogRebuild) return;

    const direction = taskColumns.some((column) => column.name === "direction") ? "direction" : "'uncategorized'";
    const taskId = logColumns.some((column) => column.name === "task_id") ? "task_id" : "NULL";
    const logKind = logColumns.some((column) => column.name === "kind") ? "kind" : "'general'";
    await this.database.execute("PRAGMA foreign_keys = OFF");
    try {
      const statements: SqliteStatement[] = [];
      if (needsLogRebuild) statements.push({ sql: "ALTER TABLE project_logs RENAME TO project_logs_legacy" });
      if (needsTaskRebuild) statements.push({ sql: "ALTER TABLE project_tasks RENAME TO project_tasks_legacy" });
      if (needsTaskRebuild) statements.push(
        { sql: `CREATE TABLE project_tasks (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          milestone_id TEXT REFERENCES project_milestones(id) ON DELETE SET NULL,
          direction TEXT NOT NULL DEFAULT 'uncategorized',
          title TEXT NOT NULL,
          action_type TEXT NOT NULL DEFAULT 'organize',
          definition_of_done TEXT NOT NULL DEFAULT '',
          steps_json TEXT NOT NULL DEFAULT '[]',
          current_focus TEXT NOT NULL DEFAULT '',
          details TEXT NOT NULL DEFAULT '',
          benefit TEXT NOT NULL DEFAULT '',
          due_date TEXT NOT NULL DEFAULT '',
          estimated_days INTEGER NOT NULL DEFAULT 0,
          auto_schedule_paused INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          waiting_for TEXT NOT NULL DEFAULT '',
          resume_action TEXT NOT NULL DEFAULT '',
          context TEXT NOT NULL DEFAULT 'anywhere',
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          deleted_at TEXT,
          deleted_plan_json TEXT NOT NULL DEFAULT ''
        )` },
        { sql: `INSERT INTO project_tasks(
          id, project_id, milestone_id, direction, title, action_type, definition_of_done, steps_json,
          current_focus, details, benefit, due_date, estimated_days, auto_schedule_paused, status, waiting_for, resume_action, context,
          sort_order, created_at, updated_at, completed_at, deleted_at, deleted_plan_json
        ) SELECT id, project_id, milestone_id, ${direction}, title, action_type, definition_of_done, steps_json,
          current_focus, details, benefit, due_date, estimated_days, auto_schedule_paused, status, waiting_for, resume_action, context,
          sort_order, created_at, updated_at, completed_at, deleted_at, deleted_plan_json
          FROM project_tasks_legacy` },
      );
      if (needsLogRebuild) statements.push(
        { sql: `CREATE TABLE project_logs (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          task_id TEXT REFERENCES project_tasks(id) ON DELETE SET NULL,
          kind TEXT NOT NULL DEFAULT 'general',
          body TEXT NOT NULL,
          created_at TEXT NOT NULL
        )` },
        { sql: `INSERT INTO project_logs(id, project_id, task_id, kind, body, created_at)
          SELECT id, project_id, ${taskId}, ${logKind}, body, created_at FROM project_logs_legacy` },
      );
      if (needsLogRebuild) statements.push({ sql: "DROP TABLE project_logs_legacy" });
      if (needsTaskRebuild) statements.push({ sql: "DROP TABLE project_tasks_legacy" });
      statements.push(
        { sql: "CREATE INDEX IF NOT EXISTS idx_project_tasks_project_status ON project_tasks(project_id, status, sort_order)" },
        { sql: "CREATE INDEX IF NOT EXISTS idx_project_logs_project_created ON project_logs(project_id, created_at DESC)" },
        { sql: "CREATE INDEX IF NOT EXISTS idx_project_logs_task_created ON project_logs(task_id, created_at DESC)" },
      );
      await executeSqliteTransaction(this.database, statements);
    } finally {
      await this.database.execute("PRAGMA foreign_keys = ON");
    }
  }

  private async insertSeed(seed: ProjectSeed) {
    await this.writeProject(seed.project, true);
    for (const milestone of seed.milestones) await this.writeMilestone(milestone, true);
    for (const task of seed.tasks) await this.writeTask(task, true);
    for (const log of seed.logs) {
      await this.database.execute(
        `INSERT INTO project_logs(id, project_id, task_id, kind, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        [log.id, log.projectId, log.taskId, log.kind, log.body, log.createdAt],
      );
    }
    for (const proposal of seed.proposals ?? []) await this.writeProposal(proposal, true);
    for (const accumulation of seed.accumulations ?? []) await this.writeAccumulation(accumulation, true);
  }

  async list(): Promise<ProjectSummary[]> {
    try {
      await this.initialize();
      const [rows, milestoneRows, taskRows] = await Promise.all([
        this.database.select<ProjectRow>(
          `SELECT * FROM projects
           ORDER BY
             CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
             sort_order ASC,
             updated_at DESC`,
        ),
        this.database.select<MilestoneRow>(
          "SELECT * FROM project_milestones ORDER BY project_id, sort_order ASC, created_at ASC",
        ),
        this.database.select<ProjectTaskRow>(
          `SELECT * FROM project_tasks WHERE deleted_at IS NULL
           ORDER BY project_id, sort_order ASC, created_at ASC`,
        ),
      ]);
      const milestonesByProject = new Map<string, Milestone[]>();
      for (const row of milestoneRows) {
        const list = milestonesByProject.get(row.project_id) ?? [];
        list.push(rowToMilestone(row));
        milestonesByProject.set(row.project_id, list);
      }
      const tasksByProject = new Map<string, ProjectTask[]>();
      for (const row of taskRows) {
        if (!row.project_id) continue;
        const list = tasksByProject.get(row.project_id) ?? [];
        list.push(rowToTask(row));
        tasksByProject.set(row.project_id, list);
      }
      this.indexCache.clear();
      return rows.map((row) => {
        const project = rowToProject(row);
        const milestones = milestonesByProject.get(project.id) ?? [];
        const tasks = tasksByProject.get(project.id) ?? [];
        this.indexCache.set(project.id, { project, milestones, tasks });
        return {
          ...project,
          currentMilestone: milestones.find((item) => item.status === "current") ?? null,
          nextTask: tasks.find((item) => item.status === "next")
            ?? tasks.find((item) => item.status === "waiting")
            ?? null,
          openTaskCount: tasks.filter((item) => item.status !== "done" && item.status !== "cancelled").length,
          completedTaskCount: tasks.filter((item) => item.status === "done").length,
          milestoneCount: milestones.filter((item) => item.status !== "superseded").length,
          completedMilestoneCount: milestones.filter((item) => item.status === "completed").length,
        };
      });
    } catch (error) {
      throw new ProjectRepositoryError("读取本地项目失败", "read_failed", error);
    }
  }

  async get(id: string): Promise<ProjectDetail | null> {
    try {
      await this.initialize();
      if (!this.indexCache.has(id)) await this.list();
      const cached = this.indexCache.get(id);
      if (!cached) return null;
      const [logs, proposals, accumulations] = await Promise.all([
        this.listLogs(id),
        this.listProposals(id),
        this.listAccumulations(id),
      ]);
      return { ...cached, logs, proposals, accumulations };
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("读取项目详情失败", "read_failed", error);
    }
  }

  async listIndexDetails(): Promise<ProjectDetail[]> {
    await this.initialize();
    if (!this.indexCache.size) await this.list();
    return Array.from(this.indexCache.values(), (detail) => ({
      ...detail,
      logs: [],
      proposals: [],
      accumulations: [],
    }));
  }

  async listStandaloneTasks(): Promise<ProjectTask[]> {
    await this.initialize();
    const rows = await this.database.select<ProjectTaskRow>(
      `SELECT * FROM project_tasks
       WHERE project_id IS NULL AND deleted_at IS NULL
       ORDER BY sort_order ASC, created_at ASC`,
    );
    return rows.map(rowToTask);
  }

  async listTaskLogs(taskId: string): Promise<ProjectLog[]> {
    await this.initialize();
    const rows = await this.database.select<ProjectLogRow>(
      "SELECT * FROM project_logs WHERE task_id = ? ORDER BY created_at DESC LIMIT 40",
      [taskId],
    );
    return rows.map(rowToLog);
  }

  async saveProject(project: Project): Promise<Project> {
    this.indexCache.clear();
    if (!project.title.trim() || !project.outcome.trim()) {
      throw new ProjectRepositoryError("项目名称和期望结果不能为空", "invalid_data");
    }
    try {
      await this.initialize();
      const now = this.now();
      const relationship = await this.normalizeRelationship(project);
      const planningMode = normalizePlanningMode(project.planningMode);
      const saved: Project = {
        ...relationship,
        id: project.id || `project-${slugify(project.title)}-${Date.now()}`,
        title: project.title.trim(),
        outcome: project.outcome.trim(),
        motivation: project.motivation.trim(),
        planningMode,
        reviewDate: planningMode === "adaptive"
          ? resolveAdaptiveReviewDate(project.reviewDate, project.targetDate, "", now)
          : project.reviewDate,
        completedAt: relationship.status === "completed" ? relationship.completedAt || now : null,
        createdAt: project.createdAt || now,
        updatedAt: now,
      };
      await this.writeProject(saved, false);
      return saved;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("保存项目失败", "save_failed", error);
    }
  }

  async updateProjectStatus(id: string, status: ProjectStatus, logBody: string): Promise<void> {
    this.indexCache.clear();
    const text = logBody.trim();
    if (!text) throw new ProjectRepositoryError("项目状态记录不能为空", "invalid_data");
    try {
      await this.initialize();
      const rows = await this.database.select<ProjectRow>(
        "SELECT * FROM projects WHERE id = ? LIMIT 1",
        [id],
      );
      if (!rows[0]) throw new ProjectRepositoryError("没有找到这个项目", "invalid_data");
      const now = this.now();
      const statements: SqliteStatement[] = [
        {
          sql: "UPDATE projects SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?",
          bindValues: [status, status === "completed" ? now : null, now, id],
        },
        {
          sql: "INSERT INTO project_logs(id, project_id, body, created_at) VALUES (?, ?, ?, ?)",
          bindValues: [`${id}-log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, id, text, now],
        },
      ];
      await executeSqliteTransaction(this.database, statements);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("更新项目状态失败，原状态已保留", "save_failed", error);
    }
  }

  async saveWorkspace(project: Project, milestones: Milestone[], task: ProjectTask | null, branches: Project[] = []): Promise<Project> {
    this.indexCache.clear();
    try {
      await this.initialize();
      if (!project.title.trim() || !project.outcome.trim()) {
        throw new ProjectRepositoryError("项目名称和期望结果不能为空", "invalid_data");
      }
      const now = this.now();
      const relationship = await this.normalizeRelationship(project);
      const planningMode = normalizePlanningMode(project.planningMode);
      const savedProject: Project = {
        ...relationship,
        id: project.id || `project-${slugify(project.title)}-${Date.now()}`,
        title: project.title.trim(),
        outcome: project.outcome.trim(),
        motivation: project.motivation.trim(),
        planningMode,
        completedAt: relationship.status === "completed" ? relationship.completedAt || now : null,
        createdAt: project.createdAt || now,
        updatedAt: now,
      };
      const savedMilestones = milestones.filter((milestone) => milestone.title.trim()).map((milestone, index) => ({
        ...milestone,
        id: milestone.id || `${savedProject.id}-milestone-${Date.now()}-${index}`,
        projectId: savedProject.id,
        title: milestone.title.trim(),
        definitionOfDone: milestone.definitionOfDone.trim(),
        status: planningMode === "direct" && milestone.status !== "completed" ? "superseded" as const : milestone.status,
        createdAt: milestone.createdAt || now,
        updatedAt: now,
      }));
      if (planningMode !== "direct" && !savedMilestones.some((milestone) => milestone.status === "current")) {
        throw new ProjectRepositoryError(
          planningMode === "adaptive" ? "滚动推进项目需要一个当前检查点" : "按阶段推进项目需要一个当前阶段",
          "invalid_data",
        );
      }
      savedProject.reviewDate = planningMode === "adaptive"
        ? resolveAdaptiveReviewDate(
          savedProject.reviewDate,
          savedProject.targetDate,
          savedMilestones.filter((milestone) => milestone.status === "current").map((node) => node.dueDate).filter(Boolean).sort()[0] || "",
          now,
        )
        : savedProject.reviewDate;
      let taskMilestoneId = task?.milestoneId ?? null;
      if (task) {
        const matching = savedMilestones.find((milestone) => milestone.id === task.milestoneId)
          ?? (!taskMilestoneId ? savedMilestones.find((milestone) => milestone.status === "current") : null);
        if (matching) taskMilestoneId = matching.id;
        else if (taskMilestoneId && !savedMilestones.some((milestone) => milestone.id === taskMilestoneId)) {
          taskMilestoneId = savedMilestones.find((milestone) => milestone.status === "current")?.id ?? null;
        }
      }
      const savedTask = task?.title.trim() ? {
        ...task,
        id: task.id || `${savedProject.id}-task-${Date.now()}`,
        projectId: savedProject.id,
        milestoneId: planningMode === "direct" ? null : taskMilestoneId,
        direction: savedProject.category,
        title: task.title.trim(),
        definitionOfDone: task.definitionOfDone.trim(),
        steps: normalizeTaskSteps(task.steps),
        currentFocus: task.currentFocus.trim(),
        status: task.status,
        waitingFor: task.waitingFor.trim(),
        resumeAction: task.resumeAction.trim(),
        createdAt: task.createdAt || now,
        updatedAt: now,
        completedAt: task.status === "done" ? task.completedAt || now : null,
      } : null;
      if (savedProject.parentProjectId && branches.length) {
        throw new ProjectRepositoryError("支线只允许一层，不能继续创建下级支线", "invalid_data");
      }
      const savedBranches = branches.map((branch, index): Project => {
        if (branch.projectType !== "main" && (!branch.title.trim() || !branch.outcome.trim())) {
          throw new ProjectRepositoryError("支线名称和完成标准不能为空", "invalid_data");
        }
        const detached = branch.projectType === "main";
        const supportsMilestoneId = detached ? null : branch.supportsMilestoneId?.trim() || null;
        if (supportsMilestoneId && !savedMilestones.some((milestone) => milestone.id === supportsMilestoneId)) {
          throw new ProjectRepositoryError("支线关联的阶段不属于这个主项目", "invalid_data");
        }
        return {
          ...branch,
          id: branch.id || `${savedProject.id}-branch-${slugify(branch.title)}-${Date.now()}-${index}`,
          title: branch.title.trim(),
          outcome: branch.outcome.trim(),
          motivation: branch.motivation.trim(),
          projectType: detached ? "main" : branch.projectType === "experiment" ? "experiment" : "side",
          planningMode: normalizePlanningMode(branch.planningMode),
          parentProjectId: detached ? null : savedProject.id,
          supportsMilestoneId,
          category: savedProject.category,
          createdAt: branch.createdAt || now,
          updatedAt: now,
        };
      });

      const [existingMilestones, existingProjectRows] = project.id
        ? await Promise.all([
          this.database.select<{ id: string }>("SELECT id FROM project_milestones WHERE project_id = ?", [project.id]),
          this.database.select<ProjectRow>("SELECT * FROM projects WHERE id = ? LIMIT 1", [project.id]),
        ])
        : [[], [] as ProjectRow[]];
      if (planningMode === "adaptive") {
        const parents = routeParents(savedMilestones);
        for (const node of savedMilestones) node.predecessorIds ??= parents.get(node.id) ?? [];
        try { validateRoute(savedMilestones); }
        catch (error) { throw new ProjectRepositoryError((error as Error).message, "invalid_data"); }
      }
      const savedMilestoneIds = new Set(savedMilestones.map((milestone) => milestone.id));
      const removedMilestones = existingMilestones.filter((milestone) => !savedMilestoneIds.has(milestone.id));
      const statements: SqliteStatement[] = [projectWriteStatement(savedProject), ...savedBranches.map(projectWriteStatement)];
      for (const milestone of removedMilestones) {
        statements.push({ sql: "DELETE FROM project_milestones WHERE id = ?", bindValues: [milestone.id] });
      }
      for (const milestone of savedMilestones) {
        if (milestone.status === "current") {
          statements.push({
            sql: "UPDATE project_milestones SET status = 'planned', updated_at = ? WHERE project_id = ? AND (SELECT planning_mode FROM projects WHERE id = project_id) != 'adaptive' AND status = 'current' AND id != ?",
            bindValues: [now, savedProject.id, milestone.id],
          });
        }
        statements.push(milestoneWriteStatement(milestone));
      }
      if (planningMode === "direct" && savedMilestones.length) {
        statements.push({
          sql: `UPDATE project_tasks SET milestone_id = NULL, updated_at = ?
                WHERE project_id = ? AND milestone_id IN (
                  SELECT id FROM project_milestones WHERE project_id = ? AND status = 'superseded'
                )`,
          bindValues: [now, savedProject.id, savedProject.id],
        });
      }
      if (savedTask) {
        if (savedTask.status === "next") {
          statements.push({
            sql: "UPDATE project_tasks SET status = 'later', updated_at = ? WHERE project_id = ? AND ((SELECT planning_mode FROM projects WHERE id = project_id) != 'adaptive' OR milestone_id IS ?) AND status = 'next' AND id != ?",
            bindValues: [now, savedProject.id, savedTask.milestoneId, savedTask.id],
          });
        }
        statements.push(taskWriteStatement(savedTask));
      }
      const previousProject = existingProjectRows[0];
      if (previousProject && previousProject.planning_mode !== savedProject.planningMode) {
        statements.push({
          sql: "INSERT INTO project_logs(id, project_id, task_id, kind, body, created_at) VALUES (?, ?, NULL, 'plan_revision', ?, ?)",
          bindValues: [
            `log-plan-mode-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            savedProject.id,
            `计划调整｜${JSON.stringify({ source: "manual", trigger: "切换项目推进方式", before: { planningMode: previousProject.planning_mode }, accepted: { planningMode: savedProject.planningMode } })}`,
            now,
          ],
        });
      }
      await executeSqliteTransaction(this.database, statements);
      return savedProject;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("保存项目工作区失败，原内容已保留", "save_failed", error);
    }
  }

  async saveMilestone(milestone: Milestone): Promise<Milestone> {
    this.indexCache.clear();
    if (!milestone.title.trim()) {
      throw new ProjectRepositoryError("里程碑名称不能为空", "invalid_data");
    }
    try {
      await this.initialize();
      const now = this.now();
      const existing = milestone.id
        ? (await this.database.select<MilestoneRow>("SELECT * FROM project_milestones WHERE id = ? AND project_id = ? LIMIT 1", [milestone.id, milestone.projectId]))[0]
        : null;
      const project = (await this.database.select<ProjectRow>("SELECT * FROM projects WHERE id = ? LIMIT 1", [milestone.projectId]))[0];
      const saved = {
        ...milestone,
        id: milestone.id || `${milestone.projectId}-milestone-${Date.now()}`,
        title: milestone.title.trim(),
        definitionOfDone: milestone.definitionOfDone.trim(),
        createdAt: milestone.createdAt || now,
        updatedAt: now,
      };
      if (saved.predecessorIds === undefined && existing?.predecessor_ids) saved.predecessorIds = JSON.parse(existing.predecessor_ids);
      const siblings = (await this.database.select<MilestoneRow>("SELECT * FROM project_milestones WHERE project_id = ?", [saved.projectId])).map(rowToMilestone);
      saved.predecessorIds ??= routeParents([...siblings.filter((node) => node.id !== saved.id), saved]).get(saved.id) ?? [];
      try { validateRoute([...siblings.filter((node) => node.id !== saved.id), saved]); }
      catch (error) { throw new ProjectRepositoryError((error as Error).message, "invalid_data"); }
      if (saved.status === "current" && saved.predecessorIds?.some((id) => siblings.find((node) => node.id === id)?.status !== "completed")) {
        throw new ProjectRepositoryError("请先完成所有前置节点，或调整连接关系以并行开展。", "invalid_data");
      }
      const statements: SqliteStatement[] = [];
      if (saved.status === "current") {
        statements.push({
          sql: "UPDATE project_milestones SET status = 'planned', updated_at = ? WHERE project_id = ? AND (SELECT planning_mode FROM projects WHERE id = project_id) != 'adaptive' AND status = 'current' AND id != ?",
          bindValues: [now, saved.projectId, saved.id],
        });
      }
      statements.push(milestoneWriteStatement(saved));
      const currentCheckpoint = [...siblings.filter((node) => node.id !== saved.id && node.status === "current"), ...(saved.status === "current" ? [saved] : [])]
        .map((node) => node.dueDate).filter(Boolean).sort()[0] || "";
      const reviewDate = project?.planning_mode === "adaptive"
        ? resolveAdaptiveReviewDate("", project.target_date, currentCheckpoint, now)
        : project?.review_date || "";
      statements.push({
        sql: "UPDATE projects SET review_date = ?, updated_at = ? WHERE id = ?",
        bindValues: [reviewDate, now, saved.projectId],
      });
      statements.push({
        sql: "INSERT INTO project_logs(id, project_id, task_id, kind, body, created_at) VALUES (?, ?, NULL, 'plan_revision', ?, ?)",
        bindValues: [
          `log-plan-node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          saved.projectId,
          `计划调整｜${JSON.stringify({ source: "manual", trigger: existing ? "手动调整项目节点" : "手动新增项目节点", before: existing ? rowToMilestone(existing) : null, accepted: saved })}`,
          now,
        ],
      });
      await executeSqliteTransaction(this.database, statements);
      return saved;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("保存里程碑失败", "save_failed", error);
    }
  }

  async completeMilestone(id: string, logBody: string): Promise<Milestone | null> {
    this.indexCache.clear();
    const text = logBody.trim();
    if (!text) throw new ProjectRepositoryError("阶段完成记录不能为空", "invalid_data");
    try {
      await this.initialize();
      const rows = await this.database.select<MilestoneRow>(
        "SELECT * FROM project_milestones WHERE id = ? LIMIT 1",
        [id],
      );
      const current = rows[0];
      if (!current) throw new ProjectRepositoryError("没有找到这个阶段", "invalid_data");
      if (current.status === "completed") return null;

      const milestones = await this.database.select<MilestoneRow>(
        "SELECT * FROM project_milestones WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC",
        [current.project_id],
      );
      const currentIndex = milestones.findIndex((milestone) => milestone.id === id);
      const project = (await this.database.select<ProjectRow>("SELECT * FROM projects WHERE id = ? LIMIT 1", [current.project_id]))[0];
      const nextCandidate = milestones.slice(currentIndex + 1).find((milestone) => milestone.status === "planned") ?? null;
      const next = project?.planning_mode === "adaptive" ? null : nextCandidate;
      const now = this.now();
      const nextReviewDate = project?.planning_mode === "adaptive"
        ? resolveAdaptiveReviewDate("", project.target_date, [...milestones.filter((node) => node.id !== id && node.status === "current").map((node) => node.due_date), next?.due_date || ""].filter(Boolean).sort()[0] || "", now)
        : project?.review_date || "";
      const statements: SqliteStatement[] = [
        {
          sql: "UPDATE project_milestones SET status = 'completed', updated_at = ? WHERE id = ?",
          bindValues: [now, id],
        },
      ];
      if (next) {
        statements.push({
          sql: "UPDATE project_milestones SET status = 'current', updated_at = ? WHERE id = ?",
          bindValues: [now, next.id],
        });
      }
      statements.push(
        {
          sql: "INSERT INTO project_logs(id, project_id, body, created_at) VALUES (?, ?, ?, ?)",
          bindValues: [`${current.project_id}-log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, current.project_id, text, now],
        },
        {
          sql: "UPDATE projects SET review_date = ?, updated_at = ? WHERE id = ?",
          bindValues: [nextReviewDate, now, current.project_id],
        },
      );
      await executeSqliteTransaction(this.database, statements);
      return next ? rowToMilestone({ ...next, status: "current", updated_at: now }) : null;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("完成阶段失败，原状态已保留", "save_failed", error);
    }
  }

  async removeProject(id: string): Promise<void> {
    this.indexCache.clear();
    try {
      await this.initialize();
      const rows = await this.database.select<{ id: string }>(
        "SELECT id FROM projects WHERE id = ? LIMIT 1",
        [id],
      );
      if (!rows[0]) throw new ProjectRepositoryError("没有找到这个项目", "invalid_data");
      const tables = await this.database.select<{ name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table'",
      );
      const tableNames = new Set(tables.map((table) => table.name));
      const relatedProjectIds = "SELECT id FROM projects WHERE id = ? OR parent_project_id = ?";
      const statements: SqliteStatement[] = [];
      if (tableNames.has("articles")) {
        statements.push({
          sql: `UPDATE articles SET project_id = '' WHERE project_id IN (${relatedProjectIds})`,
          bindValues: [id, id],
        });
      }
      if (tableNames.has("focus_sessions")) {
        statements.push({
          sql: `UPDATE focus_sessions SET project_id = NULL WHERE project_id IN (${relatedProjectIds})`,
          bindValues: [id, id],
        });
      }
      if (tableNames.has("task_plans")) {
        statements.push({
          sql: `DELETE FROM task_plans WHERE task_id IN (
            SELECT id FROM project_tasks WHERE project_id IN (${relatedProjectIds})
          )`,
          bindValues: [id, id],
        });
      }
      for (const table of ["project_accumulations", "project_proposals", "project_logs", "project_tasks", "project_milestones"]) {
        statements.push({
          sql: `DELETE FROM ${table} WHERE project_id IN (${relatedProjectIds})`,
          bindValues: [id, id],
        });
      }
      statements.push({ sql: "DELETE FROM projects WHERE parent_project_id = ?", bindValues: [id] });
      statements.push({ sql: "DELETE FROM projects WHERE id = ?", bindValues: [id] });
      await executeSqliteTransaction(this.database, statements);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("删除项目失败，原内容已保留", "save_failed", error);
    }
  }

  async removeMilestone(id: string): Promise<void> {
    this.indexCache.clear();
    try {
      await this.initialize();
      const rows = await this.database.select<MilestoneRow>(
        "SELECT * FROM project_milestones WHERE id = ? LIMIT 1",
        [id],
      );
      if (!rows[0]) throw new ProjectRepositoryError("没有找到这个阶段", "invalid_data");
      const dependents = await this.database.select<MilestoneRow>("SELECT * FROM project_milestones WHERE project_id = ?", [rows[0].project_id]);
      if (dependents.some((node) => node.predecessor_ids && JSON.parse(node.predecessor_ids).includes(id))) {
        throw new ProjectRepositoryError("此节点仍连接着后续任务，请先调整后续节点的前置关系。", "invalid_data");
      }
      await this.database.execute("DELETE FROM project_milestones WHERE id = ?", [id]);
      await this.touchProject(rows[0].project_id, this.now());
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("删除阶段失败", "save_failed", error);
    }
  }

  async saveTask(task: ProjectTask): Promise<ProjectTask> {
    this.indexCache.clear();
    if (!task.title.trim()) {
      throw new ProjectRepositoryError("行动名称不能为空", "invalid_data");
    }
    if (task.estimatedDays !== undefined && (!Number.isInteger(task.estimatedDays) || task.estimatedDays < 0 || task.estimatedDays > 365)) {
      throw new ProjectRepositoryError("预计天数应为 1 到 365 天，或留空", "invalid_data");
    }
    try {
      await this.initialize();
      const now = this.now();
      const projectId = task.projectId?.trim() || null;
      if (!projectId && task.milestoneId) {
        throw new ProjectRepositoryError("独立行动不能关联项目阶段", "invalid_data");
      }
      const saved = {
        ...task,
        estimatedDays: task.estimatedDays || 0,
        autoSchedulePaused: Boolean(task.autoSchedulePaused),
        id: task.id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        projectId,
        milestoneId: projectId ? task.milestoneId : null,
        direction: normalizeLifeDomain(task.direction),
        title: task.title.trim(),
        definitionOfDone: task.definitionOfDone.trim(),
        steps: normalizeTaskSteps(task.steps),
        currentFocus: task.currentFocus.trim(),
        waitingFor: task.waitingFor.trim(),
        resumeAction: task.resumeAction.trim(),
        createdAt: task.createdAt || now,
        updatedAt: now,
        completedAt: task.status === "done" ? task.completedAt || now : null,
      };
      const statements: SqliteStatement[] = [];
      if (saved.status === "next") {
        statements.push({
          sql: saved.projectId
            ? "UPDATE project_tasks SET status = 'later', updated_at = ? WHERE project_id = ? AND ((SELECT planning_mode FROM projects WHERE id = project_id) != 'adaptive' OR milestone_id IS ?) AND status = 'next' AND id != ?"
            : "UPDATE project_tasks SET status = 'later', updated_at = ? WHERE project_id IS NULL AND status = 'next' AND id != ?",
          bindValues: saved.projectId ? [now, saved.projectId, saved.milestoneId, saved.id] : [now, saved.id],
        });
      }
      statements.push(taskWriteStatement(saved));
      if (saved.projectId) statements.push({
          sql: "UPDATE projects SET updated_at = ? WHERE id = ?",
          bindValues: [now, saved.projectId],
        });
      await executeSqliteTransaction(this.database, statements);
      return saved;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("保存项目行动失败", "save_failed", error);
    }
  }

  async removeTask(id: string): Promise<void> {
    this.indexCache.clear();
    try {
      await this.initialize();
      const rows = await this.database.select<ProjectTaskRow>(
        "SELECT * FROM project_tasks WHERE id = ? AND deleted_at IS NULL LIMIT 1",
        [id],
      );
      if (!rows[0]) throw new ProjectRepositoryError("没有找到这条行动", "invalid_data");
      const tableRows = await this.database.select<{ name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'task_plans'",
      );
      const plan = tableRows[0]
        ? (await this.database.select<TaskPlanSnapshotRow>("SELECT * FROM task_plans WHERE task_id = ? LIMIT 1", [id]))[0]
        : undefined;
      const now = this.now();
      const statements: SqliteStatement[] = [{
        sql: "UPDATE project_tasks SET deleted_at = ?, deleted_plan_json = ?, updated_at = ? WHERE id = ?",
        bindValues: [now, plan ? JSON.stringify(plan) : "", now, id],
      }];
      if (tableRows[0]) statements.push({ sql: "DELETE FROM task_plans WHERE task_id = ?", bindValues: [id] });
      if (rows[0].project_id) statements.push({ sql: "UPDATE projects SET updated_at = ? WHERE id = ?", bindValues: [now, rows[0].project_id] });
      await executeSqliteTransaction(this.database, statements);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("删除行动失败，原内容已保留", "save_failed", error);
    }
  }

  async restoreTask(id: string): Promise<void> {
    this.indexCache.clear();
    try {
      await this.initialize();
      const rows = await this.database.select<ProjectTaskRow>(
        "SELECT * FROM project_tasks WHERE id = ? AND deleted_at IS NOT NULL LIMIT 1",
        [id],
      );
      if (!rows[0]) throw new ProjectRepositoryError("没有找到可恢复的行动", "invalid_data");
      const now = this.now();
      const statements: SqliteStatement[] = [{
        sql: "UPDATE project_tasks SET deleted_at = NULL, deleted_plan_json = '', updated_at = ? WHERE id = ?",
        bindValues: [now, id],
      }];
      const plan = parseTaskPlanSnapshot(rows[0].deleted_plan_json);
      const planColumns = plan ? await this.database.select<{ name: string }>("PRAGMA table_info(task_plans)") : [];
      const planHasSource = planColumns.some((column) => column.name === "source");
      if (plan && planHasSource) statements.push({
        sql: `INSERT INTO task_plans(task_id, planned_date, source, priority, estimate_minutes, sort_order, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(task_id) DO UPDATE SET planned_date = excluded.planned_date, source = excluded.source, priority = excluded.priority,
                estimate_minutes = excluded.estimate_minutes, sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
        bindValues: [plan.task_id, plan.planned_date, plan.source || "manual", plan.priority, plan.estimate_minutes, plan.sort_order, now],
      });
      else if (plan) statements.push({
        sql: `INSERT INTO task_plans(task_id, planned_date, priority, estimate_minutes, sort_order, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(task_id) DO UPDATE SET planned_date = excluded.planned_date, priority = excluded.priority,
                estimate_minutes = excluded.estimate_minutes, sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
        bindValues: [plan.task_id, plan.planned_date, plan.priority, plan.estimate_minutes, plan.sort_order, now],
      });
      if (plan && planColumns.some((column) => column.name === "skip_auto_date")) statements.push({
        sql: "UPDATE task_plans SET skip_auto_date = ? WHERE task_id = ?",
        bindValues: [plan.skip_auto_date || "", plan.task_id],
      });
      if (rows[0].project_id) statements.push({ sql: "UPDATE projects SET updated_at = ? WHERE id = ?", bindValues: [now, rows[0].project_id] });
      await executeSqliteTransaction(this.database, statements);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("恢复行动失败", "save_failed", error);
    }
  }

  async updateTaskStatus(id: string, status: ProjectTaskStatus): Promise<void> {
    this.indexCache.clear();
    try {
      await this.initialize();
      const rows = await this.database.select<ProjectTaskRow>(
        "SELECT * FROM project_tasks WHERE id = ? LIMIT 1",
        [id],
      );
      if (!rows[0]) throw new ProjectRepositoryError("没有找到这条行动", "invalid_data");
      const now = this.now();
      const statements: SqliteStatement[] = [];
      if (status === "next") {
        statements.push({
          sql: rows[0].project_id
            ? "UPDATE project_tasks SET status = 'later', updated_at = ? WHERE project_id = ? AND ((SELECT planning_mode FROM projects WHERE id = project_id) != 'adaptive' OR milestone_id IS ?) AND status = 'next' AND id != ?"
            : "UPDATE project_tasks SET status = 'later', updated_at = ? WHERE project_id IS NULL AND status = 'next' AND id != ?",
          bindValues: rows[0].project_id ? [now, rows[0].project_id, rows[0].milestone_id, id] : [now, id],
        });
      }
      statements.push({
        sql: `UPDATE project_tasks
              SET status = ?, updated_at = ?, completed_at = ?
              WHERE id = ?`,
        bindValues: [status, now, status === "done" ? now : null, id],
      });
      if (rows[0].project_id) statements.push({
        sql: "UPDATE projects SET updated_at = ? WHERE id = ?",
        bindValues: [now, rows[0].project_id],
      });
      await executeSqliteTransaction(this.database, statements);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("更新行动状态失败", "save_failed", error);
    }
  }

  async completeTask(id: string, logBody: string): Promise<void> {
    this.indexCache.clear();
    const text = logBody.trim();
    if (!text) throw new ProjectRepositoryError("完成记录不能为空", "invalid_data");
    try {
      await this.initialize();
      const rows = await this.database.select<ProjectTaskRow>(
        "SELECT * FROM project_tasks WHERE id = ? LIMIT 1",
        [id],
      );
      if (!rows[0]) throw new ProjectRepositoryError("没有找到这条行动", "invalid_data");
      const now = this.now();
      const statements: SqliteStatement[] = [
        {
          sql: `UPDATE project_tasks SET status = 'done', updated_at = ?, completed_at = ? WHERE id = ?`,
          bindValues: [now, now, id],
        },
        {
          sql: "INSERT INTO project_logs(id, project_id, task_id, kind, body, created_at) VALUES (?, ?, ?, 'task_completed', ?, ?)",
          bindValues: [`log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, rows[0].project_id, id, text, now],
        },
      ];
      if (rows[0].project_id) statements.push({
          sql: "UPDATE projects SET updated_at = ? WHERE id = ?",
          bindValues: [now, rows[0].project_id],
        });
      await executeSqliteTransaction(this.database, statements);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("完成行动失败，原状态已保留", "save_failed", error);
    }
  }

  async recordTaskProgress(id: string, result: string, nextFocus: string): Promise<void> {
    this.indexCache.clear();
    const progress = result.trim();
    const focus = nextFocus.trim();
    if (!progress || !focus) {
      throw new ProjectRepositoryError("请填写今天完成的进展和下次继续的起点", "invalid_data");
    }
    try {
      await this.initialize();
      const rows = await this.database.select<ProjectTaskRow>(
        "SELECT * FROM project_tasks WHERE id = ? AND deleted_at IS NULL LIMIT 1",
        [id],
      );
      if (!rows[0]) throw new ProjectRepositoryError("没有找到这条行动", "invalid_data");
      if (rows[0].status === "done") throw new ProjectRepositoryError("已完成的行动无需记录今日续作", "invalid_data");
      const now = this.now();
      const body = `行动推进｜${JSON.stringify({
        taskId: id,
        title: rows[0].title,
        result: progress,
        nextFocus: focus,
      })}`;
      const statements: SqliteStatement[] = [
        {
          sql: "UPDATE project_tasks SET current_focus = ?, resume_action = ?, updated_at = ? WHERE id = ?",
          bindValues: [focus, focus, now, id],
        },
        {
          sql: "INSERT INTO project_logs(id, project_id, task_id, kind, body, created_at) VALUES (?, ?, ?, 'task_progress', ?, ?)",
          bindValues: [`log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, rows[0].project_id, id, body, now],
        },
      ];
      if (rows[0].project_id) statements.push({
          sql: "UPDATE projects SET updated_at = ? WHERE id = ?",
          bindValues: [now, rows[0].project_id],
        });
      await executeSqliteTransaction(this.database, statements);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("保存今日进展失败，行动内容已保留", "save_failed", error);
    }
  }

  async saveProposal(proposal: ProjectProposal): Promise<ProjectProposal> {
    this.indexCache.clear();
    if (!proposal.title.trim()) {
      throw new ProjectRepositoryError("想法名称不能为空", "invalid_data");
    }
    try {
      await this.initialize();
      const now = this.now();
      const saved: ProjectProposal = {
        ...proposal,
        id: proposal.id || `${proposal.projectId}-proposal-${Date.now()}`,
        title: proposal.title.trim(),
        problem: proposal.problem.trim(),
        expectedValue: proposal.expectedValue.trim(),
        cost: proposal.cost.trim(),
        reviewNote: proposal.reviewNote.trim(),
        createdAt: proposal.createdAt || now,
        updatedAt: now,
      };
      await this.writeProposal(saved, false);
      await this.touchProject(saved.projectId, now);
      return saved;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("保存项目想法失败", "save_failed", error);
    }
  }

  async updateProposalStatus(id: string, status: ProposalStatus, reviewNote: string): Promise<void> {
    this.indexCache.clear();
    try {
      await this.initialize();
      const rows = await this.database.select<ProjectProposalRow>(
        "SELECT * FROM project_proposals WHERE id = ? LIMIT 1",
        [id],
      );
      if (!rows[0]) throw new ProjectRepositoryError("没有找到这条想法", "invalid_data");
      const now = this.now();
      await this.database.execute(
        "UPDATE project_proposals SET status = ?, review_note = ?, updated_at = ? WHERE id = ?",
        [status, reviewNote.trim(), now, id],
      );
      await this.touchProject(rows[0].project_id, now);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("更新想法评审状态失败", "save_failed", error);
    }
  }

  async removeProposal(id: string): Promise<void> {
    this.indexCache.clear();
    try {
      await this.initialize();
      const rows = await this.database.select<ProjectProposalRow>(
        "SELECT * FROM project_proposals WHERE id = ? LIMIT 1",
        [id],
      );
      if (!rows[0]) throw new ProjectRepositoryError("没有找到这条想法", "invalid_data");
      const now = this.now();
      await executeSqliteTransaction(this.database, [
        { sql: "DELETE FROM project_proposals WHERE id = ?", bindValues: [id] },
        { sql: "UPDATE projects SET updated_at = ? WHERE id = ?", bindValues: [now, rows[0].project_id] },
      ]);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("删除项目想法失败", "save_failed", error);
    }
  }

  async saveAccumulation(accumulation: ProjectAccumulation): Promise<ProjectAccumulation> {
    this.indexCache.clear();
    if (!accumulation.title.trim() && !accumulation.content.trim()) {
      throw new ProjectRepositoryError("写下一点内容后再保存积累", "invalid_data");
    }
    try {
      await this.initialize();
      const project = await this.database.select<{ id: string }>("SELECT id FROM projects WHERE id = ? LIMIT 1", [accumulation.projectId]);
      if (!project[0]) throw new ProjectRepositoryError("没有找到这条积累所属的项目", "invalid_data");
      const milestoneId = accumulation.milestoneId?.trim() || null;
      if (milestoneId) {
        const milestone = await this.database.select<{ id: string }>(
          "SELECT id FROM project_milestones WHERE id = ? AND project_id = ? LIMIT 1",
          [milestoneId, accumulation.projectId],
        );
        if (!milestone[0]) throw new ProjectRepositoryError("积累关联的检查点不属于当前项目", "invalid_data");
      }
      const now = this.now();
      const saved: ProjectAccumulation = {
        ...accumulation,
        id: accumulation.id || `${accumulation.projectId}-accumulation-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        milestoneId,
        title: accumulation.title.trim(),
        content: accumulation.content.trim(),
        reference: accumulation.reference.trim(),
        createdAt: accumulation.createdAt || now,
        updatedAt: now,
      };
      await this.writeAccumulation(saved, false);
      await this.touchProject(saved.projectId, now);
      return saved;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("保存项目积累失败", "save_failed", error);
    }
  }

  async removeAccumulation(id: string): Promise<void> {
    this.indexCache.clear();
    try {
      await this.initialize();
      const rows = await this.database.select<ProjectAccumulationRow>(
        "SELECT * FROM project_accumulations WHERE id = ? LIMIT 1",
        [id],
      );
      if (!rows[0]) throw new ProjectRepositoryError("没有找到这条积累", "invalid_data");
      const now = this.now();
      await executeSqliteTransaction(this.database, [
        { sql: "DELETE FROM project_accumulations WHERE id = ?", bindValues: [id] },
        { sql: "UPDATE projects SET updated_at = ? WHERE id = ?", bindValues: [now, rows[0].project_id] },
      ]);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("删除项目积累失败", "save_failed", error);
    }
  }

  async applyProjectAdjustment(draft: ProjectAdjustmentDraft): Promise<void> {
    this.indexCache.clear();
    const trigger = draft.trigger.trim();
    if (!trigger) throw new ProjectRepositoryError("请先说明这次计划变化的事实", "invalid_data");
    try {
      await this.initialize();
      const [projectRows, milestoneRows, taskRows] = await Promise.all([
        this.database.select<ProjectRow>("SELECT * FROM projects WHERE id = ? LIMIT 1", [draft.projectId]),
        this.database.select<MilestoneRow>("SELECT * FROM project_milestones WHERE project_id = ? ORDER BY sort_order ASC", [draft.projectId]),
        this.database.select<ProjectTaskRow>("SELECT * FROM project_tasks WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC", [draft.projectId]),
      ]);
      const projectRow = projectRows[0];
      if (!projectRow) throw new ProjectRepositoryError("没有找到要调整的项目", "invalid_data");
      const milestoneById = new Map(milestoneRows.map((row) => [row.id, row]));
      const taskById = new Map(taskRows.map((row) => [row.id, row]));
      const selectedMilestoneChanges = draft.proposal.milestoneChanges.filter((change) => change.selected);
      const selectedTaskChanges = draft.proposal.taskChanges.filter((change) => change.selected);
      const selectedNewTasks = draft.proposal.newTasks.filter((item) => item.selected);
      for (const change of selectedMilestoneChanges) {
        if (!milestoneById.has(change.id)) throw new ProjectRepositoryError("调整草案包含其他项目的节点", "invalid_data");
      }
      for (const change of selectedTaskChanges) {
        if (!taskById.has(change.id)) throw new ProjectRepositoryError("调整草案包含其他项目的行动", "invalid_data");
      }

      const now = this.now();
      const statements: SqliteStatement[] = [];
      const projectPatch = draft.proposal.projectPatch;
      const targetDate = projectPatch.targetDate === null ? projectRow.target_date : normalizeAiDate(projectPatch.targetDate);
      const outcome = projectPatch.outcome === null ? projectRow.outcome : projectPatch.outcome.trim();
      const selectedNewMilestones = draft.proposal.newMilestones.filter((item) => item.selected);
      const clientMilestoneIds = new Map<string, string>();
      selectedNewMilestones.forEach((item, index) => {
        clientMilestoneIds.set(item.clientId, `${draft.projectId}-milestone-ai-${Date.now()}-${index}`);
      });
      const retiringIds = new Set(selectedMilestoneChanges
        .filter((change) => change.action === "complete" || change.action === "supersede" || change.action === "replace")
        .map((change) => change.id));
      const newCurrent = selectedNewMilestones.find((item) => item.status === "current") ?? null;
      const existingCurrent = milestoneRows.find((row) => row.status === "current" && !retiringIds.has(row.id)) ?? null;
      const checkpointDate = normalizeAiDate(newCurrent?.dueDate ?? existingCurrent?.due_date ?? "");
      const reviewDate = projectRow.planning_mode === "adaptive"
        ? resolveAdaptiveReviewDate(projectPatch.reviewDate || "", targetDate, checkpointDate, now)
        : projectPatch.reviewDate === null ? projectRow.review_date : normalizeAiDate(projectPatch.reviewDate);
      statements.push({
        sql: "UPDATE projects SET outcome = ?, target_date = ?, review_date = ?, updated_at = ? WHERE id = ?",
        bindValues: [outcome || projectRow.outcome, targetDate, reviewDate, now, draft.projectId],
      });

      for (const change of selectedMilestoneChanges) {
        const current = milestoneById.get(change.id)!;
        const status = change.action === "complete" ? "completed"
          : change.action === "supersede" || change.action === "replace" ? "superseded"
          : current.status;
        statements.push({
          sql: "UPDATE project_milestones SET title = ?, definition_of_done = ?, due_date = ?, status = ?, updated_at = ? WHERE id = ? AND project_id = ?",
          bindValues: [
            change.title === null ? current.title : change.title.trim() || current.title,
            change.definitionOfDone === null ? current.definition_of_done : change.definitionOfDone.trim(),
            change.dueDate === null ? current.due_date : normalizeAiDate(change.dueDate),
            status,
            now,
            change.id,
            draft.projectId,
          ],
        });
        if (status === "superseded") statements.push({
          sql: "UPDATE project_tasks SET milestone_id = NULL, updated_at = ? WHERE project_id = ? AND milestone_id = ? AND status NOT IN ('done', 'cancelled')",
          bindValues: [now, draft.projectId, change.id],
        });
      }

      for (const [index, item] of selectedNewMilestones.entries()) {
        const id = clientMilestoneIds.get(item.clientId)!;
        if (item.status === "current") statements.push({
          sql: "UPDATE project_milestones SET status = 'planned', updated_at = ? WHERE project_id = ? AND (SELECT planning_mode FROM projects WHERE id = project_id) != 'adaptive' AND status = 'current'",
          bindValues: [now, draft.projectId],
        });
        statements.push(milestoneWriteStatement({
          id,
          projectId: draft.projectId,
          title: item.title.trim(),
          definitionOfDone: item.definitionOfDone.trim(),
          status: item.status,
          dueDate: normalizeAiDate(item.dueDate),
          sortOrder: milestoneRows.length * 10 + (index + 1) * 10,
          createdAt: now,
          updatedAt: now,
        }));
      }

      const requestedNextTaskId = selectedNewTasks.length
        ? null
        : selectedTaskChanges.find((change) => change.status === "next" && !["complete", "cancel", "replace"].includes(change.action))?.id ?? null;
      if (requestedNextTaskId) statements.push({
        sql: "UPDATE project_tasks SET status = 'later', updated_at = ? WHERE project_id = ? AND ((SELECT planning_mode FROM projects WHERE id = project_id) != 'adaptive' OR milestone_id IS ?) AND status = 'next' AND id != ?",
        bindValues: [now, draft.projectId, taskById.get(requestedNextTaskId)!.milestone_id, requestedNextTaskId],
      });
      for (const change of selectedTaskChanges) {
        const current = rowToTask(taskById.get(change.id)!);
        const status = change.action === "complete" ? "done"
          : change.action === "cancel" || change.action === "replace" ? "cancelled"
          : change.status && change.status !== "done" && change.status !== "cancelled"
            ? change.status === "next" && change.id !== requestedNextTaskId ? "later" : change.status
            : "later";
        statements.push(taskWriteStatement({
          ...current,
          title: change.title === null ? current.title : change.title.trim() || current.title,
          currentFocus: change.currentFocus === null ? current.currentFocus : change.currentFocus.trim(),
          definitionOfDone: change.definitionOfDone === null ? current.definitionOfDone : change.definitionOfDone.trim(),
          dueDate: change.dueDate === null ? current.dueDate : normalizeAiDate(change.dueDate),
          status,
          completedAt: status === "done" ? now : null,
          updatedAt: now,
        }));
      }

      if (selectedNewTasks.length) statements.push({
        sql: "UPDATE project_tasks SET status = 'later', updated_at = ? WHERE project_id = ? AND (SELECT planning_mode FROM projects WHERE id = project_id) != 'adaptive' AND status = 'next'",
        bindValues: [now, draft.projectId],
      });
      selectedNewTasks.forEach((item, index) => {
        const milestoneId = item.milestoneId
          ? clientMilestoneIds.get(item.milestoneId) || (milestoneById.has(item.milestoneId) ? item.milestoneId : null)
          : null;
        if (index === 0) statements.push({
          sql: "UPDATE project_tasks SET status = 'later', updated_at = ? WHERE project_id = ? AND milestone_id IS ? AND status = 'next'",
          bindValues: [now, draft.projectId, milestoneId],
        });
        statements.push(taskWriteStatement({
          id: `${draft.projectId}-task-ai-${Date.now()}-${index}`,
          projectId: draft.projectId,
          milestoneId,
          direction: normalizeLifeDomain(projectRow.category),
          title: item.title.trim(),
          actionType: "organize",
          definitionOfDone: item.definitionOfDone.trim(),
          steps: [],
          currentFocus: item.currentFocus.trim(),
          details: item.details.trim(),
          benefit: "",
          dueDate: normalizeAiDate(item.dueDate),
          status: index === 0 ? "next" : "later",
          waitingFor: "",
          resumeAction: "",
          context: "anywhere",
          sortOrder: taskRows.length * 10 + (index + 1) * 10,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        }));
      });

      const revision = {
        source: "deepseek_api",
        trigger,
        model: draft.model,
        tokenUsage: draft.tokenUsage,
        before: {
          project: rowToProject(projectRow),
          milestones: selectedMilestoneChanges.map((change) => rowToMilestone(milestoneById.get(change.id)!)),
          tasks: selectedTaskChanges.map((change) => rowToTask(taskById.get(change.id)!)),
        },
        accepted: {
          projectPatch,
          milestoneChanges: selectedMilestoneChanges,
          newMilestones: selectedNewMilestones,
          taskChanges: selectedTaskChanges,
          newTasks: selectedNewTasks,
        },
      };
      statements.push({
        sql: "INSERT INTO project_logs(id, project_id, task_id, kind, body, created_at) VALUES (?, ?, NULL, 'plan_revision', ?, ?)",
        bindValues: [`log-plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, draft.projectId, `计划调整｜${JSON.stringify(revision)}`, now],
      });
      await executeSqliteTransaction(this.database, statements);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("应用计划调整失败，原项目已完整保留", "save_failed", error);
    }
  }

  async addLog(projectId: string | null, body: string, taskId: string | null = null, kind: ProjectLogKind = "general"): Promise<ProjectLog> {
    this.indexCache.clear();
    const text = body.trim();
    if (!text) throw new ProjectRepositoryError("推进记录不能为空", "invalid_data");
    try {
      await this.initialize();
      const now = this.now();
      const log: ProjectLog = {
        id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        projectId,
        taskId,
        kind,
        body: text,
        createdAt: now,
      };
      await this.database.execute(
        "INSERT INTO project_logs(id, project_id, task_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [log.id, log.projectId, log.taskId, log.kind, log.body, log.createdAt],
      );
      if (projectId) await this.touchProject(projectId, now);
      return log;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("保存推进记录失败", "save_failed", error);
    }
  }

  async confirmProject(id: string): Promise<void> {
    this.indexCache.clear();
    try {
      await this.initialize();
      const now = this.now();
      await this.database.execute(
        "UPDATE projects SET is_draft = 0, updated_at = ? WHERE id = ?",
        [now, id],
      );
    } catch (error) {
      throw new ProjectRepositoryError("确认项目失败", "save_failed", error);
    }
  }

  private async listLogs(projectId: string) {
    const rows = await this.database.select<ProjectLogRow>(
      "SELECT * FROM project_logs WHERE project_id = ? ORDER BY created_at DESC LIMIT 40",
      [projectId],
    );
    return rows.map(rowToLog);
  }

  private async listProposals(projectId: string) {
    const rows = await this.database.select<ProjectProposalRow>(
      `SELECT * FROM project_proposals WHERE project_id = ?
       ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'experiment' THEN 1 WHEN 'accepted' THEN 2 WHEN 'deferred' THEN 3 ELSE 4 END,
       updated_at DESC`,
      [projectId],
    );
    return rows.map(rowToProposal);
  }

  async applyProjectRoute(draft: ProjectRouteDraft): Promise<void> {
    this.indexCache.clear();
    try {
      await this.initialize();
      const [projectRows, milestoneRows, taskRows] = await Promise.all([
        this.database.select<ProjectRow>("SELECT * FROM projects WHERE id = ? LIMIT 1", [draft.projectId]),
        this.database.select<MilestoneRow>("SELECT * FROM project_milestones WHERE project_id = ? ORDER BY sort_order ASC", [draft.projectId]),
        this.database.select<ProjectTaskRow>("SELECT * FROM project_tasks WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC", [draft.projectId]),
      ]);
      const projectRow = projectRows[0];
      if (!projectRow) throw new ProjectRepositoryError("没有找到要规划主线的项目", "invalid_data");
      const project = rowToProject(projectRow);
      const existingMilestones = milestoneRows.map(rowToMilestone);
      const now = this.now();
      let prepared;
      try {
        prepared = prepareProjectRoute(
          project,
          existingMilestones,
          draft.proposal,
          now,
          (_ref, index) => `${draft.projectId}-milestone-route-${Date.now()}-${index}`,
        );
      } catch (error) {
        throw new ProjectRepositoryError((error as Error).message, "invalid_data", error);
      }

      const statements: SqliteStatement[] = [];
      for (const id of prepared.supersededIds) {
        statements.push({
          sql: "UPDATE project_milestones SET status = 'superseded', updated_at = ? WHERE id = ? AND project_id = ? AND status IN ('current', 'planned')",
          bindValues: [now, id, draft.projectId],
        });
        statements.push({
          sql: "UPDATE project_tasks SET milestone_id = NULL, updated_at = ? WHERE project_id = ? AND milestone_id = ? AND status NOT IN ('done', 'cancelled')",
          bindValues: [now, draft.projectId, id],
        });
      }
      prepared.milestones.forEach((milestone) => statements.push(milestoneWriteStatement(milestone)));
      const checkpointDate = prepared.milestones
        .filter((milestone) => milestone.status === "current" && milestone.dueDate)
        .map((milestone) => milestone.dueDate)
        .sort()[0] || "";
      statements.push({
        sql: "UPDATE projects SET review_date = ?, updated_at = ? WHERE id = ?",
        bindValues: [resolveAdaptiveReviewDate(project.reviewDate, project.targetDate, checkpointDate, now), now, draft.projectId],
      });
      const affectedTaskIds = taskRows
        .filter((task) => task.milestone_id && prepared.supersededIds.includes(task.milestone_id) && !["done", "cancelled"].includes(task.status))
        .map((task) => task.id);
      const revision = {
        source: "deepseek_api_route",
        trigger: [draft.currentSituation.trim(), draft.requirements.trim()].filter(Boolean).join("｜") || "用户请求 AI 推荐主线",
        model: draft.model,
        tokenUsage: draft.tokenUsage,
        before: { milestones: existingMilestones.filter((item) => item.status !== "superseded") },
        accepted: draft.proposal,
        detachedTaskIds: affectedTaskIds,
      };
      statements.push({
        sql: "INSERT INTO project_logs(id, project_id, task_id, kind, body, created_at) VALUES (?, ?, NULL, 'plan_revision', ?, ?)",
        bindValues: [`log-route-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, draft.projectId, `主线规划｜${JSON.stringify(revision)}`, now],
      });
      await executeSqliteTransaction(this.database, statements);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("应用主线草案失败，原项目已完整保留", "save_failed", error);
    }
  }

  private async listAccumulations(projectId: string) {
    const rows = await this.database.select<ProjectAccumulationRow>(
      "SELECT * FROM project_accumulations WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC",
      [projectId],
    );
    return rows.map(rowToAccumulation);
  }

  private async touchProject(projectId: string, updatedAt: string) {
    await this.database.execute(
      "UPDATE projects SET updated_at = ? WHERE id = ?",
      [updatedAt, projectId],
    );
  }

  private async normalizeRelationship(project: Project): Promise<Project> {
    const parentProjectId = project.parentProjectId?.trim() || null;
    if (!parentProjectId) {
      return {
        ...project,
        projectType: "main",
        parentProjectId: null,
        supportsMilestoneId: null,
      };
    }
    if (project.id && parentProjectId === project.id) {
      throw new ProjectRepositoryError("项目不能成为自己的支线", "invalid_data");
    }
    const parents = await this.database.select<{ parent_project_id: string | null }>(
      "SELECT parent_project_id FROM projects WHERE id = ? LIMIT 1",
      [parentProjectId],
    );
    if (!parents[0]) throw new ProjectRepositoryError("没有找到支线所属的主项目", "invalid_data");
    if (parents[0].parent_project_id) {
      throw new ProjectRepositoryError("支线只允许一层，不能继续创建下级支线", "invalid_data");
    }
    const supportsMilestoneId = project.supportsMilestoneId?.trim() || null;
    if (supportsMilestoneId) {
      const milestones = await this.database.select<{ id: string }>(
        "SELECT id FROM project_milestones WHERE id = ? AND project_id = ? LIMIT 1",
        [supportsMilestoneId, parentProjectId],
      );
      if (!milestones[0]) {
        throw new ProjectRepositoryError("支线关联的阶段不属于这个主项目", "invalid_data");
      }
    }
    return {
      ...project,
      projectType: project.projectType === "experiment" ? "experiment" : "side",
      parentProjectId,
      supportsMilestoneId,
    };
  }

  private async writeProject(project: Project, seed: boolean) {
    await this.database.execute(
      `INSERT INTO projects(
        id, title, outcome, motivation, project_type, planning_mode, parent_project_id, supports_milestone_id,
        status, category, sort_order, is_draft, source_note, target_date, review_date, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO ${seed ? "NOTHING" : `UPDATE SET
        title = excluded.title,
        outcome = excluded.outcome,
        motivation = excluded.motivation,
        project_type = excluded.project_type,
        planning_mode = excluded.planning_mode,
        parent_project_id = excluded.parent_project_id,
        supports_milestone_id = excluded.supports_milestone_id,
        status = excluded.status,
        category = excluded.category,
        sort_order = excluded.sort_order,
        is_draft = excluded.is_draft,
        source_note = excluded.source_note,
        target_date = excluded.target_date,
        review_date = excluded.review_date,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at`}`,
      [
        project.id,
        project.title,
        project.outcome,
        project.motivation,
        project.projectType,
        project.planningMode,
        project.parentProjectId,
        project.supportsMilestoneId,
        project.status,
        project.category,
        project.sortOrder,
        project.isDraft ? 1 : 0,
        project.sourceNote,
        project.targetDate,
        project.reviewDate,
        project.completedAt,
        project.createdAt,
        project.updatedAt,
      ],
    );
  }

  private async writeMilestone(milestone: Milestone, seed: boolean) {
    await this.database.execute(
      `INSERT INTO project_milestones(
        id, project_id, title, definition_of_done, status, due_date, sort_order, created_at, updated_at, predecessor_ids
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO ${seed ? "NOTHING" : `UPDATE SET
        title = excluded.title,
        definition_of_done = excluded.definition_of_done,
        status = excluded.status,
        due_date = excluded.due_date,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at`}`,
      [
        milestone.id,
        milestone.projectId,
        milestone.title,
        milestone.definitionOfDone,
        milestone.status,
        milestone.dueDate,
        milestone.sortOrder,
        milestone.createdAt,
        milestone.updatedAt,
        milestone.predecessorIds === undefined ? null : JSON.stringify(milestone.predecessorIds),
      ],
    );
  }

  private async writeTask(task: ProjectTask, seed: boolean) {
    await this.database.execute(
      `INSERT INTO project_tasks(
        id, project_id, milestone_id, direction, title, action_type, definition_of_done, steps_json, current_focus, details, benefit, due_date,
        status, waiting_for, resume_action, context, sort_order, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO ${seed ? "NOTHING" : `UPDATE SET
        project_id = excluded.project_id,
        milestone_id = excluded.milestone_id,
        direction = excluded.direction,
        title = excluded.title,
        action_type = excluded.action_type,
        definition_of_done = excluded.definition_of_done,
        steps_json = excluded.steps_json,
        current_focus = excluded.current_focus,
        details = excluded.details,
        benefit = excluded.benefit,
        due_date = excluded.due_date,
        status = excluded.status,
        waiting_for = excluded.waiting_for,
        resume_action = excluded.resume_action,
        context = excluded.context,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at`}`,
      [
        task.id,
        task.projectId,
        task.milestoneId,
        task.direction,
        task.title,
        task.actionType,
        task.definitionOfDone,
        JSON.stringify(normalizeTaskSteps(task.steps)),
        task.currentFocus,
        task.details,
        task.benefit,
        task.dueDate,
        task.status,
        task.waitingFor,
        task.resumeAction,
        task.context,
        task.sortOrder,
        task.createdAt,
        task.updatedAt,
        task.completedAt,
      ],
    );
  }

  private async writeProposal(proposal: ProjectProposal, seed: boolean) {
    await this.database.execute(
      `INSERT INTO project_proposals(
        id, project_id, title, problem, expected_value, cost, status, review_note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO ${seed ? "NOTHING" : `UPDATE SET
        title = excluded.title,
        problem = excluded.problem,
        expected_value = excluded.expected_value,
        cost = excluded.cost,
        status = excluded.status,
        review_note = excluded.review_note,
        updated_at = excluded.updated_at`}`,
      [
        proposal.id,
        proposal.projectId,
        proposal.title,
        proposal.problem,
        proposal.expectedValue,
        proposal.cost,
        proposal.status,
        proposal.reviewNote,
        proposal.createdAt,
        proposal.updatedAt,
      ],
    );
  }

  private async writeAccumulation(accumulation: ProjectAccumulation, seed: boolean) {
    await this.database.execute(
      `INSERT INTO project_accumulations(
        id, project_id, milestone_id, kind, title, completed_work, takeaway, reference, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO ${seed ? "NOTHING" : `UPDATE SET
        milestone_id = excluded.milestone_id,
        kind = excluded.kind,
        title = excluded.title,
        completed_work = excluded.completed_work,
        takeaway = excluded.takeaway,
        reference = excluded.reference,
        updated_at = excluded.updated_at`}`,
      [
        accumulation.id,
        accumulation.projectId,
        accumulation.milestoneId,
        "other",
        accumulation.title,
        accumulation.content,
        "",
        accumulation.reference,
        accumulation.createdAt,
        accumulation.updatedAt,
      ],
    );
  }
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    title: row.title,
    outcome: row.outcome,
    motivation: row.motivation,
    projectType: row.project_type || "main",
    planningMode: row.planning_mode || "direct",
    parentProjectId: row.parent_project_id || null,
    supportsMilestoneId: row.supports_milestone_id || null,
    status: row.status === "waiting" ? "paused" : row.status,
    category: normalizeLifeDomain(row.category),
    sortOrder: Number(row.sort_order),
    isDraft: Boolean(row.is_draft),
    sourceNote: row.source_note,
    targetDate: row.target_date || "",
    reviewDate: row.review_date,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMilestone(row: MilestoneRow): Milestone {
  return {
    predecessorIds: row.predecessor_ids ? JSON.parse(row.predecessor_ids) : undefined,
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    definitionOfDone: row.definition_of_done,
    status: row.status,
    dueDate: row.due_date,
    sortOrder: Number(row.sort_order),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTask(row: ProjectTaskRow): ProjectTask {
  return {
    id: row.id,
    projectId: row.project_id,
    milestoneId: row.milestone_id,
    direction: normalizeLifeDomain(row.direction),
    title: row.title,
    actionType: row.action_type,
    definitionOfDone: row.definition_of_done || "",
    steps: parseTaskSteps(row.steps_json),
    currentFocus: row.current_focus || "",
    details: row.details,
    benefit: row.benefit,
    dueDate: row.due_date,
    estimatedDays: Number(row.estimated_days || 0),
    autoSchedulePaused: Boolean(row.auto_schedule_paused),
    status: row.status,
    waitingFor: row.waiting_for,
    resumeAction: row.resume_action,
    context: row.context,
    sortOrder: Number(row.sort_order),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function rowToLog(row: ProjectLogRow): ProjectLog {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    kind: row.kind || "general",
    body: row.body,
    createdAt: row.created_at,
  };
}

function rowToProposal(row: ProjectProposalRow): ProjectProposal {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    problem: row.problem,
    expectedValue: row.expected_value,
    cost: row.cost,
    status: row.status,
    reviewNote: row.review_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAccumulation(row: ProjectAccumulationRow): ProjectAccumulation {
  return {
    id: row.id,
    projectId: row.project_id,
    milestoneId: row.milestone_id,
    title: row.title,
    content: [row.completed_work, row.takeaway].filter((part) => part.trim()).join("\n\n"),
    reference: row.reference,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectWriteStatement(project: Project): SqliteStatement {
  return {
    sql: `INSERT INTO projects(
      id, title, outcome, motivation, project_type, planning_mode, parent_project_id, supports_milestone_id,
      status, category, sort_order, is_draft, source_note, target_date, review_date, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, outcome = excluded.outcome, motivation = excluded.motivation,
      project_type = excluded.project_type, planning_mode = excluded.planning_mode, parent_project_id = excluded.parent_project_id,
      supports_milestone_id = excluded.supports_milestone_id,
      status = excluded.status, category = excluded.category, sort_order = excluded.sort_order,
      is_draft = excluded.is_draft, source_note = excluded.source_note,
      target_date = excluded.target_date, review_date = excluded.review_date, completed_at = excluded.completed_at,
      updated_at = excluded.updated_at`,
    bindValues: [project.id, project.title, project.outcome, project.motivation, project.projectType, project.planningMode,
      project.parentProjectId, project.supportsMilestoneId, project.status, project.category,
      project.sortOrder, project.isDraft ? 1 : 0, project.sourceNote, project.targetDate, project.reviewDate, project.completedAt,
      project.createdAt, project.updatedAt],
  };
}

function milestoneWriteStatement(milestone: Milestone): SqliteStatement {
  return {
    sql: `INSERT INTO project_milestones(
      id, project_id, title, definition_of_done, status, due_date, sort_order, created_at, updated_at, predecessor_ids
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, definition_of_done = excluded.definition_of_done,
      status = excluded.status, due_date = excluded.due_date,
      sort_order = excluded.sort_order, updated_at = excluded.updated_at, predecessor_ids = excluded.predecessor_ids`,
    bindValues: [milestone.id, milestone.projectId, milestone.title, milestone.definitionOfDone,
      milestone.status, milestone.dueDate, milestone.sortOrder, milestone.createdAt, milestone.updatedAt, milestone.predecessorIds === undefined ? null : JSON.stringify(milestone.predecessorIds)],
  };
}

function taskWriteStatement(task: ProjectTask): SqliteStatement {
  return {
    sql: `INSERT INTO project_tasks(
      id, project_id, milestone_id, direction, title, action_type, definition_of_done, steps_json, current_focus, details, benefit, due_date,
      estimated_days, auto_schedule_paused, status, waiting_for, resume_action, context, sort_order, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project_id = excluded.project_id, milestone_id = excluded.milestone_id, direction = excluded.direction, title = excluded.title,
      action_type = excluded.action_type, definition_of_done = excluded.definition_of_done,
      steps_json = excluded.steps_json, current_focus = excluded.current_focus, details = excluded.details,
      benefit = excluded.benefit, due_date = excluded.due_date,
      estimated_days = excluded.estimated_days,
      auto_schedule_paused = CASE WHEN project_tasks.due_date != excluded.due_date OR project_tasks.estimated_days != excluded.estimated_days THEN 0 ELSE excluded.auto_schedule_paused END,
      status = excluded.status,
      waiting_for = excluded.waiting_for, resume_action = excluded.resume_action,
      context = excluded.context, sort_order = excluded.sort_order,
      updated_at = excluded.updated_at, completed_at = excluded.completed_at,
      deleted_at = NULL, deleted_plan_json = ''`,
    bindValues: [task.id, task.projectId, task.milestoneId, task.direction, task.title, task.actionType,
      task.definitionOfDone, JSON.stringify(normalizeTaskSteps(task.steps)), task.currentFocus,
      task.details, task.benefit, task.dueDate, task.estimatedDays || 0, task.autoSchedulePaused ? 1 : 0, task.status, task.waitingFor,
      task.resumeAction, task.context, task.sortOrder, task.createdAt, task.updatedAt, task.completedAt],
  };
}

function normalizeTaskSteps(steps: ProjectTask["steps"] | undefined): ProjectTask["steps"] {
  return (steps ?? [])
    .map((step, index) => ({
      id: step.id || `step-${Date.now()}-${index}`,
      title: step.title.trim(),
      completed: Boolean(step.completed),
    }))
    .filter((step) => step.title);
}

function normalizePlanningMode(value: ProjectPlanningMode | undefined): ProjectPlanningMode {
  return value === "staged" || value === "adaptive" ? value : "direct";
}

function normalizeAiDate(value: string | null | undefined) {
  const normalized = value?.trim() || "";
  if (!normalized) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new ProjectRepositoryError("AI 草案包含无效日期，未写入任何内容", "invalid_data");
  }
  return normalized;
}

function resolveAdaptiveReviewDate(current: string, targetDate: string, checkpointDate: string, now: string) {
  const base = new Date(now);
  const today = [
    base.getFullYear(),
    String(base.getMonth() + 1).padStart(2, "0"),
    String(base.getDate()).padStart(2, "0"),
  ].join("-");
  base.setDate(base.getDate() + 7);
  const defaultDate = [
    base.getFullYear(),
    String(base.getMonth() + 1).padStart(2, "0"),
    String(base.getDate()).padStart(2, "0"),
  ].join("-");
  return [defaultDate, checkpointDate, targetDate, current]
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= today)
    .sort()[0] || defaultDate;
}

function parseTaskSteps(value: string | undefined): ProjectTask["steps"] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return normalizeTaskSteps(parsed.filter((step): step is ProjectTask["steps"][number] => (
      Boolean(step) && typeof step.id === "string" && typeof step.title === "string"
    )));
  } catch {
    return [];
  }
}

function parseTaskPlanSnapshot(value: string): TaskPlanSnapshotRow | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<TaskPlanSnapshotRow>;
    if (!parsed.task_id || !parsed.planned_date || !parsed.priority) return null;
    return {
      task_id: parsed.task_id,
      planned_date: parsed.planned_date,
      source: parsed.source === "auto" ? "auto" : "manual",
      skip_auto_date: parsed.skip_auto_date || "",
      priority: parsed.priority,
      estimate_minutes: Number(parsed.estimate_minutes) || 0,
      sort_order: Number(parsed.sort_order) || 0,
      updated_at: parsed.updated_at || "",
    };
  } catch {
    return null;
  }
}

function slugify(value: string) {
  return value
    .trim()
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "untitled";
}

import type {
  Milestone,
  MilestoneStatus,
  Project,
  ProjectCategory,
  ProjectDetail,
  ProjectLog,
  ProjectProposal,
  ProjectSeed,
  ProjectStatus,
  ProjectSummary,
  ProjectTask,
  ProjectTaskStatus,
  ProjectType,
  ProposalStatus,
} from "../project-types";
import { normalizeLifeDomain } from "../domain-taxonomy";
import {
  ProjectRepositoryError,
  type ProjectRepository,
} from "./project-repository";
import { executeSqliteTransaction, type SqliteDatabase, type SqliteStatement } from "./sqlite-article-repository";

type ProjectRow = {
  id: string;
  title: string;
  outcome: string;
  motivation: string;
  project_type: ProjectType;
  parent_project_id: string | null;
  supports_milestone_id: string | null;
  status: ProjectStatus;
  category: ProjectCategory;
  sort_order: number;
  is_draft: number;
  source_note: string;
  review_date: string;
  created_at: string;
  updated_at: string;
};

type MilestoneRow = {
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
  project_id: string;
  milestone_id: string | null;
  title: string;
  action_type: ProjectTask["actionType"];
  details: string;
  benefit: string;
  due_date: string;
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
  priority: string;
  estimate_minutes: number;
  sort_order: number;
  updated_at: string;
};

type ProjectLogRow = {
  id: string;
  project_id: string;
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
    parent_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    supports_milestone_id TEXT REFERENCES project_milestones(id) ON DELETE SET NULL,
    status TEXT NOT NULL,
    category TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_draft INTEGER NOT NULL DEFAULT 1,
    source_note TEXT NOT NULL DEFAULT '',
    review_date TEXT NOT NULL DEFAULT '',
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
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    milestone_id TEXT REFERENCES project_milestones(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    action_type TEXT NOT NULL DEFAULT 'organize',
    details TEXT NOT NULL DEFAULT '',
    benefit TEXT NOT NULL DEFAULT '',
    due_date TEXT NOT NULL DEFAULT '',
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
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
  "CREATE INDEX IF NOT EXISTS idx_projects_status_order ON projects(status, sort_order, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_project_milestones_project_status ON project_milestones(project_id, status, sort_order)",
  "CREATE INDEX IF NOT EXISTS idx_project_tasks_project_status ON project_tasks(project_id, status, sort_order)",
  "CREATE INDEX IF NOT EXISTS idx_project_logs_project_created ON project_logs(project_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_project_proposals_project_status ON project_proposals(project_id, status, updated_at DESC)",
] as const;

export class SqliteProjectRepository implements ProjectRepository {
  private initialization: Promise<void> | null = null;

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

  private async applyMigrationsAndSeed() {
    await this.database.execute("PRAGMA foreign_keys = ON");
    for (const statement of migrations) await this.database.execute(statement);
    await this.ensureColumn("projects", "review_date", "TEXT NOT NULL DEFAULT ''");
    await this.ensureColumn("projects", "project_type", "TEXT NOT NULL DEFAULT 'main'");
    await this.ensureColumn("projects", "parent_project_id", "TEXT");
    await this.ensureColumn("projects", "supports_milestone_id", "TEXT");
    await this.ensureColumn("project_milestones", "due_date", "TEXT NOT NULL DEFAULT ''");
    await this.ensureColumn("project_tasks", "action_type", "TEXT NOT NULL DEFAULT 'organize'");
    await this.ensureColumn("project_tasks", "details", "TEXT NOT NULL DEFAULT ''");
    await this.ensureColumn("project_tasks", "benefit", "TEXT NOT NULL DEFAULT ''");
    await this.ensureColumn("project_tasks", "due_date", "TEXT NOT NULL DEFAULT ''");
    await this.ensureColumn("project_tasks", "deleted_at", "TEXT");
    await this.ensureColumn("project_tasks", "deleted_plan_json", "TEXT NOT NULL DEFAULT ''");
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
    await this.database.execute("PRAGMA optimize");

    const seeded = await this.database.select<{ value: string }>(
      "SELECT value FROM app_meta WHERE key = 'project_seed_version' LIMIT 1",
    );
    if (seeded[0]?.value === "3") return;

    for (const seed of this.options.seedProjects ?? []) {
      await this.insertSeed(seed);
    }
    await this.database.execute(
      `INSERT INTO app_meta(key, value) VALUES('project_seed_version', '3')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
  }

  private async ensureColumn(table: string, column: string, definition: string) {
    const columns = await this.database.select<{ name: string }>(`PRAGMA table_info(${table})`);
    if (columns.some((item) => item.name === column)) return;
    await this.database.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private async insertSeed(seed: ProjectSeed) {
    await this.writeProject(seed.project, true);
    for (const milestone of seed.milestones) await this.writeMilestone(milestone, true);
    for (const task of seed.tasks) await this.writeTask(task, true);
    for (const log of seed.logs) {
      await this.database.execute(
        `INSERT INTO project_logs(id, project_id, body, created_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        [log.id, log.projectId, log.body, log.createdAt],
      );
    }
    for (const proposal of seed.proposals ?? []) await this.writeProposal(proposal, true);
  }

  async list(): Promise<ProjectSummary[]> {
    try {
      await this.initialize();
      const rows = await this.database.select<ProjectRow>(
        `SELECT * FROM projects
         ORDER BY
           CASE status WHEN 'active' THEN 0 WHEN 'waiting' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
           sort_order ASC,
           updated_at DESC`,
      );
      return Promise.all(rows.map(async (row) => {
        const project = rowToProject(row);
        const milestones = await this.listMilestones(project.id);
        const tasks = await this.listTasks(project.id);
        return {
          ...project,
          currentMilestone: milestones.find((item) => item.status === "current") ?? null,
          nextTask: tasks.find((item) => item.status === "next")
            ?? tasks.find((item) => item.status === "waiting")
            ?? null,
          openTaskCount: tasks.filter((item) => item.status !== "done").length,
          completedTaskCount: tasks.filter((item) => item.status === "done").length,
          milestoneCount: milestones.length,
          completedMilestoneCount: milestones.filter((item) => item.status === "completed").length,
        };
      }));
    } catch (error) {
      throw new ProjectRepositoryError("读取本地项目失败", "read_failed", error);
    }
  }

  async get(id: string): Promise<ProjectDetail | null> {
    try {
      await this.initialize();
      const rows = await this.database.select<ProjectRow>(
        "SELECT * FROM projects WHERE id = ? LIMIT 1",
        [id],
      );
      if (!rows[0]) return null;
      const [milestones, tasks, logs, proposals] = await Promise.all([
        this.listMilestones(id),
        this.listTasks(id),
        this.listLogs(id),
        this.listProposals(id),
      ]);
      return { project: rowToProject(rows[0]), milestones, tasks, logs, proposals };
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("读取项目详情失败", "read_failed", error);
    }
  }

  async saveProject(project: Project): Promise<Project> {
    if (!project.title.trim() || !project.outcome.trim()) {
      throw new ProjectRepositoryError("项目名称和期望结果不能为空", "invalid_data");
    }
    try {
      await this.initialize();
      const now = this.now();
      const relationship = await this.normalizeRelationship(project);
      const saved: Project = {
        ...relationship,
        id: project.id || `project-${slugify(project.title)}-${Date.now()}`,
        title: project.title.trim(),
        outcome: project.outcome.trim(),
        motivation: project.motivation.trim(),
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
      await executeSqliteTransaction(this.database, [
        {
          sql: "UPDATE projects SET status = ?, updated_at = ? WHERE id = ?",
          bindValues: [status, now, id],
        },
        {
          sql: "INSERT INTO project_logs(id, project_id, body, created_at) VALUES (?, ?, ?, ?)",
          bindValues: [`${id}-log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, id, text, now],
        },
      ]);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("更新项目状态失败，原状态已保留", "save_failed", error);
    }
  }

  async saveWorkspace(project: Project, milestones: Milestone[], task: ProjectTask | null, branches: Project[] = []): Promise<Project> {
    try {
      await this.initialize();
      if (!project.title.trim() || !project.outcome.trim()) {
        throw new ProjectRepositoryError("项目名称和期望结果不能为空", "invalid_data");
      }
      const now = this.now();
      const relationship = await this.normalizeRelationship(project);
      const savedProject: Project = {
        ...relationship,
        id: project.id || `project-${slugify(project.title)}-${Date.now()}`,
        title: project.title.trim(),
        outcome: project.outcome.trim(),
        motivation: project.motivation.trim(),
        createdAt: project.createdAt || now,
        updatedAt: now,
      };
      const savedMilestones = milestones.filter((milestone) => milestone.title.trim()).map((milestone, index) => ({
        ...milestone,
        id: milestone.id || `${savedProject.id}-milestone-${Date.now()}-${index}`,
        projectId: savedProject.id,
        title: milestone.title.trim(),
        definitionOfDone: milestone.definitionOfDone.trim(),
        createdAt: milestone.createdAt || now,
        updatedAt: now,
      }));
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
        milestoneId: taskMilestoneId,
        title: task.title.trim(),
        status: savedProject.status === "waiting" ? "waiting" as const : task.status,
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
          parentProjectId: detached ? null : savedProject.id,
          supportsMilestoneId,
          category: savedProject.category,
          createdAt: branch.createdAt || now,
          updatedAt: now,
        };
      });

      const existingMilestones = project.id
        ? await this.database.select<{ id: string }>("SELECT id FROM project_milestones WHERE project_id = ?", [project.id])
        : [];
      const savedMilestoneIds = new Set(savedMilestones.map((milestone) => milestone.id));
      const removedMilestones = existingMilestones.filter((milestone) => !savedMilestoneIds.has(milestone.id));
      const statements: SqliteStatement[] = [projectWriteStatement(savedProject), ...savedBranches.map(projectWriteStatement)];
      for (const milestone of removedMilestones) {
        statements.push({ sql: "DELETE FROM project_milestones WHERE id = ?", bindValues: [milestone.id] });
      }
      for (const milestone of savedMilestones) {
        if (milestone.status === "current") {
          statements.push({
            sql: "UPDATE project_milestones SET status = 'planned', updated_at = ? WHERE project_id = ? AND status = 'current' AND id != ?",
            bindValues: [now, savedProject.id, milestone.id],
          });
        }
        statements.push(milestoneWriteStatement(milestone));
      }
      if (savedTask) {
        if (savedTask.status === "next") {
          statements.push({
            sql: "UPDATE project_tasks SET status = 'later', updated_at = ? WHERE project_id = ? AND status = 'next' AND id != ?",
            bindValues: [now, savedProject.id, savedTask.id],
          });
        }
        statements.push(taskWriteStatement(savedTask));
      }
      await executeSqliteTransaction(this.database, statements);
      return savedProject;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("保存项目工作区失败，原内容已保留", "save_failed", error);
    }
  }

  async saveMilestone(milestone: Milestone): Promise<Milestone> {
    if (!milestone.title.trim()) {
      throw new ProjectRepositoryError("里程碑名称不能为空", "invalid_data");
    }
    try {
      await this.initialize();
      const now = this.now();
      const saved = {
        ...milestone,
        id: milestone.id || `${milestone.projectId}-milestone-${Date.now()}`,
        title: milestone.title.trim(),
        definitionOfDone: milestone.definitionOfDone.trim(),
        createdAt: milestone.createdAt || now,
        updatedAt: now,
      };
      const statements: SqliteStatement[] = [];
      if (saved.status === "current") {
        statements.push({
          sql: "UPDATE project_milestones SET status = 'planned', updated_at = ? WHERE project_id = ? AND status = 'current' AND id != ?",
          bindValues: [now, saved.projectId, saved.id],
        });
      }
      statements.push(milestoneWriteStatement(saved));
      statements.push({
        sql: "UPDATE projects SET updated_at = ? WHERE id = ?",
        bindValues: [now, saved.projectId],
      });
      await executeSqliteTransaction(this.database, statements);
      return saved;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("保存里程碑失败", "save_failed", error);
    }
  }

  async removeProject(id: string): Promise<void> {
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
      for (const table of ["project_proposals", "project_logs", "project_tasks", "project_milestones"]) {
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
    try {
      await this.initialize();
      const rows = await this.database.select<MilestoneRow>(
        "SELECT * FROM project_milestones WHERE id = ? LIMIT 1",
        [id],
      );
      if (!rows[0]) throw new ProjectRepositoryError("没有找到这个阶段", "invalid_data");
      await this.database.execute("DELETE FROM project_milestones WHERE id = ?", [id]);
      await this.touchProject(rows[0].project_id, this.now());
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("删除阶段失败", "save_failed", error);
    }
  }

  async saveTask(task: ProjectTask): Promise<ProjectTask> {
    if (!task.title.trim()) {
      throw new ProjectRepositoryError("行动名称不能为空", "invalid_data");
    }
    try {
      await this.initialize();
      const now = this.now();
      const saved = {
        ...task,
        id: task.id || `${task.projectId}-task-${Date.now()}`,
        title: task.title.trim(),
        waitingFor: task.waitingFor.trim(),
        resumeAction: task.resumeAction.trim(),
        createdAt: task.createdAt || now,
        updatedAt: now,
        completedAt: task.status === "done" ? task.completedAt || now : null,
      };
      const statements: SqliteStatement[] = [];
      if (saved.status === "next") {
        statements.push({
          sql: "UPDATE project_tasks SET status = 'later', updated_at = ? WHERE project_id = ? AND status = 'next' AND id != ?",
          bindValues: [now, saved.projectId, saved.id],
        });
      }
      statements.push(taskWriteStatement(saved));
      statements.push({
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
      statements.push({ sql: "UPDATE projects SET updated_at = ? WHERE id = ?", bindValues: [now, rows[0].project_id] });
      await executeSqliteTransaction(this.database, statements);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("删除行动失败，原内容已保留", "save_failed", error);
    }
  }

  async restoreTask(id: string): Promise<void> {
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
      if (plan) statements.push({
        sql: `INSERT INTO task_plans(task_id, planned_date, priority, estimate_minutes, sort_order, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(task_id) DO UPDATE SET planned_date = excluded.planned_date, priority = excluded.priority,
                estimate_minutes = excluded.estimate_minutes, sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
        bindValues: [plan.task_id, plan.planned_date, plan.priority, plan.estimate_minutes, plan.sort_order, now],
      });
      statements.push({ sql: "UPDATE projects SET updated_at = ? WHERE id = ?", bindValues: [now, rows[0].project_id] });
      await executeSqliteTransaction(this.database, statements);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("恢复行动失败", "save_failed", error);
    }
  }

  async updateTaskStatus(id: string, status: ProjectTaskStatus): Promise<void> {
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
          sql: "UPDATE project_tasks SET status = 'later', updated_at = ? WHERE project_id = ? AND status = 'next' AND id != ?",
          bindValues: [now, rows[0].project_id, id],
        });
      }
      statements.push({
        sql: `UPDATE project_tasks
              SET status = ?, updated_at = ?, completed_at = ?
              WHERE id = ?`,
        bindValues: [status, now, status === "done" ? now : null, id],
      });
      statements.push({
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
      await executeSqliteTransaction(this.database, [
        {
          sql: `UPDATE project_tasks SET status = 'done', updated_at = ?, completed_at = ? WHERE id = ?`,
          bindValues: [now, now, id],
        },
        {
          sql: "INSERT INTO project_logs(id, project_id, body, created_at) VALUES (?, ?, ?, ?)",
          bindValues: [`${rows[0].project_id}-log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, rows[0].project_id, text, now],
        },
        {
          sql: "UPDATE projects SET updated_at = ? WHERE id = ?",
          bindValues: [now, rows[0].project_id],
        },
      ]);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("完成行动失败，原状态已保留", "save_failed", error);
    }
  }

  async saveProposal(proposal: ProjectProposal): Promise<ProjectProposal> {
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

  async addLog(projectId: string, body: string): Promise<ProjectLog> {
    const text = body.trim();
    if (!text) throw new ProjectRepositoryError("推进记录不能为空", "invalid_data");
    try {
      await this.initialize();
      const now = this.now();
      const log = {
        id: `${projectId}-log-${Date.now()}`,
        projectId,
        body: text,
        createdAt: now,
      };
      await this.database.execute(
        "INSERT INTO project_logs(id, project_id, body, created_at) VALUES (?, ?, ?, ?)",
        [log.id, log.projectId, log.body, log.createdAt],
      );
      await this.touchProject(projectId, now);
      return log;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError("保存推进记录失败", "save_failed", error);
    }
  }

  async confirmProject(id: string): Promise<void> {
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

  private async listMilestones(projectId: string) {
    const rows = await this.database.select<MilestoneRow>(
      `SELECT * FROM project_milestones WHERE project_id = ?
       ORDER BY sort_order ASC, created_at ASC`,
      [projectId],
    );
    return rows.map(rowToMilestone);
  }

  private async listTasks(projectId: string) {
    const rows = await this.database.select<ProjectTaskRow>(
      `SELECT * FROM project_tasks WHERE project_id = ? AND deleted_at IS NULL
       ORDER BY CASE status WHEN 'next' THEN 0 WHEN 'waiting' THEN 1 WHEN 'later' THEN 2 ELSE 3 END, sort_order ASC, updated_at DESC`,
      [projectId],
    );
    return rows.map(rowToTask);
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
        id, title, outcome, motivation, project_type, parent_project_id, supports_milestone_id,
        status, category, sort_order, is_draft, source_note, review_date, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO ${seed ? "NOTHING" : `UPDATE SET
        title = excluded.title,
        outcome = excluded.outcome,
        motivation = excluded.motivation,
        project_type = excluded.project_type,
        parent_project_id = excluded.parent_project_id,
        supports_milestone_id = excluded.supports_milestone_id,
        status = excluded.status,
        category = excluded.category,
        sort_order = excluded.sort_order,
        is_draft = excluded.is_draft,
        source_note = excluded.source_note,
        review_date = excluded.review_date,
        updated_at = excluded.updated_at`}`,
      [
        project.id,
        project.title,
        project.outcome,
        project.motivation,
        project.projectType,
        project.parentProjectId,
        project.supportsMilestoneId,
        project.status,
        project.category,
        project.sortOrder,
        project.isDraft ? 1 : 0,
        project.sourceNote,
        project.reviewDate,
        project.createdAt,
        project.updatedAt,
      ],
    );
  }

  private async writeMilestone(milestone: Milestone, seed: boolean) {
    await this.database.execute(
      `INSERT INTO project_milestones(
        id, project_id, title, definition_of_done, status, due_date, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      ],
    );
  }

  private async writeTask(task: ProjectTask, seed: boolean) {
    await this.database.execute(
      `INSERT INTO project_tasks(
        id, project_id, milestone_id, title, action_type, details, benefit, due_date,
        status, waiting_for, resume_action, context, sort_order, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO ${seed ? "NOTHING" : `UPDATE SET
        milestone_id = excluded.milestone_id,
        title = excluded.title,
        action_type = excluded.action_type,
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
        task.title,
        task.actionType,
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
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    title: row.title,
    outcome: row.outcome,
    motivation: row.motivation,
    projectType: row.project_type || "main",
    parentProjectId: row.parent_project_id || null,
    supportsMilestoneId: row.supports_milestone_id || null,
    status: row.status,
    category: normalizeLifeDomain(row.category),
    sortOrder: Number(row.sort_order),
    isDraft: Boolean(row.is_draft),
    sourceNote: row.source_note,
    reviewDate: row.review_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMilestone(row: MilestoneRow): Milestone {
  return {
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
    title: row.title,
    actionType: row.action_type,
    details: row.details,
    benefit: row.benefit,
    dueDate: row.due_date,
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

function projectWriteStatement(project: Project): SqliteStatement {
  return {
    sql: `INSERT INTO projects(
      id, title, outcome, motivation, project_type, parent_project_id, supports_milestone_id,
      status, category, sort_order, is_draft, source_note, review_date, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, outcome = excluded.outcome, motivation = excluded.motivation,
      project_type = excluded.project_type, parent_project_id = excluded.parent_project_id,
      supports_milestone_id = excluded.supports_milestone_id,
      status = excluded.status, category = excluded.category, sort_order = excluded.sort_order,
      is_draft = excluded.is_draft, source_note = excluded.source_note,
      review_date = excluded.review_date, updated_at = excluded.updated_at`,
    bindValues: [project.id, project.title, project.outcome, project.motivation, project.projectType,
      project.parentProjectId, project.supportsMilestoneId, project.status, project.category,
      project.sortOrder, project.isDraft ? 1 : 0, project.sourceNote, project.reviewDate,
      project.createdAt, project.updatedAt],
  };
}

function milestoneWriteStatement(milestone: Milestone): SqliteStatement {
  return {
    sql: `INSERT INTO project_milestones(
      id, project_id, title, definition_of_done, status, due_date, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, definition_of_done = excluded.definition_of_done,
      status = excluded.status, due_date = excluded.due_date,
      sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
    bindValues: [milestone.id, milestone.projectId, milestone.title, milestone.definitionOfDone,
      milestone.status, milestone.dueDate, milestone.sortOrder, milestone.createdAt, milestone.updatedAt],
  };
}

function taskWriteStatement(task: ProjectTask): SqliteStatement {
  return {
    sql: `INSERT INTO project_tasks(
      id, project_id, milestone_id, title, action_type, details, benefit, due_date,
      status, waiting_for, resume_action, context, sort_order, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      milestone_id = excluded.milestone_id, title = excluded.title,
      action_type = excluded.action_type, details = excluded.details,
      benefit = excluded.benefit, due_date = excluded.due_date, status = excluded.status,
      waiting_for = excluded.waiting_for, resume_action = excluded.resume_action,
      context = excluded.context, sort_order = excluded.sort_order,
      updated_at = excluded.updated_at, completed_at = excluded.completed_at,
      deleted_at = NULL, deleted_plan_json = ''`,
    bindValues: [task.id, task.projectId, task.milestoneId, task.title, task.actionType,
      task.details, task.benefit, task.dueDate, task.status, task.waitingFor,
      task.resumeAction, task.context, task.sortOrder, task.createdAt, task.updatedAt, task.completedAt],
  };
}

function parseTaskPlanSnapshot(value: string): TaskPlanSnapshotRow | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<TaskPlanSnapshotRow>;
    if (!parsed.task_id || !parsed.planned_date || !parsed.priority) return null;
    return {
      task_id: parsed.task_id,
      planned_date: parsed.planned_date,
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

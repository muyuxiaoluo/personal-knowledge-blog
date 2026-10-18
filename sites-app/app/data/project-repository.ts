import type {
  Milestone,
  Project,
  ProjectAccumulation,
  ProjectDetail,
  ProjectLog,
  ProjectProposal,
  ProjectStatus,
  ProjectSummary,
  ProjectTask,
  ProjectTaskStatus,
  ProposalStatus,
} from "../project-types";
import type { ProjectAdjustmentDraft, ProjectRouteDraft } from "../ai-api-types";

export interface ProjectRepository {
  list(): Promise<ProjectSummary[]>;
  listIndexDetails(): Promise<ProjectDetail[]>;
  listStandaloneTasks(): Promise<ProjectTask[]>;
  listTaskLogs(taskId: string): Promise<ProjectLog[]>;
  get(id: string): Promise<ProjectDetail | null>;
  saveProject(project: Project): Promise<Project>;
  saveWorkspace(project: Project, milestones: Milestone[], task: ProjectTask | null, branches?: Project[]): Promise<Project>;
  updateProjectStatus(id: string, status: ProjectStatus, logBody: string): Promise<void>;
  removeProject(id: string): Promise<void>;
  saveMilestone(milestone: Milestone): Promise<Milestone>;
  completeMilestone(id: string, logBody: string): Promise<Milestone | null>;
  removeMilestone(id: string): Promise<void>;
  saveTask(task: ProjectTask): Promise<ProjectTask>;
  removeTask(id: string): Promise<void>;
  restoreTask(id: string): Promise<void>;
  updateTaskStatus(id: string, status: ProjectTaskStatus): Promise<void>;
  completeTask(id: string, logBody: string): Promise<void>;
  recordTaskProgress(id: string, result: string, nextFocus: string): Promise<void>;
  saveProposal(proposal: ProjectProposal): Promise<ProjectProposal>;
  updateProposalStatus(id: string, status: ProposalStatus, reviewNote: string): Promise<void>;
  removeProposal(id: string): Promise<void>;
  saveAccumulation(accumulation: ProjectAccumulation): Promise<ProjectAccumulation>;
  removeAccumulation(id: string): Promise<void>;
  addLog(projectId: string | null, body: string, taskId?: string | null, kind?: ProjectLog["kind"]): Promise<ProjectLog>;
  applyProjectAdjustment(draft: ProjectAdjustmentDraft): Promise<void>;
  applyProjectRoute(draft: ProjectRouteDraft): Promise<void>;
  confirmProject(id: string): Promise<void>;
}

export class ProjectRepositoryError extends Error {
  constructor(
    message: string,
    readonly code: "read_failed" | "save_failed" | "invalid_data",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProjectRepositoryError";
  }
}

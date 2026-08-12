import type {
  Milestone,
  Project,
  ProjectDetail,
  ProjectLog,
  ProjectProposal,
  ProjectSummary,
  ProjectTask,
  ProjectTaskStatus,
  ProposalStatus,
} from "../project-types";

export interface ProjectRepository {
  list(): Promise<ProjectSummary[]>;
  get(id: string): Promise<ProjectDetail | null>;
  saveProject(project: Project): Promise<Project>;
  saveWorkspace(project: Project, milestones: Milestone[], task: ProjectTask | null): Promise<Project>;
  saveMilestone(milestone: Milestone): Promise<Milestone>;
  removeMilestone(id: string): Promise<void>;
  saveTask(task: ProjectTask): Promise<ProjectTask>;
  updateTaskStatus(id: string, status: ProjectTaskStatus): Promise<void>;
  completeTask(id: string, logBody: string): Promise<void>;
  saveProposal(proposal: ProjectProposal): Promise<ProjectProposal>;
  updateProposalStatus(id: string, status: ProposalStatus, reviewNote: string): Promise<void>;
  addLog(projectId: string, body: string): Promise<ProjectLog>;
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

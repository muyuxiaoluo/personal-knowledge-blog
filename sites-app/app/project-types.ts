import type { LifeDomain } from "./domain-taxonomy";

export type ProjectStatus = "active" | "paused" | "completed";

export type ProjectCategory = LifeDomain;

export type ProjectType = "main" | "side" | "experiment";

export type ProjectPlanningMode = "direct" | "staged" | "adaptive";

export type MilestoneStatus = "current" | "planned" | "completed" | "superseded";

export type ProjectTaskStatus = "next" | "later" | "waiting" | "done" | "cancelled";

export type ProjectLogKind = "general" | "continuation" | "task_progress" | "task_completed" | "plan_revision";

export type ProjectTaskStep = {
  id: string;
  title: string;
  completed: boolean;
};

export type ProposalStatus =
  | "pending"
  | "experiment"
  | "accepted"
  | "deferred"
  | "rejected";

export type ActionType =
  | "read"
  | "write"
  | "experiment"
  | "decide"
  | "organize"
  | "communicate"
  | "life";

export type Project = {
  id: string;
  title: string;
  outcome: string;
  motivation: string;
  projectType: ProjectType;
  planningMode: ProjectPlanningMode;
  parentProjectId: string | null;
  supportsMilestoneId: string | null;
  status: ProjectStatus;
  category: ProjectCategory;
  sortOrder: number;
  isDraft: boolean;
  sourceNote: string;
  targetDate: string;
  reviewDate: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Milestone = {
  id: string;
  projectId: string;
  title: string;
  definitionOfDone: string;
  status: MilestoneStatus;
  dueDate: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type ProjectTask = {
  id: string;
  projectId: string | null;
  milestoneId: string | null;
  direction: ProjectCategory;
  title: string;
  actionType: ActionType;
  definitionOfDone: string;
  steps: ProjectTaskStep[];
  currentFocus: string;
  details: string;
  benefit: string;
  dueDate: string;
  status: ProjectTaskStatus;
  waitingFor: string;
  resumeAction: string;
  context: "anywhere" | "computer" | "phone";
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type ProjectLog = {
  id: string;
  projectId: string | null;
  taskId: string | null;
  kind: ProjectLogKind;
  body: string;
  createdAt: string;
};

export type ProjectProposal = {
  id: string;
  projectId: string;
  title: string;
  problem: string;
  expectedValue: string;
  cost: string;
  status: ProposalStatus;
  reviewNote: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectSummary = Project & {
  currentMilestone: Milestone | null;
  nextTask: ProjectTask | null;
  openTaskCount: number;
  completedTaskCount: number;
  milestoneCount: number;
  completedMilestoneCount: number;
};

export type ProjectDetail = {
  project: Project;
  milestones: Milestone[];
  tasks: ProjectTask[];
  logs: ProjectLog[];
  proposals: ProjectProposal[];
};

export type ProjectSeed = {
  project: Project;
  milestones: Milestone[];
  tasks: ProjectTask[];
  logs: ProjectLog[];
  proposals?: ProjectProposal[];
};

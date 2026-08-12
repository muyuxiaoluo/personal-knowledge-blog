export type ProjectStatus = "active" | "waiting" | "paused" | "completed";

export type ProjectCategory =
  | "research"
  | "creative"
  | "product"
  | "maintenance"
  | "support"
  | "personal";

export type MilestoneStatus = "current" | "planned" | "completed";

export type ProjectTaskStatus = "next" | "later" | "waiting" | "done";

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
  status: ProjectStatus;
  category: ProjectCategory;
  sortOrder: number;
  isDraft: boolean;
  sourceNote: string;
  reviewDate: string;
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
  projectId: string;
  milestoneId: string | null;
  title: string;
  actionType: ActionType;
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
  projectId: string;
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

import type { LifeDomain } from "./domain-taxonomy";
import type { ProjectPlanningMode, ProjectTaskStatus } from "./project-types";

export type DeepSeekApiFeature = "projectCreate" | "projectReplan" | "nextAction" | "financeReport" | "healthAdvice";

export type DeepSeekModelSettings = {
  defaultModel: string;
  overrides: Record<DeepSeekApiFeature, string>;
};

export type DeepSeekModel = {
  id: string;
  object: string;
  ownedBy: string;
};

export type DeepSeekTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type DeepSeekStructuredResponse<T> = {
  content: T;
  model: string;
  tokenUsage: DeepSeekTokenUsage;
};

export type ProjectCreationProposal = {
  classification: "standalone_action" | "project";
  reason: string;
  planningMode: ProjectPlanningMode;
  project: {
    title: string;
    outcome: string;
    motivation: string;
    category: LifeDomain;
    targetDate: string;
    reviewDate: string;
  };
  milestones: Array<{
    clientId: string;
    title: string;
    definitionOfDone: string;
    dueDate: string;
    status: "current" | "planned";
  }>;
  firstAction: {
    title: string;
    currentFocus: string;
    definitionOfDone: string;
    details: string;
    dueDate: string;
    direction: LifeDomain;
  };
  assumptions: string[];
  risks: string[];
};

export type ProjectReplanProposal = {
  summary: string;
  projectPatch: { outcome: string | null; targetDate: string | null; reviewDate: string | null };
  milestoneChanges: Array<{
    id: string;
    action: "complete" | "postpone" | "supersede" | "replace";
    title: string | null;
    definitionOfDone: string | null;
    dueDate: string | null;
    selected: boolean;
  }>;
  newMilestones: Array<{
    clientId: string;
    title: string;
    definitionOfDone: string;
    dueDate: string;
    status: "current" | "planned";
    selected: boolean;
  }>;
  taskChanges: Array<{
    id: string;
    action: "complete" | "postpone" | "cancel" | "replace";
    title: string | null;
    currentFocus: string | null;
    definitionOfDone: string | null;
    dueDate: string | null;
    status: ProjectTaskStatus | null;
    selected: boolean;
  }>;
  newTasks: Array<{
    clientId: string;
    milestoneId: string | null;
    title: string;
    currentFocus: string;
    definitionOfDone: string;
    details: string;
    dueDate: string;
    selected: boolean;
  }>;
  assumptions: string[];
  risks: string[];
};

export type NextActionProposal = {
  reason: string;
  action: {
    milestoneId: string | null;
    title: string;
    currentFocus: string;
    definitionOfDone: string;
    details: string;
    dueDate: string;
  };
};

export type ActionDaysEstimate = {
  days: number | null;
  reason: string;
};

export type ProjectRouteProposalNode = {
  ref: string;
  existingMilestoneId: string | null;
  action: "keep" | "update" | "supersede" | "create";
  title: string;
  definitionOfDone: string;
  dueDate: string;
  status: "current" | "planned";
  predecessorRefs: string[];
};

export type ProjectRouteProposal = {
  summary: string;
  nodes: ProjectRouteProposalNode[];
  assumptions: string[];
  risks: string[];
};

export type ProjectRouteDraft = {
  projectId: string;
  currentSituation: string;
  requirements: string;
  proposal: ProjectRouteProposal;
  model: string;
  tokenUsage: DeepSeekTokenUsage;
};

export type ProjectAdjustmentDraft = {
  projectId: string;
  trigger: string;
  proposal: ProjectReplanProposal;
  model: string;
  tokenUsage: DeepSeekTokenUsage;
};

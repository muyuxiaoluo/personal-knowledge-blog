import type { Milestone, ProjectDetail } from "./project-types";
import { decodeTaskProgressLog } from "./home-workflow";
import { projectDecisionRecords, projectMaterialKind, scopeProjectAiRecords } from "./project-ai-context";
import type { StoredArticle } from "./types";
import { asabaJobLabels, type AsabaJob } from "./companion-types";
import { projectJobGroups } from "./project-selectors";

export type AsabaPlan = {
  kind: "new_project" | "existing_project" | "action" | "note";
  projectId: string | null;
  title: string;
  outcome: string;
  reason: string;
  questions: string[];
  action: string;
};

export type AsabaPlanPreview = AsabaPlan & {
  projectTitle: string;
  milestone: { id: string; title: string } | null;
  expectedUpdatedAt?: string;
  completionCondition?: string;
};

export type AsabaPlanRoute = AsabaPlan | (Omit<AsabaPlan, "kind"> & { kind: "project_progress" });

export type AsabaProgressAnswer = {
  summary: string;
  findings: { text: string; evidenceIds: string[] }[];
  unknowns: string[];
  nextAction: string;
  decision?: "continue" | "new_action" | "clarify" | "wait" | "delegate" | "adjust" | "keep";
  taskEvidenceId?: string | null;
  completionCondition?: string;
  decisionEvidenceIds?: string[];
};

export type AsabaProgressEvidence = {
  id: string;
  kind: "milestone" | "progress" | "completed" | "continuation" | "accumulation" | "waiting" | "action" | "decision" | "confirmed_outcome" | "worker_report" | "worker_status" | "authorized_note" | "goal_change" | "user_input";
  title: string;
  text: string;
  date: string;
  projectId?: string;
  milestoneId?: string | null;
};

export type AsabaPlanningResult =
  | { kind: "plan"; draft: AsabaPlanPreview }
  | { kind: "choose_project"; projects: { id: string; title: string; outcome: string }[] }
  | AsabaProjectDecision;

export type AsabaProjectDecision = { kind: "progress"; projectId: string; projectTitle: string; expectedUpdatedAt: string; answer: AsabaProgressAnswer; evidence: AsabaProgressEvidence[]; actionDraft: AsabaPlanPreview | null; canAdjust: boolean; existingAction?: { id: string; title: string }; investigation?: string };

export const maxAuthorizedProjectNotes = 3;
export type AsabaProjectNote = { id: string; title: string };

export async function readAuthorizedProjectEvidence(projectId: string, noteIds: string[], readNote: (id: string) => Promise<StoredArticle | null>) {
  const notes = await Promise.all([...new Set(noteIds)].slice(0, maxAuthorizedProjectNotes).map(readNote));
  return notes.flatMap((note): AsabaProgressEvidence[] => {
    if (!note || note.projectId !== projectId || note.storage.deletedAt || !note.body.trim()) return [];
    const body = note.body.trim();
    return [{ id: "note:" + note.id, kind: "authorized_note", title: note.title.slice(0, 140),
      text: body.slice(0, 1800) + (body.length > 1800 ? "…（节选）" : ""), date: note.updated, projectId }];
  });
}

export type AsabaAdjustmentRequest = { id: string; projectId: string; request: string; suggestion: string; expectedUpdatedAt?: string };
export type AskProjectDecision = (projectId: string, request: string, milestoneId?: string | null) => Promise<AsabaProjectDecision>;
export type ProjectDecisionActions = {
  ask: AskProjectDecision;
  delegate: (result: AsabaProjectDecision) => Promise<void>;
  adjust: (request: AsabaAdjustmentRequest) => Promise<void>;
};

export function projectDelegationSource(result: AsabaProjectDecision) {
  if (result.answer.decision !== "delegate" || !result.answer.completionCondition?.trim()) throw new Error("委托需要明确的任务与验收条件。");
  return { noteId: "project-decision:" + crypto.randomUUID(), projectId: result.projectId, title: result.answer.nextAction.slice(0, 100), repository: "",
    description: result.answer.nextAction + "\n\n验收条件\n" + result.answer.completionCondition };
}

export function buildAsabaProgressInput(request: string, detail: ProjectDetail, branch?: Milestone | null, jobs: AsabaJob[] = []) {
  const { project, milestones, tasks, logs, accumulations } = scopeProjectAiRecords(detail, branch);
  const taskById = new Map(tasks.map((item) => [item.id, item]));
  const byRecent = <T,>(items: T[], date: (item: T) => string) =>
    [...items].sort((left, right) => date(right).localeCompare(date(left)));
  const clip = (value: string, max = 340) => value.trim().slice(0, max);
  const currentMilestones = new Set(milestones.filter((node) => node.status === "current").map((node) => node.id));
  const activeTasks = project.status === "active" ? byRecent(tasks.filter((item) => (item.status === "next" || item.status === "later") &&
    (!item.milestoneId || currentMilestones.has(item.milestoneId))), (item) => item.updatedAt)
    .sort((left, right) => Number(right.status === "next") - Number(left.status === "next")).slice(0, 5) : [];
  const evidence: AsabaProgressEvidence[] = [
    { id: "request:current", kind: "user_input", title: "本次提供的问题或变化", text: clip(request, 4000), date: "" },
    ...projectDecisionRecords(detail).map((item): AsabaProgressEvidence => ({
      id: "proposal:" + item.id, kind: "decision", title: item.title,
      text: clip((item.status === "accepted" ? "已采纳" : item.status === "deferred" ? "已暂缓" : "已否决") + (item.reason ? " · " + item.reason : "")), date: item.decidedAt,
    })),
    ...byRecent(milestones.filter(item => item.status !== "superseded"), item => item.updatedAt)
      .sort((a, b) => Number(b.id === branch?.id || b.status === "current") - Number(a.id === branch?.id || a.status === "current")).slice(0, 8).map((item): AsabaProgressEvidence => ({
      id: "milestone:" + item.id, kind: "milestone", title: clip(item.title, 140),
      text: clip([item.status === "completed" ? "已确认达成" : item.status === "current" ? "当前节点" : "计划节点",
        item.dueDate && (item.dueDateKind === "deadline" ? "明确截止 " : "预期日期 ") + item.dueDate, item.definitionOfDone].filter(Boolean).join(" · ")),
      date: item.updatedAt, milestoneId: item.id,
    })),
    ...byRecent(tasks.filter(item => item.status === "waiting"), item => item.updatedAt).slice(0, 6).map((item): AsabaProgressEvidence => ({
      id: "task:" + item.id, kind: "waiting", title: clip(item.title, 140), text: clip([item.waitingFor, item.resumeAction].filter(Boolean).join(" · ")), date: item.updatedAt, milestoneId: item.milestoneId,
    })),
    ...activeTasks.map((item): AsabaProgressEvidence => ({
      id: "task:" + item.id, kind: "action", title: clip(item.title, 140), text: clip([item.currentFocus, item.definitionOfDone].filter(Boolean).join(" · ")), date: item.updatedAt, milestoneId: item.milestoneId,
    })),
    ...byRecent(tasks.filter(item => item.status === "done"), item => item.completedAt || item.updatedAt).slice(0, 4).map((item): AsabaProgressEvidence => ({
      id: "task:" + item.id, kind: "completed", title: clip(item.title, 140), text: "行动已标记完成", date: item.completedAt || item.updatedAt, milestoneId: item.milestoneId,
    })),
    ...byRecent(logs.filter(item => item.kind !== "plan_revision" && item.kind !== "goal_revision"), item => item.createdAt).slice(0, 8).map((item): AsabaProgressEvidence => ({
      id: "log:" + item.id, kind: item.kind === "task_completed" ? "completed" : item.kind === "continuation" ? "continuation" : "progress",
      title: clip((item.taskId && taskById.get(item.taskId)?.title) || (item.kind === "continuation" ? "接续记录" : "行动记录"), 140),
      text: clip(decodeTaskProgressLog(item.body)?.result ?? (item.body.startsWith("接续点｜") ? item.body.split("｜").slice(3).join("｜") : item.body)), date: item.createdAt,
      milestoneId: item.taskId ? taskById.get(item.taskId)?.milestoneId : null,
    })),
    ...byRecent(logs.filter(item => item.kind === "goal_revision"), item => item.createdAt).slice(0, 3).map((item): AsabaProgressEvidence => ({
      id: "log:" + item.id, kind: "goal_change", title: "已记录的方向调整", text: clip(item.body, 1000), date: item.createdAt,
    })),
    ...(branch === undefined ? projectJobGroups(jobs.filter(job => job.projectId === project.id)).slice(0, 4).map(({ latest }): AsabaProgressEvidence => ({
      id: "worker:" + latest.id, kind: "worker_status", title: clip(latest.title, 140), text: asabaJobLabels[latest.state], date: latest.updatedAt,
    })) : []),
    ...byRecent(accumulations, item => item.updatedAt)
      .sort((left, right) => Number(right.id.startsWith("asaba-worker-") && request.includes(right.title)) -
        Number(left.id.startsWith("asaba-worker-") && request.includes(left.title)))
      .slice(0, 5).map((item): AsabaProgressEvidence => {
        const kind = projectMaterialKind(item);
        return { id: "accumulation:" + item.id, kind: kind === "reference" ? "accumulation" : kind, title: clip(item.title, 140),
          text: clip([item.content, item.reference].filter(Boolean).join("\n")), date: item.updatedAt, milestoneId: item.milestoneId };
      }),
  ];
  return { request, project: { id: project.id, title: clip(project.title, 140), outcome: clip(project.outcome), background: clip(project.motivation, 700), status: project.status,
    deadline: project.targetDateKind === "deadline" ? project.targetDate : "", reviewDate: project.reviewDate },
    ...(branch !== undefined ? { scope: { milestoneId: branch?.id ?? null } } : {}),
    evidence: evidence.map((source) => ({ ...source, projectId: project.id })) };
}

export async function analyzeProjectProgress(
  input: ReturnType<typeof buildAsabaProgressInput>,
  evaluate: (input: ReturnType<typeof buildAsabaProgressInput> & { investigation?: { gaps: string[]; scope: string } }) => Promise<AsabaProgressAnswer>,
  readApprovedEvidence?: () => Promise<AsabaProgressEvidence[]>,
): Promise<{ answer: AsabaProgressAnswer; evidence: AsabaProgressEvidence[]; investigation?: string }> {
  const answer = await evaluate(input);
  const localResult = { answer, evidence: input.evidence };
  if (!readApprovedEvidence || !answer.unknowns.length || (answer.decision !== "clarify" && answer.decision !== "wait")) return localResult;
  try {
    const approved = (await readApprovedEvidence()).filter((item) => item.kind === "authorized_note" && item.projectId === input.project.id)
      .map((item) => ({ ...item, projectId: input.project.id }));
    if (!approved.length) return { ...localResult, investigation: "授权笔记目前没有可读取的项目正文。" };
    const evidence = [...input.evidence, ...approved];
    const followup = await evaluate({ ...input, evidence, investigation: {
      gaps: answer.unknowns, scope: "本次授权的关联笔记节选。将它们作为可追溯的记录，不把旧计划、推测或引用的建议当作已经发生的事实。",
    } });
    return { answer: followup, evidence, investigation: `已核对 ${approved.length} 条本次授权的笔记节选。` };
  } catch {
    return { ...localResult, investigation: "补充调查未完成，以下内容来自已有项目记录。" };
  }
}

export function findDuplicateProjectAction(detail: ProjectDetail, title: string) {
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\p{P}\s]/gu, "");
  const key = normalize(title);
  if (!key) return undefined;
  return detail.tasks.find((task) => task.status !== "cancelled" && [task.title, task.currentFocus].some((value) => normalize(value) === key));
}

export function assertProjectActionIsCurrent(detail: ProjectDetail | null, title: string, updatedAt: string) {
  if (!detail || detail.project.isDraft || detail.project.status !== "active" || detail.project.updatedAt !== updatedAt) {
    throw new Error("项目或行动已有变化，请重新生成建议。");
  }
  if (findDuplicateProjectAction(detail, title)) throw new Error("项目中已有同名行动或完成记录，请核对后再保存。");
}

export function resolveProjectDecision(
  detail: ProjectDetail,
  analysis: Awaited<ReturnType<typeof analyzeProjectProgress>>,
  branch?: Milestone | null,
): AsabaProjectDecision {
  const { project } = detail;
  const { evidence, investigation } = analysis;
  let answer = analysis.answer;
  const active = project.status === "active" && !project.isDraft;
  const actionable = (task: ProjectDetail["tasks"][number]) => evidence.some((item) => item.kind === "action" && item.id === "task:" + task.id);
  let existing = answer.decision === "continue" ? detail.tasks.find((task) => "task:" + task.id === answer.taskEvidenceId && actionable(task)) : undefined;
  if (answer.decision === "new_action") {
    const duplicate = findDuplicateProjectAction(detail, answer.nextAction);
    if (duplicate) {
      existing = actionable(duplicate) ? duplicate : undefined;
      answer = { ...answer, decision: existing ? "continue" : duplicate.status === "waiting" ? "wait" : "keep",
        summary: duplicate.status === "waiting" ? [duplicate.title, duplicate.waitingFor, duplicate.resumeAction].filter(Boolean).join(" · ") :
          duplicate.status === "done" ? "这项工作已有完成记录：" + duplicate.title : "项目中已有这项工作：" + duplicate.title,
        taskEvidenceId: existing ? "task:" + existing.id : null, nextAction: "", completionCondition: "" };
    }
  }
  if (!active && answer.decision && !["keep", "clarify", "wait"].includes(answer.decision)) {
    answer = { ...answer, decision: "keep", summary: project.status === "paused" ? "项目当前处于暂停状态。" : "项目当前不可推进。",
      taskEvidenceId: null, nextAction: "", completionCondition: "" };
    existing = undefined;
  }
  const existingAction = existing && { id: existing.id, title: existing.title };
  const actionDraft = active && answer.decision === "new_action" && answer.nextAction.trim() && answer.completionCondition?.trim()
    ? {
      ...previewAsabaPlan({ kind: "existing_project", projectId: project.id, title: "", outcome: "", reason: answer.summary,
        questions: answer.unknowns, action: answer.nextAction }, [detail]),
      ...(branch !== undefined ? { milestone: branch ? { id: branch.id, title: branch.title } : null } : {}),
      expectedUpdatedAt: project.updatedAt, completionCondition: answer.completionCondition,
    } : null;
  return { kind: "progress", projectId: project.id, projectTitle: project.title, expectedUpdatedAt: project.updatedAt,
    answer, evidence, investigation, existingAction, actionDraft, canAdjust: active && answer.decision === "adjust" };
}

export type AsabaPlanSave = {
  id: string;
  request: string;
  draft: AsabaPlanPreview;
  attachMilestone: boolean;
};

export function buildAsabaPlanningInput(request: string, projectId: string | null, details: ProjectDetail[]) {
  return {
    request,
    projectId,
    projects: details.filter(({ project }) => !project.isDraft)
      .sort((a, b) => Number(b.project.id === projectId) - Number(a.project.id === projectId))
      .slice(0, 40).map(({ project, tasks, milestones }) => ({
        id: project.id, title: project.title.slice(0, 100), outcome: project.outcome.slice(0, 240),
        status: project.status,
        current: milestones.filter((item) => item.status === "current").slice(0, 2).map((item) => item.title.slice(0, 80)),
        actions: tasks.filter((item) => item.status === "next" || item.status === "waiting").slice(0, 2)
          .map((item) => ({ title: item.title.slice(0, 80), status: item.status })),
      })),
  };
}

export function previewAsabaPlan(plan: AsabaPlan, candidates: ProjectDetail[]): AsabaPlanPreview {
  const detail = candidates.find(({ project }) => project.id === plan.projectId && project.status !== "completed" && !project.isDraft);
  if ((plan.kind === "existing_project" && !detail) || (plan.kind !== "existing_project" && plan.projectId !== null)) {
    throw new Error("建议里的项目已不可用，请重新生成。");
  }
  const current = detail?.milestones.filter((item) => item.status === "current") ?? [];
  return { ...plan, projectTitle: detail?.project.title ?? "", milestone: current.length === 1 ? { id: current[0].id, title: current[0].title } : null };
}

export function validateAsabaPlanSave({ id, request, draft }: AsabaPlanSave) {
  if (!["new_project", "existing_project", "action", "note"].includes(draft.kind) || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id) || !request.trim() || request.length > 4000 ||
      draft.title.length > 200 || draft.outcome.length > 2000 || draft.action.length > 200 ||
      (draft.expectedUpdatedAt !== undefined && (!draft.completionCondition?.trim() || draft.completionCondition.length > 500)) ||
      (draft.kind === "new_project" && (!draft.title.trim() || !draft.outcome.trim())) ||
      (["action", "existing_project"].includes(draft.kind) && !draft.action.trim())) {
    throw new Error("请补全草案内容，并检查文字长度。");
  }
}

export function formatAsabaEvidenceDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "日期未记录" : date.toLocaleDateString("zh-CN");
}

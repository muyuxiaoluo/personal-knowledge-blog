import type { ProjectDetail } from "./project-types";
import { decodeTaskProgressLog } from "./home-workflow";
import { projectDecisionRecords, projectMaterialKind } from "./project-ai-context";
import type { StoredArticle } from "./types";

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
};

export type AsabaPlanRoute = AsabaPlan | (Omit<AsabaPlan, "kind"> & { kind: "project_progress" });

export type AsabaProgressAnswer = {
  summary: string;
  findings: { text: string; evidenceIds: string[] }[];
  unknowns: string[];
  nextAction: string;
  decision?: "continue" | "new_action" | "clarify" | "wait" | "delegate" | "adjust" | "keep";
  taskEvidenceId?: string | null;
};

export type AsabaProgressEvidence = {
  id: string;
  kind: "milestone" | "progress" | "completed" | "continuation" | "accumulation" | "waiting" | "action" | "decision" | "confirmed_outcome" | "worker_report" | "authorized_note";
  title: string;
  text: string;
  date: string;
};

export type AsabaPlanningResult =
  | { kind: "plan"; draft: AsabaPlanPreview }
  | { kind: "choose_project"; projects: { id: string; title: string; outcome: string }[] }
  | { kind: "progress"; projectId: string; projectTitle: string; answer: AsabaProgressAnswer; evidence: AsabaProgressEvidence[]; actionDraft: AsabaPlanPreview | null; canAdjust: boolean; existingAction?: { id: string; title: string }; investigation?: string };

export const maxAuthorizedProjectNotes = 3;
export type AsabaProjectNote = { id: string; title: string };

export async function readAuthorizedProjectEvidence(projectId: string, noteIds: string[], readNote: (id: string) => Promise<StoredArticle | null>) {
  const notes = await Promise.all([...new Set(noteIds)].slice(0, maxAuthorizedProjectNotes).map(readNote));
  return notes.flatMap((note): AsabaProgressEvidence[] => {
    if (!note || note.projectId !== projectId || note.storage.deletedAt || !note.body.trim()) return [];
    const body = note.body.trim();
    return [{ id: "note:" + note.id, kind: "authorized_note", title: note.title.slice(0, 140),
      text: body.slice(0, 1800) + (body.length > 1800 ? "…（节选）" : ""), date: note.updated }];
  });
}

export type AsabaAdjustmentRequest = { id: string; projectId: string; request: string; suggestion: string };

export function buildAsabaProgressInput(request: string, detail: ProjectDetail) {
  const { project, logs, milestones, tasks, accumulations } = detail;
  const byRecent = <T,>(items: T[], date: (item: T) => string) =>
    [...items].sort((left, right) => date(right).localeCompare(date(left)));
  const clip = (value: string, max = 340) => value.trim().slice(0, max);
  const currentMilestones = new Set(milestones.filter((node) => node.status === "current").map((node) => node.id));
  const activeTasks = project.status === "active" ? byRecent(tasks.filter((item) => (item.status === "next" || item.status === "later") &&
    (!item.milestoneId || currentMilestones.has(item.milestoneId))), (item) => item.updatedAt)
    .sort((left, right) => Number(right.status === "next") - Number(left.status === "next")).slice(0, 5) : [];
  const evidence: AsabaProgressEvidence[] = [
    ...projectDecisionRecords(detail).map((item): AsabaProgressEvidence => ({
      id: "proposal:" + item.id, kind: "decision", title: item.title,
      text: clip((item.status === "accepted" ? "已采纳" : item.status === "deferred" ? "已暂缓" : "已否决") + (item.reason ? " · " + item.reason : "")), date: item.decidedAt,
    })),
    ...byRecent(milestones.filter(item => item.status === "current"), item => item.updatedAt).slice(0, 5).map((item): AsabaProgressEvidence => ({
      id: "milestone:" + item.id, kind: "milestone", title: clip(item.title, 140), text: clip(item.definitionOfDone), date: item.updatedAt,
    })),
    ...byRecent(tasks.filter(item => item.status === "waiting"), item => item.updatedAt).slice(0, 6).map((item): AsabaProgressEvidence => ({
      id: "task:" + item.id, kind: "waiting", title: clip(item.title, 140), text: clip([item.waitingFor, item.resumeAction].filter(Boolean).join(" · ")), date: item.updatedAt,
    })),
    ...activeTasks.map((item): AsabaProgressEvidence => ({
      id: "task:" + item.id, kind: "action", title: clip(item.title, 140), text: clip([item.currentFocus, item.definitionOfDone].filter(Boolean).join(" · ")), date: item.updatedAt,
    })),
    ...byRecent(tasks.filter(item => item.status === "done"), item => item.completedAt || item.updatedAt).slice(0, 4).map((item): AsabaProgressEvidence => ({
      id: "task:" + item.id, kind: "completed", title: clip(item.title, 140), text: "行动已标记完成", date: item.completedAt || item.updatedAt,
    })),
    ...byRecent(logs.filter(item => item.kind !== "plan_revision" && item.kind !== "goal_revision"), item => item.createdAt).slice(0, 8).map((item): AsabaProgressEvidence => ({
      id: "log:" + item.id, kind: item.kind === "task_completed" ? "completed" : item.kind === "continuation" ? "continuation" : "progress",
      title: clip(tasks.find(task => task.id === item.taskId)?.title ?? (item.kind === "continuation" ? "接续记录" : "行动记录"), 140),
      text: clip(decodeTaskProgressLog(item.body)?.result ?? (item.body.startsWith("接续点｜") ? item.body.split("｜").slice(3).join("｜") : item.body)), date: item.createdAt,
    })),
    ...byRecent(accumulations, item => item.updatedAt)
      .sort((left, right) => Number(right.id.startsWith("asaba-worker-") && request.includes(right.title)) -
        Number(left.id.startsWith("asaba-worker-") && request.includes(left.title)))
      .slice(0, 5).map((item): AsabaProgressEvidence => {
        const kind = projectMaterialKind(item);
        return { id: "accumulation:" + item.id, kind: kind === "reference" ? "accumulation" : kind, title: clip(item.title, 140),
          text: clip(item.content), date: item.updatedAt };
      }),
  ];
  return { request, project: { title: clip(project.title, 140), outcome: clip(project.outcome), background: clip(project.motivation), status: project.status,
    deadline: project.targetDateKind === "deadline" ? project.targetDate : "", reviewDate: project.reviewDate }, evidence };
}

export async function analyzeProjectProgress(
  input: ReturnType<typeof buildAsabaProgressInput>,
  evaluate: (input: ReturnType<typeof buildAsabaProgressInput> & { investigation?: { gaps: string[]; scope: string } }) => Promise<AsabaProgressAnswer>,
  readApprovedEvidence?: () => Promise<AsabaProgressEvidence[]>,
): Promise<{ answer: AsabaProgressAnswer; evidence: AsabaProgressEvidence[]; investigation?: string }> {
  const answer = await evaluate(input);
  const localResult = { answer, evidence: input.evidence };
  if (!readApprovedEvidence || !answer.unknowns.length) return localResult;
  try {
    const approved = await readApprovedEvidence();
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
      (draft.kind === "new_project" && (!draft.title.trim() || !draft.outcome.trim())) ||
      (["action", "existing_project"].includes(draft.kind) && !draft.action.trim())) {
    throw new Error("请补全草案内容，并检查文字长度。");
  }
}

export function formatAsabaEvidenceDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "日期未记录" : date.toLocaleDateString("zh-CN");
}

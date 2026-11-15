import type { ProjectDetail } from "./project-types";
import { decodeTaskProgressLog } from "./home-workflow";

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
};

export type AsabaProgressEvidence = {
  id: string;
  kind: "milestone" | "progress" | "completed" | "continuation" | "accumulation" | "waiting" | "action";
  title: string;
  text: string;
  date: string;
};

export type AsabaPlanningResult =
  | { kind: "plan"; draft: AsabaPlanPreview }
  | { kind: "choose_project"; projects: { id: string; title: string; outcome: string }[] }
  | { kind: "progress"; projectId: string; projectTitle: string; answer: AsabaProgressAnswer; evidence: AsabaProgressEvidence[]; actionDraft: AsabaPlanPreview | null; canAdjust: boolean };

export type AsabaAdjustmentRequest = { id: string; projectId: string; request: string; suggestion: string };

export function buildAsabaProgressInput(request: string, detail: ProjectDetail) {
  const { project, logs, milestones, tasks, accumulations } = detail;
  const byRecent = <T,>(items: T[], date: (item: T) => string) =>
    [...items].sort((left, right) => date(right).localeCompare(date(left)));
  const clip = (value: string, max = 340) => value.trim().slice(0, max);
  const evidence: AsabaProgressEvidence[] = [
    ...byRecent(milestones.filter(item => item.status === "current"), item => item.updatedAt).slice(0, 5).map((item): AsabaProgressEvidence => ({
      id: "milestone:" + item.id, kind: "milestone", title: clip(item.title, 140), text: clip(item.definitionOfDone), date: item.updatedAt,
    })),
    ...byRecent(tasks.filter(item => item.status === "waiting"), item => item.updatedAt).slice(0, 6).map((item): AsabaProgressEvidence => ({
      id: "task:" + item.id, kind: "waiting", title: clip(item.title, 140), text: clip([item.waitingFor, item.resumeAction].filter(Boolean).join(" · ")), date: item.updatedAt,
    })),
    ...byRecent(tasks.filter(item => item.status === "next"), item => item.updatedAt).slice(0, 5).map((item): AsabaProgressEvidence => ({
      id: "task:" + item.id, kind: "action", title: clip(item.title, 140), text: clip(item.currentFocus), date: item.updatedAt,
    })),
    ...byRecent(tasks.filter(item => item.status === "done"), item => item.completedAt || item.updatedAt).slice(0, 4).map((item): AsabaProgressEvidence => ({
      id: "task:" + item.id, kind: "completed", title: clip(item.title, 140), text: "行动已标记完成", date: item.completedAt || item.updatedAt,
    })),
    ...byRecent(logs.filter(item => item.kind !== "plan_revision"), item => item.createdAt).slice(0, 8).map((item): AsabaProgressEvidence => ({
      id: "log:" + item.id, kind: item.kind === "task_completed" ? "completed" : item.kind === "continuation" ? "continuation" : "progress",
      title: clip(tasks.find(task => task.id === item.taskId)?.title ?? (item.kind === "continuation" ? "接续记录" : "行动记录"), 140),
      text: clip(decodeTaskProgressLog(item.body)?.result ?? (item.body.startsWith("接续点｜") ? item.body.split("｜").slice(3).join("｜") : item.body)), date: item.createdAt,
    })),
    ...byRecent(accumulations, item => item.updatedAt)
      .sort((left, right) => Number(right.id.startsWith("asaba-worker-") && request.includes(right.title)) -
        Number(left.id.startsWith("asaba-worker-") && request.includes(left.title)))
      .slice(0, 5).map((item): AsabaProgressEvidence => ({
      id: "accumulation:" + item.id, kind: "accumulation", title: clip(item.title, 140), text: clip(item.content), date: item.updatedAt,
    })),
  ];
  return { request, project: { title: clip(project.title, 140), outcome: clip(project.outcome), status: project.status,
    deadline: project.targetDateKind === "deadline" ? project.targetDate : "", reviewDate: project.reviewDate }, evidence };
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

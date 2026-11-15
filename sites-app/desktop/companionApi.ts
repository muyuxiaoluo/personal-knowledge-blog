import type { DocumentInput, ResearchInput, WorkerArchive, WorkerRequest } from "../app/asaba-worker";
import type { AttentionCommand, AttentionJob, AttentionView } from "../app/asaba-attention";
import type { CareerScope } from "../app/asaba-career";
import type { AsabaPlanSave, AsabaPlanningResult, AsabaAdjustmentRequest } from "../app/asaba-planning";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import type { AsabaActivity, AsabaDelegation, AsabaFocusCommand, AsabaJob, AsabaNote, AsabaObservation, AsabaRecap, CompanionAction, CompanionAskScope, CompanionContext, CompanionStatus } from "../app/companion-types";
export type AsabaStage = {
  expanded: boolean; speech?: boolean; walking: boolean; direction: number; mood: string;
  layout: { petX: number; petY: number; bubbleX: number; bubbleY: number; tailY: number; bubbleLeft: boolean };
};
async function askWorkbench<T>(event: string, command: { id: string } & Record<string, unknown>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let finish!: (value: T & { id: string; error?: string }) => void;
  const result = new Promise<T & { id: string; error?: string }>(resolve => { finish = resolve; });
  const stop = await listen<T & { id: string; error?: string }>(event + "-result", ({ payload }) => {
    if (payload.id === command.id) finish(payload);
  });
  let timeout: number | undefined;
  try {
    await emitTo("main", event, command);
    const value = await Promise.race([result, new Promise<never>((_, reject) => { timeout = window.setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs); })]);
    if (value.error) throw new Error(value.error);
    return value;
  } finally { window.clearTimeout(timeout); stop(); }
}

export const companionApi = {
  async startCareer(id: string, scope: CareerScope) {
    await askWorkbench<object>("asaba-start-career", { id, scope }, 20_000, "委托尚未确认，可用原范围重试。");
  },
  async openCareerReview(jobId: string) {
    await askWorkbench<object>("asaba-review-career", { id: crypto.randomUUID(), jobId }, 15_000, "工作台尚未打开路线，请重试。");
  },
  async attention(command: AttentionCommand) {
    return (await askWorkbench<{ view: AttentionView }>("asaba-attention", { id: crypto.randomUUID(), ...command }, 12_000, "工作台尚未响应，可以重试。")).view;
  },
  async openAttentionItem(kind: "project" | "task" | "source", targetId: string) {
    await askWorkbench<object>("asaba-open-attention-item", { id: crypto.randomUUID(), kind, targetId }, 12_000, "工作台尚未打开该事项，请重试。");
  },
  status: () => invoke<CompanionStatus>("companion_status"),
  context: (context: CompanionContext) => invoke<void>("companion_update_context", { context }),
  refresh: () => invoke<CompanionStatus>("companion_refresh"),
  enable: (enabled: boolean) => invoke<CompanionStatus>("companion_set_enabled", { enabled }),
  pauseAll: () => invoke<CompanionStatus>("companion_pause_all"),
  ask: (question: string, model: string, scope: CompanionAskScope) => invoke<CompanionStatus>("companion_ask", { question, model, scope }),
  action: (action: CompanionAction) => invoke<void>("companion_action", { action }),
  window: (expanded: boolean, visible = true) => invoke<void>("companion_window", { expanded, visible }),
  dictation: (operation: "listen" | "stop", requestId?: string) => invoke<string>("asaba_dictation", { operation, requestId }),
  synthesize: (text: string) => invoke<ArrayBuffer>("asaba_synthesize", { text }),
  stage: (options: { width?: number; height?: number; busy?: boolean; reducedMotion?: boolean; speech?: boolean } = {}) => invoke<AsabaStage>("asaba_stage", options),
  observation: (operation = "status", executable?: string) => invoke<AsabaObservation>("asaba_observation", { operation, executable }),
  recap: (force = false) => invoke<AsabaRecap>("asaba_recap", { force }),
  cancelRecap: () => invoke<void>("asaba_cancel_recap"),
  activity: () => invoke<AsabaActivity>("asaba_activity"),
  async refreshContext() {
    const id = crypto.randomUUID();
    let finish!: (value: { error?: string }) => void;
    const result = new Promise<{ error?: string }>(resolve => { finish = resolve; });
    const stop = await listen<{ id: string; error?: string }>("asaba-context-refreshed", ({ payload }) => {
      if (payload.id === id) finish(payload);
    });
    const timeout = window.setTimeout(() => finish({ error: "工作台的资讯尚未刷新，请稍后再试。" }), 10_000);
    try {
      await emitTo("main", "asaba-context-refresh", { id });
      const refreshed = await result;
      if (refreshed.error) throw new Error(refreshed.error);
    } finally { window.clearTimeout(timeout); stop(); }
  },
  async focus(command: AsabaFocusCommand) {
    let finish!: (value: { error?: string }) => void;
    const result = new Promise<{ error?: string }>(resolve => { finish = resolve; });
    const stop = await listen<{ id: string; error?: string }>("asaba-focus-result", ({ payload }) => {
      if (payload.id === command.id) finish(payload);
    });
    const timeout = window.setTimeout(() => finish({ error: "投入记录尚未确认，请刷新后核对。" }), 15_000);
    try {
      await emitTo("main", "asaba-focus-command", command);
      const saved = await result;
      if (saved.error) throw new Error(saved.error);
    } finally { window.clearTimeout(timeout); stop(); }
  },
  shot: (id: string) => invoke<string>("asaba_shot", { id }),
  restoreSource: () => invoke<void>("asaba_restore_source"),
  jobs: (projectId?: string) => invoke<AsabaJob[]>("asaba_jobs", { projectId }),
  attentionJobs: () => invoke<AttentionJob[]>("asaba_attention_jobs"),
  repository: (projectId: string) => invoke<string | null>("asaba_repository", { projectId }),
  bindRepository: (projectId: string, repository: string) => invoke<string | null>("asaba_bind_repository", { projectId, repository }),
  repositoryStatus: (repository: string) => invoke<{ directory: string; dirty: boolean }>("asaba_repository_status", { repository }),
  polishDelegation: (text: string) => invoke<string>("asaba_polish_delegation", { text }),
  delegate: (request: AsabaDelegation) => invoke<AsabaJob>("asaba_delegate", { request }),
  jobAction: (id: string, operation: "cancel" | "reviewed" | "openSession" | "retry") => invoke<void>("asaba_job_action", { id, operation }),
  researchDefaults(topic: string, projectId: string | null) {
    return askWorkbench<{ model: string; projectId: string | null }>("asaba-research-model", { id: crypto.randomUUID(), topic, projectId }, 15_000, "无法读取研究设置。");
  },
  research: (request: WorkerRequest<ResearchInput>) => invoke<string>("asaba_research", { request }),
  checkDocument: (request: WorkerRequest<DocumentInput>) => invoke<string>("asaba_check_document", { request }),
  markArchived: (id: string, projectId: string) => invoke<void>("asaba_mark_archived", { id, projectId }),
  async archiveWorker(command: WorkerArchive) {
    await askWorkbench<object>("asaba-save-worker", { id: crypto.randomUUID(), ...command }, 15_000, "归档尚未确认，可重试。");
  },
  async plan(request: string, projectId: string | null, authorizedNoteIds: string[] = [], milestoneId?: string | null) {
    const command = { id: crypto.randomUUID(), request, projectId, authorizedNoteIds, milestoneId };
    return (await askWorkbench<{ result: AsabaPlanningResult }>("asaba-plan", command, authorizedNoteIds.length ? 240_000 : 180_000, "规划尚未返回，请稍后再试。")).result;
  },
  async openAdjustment(command: Omit<AsabaAdjustmentRequest, "id">) {
    await askWorkbench<object>("asaba-open-adjustment", { id: crypto.randomUUID(), ...command }, 15_000, "计划调整窗口未响应，请重试。");
  },
  async openProjectDelegation(result: Extract<AsabaPlanningResult, { kind: "progress" }>) {
    await askWorkbench<object>("asaba-open-project-delegation", { id: crypto.randomUUID(), result }, 15_000, "委托表单未响应，请重试。");
  },
  async openPlanProject(projectId: string) {
    await askWorkbench<object>("asaba-open-plan-project", { id: crypto.randomUUID(), projectId }, 15_000, "项目窗口未响应，请重试。");
  },
  async savePlan(command: AsabaPlanSave) {
    return (await askWorkbench<{ saved: { projectId?: string } }>("asaba-save-plan", command, 15_000, "工作台尚未确认保存，可以重试。")).saved;
  },
  async saveNote(note: AsabaNote) {
    let finish!: (result: { noteId?: string; error?: string }) => void;
    const result = new Promise<{ noteId?: string; error?: string }>(resolve => { finish = resolve; });
    const stop = await listen<{ id: string; noteId?: string; error?: string }>("asaba-note-result", ({ payload }) => {
      if (payload.id === note.id) finish(payload);
    });
    const timeout = window.setTimeout(() => finish({ error: "工作台未确认保存，原文仍在便签里。请重试。" }), 15_000);
    try {
      await emitTo("main", "asaba-save-note", note);
      const saved = await result;
      if (!saved.noteId) throw new Error(saved.error || "便签未能保存。");
      return saved.noteId;
    } finally {
      window.clearTimeout(timeout);
      stop();
    }
  },
};

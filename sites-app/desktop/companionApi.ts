import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import type { AsabaActivity, AsabaDelegation, AsabaFocusCommand, AsabaJob, AsabaNote, AsabaObservation, AsabaRecap, CompanionAction, CompanionAskScope, CompanionContext, CompanionStatus } from "../app/companion-types";
export type AsabaStage = {
  expanded: boolean; speech?: boolean; walking: boolean; direction: number; mood: string;
  layout: { petX: number; petY: number; bubbleX: number; bubbleY: number; tailY: number; bubbleLeft: boolean };
};
export const companionApi = {
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
  repository: (projectId: string) => invoke<string | null>("asaba_repository", { projectId }),
  bindRepository: (projectId: string, repository: string) => invoke<string | null>("asaba_bind_repository", { projectId, repository }),
  repositoryStatus: (repository: string) => invoke<{ directory: string; dirty: boolean }>("asaba_repository_status", { repository }),
  polishDelegation: (text: string) => invoke<string>("asaba_polish_delegation", { text }),
  delegate: (request: AsabaDelegation) => invoke<AsabaJob>("asaba_delegate", { request }),
  jobAction: (id: string, operation: "cancel" | "reviewed" | "openSession") => invoke<void>("asaba_job_action", { id, operation }),
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

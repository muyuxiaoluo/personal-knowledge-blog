import { useEffect, useRef } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import type { AsabaFocusCommand, AsabaNote, CompanionAction } from "../app/companion-types";
import type { ProjectSummary } from "../app/project-types";
import type { StoredArticle } from "../app/types";
import type { AiBriefSnapshot, DashboardPreferences, MorningBriefSnapshot } from "../app/dashboard-types";
import type { FocusSession } from "../app/work-types";
import { matchingAiKeywords } from "../app/dashboard-helpers";
import type { DashboardRepository } from "../app/data/dashboard-repository";
import { loadDeepSeekModelSettings } from "../app/ai-model-settings";
import type { WorkspaceTask } from "./WorkPages";
import { companionApi } from "./companionApi";
import { Button } from "./DesktopControls";

export function CompanionBridge({ projects, tasks, articles, dashboardRepository, dashboardPreferences, activeSession, onFocus, onAction, onSaveNote, onError }: {
  projects: ProjectSummary[]; tasks: WorkspaceTask[]; articles: StoredArticle[]; dashboardRepository: DashboardRepository;
  onAction: (action: CompanionAction) => Promise<void>; onError: (message: string) => void;
  onSaveNote: (note: AsabaNote) => Promise<string>;
  dashboardPreferences: DashboardPreferences; activeSession: FocusSession | null;
  onFocus: (command: AsabaFocusCommand) => Promise<void>;
}) {
  const latest = useRef({ projects, tasks, articles, dashboardPreferences, activeSession, onFocus, onAction, onSaveNote, onError });
  latest.current = { projects, tasks, articles, dashboardPreferences, activeSession, onFocus, onAction, onSaveNote, onError };
  const opened = useRef(false);
  const publish = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    const send = async () => {
      const date = new Date().toLocaleDateString("en-CA");
      const [ai, brief] = await Promise.all([
        dashboardRepository.getCache<AiBriefSnapshot>("aihot:brief"),
        dashboardRepository.getCache<MorningBriefSnapshot>(`morning-brief:${date}`),
      ]);
      if (!active) return;
      const { projects, tasks, articles, dashboardPreferences, activeSession } = latest.current;
      await companionApi.context({
        updatedAt: new Date().toISOString(), model: loadDeepSeekModelSettings().defaultModel,
        projects: projects.filter(project => project.status !== "completed").slice(0, 40).map(({ id, title, outcome, status }) => ({ id, title, outcome: outcome.slice(0, 500), status })),
        tasks: tasks.filter(task => !["done", "cancelled", "waiting"].includes(task.status)).slice(0, 80).map(({ id, title, projectId, projectTitle }) => ({ id, title, projectId, projectTitle })),
        notes: articles.filter(article => article.source.includes("浅羽随手记")).slice(0, 60).map(({ id, title, summary, project, updated }) => ({ id, title, summary: summary.slice(0, 400), project, at: updated })),
        news: (ai?.value.items ?? []).filter(item => matchingAiKeywords(item, dashboardPreferences.aiHighlightKeywords).length > 0).map(item => ({ title: item.title, summary: item.summary.slice(0, 500), url: item.originalUrl || item.aihotUrl, matched: true })),
        brief: brief ? { date: brief.value.date, news: brief.value.news, tip: brief.value.tip } : null,
        activeFocus: activeSession,
      });
    };
    publish.current = send;
    void send().catch(error => latest.current.onError(String(error)));
    const timer = window.setInterval(() => { void send().catch(() => {}); }, 60_000);
    const subscription = listen<CompanionAction>("companion-action", async ({ payload }) => {
      if (!active) return;
      try { await latest.current.onAction(payload); await emitTo("companion", "companion-action-result", payload.kind === "prepare_note" ? "已从笔记带入委托说明，请确认内容。" : payload.kind === "capture" ? "已打开收集箱，确认保存后写入。" : payload.kind === "start_task" ? "已经开始记录这项行动的投入。" : "已打开工作台，请查看操作结果。"); }
      catch (error) { await emitTo("companion", "companion-action-result", `操作未完成：${String(error)}`); }
    });
    const capture = listen<AsabaNote>("asaba-save-note", async ({ payload }) => {
      if (!active) return;
      try {
        const noteId = await latest.current.onSaveNote(payload);
        await publish.current?.();
        await emitTo("companion", "asaba-note-result", { id: payload.id, noteId });
      } catch (error) {
        await emitTo("companion", "asaba-note-result", { id: payload.id, error: String(error) });
      }
    });
    let changingFocus = false;
    const focus = listen<AsabaFocusCommand>("asaba-focus-command", async ({ payload }) => {
      if (!active) return;
      if (changingFocus) {
        await emitTo("companion", "asaba-focus-result", { id: payload.id, error: "投入记录正在保存，请稍后再试。" });
        return;
      }
      changingFocus = true;
      try {
        await latest.current.onFocus(payload);
        await send();
        await emitTo("companion", "asaba-focus-result", { id: payload.id });
      } catch (error) {
        await emitTo("companion", "asaba-focus-result", { id: payload.id, error: String(error) });
      } finally { changingFocus = false; }
    });
    const refreshRequested = listen<{ id: string }>("asaba-context-refresh", async ({ payload }) => {
      if (!active) return;
      try {
        await send();
        await emitTo("companion", "asaba-context-refreshed", { id: payload.id });
      } catch (error) {
        await emitTo("companion", "asaba-context-refreshed", { id: payload.id, error: String(error) });
      }
    });
    if (!opened.current) { opened.current = true; void companionApi.window(false).catch(error => latest.current.onError(String(error))); }
    return () => { active = false; publish.current = null; window.clearInterval(timer); for (const subscription of [focus, capture, refreshRequested]) void subscription.then(stop => stop()); void subscription.then(stop => stop()); };
  }, [dashboardRepository]);
  useEffect(() => {
    if (!isTauri()) return;
    // Refresh the snapshot after an actual workbench change, without a model call.
    const timer = window.setTimeout(() => { void publish.current?.().catch(() => {}); }, 300);
    return () => window.clearTimeout(timer);
  }, [projects, tasks, articles, dashboardPreferences, activeSession]);
  return <Button className="companion-launcher" size="small" onClick={() => void companionApi.window(true).catch(error => onError(String(error)))}><span aria-hidden="true">✦</span> 浅羽</Button>;
}

import { useEffect, useRef } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { attentionSourceKey, attentionView, initialAttentionState, type AttentionCommand, type AttentionView } from "../app/asaba-attention";
import { localDate } from "../app/date-helpers";
import type { SqliteArticleRepository } from "../app/data/sqlite-article-repository";
import type { ProjectRepository } from "../app/data/project-repository";
import type { WorkspacePreferencesRepository } from "../app/data/workspace-preferences-repository";
import type { ProjectDetail } from "../app/project-types";
import type { StoredArticle } from "../app/types";
import { companionApi } from "./companionApi";

export function useAsabaAttentionBridge({ ready, projects, articles, repository, projectRepository, preferences, onLink, onOpen }: {
  ready: boolean; projects: ProjectDetail[]; articles: StoredArticle[];
  repository: SqliteArticleRepository; projectRepository: ProjectRepository;
  preferences: WorkspacePreferencesRepository; onLink: () => Promise<void>;
  onOpen: (kind: "task" | "source" | "project", id: string) => Promise<void>;
}) {
  const latest = useRef({ projects, onLink, onOpen });
  latest.current = { projects, onLink, onOpen };
  const refresh = useRef<(() => void) | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (!ready || !isTauri()) return;
    let active = true;
    let timer: number | undefined;
    let previousView = "";
    const startedAt = new Date();

    async function process(command: AttentionCommand): Promise<AttentionView> {
      const [saved, jobs, sources] = await Promise.all([
        preferences.getAsabaAttention(), companionApi.attentionJobs(), repository.listAttentionSources(),
      ]);
      const state = saved ?? initialAttentionState(startedAt, sources, jobs, latest.current.projects);
      let changed = !saved;
      const view = () => attentionView(state, localDate(), latest.current.projects, jobs, sources);
      if (command.kind === "showDot" && state.showDot !== command.enabled) {
        state.showDot = command.enabled;
        changed = true;
      } else if (command.kind === "read" || command.kind === "dismiss") {
        const visible = new Set(view().groups.flatMap(group => group.entries.map(entry => entry.key)));
        for (const key of command.keys) {
          const disposition = command.kind === "read" ? "read" : "dismissed";
          if (visible.has(key) && state.disposition[key] !== disposition) {
            state.disposition[key] = disposition;
            changed = true;
          }
        }
      } else if (command.kind === "link") {
        const { sourceId, projectId, key } = command;
        const source = sources.find(item => item.id === sourceId);
        const validKey = key === attentionSourceKey(sourceId, projectId);
        if (!validKey || !source || source.deleted || source.branch === "已归档") {
          throw new Error("收藏或项目已发生变化，请刷新后核对。");
        }
        if (source.projectId !== projectId) {
          // Resolve current project names and status even if a sync refresh is still rendering.
          await projectRepository.list();
          const projects = await projectRepository.listIndexDetails();
          const suggestion = attentionView(state, localDate(), projects, jobs, sources).groups.some(group =>
            group.kind === "source" && group.entries.some(entry => entry.key === key));
          const target = projects.find(detail => detail.project.id === projectId)?.project;
          if (!suggestion || !target ||
              !await repository.linkAttentionSource(sourceId, source.version, projectId, target.title)) {
            throw new Error("收藏或项目已发生变化，请刷新后核对。");
          }
          source.projectId = projectId;
        }
        await latest.current.onLink();
      }
      if (changed) await preferences.saveAsabaAttention(state);
      return view();
    }

    function enqueue(command: AttentionCommand) {
      const next = queue.current.catch(() => {}).then(() => {
        if (!active) throw new Error("工作台还在准备，请稍后再试。");
        return process(command);
      });
      queue.current = next;
      return next;
    }

    async function publish(view: AttentionView) {
      const serialized = JSON.stringify(view);
      if (active && serialized !== previousView) {
        await emitTo("companion", "asaba-attention-changed", view);
        previousView = serialized;
      }
    }
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void enqueue({ kind: "get" }).then(publish).catch(() => {}); }, 250);
    };
    const requests = listen<AttentionCommand & { id: string }>("asaba-attention", async ({ payload }) => {
      if (!active) return;
      try {
        const view = await enqueue(payload);
        await emitTo("companion", "asaba-attention-result", { id: payload.id, view });
        await publish(view);
      } catch (error) {
        if (active) await emitTo("companion", "asaba-attention-result", {
          id: payload.id, error: error instanceof Error ? error.message : String(error),
        });
        schedule();
      }
    });
    const open = listen<{ id: string; kind: "task" | "source" | "project"; targetId: string }>("asaba-open-attention-item", async ({ payload }) => {
      if (!active) return;
      try {
        await latest.current.onOpen(payload.kind, payload.targetId);
        await emitTo("companion", "asaba-open-attention-item-result", { id: payload.id });
      } catch (error) {
        if (active) await emitTo("companion", "asaba-open-attention-item-result", {
          id: payload.id, error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    const jobs = listen("asaba-jobs-changed", schedule);
    refresh.current = schedule;
    schedule();
    const heartbeat = window.setInterval(schedule, 30_000);
    window.addEventListener("focus", schedule);
    return () => {
      active = false;
      refresh.current = null;
      window.clearTimeout(timer);
      window.clearInterval(heartbeat);
      window.removeEventListener("focus", schedule);
      void requests.then(stop => stop());
      void open.then(stop => stop());
      void jobs.then(stop => stop());
    };
  }, [ready, repository, projectRepository, preferences]);

  useEffect(() => refresh.current?.(), [projects, articles]);
}

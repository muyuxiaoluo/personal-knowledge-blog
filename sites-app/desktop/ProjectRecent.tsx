import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { StoredArticle } from "../app/types";
import type { ProjectDetail } from "../app/project-types";
import type { AsabaJob } from "../app/companion-types";
import { AsabaJobCard, AsabaShotPreview } from "./AsabaDetails";
import { companionApi } from "./companionApi";
import { Button } from "./DesktopControls";
import { decodeTaskProgressLog } from "../app/home-workflow";

export function ProjectRecent({ detail, articles, onOpenArticle, onPlan }: {
  detail: ProjectDetail;
  articles: StoredArticle[];
  onOpenArticle: (article: StoredArticle) => Promise<void>;
  onPlan: () => void;
}) {
  const { project, logs, tasks } = detail;
  const [jobs, setJobs] = useState<AsabaJob[]>([]);
  const [repository, setRepository] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    const refresh = () => void companionApi.jobs(project.id).then(value => { if (active) setJobs(value); }).catch(e => { if (active) setError(String(e)); });
    refresh();
    void companionApi.repository(project.id).then(value => { if (active) setRepository(value); }).catch(e => { if (active) setError(String(e)); });
    const subscription = listen("asaba-jobs-changed", refresh);
    return () => { active = false; void subscription.then(stop => stop()); };
  }, [project.id]);

  async function bind() {
    try {
      const path = await open({ directory: true, title: "绑定项目的本地 Git 仓库" });
      if (typeof path === "string") setRepository(await companionApi.bindRepository(project.id, path));
    } catch (e) { setError(String(e)); }
  }

  const notes = articles.filter(article => article.projectId === project.id && !article.storage.deletedAt);
  const latestJobs = [...new Map(jobs.slice().reverse().map(job => [job.noteId, job])).values()];
  const waiting = tasks.filter(task => task.status === "waiting");
  const next = tasks.filter(task => task.status === "next");
  const recent = [
    ...logs.map(value => ({ kind: "log" as const, at: value.createdAt, value })),
    ...notes.map(value => ({ kind: "note" as const, at: value.updated, value })),
    ...latestJobs.map(value => ({ kind: "job" as const, at: value.updatedAt, value })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  function reviewed(job: AsabaJob) { void companionApi.jobAction(job.id, "reviewed").catch(e => setError(String(e))); }

  return <div className="project-recent">
    <section>
      <h2>等我处理</h2>
      {latestJobs.filter(job => job.state === "review").map(job => <AsabaJobCard key={job.id} job={job} onReviewed={() => reviewed(job)} />)}
      {next.slice(0, 3).map(task => <p key={task.id}><Button variant="ghost" size="small" onClick={onPlan}>{task.title}</Button></p>)}
      {!next.length && !latestJobs.some(job => job.state === "review") && <p>暂无需要你处理的事项。</p>}
      {!!waiting.length && <details><summary>等外部条件 · {waiting.length} 项</summary>{waiting.map(task => <p key={task.id}>{task.title} · {task.waitingFor || "等待条件尚未注明"}</p>)}</details>}
    </section>
    <section>
      <h2>最近发生</h2>
      {!recent.length && <p>还没有项目动态。关联到这个项目的便签和委托会出现在这里。</p>}
      {recent.slice(0, 12).map(entry => {
        if (entry.kind === "job") return <AsabaJobCard key={entry.value.id} job={entry.value} />;
        if (entry.kind === "log") return <article key={entry.value.id}><small>{new Date(entry.at).toLocaleDateString("zh-CN")} · 项目记录</small><p>{decodeTaskProgressLog(entry.value.body)?.result ?? entry.value.body.replace(/^<!--[\s\S]*?-->\s*/, "")}</p></article>;
        const shotId = entry.value.source.find(source => source.startsWith("浅羽画面 · "))?.split(" · ")[1];
        return <article key={entry.value.id}><small>{new Date(entry.at).toLocaleDateString("zh-CN")} · {entry.value.source.includes("浅羽随手记") ? "浅羽随手记" : "关联笔记"}</small>
          <p><Button variant="ghost" size="small" onClick={() => void onOpenArticle(entry.value)}>{entry.value.title}</Button></p>
          {shotId && <AsabaShotPreview id={shotId} />}
        </article>;
      })}
    </section>
    {isTauri() && <details><summary>项目目录</summary>
      <p>{repository || "绑定本机 Git 仓库，创建委托时自动填入目录。"}</p>
      <Button size="small" onClick={() => void bind()}>{repository ? "更换仓库" : "选择仓库"}</Button>
      {repository && <Button size="small" variant="ghost" onClick={() => void companionApi.bindRepository(project.id, "").then(setRepository).catch(e => setError(String(e)))}>解除绑定</Button>}
    </details>}
    {error && <p role="status">{error}</p>}
  </div>;
}

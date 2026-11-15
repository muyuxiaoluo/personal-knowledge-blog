import type { WorkerArchive } from "../app/asaba-worker";
import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { StoredArticle } from "../app/types";
import type { ProjectDetail, ProjectLog } from "../app/project-types";
import { decodeContinuationLog, projectJobGroups, projectWorkStatus } from "../app/project-selectors";
import type { AsabaJob } from "../app/companion-types";
import { AsabaJobCard, AsabaShotPreview } from "./AsabaDetails";
import { companionApi } from "./companionApi";
import { Button } from "./DesktopControls";
import { decodeTaskProgressLog } from "../app/home-workflow";
import { isSourceArticle } from "../app/article-helpers";

export function ProjectRecent({ detail, view, loadArticles, articlesRevision, onOpenArticle, onOpenTask, onPlan, onOpenRecords, onArchive }: {
  detail: ProjectDetail;
  view: "summary" | "records" | null;
  loadArticles: (projectId: string) => Promise<StoredArticle[]>;
  articlesRevision: StoredArticle[];
  onOpenArticle: (article: StoredArticle) => Promise<void>;
  onOpenTask: (taskId: string) => void;
  onPlan: (milestoneId?: string | null) => void;
  onOpenRecords: () => void;
  onArchive: (request: WorkerArchive) => Promise<void>;
}) {
  const { project, logs } = detail;
  const [jobs, setJobs] = useState<AsabaJob[]>([]);
  const [repository, setRepository] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<StoredArticle[]>([]);
  const [visibleNotes, setVisibleNotes] = useState(12);
  const [visibleLogs, setVisibleLogs] = useState(12);
  useEffect(() => {
    if (view !== "records") return;
    let active = true;
    void loadArticles(project.id).then(articles => {
      if (active) setNotes(articles);
    }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [project.id, loadArticles, articlesRevision, view]);
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

  const jobGroups = projectJobGroups(jobs);
  const latestJobs = jobGroups.map(({ latest }) => latest);
  const { next, waiting, recent } = projectWorkStatus(detail);
  const review = latestJobs.filter((job) => job.state === "review");
  const inFlight = latestJobs.filter((job) => ["queued", "running", "recovering"].includes(job.state));
  function reviewed(job: AsabaJob) { void companionApi.jobAction(job.id, "reviewed").catch(e => setError(String(e))); }

  if (!view) return null;
  if (view === "summary") return <section className="project-status-summary workspace-card">
    <header><h2>当前状态</h2><Button variant="ghost" size="small" onClick={onOpenRecords}>查看记录</Button></header>
    <dl>
      <div><dt>最近进展</dt><dd>{recent ? <><p>{recent.text}</p><small>{recent.source} · {formatDate(recent.at)}</small></> : "暂无进展记录"}</dd></div>
      <div><dt>下一步</dt><dd>{next ? <><Button variant="ghost" size="small" onClick={() => onOpenTask(next.id)}>{next.title}</Button>{next.currentFocus && next.currentFocus !== next.title && <p>{next.currentFocus}</p>}</> : "尚未安排"}</dd></div>
      {waiting.length > 0 && <div><dt>等待中</dt><dd>{waiting.slice(0, 2).map((task) => <p key={task.id}>{task.title} · {task.waitingFor || "等待条件尚未注明"}{task.resumeAction && <small>恢复后 · {task.resumeAction}</small>}</p>)}{waiting.length > 2 && <Button size="small" variant="ghost" onClick={() => onPlan(waiting[2].milestoneId)}>还有 {waiting.length - 2} 项等待</Button>}</dd></div>}
      {review.length > 0 && <div><dt>待复测</dt><dd><Button variant="ghost" size="small" onClick={onOpenRecords}>{review[0].title}{review.length > 1 ? " 等 " + review.length + " 项" : ""}</Button></dd></div>}
      {inFlight.length > 0 && <div><dt>正在委托</dt><dd><Button variant="ghost" size="small" onClick={onOpenRecords}>{inFlight[0].title}{inFlight.length > 1 ? " 等 " + inFlight.length + " 项" : ""}</Button></dd></div>}
    </dl>
    {error && <p role="status">{error}</p>}
  </section>;

  return <div className="project-recent">
    <details open={notes.length > 0 || undefined}>
      <summary>关联笔记（{notes.length}）</summary>
      {notes.slice(0, visibleNotes).map((note) => {
        const shotId = note.source.find(source => source.startsWith("浅羽画面 · "))?.split(" · ")[1];
        return <article key={note.id}><small>{formatDate(note.updated)} · {isSourceArticle(note) ? "关联收藏" : "笔记"}</small>
          <p><Button variant="ghost" size="small" onClick={() => void onOpenArticle(note)}>{note.title}</Button></p>
          {shotId && <AsabaShotPreview id={shotId} />}
        </article>;
      })}
      {notes.length > visibleNotes && <Button size="small" variant="secondary" onClick={() => setVisibleNotes((count) => count + 12)}>加载更多笔记</Button>}
      {!notes.length && <p>暂无关联笔记</p>}
    </details>
    <details open={latestJobs.length > 0 || undefined}>
      <summary>委托（{latestJobs.length}）</summary>
      {jobGroups.map(({ latest, previous }) => <div key={latest.id}>
        <AsabaJobCard job={latest} projects={[{ id: project.id, title: project.title }]} onArchive={onArchive}
          onReviewed={latest.agent === "codex" && latest.state === "review" ? () => reviewed(latest) : undefined} />
        {previous.length > 0 && <details><summary>之前的尝试（{previous.length}）</summary>
          {previous.map((job) => <AsabaJobCard key={job.id} job={job} />)}
        </details>}
      </div>)}
      {!latestJobs.length && <p>暂无委托</p>}
    </details>
    <details>
      <summary>历史记录（{logs.length}）</summary>
      {logs.slice(0, visibleLogs).map((log) => <ProjectHistoryRow key={log.id} log={log} />)}
      {logs.length > visibleLogs && <Button size="small" variant="secondary" onClick={() => setVisibleLogs((count) => count + 12)}>加载更多记录</Button>}
      {!logs.length && <p>暂无历史记录</p>}
    </details>
    {isTauri() && <details><summary>项目目录</summary>
      {repository && <p>{repository}</p>}
      <Button size="small" onClick={() => void bind()}>{repository ? "更换仓库" : "选择本地 Git 仓库"}</Button>
      {repository && <Button size="small" variant="ghost" onClick={() => void companionApi.bindRepository(project.id, "").then(setRepository).catch(e => setError(String(e)))}>解除绑定</Button>}
    </details>}
    {error && <p role="status">{error}</p>}
  </div>;
}

function ProjectHistoryRow({ log }: { log: ProjectLog }) {
  const date = formatDate(log.createdAt);
  if (log.kind === "goal_revision") {
    try {
      const { before, after } = JSON.parse(log.body) as { before: string; after: string };
      return <article><small>{date} · 方向调整</small><p>原目标 · {before}</p><p>新目标 · {after}</p></article>;
    } catch { /* Older or externally edited log contents remain readable below. */ }
  }
  if (log.kind === "plan_revision") {
    const separator = log.body.indexOf("｜");
    if (separator >= 0) {
      try {
        const revision = JSON.parse(log.body.slice(separator + 1)) as {
          trigger?: string;
          accepted?: { title?: string; summary?: string };
        };
        return <article><small>{date} · {log.body.slice(0, separator)}</small>
          <p>{[revision.trigger, revision.accepted?.title || revision.accepted?.summary].filter(Boolean).join(" · ") || "项目路线已更新"}</p>
          <details><summary>查看原始记录</summary><pre>{JSON.stringify(revision, null, 2)}</pre></details>
        </article>;
      } catch { /* Keep plain-text revisions readable. */ }
    }
  }
  const text = decodeTaskProgressLog(log.body)?.result ?? decodeContinuationLog(log.body)?.text ?? log.body.replace(/^<!--[\s\S]*?-->\s*/, "");
  return <article><small>{date} · 项目记录</small><p>{text}</p></article>;
}

function formatDate(value: string) { return new Date(value).toLocaleDateString("zh-CN"); }

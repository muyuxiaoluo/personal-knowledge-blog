import { AsabaWorkerReport } from "./AsabaWorkerReport";
import { jobStatusLabel, type WorkerArchive } from "../app/asaba-worker";
import { useState } from "react";
import { asabaJobLabels, type AsabaJob } from "../app/companion-types";
import { companionApi } from "./companionApi";
import { Button } from "./DesktopControls";
import type { CareerReport } from "../app/asaba-career";
import { CareerSources } from "./AsabaCareer";

export function AsabaShotPreview({ id }: { id: string }) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  return <div>
    {!src && <Button size="small" variant="ghost" onClick={() => void companionApi.shot(id).then(setSrc).catch(e => setError(String(e)))}>查看本机画面</Button>}
    {src && <img src={src} alt="观察时的窗口画面" style={{ maxWidth: "100%", maxHeight: 360 }} />}
    {error && <small role="status">{error}</small>}
  </div>;
}

export function AsabaJobCard({ job, projects = [], onArchive, onCancel, onContinue, onReviewed }: {
  projects?: { id: string; title: string }[]; onArchive?: (request: WorkerArchive) => Promise<void>;
  job: AsabaJob; onCancel?: () => void; onContinue?: () => void; onReviewed?: () => void;
}) {
  const [openError, setOpenError] = useState("");
  const career = job.agent === "career" ? job.report as CareerReport | undefined : undefined;
  const research = career?.research ?? job.careerResearch;
  return <details className="asaba-details">
    <summary>{job.title || "Bug 排查"} · {jobStatusLabel(job) ?? asabaJobLabels[job.state]}</summary>
    {job.agent === "codex" ? <small>Codex · {job.workspaceMode === "original" ? "项目原目录" : "独立副本"}</small> : <small>{job.agent === "research" ? "公开资料调研" : job.agent === "career" ? "岗位调研与求职规划" : "本机 Word 格式检查"}</small>}
    {job.progress && <p role="status">{job.progress}</p>}
    {(job.agent === "research" || job.agent === "document") && job.report && <AsabaWorkerReport job={job} projects={projects} onArchive={onArchive} />}
    {job.agent === "career" && research && <CareerSources report={research} />}
    {career && !career.route && <p>目前缺少可核对的岗位样本。可以查看调研结果，再用更具体的范围重新发起。</p>}
    {career?.route && <p>{career.route.outcome}</p>}
    {career?.route && job.state === "review" && <Button size="small" variant="primary" onClick={() => {
      setOpenError("");
      void companionApi.openCareerReview(job.id).catch(error => setOpenError(String(error)));
    }}>查看并确认项目路线</Button>}
    {job.agent !== "codex" && ["failed", "interrupted", "cancelled"].includes(job.state) && <Button size="small" onClick={() => void companionApi.jobAction(job.id, "retry").catch(error => setOpenError(String(error)))}>继续委托</Button>}
    {job.summary && <p>{job.summary}</p>}
    {job.error && <p>{job.error}</p>}
    {job.commands.length > 0 && <details><summary>实际执行的命令 · {job.commands.length}</summary><ul>{job.commands.map(command => <li key={command}>{command}</li>)}</ul></details>}
    {job.diff && <details><summary>{job.workspaceMode === "original" ? "项目目录差异（含原有改动）" : "候选改动"}</summary><pre>{job.diff}</pre></details>}
    {job.sessionId && <Button size="small" onClick={() => {
      setOpenError("");
      void companionApi.jobAction(job.id, "openSession").catch(reason => setOpenError(String(reason)));
    }}>打开执行会话</Button>}
    {openError && <small role="status">{openError}</small>}
    {onCancel && <Button size="small" onClick={onCancel}>取消委托</Button>}
    {onContinue && <Button size="small" onClick={onContinue}>{job.sessionId ? "继续处理" : "重新委托"}</Button>}
    {onReviewed && <Button size="small" onClick={onReviewed}>标为已查看</Button>}
  </details>;
}

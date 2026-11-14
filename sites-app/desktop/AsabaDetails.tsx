import { useState } from "react";
import { asabaJobLabels, type AsabaJob } from "../app/companion-types";
import { companionApi } from "./companionApi";
import { Button } from "./DesktopControls";

export function AsabaShotPreview({ id }: { id: string }) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  return <div>
    {!src && <Button size="small" variant="ghost" onClick={() => void companionApi.shot(id).then(setSrc).catch(e => setError(String(e)))}>查看本机画面</Button>}
    {src && <img src={src} alt="观察时的窗口画面" style={{ maxWidth: "100%", maxHeight: 360 }} />}
    {error && <small role="status">{error}</small>}
  </div>;
}

export function AsabaJobCard({ job, onCancel, onContinue, onReviewed }: {
  job: AsabaJob; onCancel?: () => void; onContinue?: () => void; onReviewed?: () => void;
}) {
  const [openError, setOpenError] = useState("");
  return <details className="asaba-details">
    <summary>{job.title || "Bug 排查"} · {asabaJobLabels[job.state]}</summary>
    <small>{job.agent === "codex" ? "Codex" : job.agent} · {job.workspaceMode === "original" ? "项目原目录" : "独立副本"}</small>
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

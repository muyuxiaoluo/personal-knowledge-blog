import { useId, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AsabaJob } from "../app/companion-types";
import type { DocumentReport, ResearchReport, ResearchSource, WorkerArchive } from "../app/asaba-worker";
import { formatAsabaEvidenceDate } from "../app/asaba-planning";
import { Button, SelectMenu } from "./DesktopControls";

export function AsabaWorkerReport({ job, projects, onArchive }: {
  job: AsabaJob;
  projects: { id: string; title: string }[];
  onArchive?: (request: WorkerArchive) => Promise<void>;
}) {
  const [selected, setSelected] = useState(job.projectId || "");
  const [includeAction, setIncludeAction] = useState(false);
  const [action, setAction] = useState((job.report as ResearchReport | DocumentReport | undefined)?.nextAction || "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const id = useId();
  const destination = projects.some(project => project.id === selected) ? selected : "";
  const report = job.report;
  if (!report) return null;

  function link(source: ResearchSource) {
    void openUrl(source.url).catch(error => setMessage(String(error)));
  }

  async function save() {
    if (!onArchive || !destination || busy) return;
    setBusy(true);
    setMessage("");
    try {
      await onArchive({ jobId: job.id, projectId: destination, action: includeAction ? action.trim() : "" });
      setMessage("成果已保存到项目。");
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }

  return <div className="asaba-worker-report">
    {job.agent === "research" ? <ResearchResult report={report as ResearchReport} onOpen={link} /> : <DocumentResult report={report as DocumentReport} />}
    {onArchive && job.state === "review" && <div className="asaba-worker-save">
      <SelectMenu label="保存到项目" value={destination} onChange={setSelected} disabled={busy}
        options={[{ value: "", label: "选择项目" }, ...projects.map(project => ({ value: project.id, label: project.title }))]} />
      <label><input type="checkbox" checked={includeAction} disabled={busy} onChange={event => setIncludeAction(event.target.checked)} />同时加入一条待办</label>
      {includeAction && <label htmlFor={id}>下一步<input id={id} maxLength={200} value={action} disabled={busy} onChange={event => setAction(event.target.value)} /></label>}
      <Button size="small" variant="primary" disabled={!destination || busy || (includeAction && !action.trim())} onClick={() => void save()}>{busy ? "正在保存…" : "保存到项目"}</Button>
    </div>}
    {message && <p role="status">{message}</p>}
  </div>;
}

function ResearchResult({ report, onOpen }: { report: ResearchReport; onOpen: (source: ResearchSource) => void }) {
  return <>
    <p>查到 {report.sources.length} 条来源，识别 {report.positions.length} 条岗位。</p>
    {report.findings.map((item, index) => <div key={index}>
      <p>{item.text}</p>
      <div className="asaba-actions">{[...new Set(item.sourceIds)].map(id => {
        const source = report.sources.find(source => source.id === id);
        return source && <Button key={id} size="small" variant="ghost" onClick={() => onOpen(source)}>来源 {id}</Button>;
      })}</div>
    </div>)}
    {report.positions.length > 0 && <details><summary>岗位样本</summary><ul>{report.positions.map(item => <li key={item.sourceId}><strong>{item.company} · {item.role}</strong> [{item.sourceId}]<p>{item.requirements.join("、")}</p></li>)}</ul></details>}
    {report.sources.length > 0 && <details><summary>来源详情</summary><ul>{report.sources.map(source => <li key={source.id}>
      <Button size="small" variant="ghost" wrap onClick={() => onOpen(source)}>{source.id} · {source.title || source.url}</Button>
      <small>发布 {source.date ? formatAsabaEvidenceDate(source.date) : "未知"} · 查阅 {formatAsabaEvidenceDate(source.readAt || source.accessedAt)} · {source.readAt ? "已读取正文" : "仅搜索摘要"}</small>
      {source.excerpt && <p>{source.excerpt}</p>}
    </li>)}</ul></details>}
    {report.limitations.length > 0 && <ul>{report.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul>}
    {report.nextAction && <p>下一步建议 · {report.nextAction}</p>}
  </>;
}

function DocumentResult({ report }: { report: DocumentReport }) {
  return <>
    <p>比对 {report.checked} 项属性，发现 {report.issues.length + report.omitted} 处差异。</p>
    {report.issues.length > 0 && <details><summary>格式差异</summary><ul>{report.issues.map((item, index) => <li key={index}>
      <strong>{item.location} · {item.property}</strong><p>实测 {item.actual} · 模板 {item.expected}</p>
    </li>)}</ul></details>}
    {report.omitted > 0 && <p>结果达到显示上限，另有 {report.omitted} 处差异。</p>}
    {report.manual.length > 0 && <details><summary>待人工确认</summary><ul>{report.manual.map(item => <li key={item}>{item}</li>)}</ul></details>}
  </>;
}

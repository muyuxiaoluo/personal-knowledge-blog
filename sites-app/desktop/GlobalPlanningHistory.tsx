import { useEffect, useState } from "react";
import type { PlanningHistoryRepository } from "../app/data/sqlite-ai-repository";
import type { GlobalPlanningHistoryEntry, GlobalPlanningRecord } from "../app/global-planning";
import { Button } from "./DesktopControls";
import { GlobalPlanningResults } from "./GlobalPlanningResults";

export function GlobalPlanningHistory({ repository }: { repository: PlanningHistoryRepository }) {
  const [entries, setEntries] = useState<GlobalPlanningHistoryEntry[]>([]);
  const [record, setRecord] = useState<GlobalPlanningRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hasMore, setHasMore] = useState(false);
  useEffect(() => {
    let active = true;
    setBusy(true);
    void repository.listPlanningHistory(20).then((rows) => {
      if (active) { setEntries(rows); setHasMore(rows.length === 20); }
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "历史记录读取失败"); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [repository]);
  async function read(id: string) {
    setBusy(true); setError("");
    try {
      const saved = await repository.getPlanningRecord(id);
      if (!saved) throw new Error("这条规划记录已不存在");
      setRecord(saved);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "规划记录读取失败"); }
    finally { setBusy(false); }
  }
  async function loadMore() {
    setBusy(true); setError("");
    try {
      const rows = await repository.listPlanningHistory(20, entries.length);
      setEntries((current) => [...current, ...rows]); setHasMore(rows.length === 20);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "历史记录读取失败"); }
    finally { setBusy(false); }
  }
  return <div className="planning-history">
    {error && <p className="project-ai-error" role="alert">{error}</p>}
    {record ? <>
      <Button variant="ghost" size="small" onClick={() => setRecord(null)}>← 返回记录列表</Button>
      <header className="planning-history-heading"><h3>{formatPlanningTime(record.createdAt)}</h3><small>{record.model} · 历史记录，仅供回看</small></header>
      {record.request && <section className="planning-history-request"><strong>当时的想法与约束</strong><p>{record.request}</p></section>}
      {record.clarifications.length > 0 && <details className="planning-answer-history"><summary>当时补充的 {record.clarifications.length} 条信息</summary><dl>{record.clarifications.map((item, index) => <div key={index}><dt>{item.question}</dt><dd>{item.answer}</dd></div>)}</dl></details>}
      <GlobalPlanningResults proposal={record.proposal} titles={record.titles} readOnly projects={[]} tasks={[]} today="" busy={false} error="" onAnswer={async () => false} onOpenProject={() => {}} onOpenTask={() => {}} onPlanToday={() => {}} />
    </> : <>
      {!entries.length && !busy && !error && <p className="planning-history-empty">还没有保存的规划。之后每次生成和补充更新都会自动留在这里。</p>}
      <div className="planning-history-list">{entries.map((item) => <button type="button" key={item.id} disabled={busy} onClick={() => void read(item.id)}><span><strong>{formatPlanningTime(item.createdAt)}</strong><small>{item.model}</small></span><p>{item.request || item.summary}</p></button>)}</div>
      {hasMore && <Button variant="secondary" disabled={busy} onClick={() => void loadMore()}>查看更多记录</Button>}
    </>}
    {busy && <p role="status">正在读取记录…</p>}
  </div>;
}

function formatPlanningTime(value: string) { return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", year: "numeric" }); }

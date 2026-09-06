import { useEffect, useState, type FormEvent } from "react";
import type { DailySituation, SituationPlanChange, SituationTask, TaskPlanHistory } from "../app/work-types";
import type { WorkspaceTask } from "./WorkPages";
import { isValidDay } from "../app/action-planning";
import { Button, DateField, SelectMenu } from "./DesktopControls";

export function DailySituationDialog({ date, today, tasks, history, situations, activeTaskId, onClose, onSave }: {
  date: string; today: string; tasks: WorkspaceTask[]; history: TaskPlanHistory[]; situations: DailySituation[];
  activeTaskId?: string | null; onClose: () => void;
  onSave: (situation: DailySituation, changes: SituationPlanChange[]) => Promise<void>;
}) {
  const [selectedDate, setSelectedDate] = useState(date);
  const existing = situations.find((item) => item.date === selectedDate);
  const [reason, setReason] = useState(existing?.reason ?? "");
  const [actualWork, setActualWork] = useState(existing?.actualWork ?? "");
  const [affected, setAffected] = useState<SituationTask[]>(existing?.tasks ?? []);
  const [next, setNext] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setReason(existing?.reason ?? ""); setActualWork(existing?.actualWork ?? ""); setAffected(existing?.tasks ?? []);
    setNext({}); setShowAll(false); setError("");
  }, [selectedDate, existing]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [busy, onClose]);
  const historical = history.filter((item) => item.plannedDate === selectedDate);
  const candidates = new Map(historical.map((item) => [item.taskId, { taskId: item.taskId, title: item.taskTitle || tasks.find((task) => task.id === item.taskId)?.title || "已移除的行动", focus: item.currentFocus }]));
  for (const item of affected) if (!candidates.has(item.taskId)) candidates.set(item.taskId, { taskId: item.taskId, title: item.title, focus: "" });
  if (showAll) for (const task of tasks) if (!candidates.has(task.id)) candidates.set(task.id, { taskId: task.id, title: task.title, focus: task.currentFocus });
  function canAdjust(task: WorkspaceTask | undefined) {
    return task && task.plan?.plannedDate && task.plan.plannedDate <= selectedDate && !["done", "cancelled", "waiting"].includes(task.status) && task.id !== activeTaskId;
  }
  function update(taskId: string, patch: Partial<SituationTask>) {
    setAffected((items) => items.map((item) => item.taskId === taskId ? { ...item, ...patch } : item));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!isValidDay(selectedDate) || selectedDate > today) { setError("请选择今天或更早的有效日期。"); return; }
    setBusy(true); setError("");
    try {
      const changes = affected.flatMap((item): SituationPlanChange[] => {
        const task = tasks.find((task) => task.id === item.taskId);
        const destination = next[item.taskId] ?? (existing ? "keep" : "pending");
        return canAdjust(task) && task?.plan && destination !== "keep"
          ? [{ taskId: item.taskId, expectedPlan: task.plan, plannedDate: destination === "pending" ? "" : destination }]
          : [];
      });
      await onSave({ date: selectedDate, reason, actualWork, tasks: affected, updatedAt: existing?.updatedAt ?? "" }, changes);
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试。"); }
    finally { setBusy(false); }
  }
  return <div className="task-closeout-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="task-closeout-dialog situation-dialog" role="dialog" aria-modal="true" aria-label="补记当天情况" onSubmit={(event) => void submit(event)}>
      <header><div><span>计划可以随生活变化</span><h2>补记当天情况</h2></div><Button variant="secondary" size="small" iconOnly type="button" disabled={busy} onClick={onClose} aria-label="关闭">×</Button></header>
      <fieldset disabled={busy}>
        <DateField label="实际发生日期" optional={false} value={selectedDate} onChange={setSelectedDate} />
        <label><span>当天发生了什么 · 必填</span><textarea autoFocus value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：临时协助导师实验，原定安排全天未推进。" /></label>
        <label><span>实际做了什么 · 可选</span><textarea value={actualWork} onChange={(event) => setActualWork(event.target.value)} placeholder="例如：完成样品测量与数据整理。" /></label>
        <div className="situation-candidates"><strong>受影响的行动</strong><p>勾选需要说明的行动，原因只写一次。历史安排从此功能启用后保留，更早的行动可以手动补选。</p>
          {!historical.length && <small>这一天没有可回看的原定安排。</small>}
          {[...candidates.values()].map((candidate) => {
            const selected = affected.find((item) => item.taskId === candidate.taskId);
            const task = tasks.find((item) => item.id === candidate.taskId);
            const destination = next[candidate.taskId] ?? (existing ? "keep" : "pending");
            return <article key={candidate.taskId}>
              <label className="situation-check"><input type="checkbox" checked={Boolean(selected)} onChange={(event) => setAffected((items) => event.target.checked ? [...items, { taskId: candidate.taskId, title: candidate.title, outcome: "not_started", progress: "" }] : items.filter((item) => item.taskId !== candidate.taskId))} /><span>{candidate.title}</span></label>
              {candidate.focus && <small>原定起点：{candidate.focus}</small>}
              {selected && <div className="situation-task-fields">
                <SelectMenu label="当天实际情况" value={selected.outcome} onChange={(value) => update(candidate.taskId, { outcome: value as SituationTask["outcome"] })} options={[{ value: "not_started", label: "未开始" }, { value: "partial", label: "部分推进" }]} />
                {selected.outcome === "partial" && <label><span>当天做到哪里 · 必填</span><textarea value={selected.progress} onChange={(event) => update(candidate.taskId, { progress: event.target.value })} /></label>}
                {canAdjust(task) ? <>
                  <SelectMenu label="接下来怎么安排" value={destination === "keep" || destination === "pending" ? destination : "date"} onChange={(value) => setNext({ ...next, [candidate.taskId]: value === "date" ? today : value })} options={[{ value: "pending", label: "待继续，有空再做" }, { value: "keep", label: "保持当前安排" }, { value: "date", label: "安排到指定日期" }]} />
                  {destination !== "pending" && destination !== "keep" && <DateField label="后续日期（今天或以后）" optional={false} value={destination} onChange={(value) => setNext({ ...next, [candidate.taskId]: value || today })} />}
                </> : <small>仅补充历史说明；当前状态、后续安排和正在进行的投入保持不变。</small>}
              </div>}
            </article>;
          })}
          <Button type="button" variant="secondary" onClick={() => setShowAll(!showAll)}>{showAll ? "收起其他行动" : "从其他行动补选"}</Button>
        </div>
      </fieldset>
      {error && <p role="alert" className="project-ai-error">{error}</p>}
      <footer><Button variant="secondary" type="button" disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={busy || !reason.trim() || affected.some((item) => item.outcome === "partial" && !item.progress.trim())}>{busy ? "正在保存…" : "保存当天情况"}</Button></footer>
    </form>
  </div>;
}

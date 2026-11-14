import { useEffect, useMemo, useRef, useState } from "react";
import type { GlobalPlanningProposal } from "../app/ai-api-types";
import { resolveAvailableDeepSeekModel } from "../app/ai-model-settings";
import { buildGlobalPlanningContext, projectAttention, validateGlobalPlanningProposal, type GlobalPlanningRecord, type PlanningClarification, type PlanningInput } from "../app/global-planning";
import type { PlanningHistoryRepository } from "../app/data/sqlite-ai-repository";
import { Button } from "./DesktopControls";
import { desktopApi } from "./integrationApi";
import type { WorkspaceTask } from "./WorkPages";
import { GlobalPlanningResults } from "./GlobalPlanningResults";
import { GlobalPlanningHistory } from "./GlobalPlanningHistory";

export function GlobalPlanningAssistant({ input, historyRepository, onOpenProject, onOpenTask, onPlanToday }: {
  input: Omit<PlanningInput, "tasks"> & { tasks: WorkspaceTask[] };
  historyRepository: PlanningHistoryRepository;
  onOpenProject: (id: string) => void;
  onOpenTask: (id: string) => void;
  onPlanToday: (task: WorkspaceTask) => void;
}) {
  const attention = useMemo(() => projectAttention(input), [input]);
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pendingSave, setPendingSave] = useState<GlobalPlanningRecord | null>(null);
  const [saveError, setSaveError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [request, setRequest] = useState("");
  const [result, setResult] = useState<{ proposal: GlobalPlanningProposal; source: string; model: string; revision: number } | null>(null);
  const [clarifications, setClarifications] = useState<PlanningClarification[]>([]);
  const resultRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Invalidate advice after changes to facts, dates, or the user's constraints.
  const source = useMemo(() => JSON.stringify(input), [input]);
  const currentResult = result?.source === source ? result : null;
  useEffect(() => { if (currentResult) resultRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }); }, [result?.revision]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open) dialog?.showModal();
    else dialog?.close();
    return () => { dialog?.close(); };
  }, [open]);
  function openProject(id: string) { setOpen(false); onOpenProject(id); }
  function openTask(id: string) { setOpen(false); onOpenTask(id); }
  async function persist(record: GlobalPlanningRecord) {
    try { await historyRepository.savePlanningRecord(record); setPendingSave(null); setSaveError(""); }
    catch { setPendingSave(record); setSaveError("建议已生成，但历史保存失败。请重试保存。"); }
  }
  async function generate(answers: PlanningClarification[] = []) {
    if (busy) return false;
    setBusy(true); setError("");
    try {
      const nextClarifications = [...clarifications, ...answers];
      const context = buildGlobalPlanningContext(input, request, result && nextClarifications.length ? { previousProposal: result.proposal, clarifications: nextClarifications } : undefined);
      const model = await resolveAvailableDeepSeekModel("globalPlanning", desktopApi.deepseek.apiModels);
      const response = await desktopApi.deepseek.planGlobally({ model, input: context });
      const proposal = validateGlobalPlanningProposal(response.content, input);
      setResult({ proposal, source, model: response.model, revision: Date.now() });
      setClarifications(nextClarifications);
      await persist({
        id: crypto.randomUUID(), createdAt: new Date().toISOString(), request, clarifications: nextClarifications, proposal, model: response.model,
        titles: proposal.suggestions.map((item) => input.tasks.find((task) => task.id === item.taskId)?.title || input.projects.find(({ project }) => project.id === item.projectId)?.project.title || "规划建议"),
      });
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "全局规划生成失败，请重试。"); return false; }
    finally { setBusy(false); }
  }
  return <>
    <button className="global-planning-launcher workspace-card" type="button" data-home-tile aria-label="打开全局规划助手" aria-haspopup="dialog" aria-expanded={open} onClick={() => { setHistoryOpen(false); setOpen(true); }}>
      <span className="planning-launcher-heading"><strong>全局规划助手</strong>{attention.length > 0 && <span className="planning-attention-count">{attention.length} 项待回看</span>}</span>
      <span className="planning-launcher-description">检查项目遗漏，按需梳理下一步。</span>
      <span className="planning-launcher-link">查看与规划 <span aria-hidden="true">→</span></span>
    </button>
    <dialog ref={dialogRef} className="global-planning planning-dialog" aria-label="全局规划助手" onClose={() => setOpen(false)} onCancel={(event) => { event.preventDefault(); setOpen(false); }} onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setOpen(false);
    }}>
      <header><div><h2>{historyOpen ? "规划历史记录" : "全局规划助手"}</h2><p>{historyOpen ? "回看之前的建议、当时的约束和补充回答。" : attention.length ? `${attention.length} 个项目值得回看，先挑一件推进即可。` : "结合已有进展，看看下一步值得把精力放在哪里。"}</p></div><nav className="planning-dialog-actions"><Button variant="secondary" size="small" disabled={busy} onClick={() => setHistoryOpen((value) => !value)}>{historyOpen ? "返回当前规划" : "历史记录"}</Button><Button variant="ghost" size="small" iconOnly autoFocus type="button" aria-label="关闭全局规划助手" onClick={() => setOpen(false)}>×</Button></nav></header>
      {historyOpen && <div className="planning-dialog-content"><GlobalPlanningHistory repository={historyRepository} /></div>}
      <div className="planning-dialog-content" hidden={historyOpen}>
    {attention.length > 0 && <details className="planning-attention-disclosure"><summary>查看项目提醒 · {attention.length} 项</summary><div className="planning-attention">{attention.map((item) => <button type="button" key={item.projectId} onClick={() => openProject(item.projectId)}><strong>{item.title}</strong><span>{item.reasons.join("；")}</span><small>最近记录 · {item.lastProgressDate} →</small></button>)}</div></details>}
    <div className="planning-body">
      <label><span>今天的精力、可用时间或想优先做的事 · 可选</span><textarea value={request} disabled={busy} onChange={(event) => { setRequest(event.target.value); setResult(null); setClarifications([]); }} placeholder="例如：今天只有半小时，帮我找一个久未推进、但现在值得继续的项目。" /></label>
      <p className="planning-scope">生成时会将项目、行动、近期推进记录、已积累内容和本周聚焦发送给已配置的 AI。自动提醒来自本地记录；AI 会进一步检查可能的遗漏，给出最多三项建议。</p>
      <Button variant="primary" type="button" disabled={busy || Boolean(pendingSave)} onClick={() => void generate()}>{busy ? "正在梳理项目与进展…" : currentResult ? "重新梳理" : "梳理全局，建议下一步"}</Button>
      {saveError && <div className="planning-save-error" role="alert"><p>{saveError}</p>{pendingSave && <Button variant="secondary" size="small" disabled={busy} onClick={() => void persist(pendingSave)}>重试保存</Button>}</div>}
      {error && !currentResult && <p className="project-ai-error" role="alert">{error}</p>}
      {result && !currentResult && <p role="status">记录或安排已更新，可以重新梳理最新情况。</p>}
      {clarifications.length > 0 && <details className="planning-answer-history"><summary>已补充 {clarifications.length} 条信息</summary><dl>{clarifications.map((item, index) => <div key={index}><dt>{item.question}</dt><dd>{item.answer}</dd></div>)}</dl></details>}
      {currentResult && <div ref={resultRef} className="planning-result-anchor">
        <GlobalPlanningResults key={currentResult.revision} proposal={currentResult.proposal} projects={input.projects} tasks={input.tasks} today={input.today} busy={busy || Boolean(pendingSave)} error={error} onAnswer={generate} onOpenProject={openProject} onOpenTask={openTask} onPlanToday={onPlanToday} />
        <small className="planning-result-meta">生成模型 · {currentResult.model} · 建议采用后才改变安排</small>
      </div>}
    </div>
      </div>
    </dialog>
  </>;
}

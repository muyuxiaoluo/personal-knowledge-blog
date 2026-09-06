import { useEffect, useState } from "react";
import type { NextActionProposal } from "../app/ai-api-types";
import { resolveAvailableDeepSeekModel } from "../app/ai-model-settings";
import type { NewActionInput } from "./WorkPages";
import { desktopApi } from "./integrationApi";
import { Button } from "./DesktopControls";

export function ActionPlanningAssistant({ onClose, onAddTask }: {
  onClose: () => void; onAddTask: (input: NewActionInput) => Promise<boolean>;
}) {
  const [request, setRequest] = useState("");
  const [constraints, setConstraints] = useState("");
  const [proposal, setProposal] = useState<NextActionProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [today, setToday] = useState(false);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [busy, onClose]);
  async function generate() {
    setBusy(true); setError(""); setProposal(null);
    try {
      const model = await resolveAvailableDeepSeekModel("nextAction", desktopApi.deepseek.apiModels);
      const response = await desktopApi.deepseek.suggestNextAction({ model, input: {
        userRequest: request.trim(), effortAndOutcome: constraints.trim(),
        purpose: "先判断怎样最省力地达到用户认可的结果，再建议一个有范围和停止条件的起步行动。reason 用简短中文说明路线、暂时省略什么及关键假设。后续路线仅作为 details 中的参考，不生成阶段和待办清单。信息不足时先建议验证关键未知，不编造时间预算或保证结果。",
      }, allowedMilestoneIds: [], allowedTaskIds: [] });
      setProposal(response.content);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "生成失败，请重试。"); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!proposal) return;
    setBusy(true); setError("");
    try {
      const saved = await onAddTask({ projectId: null, milestoneId: null, direction: "uncategorized", title: proposal.action.title,
        currentFocus: proposal.action.currentFocus, definitionOfDone: proposal.action.definitionOfDone, steps: [],
        details: [`想做的事：${request.trim()}`, constraints.trim() ? `目标与投入约束：${constraints.trim()}` : "", proposal.reason, proposal.action.details].filter(Boolean).join("\n\n"),
        dueDate: proposal.action.dueDate, plannedToday: today, keepAvailable: !today });
      if (saved) onClose(); else setError("行动未保存，请重试。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试。"); }
    finally { setBusy(false); }
  }
  function update(patch: Partial<NextActionProposal["action"]>) { if (proposal) setProposal({ ...proposal, action: { ...proposal.action, ...patch } }); }
  return <div className="task-closeout-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="task-closeout-dialog situation-dialog" role="dialog" aria-modal="true" aria-label="AI 帮我起步">
      <header><div><span>先找到值得做的一小步</span><h2>AI 帮我起步</h2></div><Button variant="secondary" size="small" iconOnly type="button" disabled={busy} onClick={onClose} aria-label="关闭">×</Button></header>
      <fieldset disabled={busy}>
        <label><span>说说你想做的事</span><textarea autoFocus value={request} onChange={(event) => { setRequest(event.target.value); setProposal(null); }} placeholder="例如：准备一门考试，想找合适资料、刷些题就去考，不想做完整的学习计划。" /></label>
        <label><span>做到什么程度、最多投入多少 · 可选</span><textarea value={constraints} onChange={(event) => { setConstraints(event.target.value); setProposal(null); }} placeholder="例如：只求通过；下周考试，总共愿意投入三小时。也可以写不想做的事。" /></label>
        <p>仅把这里填写的内容发送给已配置的 AI。先给路线和一项行动，采用后才保存。</p>
        {!proposal && <Button variant="primary" disabled={!request.trim()} onClick={() => void generate()}>{busy ? "正在分析…" : "帮我找最小可行的起点"}</Button>}
        {proposal && <div className="situation-task-fields">
          <p className="ai-start-reason">{proposal.reason}</p>
          <label><span>行动名称</span><input value={proposal.action.title} onChange={(event) => update({ title: event.target.value })} /></label>
          <label><span>这次具体做什么</span><textarea value={proposal.action.currentFocus} onChange={(event) => update({ currentFocus: event.target.value })} /></label>
          <label><span>做到哪里就可以停</span><textarea value={proposal.action.definitionOfDone} onChange={(event) => update({ definitionOfDone: event.target.value })} /></label>
          <label><span>后续参考与取舍</span><textarea value={proposal.action.details} onChange={(event) => update({ details: event.target.value })} /></label>
          <label className="situation-check"><input type="checkbox" checked={today} onChange={(event) => setToday(event.target.checked)} /><span>安排到今天（不勾选则留在待继续）</span></label>
        </div>}
      </fieldset>
      {error && <p role="alert" className="project-ai-error">{error}</p>}
      {proposal && <footer><Button variant="secondary" type="button" disabled={busy} onClick={() => setProposal(null)}>调整想法再生成</Button><Button variant="primary" disabled={busy || !proposal.action.title.trim() || !proposal.action.currentFocus.trim() || !proposal.action.definitionOfDone.trim()} onClick={() => void save()}>{busy ? "正在保存…" : "采用这一步"}</Button></footer>}
    </section>
  </div>;
}

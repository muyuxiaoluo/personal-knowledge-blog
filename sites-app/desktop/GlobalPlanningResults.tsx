import { useState, type FormEvent } from "react";
import type { GlobalPlanningProposal } from "../app/ai-api-types";
import type { PlanningClarification } from "../app/global-planning";
import type { ProjectDetail } from "../app/project-types";
import { Button } from "./DesktopControls";
import type { WorkspaceTask } from "./WorkPages";

export function GlobalPlanningResults({ proposal, projects, tasks, today, busy, error, readOnly = false, titles, onAnswer, onOpenProject, onOpenTask, onPlanToday }: {
  proposal: GlobalPlanningProposal;
  projects: ProjectDetail[];
  tasks: WorkspaceTask[];
  today: string;
  busy: boolean;
  error: string;
  readOnly?: boolean;
  titles?: string[];
  onAnswer: (answers: PlanningClarification[]) => Promise<boolean>;
  onOpenProject: (id: string) => void;
  onOpenTask: (id: string) => void;
  onPlanToday: (task: WorkspaceTask) => void;
}) {
  const [answers, setAnswers] = useState(() => proposal.questions.map(() => ""));
  const hasAnswer = answers.some((answer) => answer.trim());
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !hasAnswer) return;
    await onAnswer(proposal.questions.map((question, index) => ({ question, answer: answers[index].trim() })).filter(({ answer }) => answer));
  }
  return <div className="planning-result">
    <section className="planning-conclusion" aria-label="这次的建议">
      <h3>这次先做</h3>
      {proposal.summary.length > 120 ? <details className="planning-long-summary"><summary>{proposal.summary.slice(0, 80)}…<span>展开完整说明</span></summary><p>{proposal.summary}</p></details> : <p>{proposal.summary}</p>}
    </section>
    {proposal.suggestions.map((item, index) => {
      const task = tasks.find((task) => task.id === item.taskId);
      const project = projects.find(({ project }) => project.id === item.projectId)?.project;
      return <article key={item.taskId || item.projectId || index} className="planning-suggestion">
        <header><span className="planning-suggestion-number">{index + 1}</span><h3>{titles?.[index] || task?.title || project?.title || "规划建议"}</h3>{!readOnly && task?.plan?.plannedDate === today && <small>已安排到今天</small>}</header>
        <p className="planning-next-step">{item.nextStep}</p>
        <details className="planning-reason"><summary>查看建议依据</summary><p>{item.reason}</p></details>
        {!readOnly && <footer>{task ? <><Button variant="secondary" size="small" type="button" onClick={() => onOpenTask(task.id)}>查看行动</Button><Button variant="primary" size="small" type="button" disabled={task.plan?.plannedDate === today} onClick={() => onPlanToday(task)}>安排到今天</Button></> : project && <Button variant="secondary" size="small" type="button" onClick={() => onOpenProject(project.id)}>进入项目安排下一步 →</Button>}</footer>}
      </article>;
    })}
    {proposal.questions.length > 0 && !readOnly && <form className="planning-questions" onSubmit={(event) => void submit(event)} aria-label="补充信息" aria-busy={busy}>
      <header><h3>补充后再调整</h3><p>可以只回答其中一项。</p></header>
      {proposal.questions.map((question, index) => <label key={index} className="planning-question"><span>{question}</span><textarea value={answers[index]} disabled={busy} onChange={(event) => setAnswers((current) => current.map((value, itemIndex) => itemIndex === index ? event.target.value : value))} placeholder="在这里回答，可留空" /></label>)}
      <Button variant="primary" type="submit" disabled={busy || !hasAnswer}>{busy ? "正在根据补充调整…" : "补充并更新建议"}</Button>
    </form>}
    {readOnly && proposal.questions.length > 0 && <details className="planning-answer-history"><summary>当时待确认的问题</summary><ul>{proposal.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></details>}
    {error && <p className="project-ai-error" role="alert">{error}</p>}
  </div>;
}

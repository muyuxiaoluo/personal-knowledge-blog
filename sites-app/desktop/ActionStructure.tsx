import { Button } from "./DesktopControls";
import type { ProjectTaskStep } from "../app/project-types";

type StepEditorProps = {
  steps: ProjectTaskStep[];
  onChange: (steps: ProjectTaskStep[]) => void;
};

export function ActionStepEditor({ steps, onChange }: StepEditorProps) {
  function update(id: string, title: string) {
    onChange(steps.map((step) => step.id === id ? { ...step, title } : step));
  }

  function remove(id: string) {
    onChange(steps.filter((step) => step.id !== id));
  }

  function add() {
    onChange([...steps, { id: newStepId(), title: "", completed: false }]);
  }

  return <fieldset className="action-step-editor">
    <legend><span>关键步骤</span><small>可选 · 只拆到真正有帮助的程度</small></legend>
    {steps.map((step, index) => <div key={step.id}>
      <i>{index + 1}</i>
      <input value={step.title} onChange={(event) => update(step.id, event.target.value)} placeholder="例如：先筛出与问题最相关的实验" />
      <Button variant="secondary" size="small" iconOnly type="button" onClick={() => remove(step.id)} aria-label={`删除第 ${index + 1} 个步骤`}>×</Button>
    </div>)}
    <Button variant="secondary" className="action-step-add" type="button" onClick={add}>＋ 添加一个关键步骤</Button>
  </fieldset>;
}

export function ActionChecklist({ steps, onToggle }: {
  steps: ProjectTaskStep[];
  onToggle?: (stepId: string) => void;
}) {
  if (!steps.length) return null;
  const completed = steps.filter((step) => step.completed).length;
  return <section className="action-checklist">
    <header><strong>关键步骤</strong><span>{completed}/{steps.length}</span></header>
    <div>{steps.map((step) => <label className={step.completed ? "completed" : ""} key={step.id}>
      <input type="checkbox" checked={step.completed} disabled={!onToggle} onChange={() => onToggle?.(step.id)} />
      <span>{step.title}</span>
    </label>)}</div>
  </section>;
}

function newStepId() {
  return `step-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

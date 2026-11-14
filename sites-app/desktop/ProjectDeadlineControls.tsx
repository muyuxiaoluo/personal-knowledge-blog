import { useId, useState, type FormEvent } from "react";
import { classifyDeadlineUrgency } from "../app/date-helpers";
import type { Milestone } from "../app/project-types";
import { Button, DateField } from "./DesktopControls";

function shortDate(date: string) {
  const [, month, day] = date.split("-");
  return `${Number(month)}/${Number(day)}`;
}

export function StageDeadlineControls({ milestone, adaptive, hasCurrentAction, saving, onSave }: {
  milestone: Milestone;
  adaptive: boolean;
  hasCurrentAction: boolean;
  saving: boolean;
  onSave: (milestone: Milestone) => Promise<boolean>;
}) {
  const id = useId();
  const { dueDate } = milestone;
  const [editing, setEditing] = useState(false);
  const [draftDate, setDraftDate] = useState(dueDate);
  const urgency = classifyDeadlineUrgency(dueDate);
  const label = adaptive ? "检查点" : "阶段";
  async function saveDate(event: FormEvent) {
    event.preventDefault();
    if (saving || !draftDate || draftDate === dueDate) return;
    if (await onSave({ ...milestone, dueDate: draftDate })) setEditing(false);
  }
  return <div className={`project-deadline-controls ${urgency?.tone ?? ""}`}>
    <div className="project-deadline-summary">
      <time dateTime={dueDate}>{label}截止 · {shortDate(dueDate)}</time>
      {urgency && <span className="project-deadline-status" role="status">{urgency.label}</span>}
      <Button variant="ghost" size="small" className="project-deadline-adjust" disabled={saving} aria-expanded={editing} aria-controls={id}
        onClick={() => { setDraftDate(dueDate); setEditing((current) => !current); }}>调整日期</Button>
      {urgency && <small>{hasCurrentAction ? "可继续推进当前行动，或按实际情况调整日期。" : "可在下方安排当前行动，或调整日期。"}</small>}
    </div>
    {editing && <form id={id} className="project-deadline-editor" onSubmit={(event) => void saveDate(event)}>
      <DateField label={`新的${label}截止日期`} optional={false} value={draftDate} onChange={setDraftDate} />
      <div><Button variant="secondary" size="small" disabled={saving} onClick={() => { setDraftDate(dueDate); setEditing(false); }}>取消</Button><Button variant="primary" size="small" type="submit" disabled={saving || !draftDate || draftDate === dueDate}>{saving ? "保存中…" : "保存日期"}</Button></div>
    </form>}
  </div>;
}

export function ProjectTargetDate({ dueDate, onAdjust, saving }: { dueDate: string; onAdjust: () => void; saving: boolean }) {
  const urgency = classifyDeadlineUrgency(dueDate);
  return <div className={`project-deadline-controls ${urgency?.tone ?? ""}`}>
    <div className="project-deadline-summary">
      <time dateTime={dueDate}>项目目标 · {shortDate(dueDate)}</time>
      {urgency && <span className="project-deadline-status" role="status">{urgency.label}</span>}
      <Button variant="ghost" size="small" disabled={saving} onClick={onAdjust}>调整目标日期</Button>
    </div>
  </div>;
}

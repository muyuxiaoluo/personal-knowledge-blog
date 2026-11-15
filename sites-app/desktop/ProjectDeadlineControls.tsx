import { useId, useState, type FormEvent } from "react";
import { projectDateLabel } from "../app/project-dates";
import { ProjectDateField } from "./ProjectDateField";
import type { Milestone, ProjectDateKind } from "../app/project-types";
import { Button } from "./DesktopControls";

export function StageDeadlineControls({ milestone, adaptive, hasCurrentAction, saving, onSave }: {
  milestone: Milestone;
  adaptive: boolean;
  hasCurrentAction: boolean;
  saving: boolean;
  onSave: (milestone: Milestone) => Promise<boolean>;
}) {
  const id = useId();
  const { dueDate, dueDateKind } = milestone;
  const [editing, setEditing] = useState(false);
  const [draftDate, setDraftDate] = useState(dueDate);
  const date = projectDateLabel(dueDate, dueDateKind);
  const [draftKind, setDraftKind] = useState(dueDateKind ?? null);
  const unchanged = draftDate === dueDate && draftKind === (dueDateKind ?? null);
  const label = adaptive ? "检查点" : "阶段";
  async function saveDate(event: FormEvent) {
    event.preventDefault();
    if (saving || unchanged) return;
    if (await onSave({ ...milestone, dueDate: draftDate, dueDateKind: draftKind })) setEditing(false);
  }
  return <div className={`project-deadline-controls ${date.tone}`}>
    <div className="project-deadline-summary">
      {dueDate && <time dateTime={dueDate}>{date.text}</time>}
      <Button variant="ghost" size="small" className="project-deadline-adjust" disabled={saving} aria-expanded={editing} aria-controls={id}
        onClick={() => { setDraftDate(dueDate); setDraftKind(dueDateKind ?? null); setEditing((current) => !current); }}>调整日期</Button>
      {date.tone && <small>{hasCurrentAction ? "可继续推进当前行动，或按实际情况调整日期。" : "可在下方安排当前行动，或调整日期。"}</small>}
    </div>
    {editing && <form id={id} className="project-deadline-editor" onSubmit={(event) => void saveDate(event)}>
      <ProjectDateField label={label + "日期"} value={draftDate} kind={draftKind} onChange={(value, kind) => { setDraftDate(value); setDraftKind(kind); }} />
      <div><Button variant="secondary" size="small" disabled={saving} onClick={() => { setDraftDate(dueDate); setDraftKind(dueDateKind ?? null); setEditing(false); }}>取消</Button><Button variant="primary" size="small" type="submit" disabled={saving || unchanged}>{saving ? "保存中…" : "保存日期"}</Button></div>
    </form>}
  </div>;
}

export function ProjectTargetDate({ dueDate, kind: dueDateKind, onAdjust, saving }: { dueDate: string; kind?: ProjectDateKind | null; onAdjust: () => void; saving: boolean }) {
  const date = projectDateLabel(dueDate, dueDateKind);
  return <div className={`project-deadline-controls ${date.tone}`}>
    <div className="project-deadline-summary">
      {dueDate && <time dateTime={dueDate}>{date.text}</time>}
      <Button variant="ghost" size="small" disabled={saving} onClick={onAdjust}>调整目标日期</Button>
    </div>
  </div>;
}

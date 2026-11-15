import { useEffect, useState } from "react";
import { resolveAvailableDeepSeekModel } from "../app/ai-model-settings";
import type { ProjectRepository, ProjectWeekState, ProjectWeekWrite } from "../app/data/project-repository";
import type { Milestone, Project, ProjectDetail, ProjectTask } from "../app/project-types";
import { affectedWeekActions, dayMinutes, scheduleWeek, validWeekChange, validWeekMinutes, validateWeekDraft, weekDate, type WeekAction, type WeekAiDraft, type WeekDayChange } from "../app/project-week";
import { Button, DateField } from "./DesktopControls";
import { desktopApi } from "./integrationApi";

export type ProjectWeekTarget = { kind: "create" | "change" } | { kind: "continue"; projectId: string };

const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export function ProjectWeekDialog({ repository, target, today, onClose, onManualCreate, onSaved }: {
  repository: ProjectRepository;
  target: ProjectWeekTarget;
  today: string;
  onClose: () => void;
  onManualCreate: () => void;
  onSaved: (projectId?: string) => Promise<void>;
}) {
  const [state, setState] = useState<ProjectWeekState>();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [minutes, setMinutes] = useState<number[]>([]);
  const [request, setRequest] = useState("");
  const [changes, setChanges] = useState<WeekDayChange[]>([{ date: "", minutes: 0 }]);
  const [targetDate, setTargetDate] = useState("");
  const [draft, setDraft] = useState<WeekAiDraft>();
  const [preview, setPreview] = useState<ProjectWeekWrite>();
  const [excess, setExcess] = useState(0);
  const [locks, setLocks] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const lastDay = weekDate(today, 6);

  async function load() {
    setBusy(true);
    setError("");
    setPreview(undefined);
    setDraft(undefined);
    setLocks({});
    setState(undefined);
    try {
      const current = await repository.readProjectWeek();
      const project = target.kind === "continue" ? await repository.get(target.projectId) : null;
      if (target.kind === "continue" && (!project || project.project.status !== "active" || project.project.isDraft)) {
        throw new Error("项目目前无法安排，请确认项目正在推进。");
      }
      setDetail(project);
      setState(current);
      setMinutes(current.settings.minutes);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }

  useEffect(() => { void load(); }, [repository, target]);

  async function generate() {
    if (!state) return;
    setBusy(true);
    setError("");
    setPreview(undefined);
    try {
      if (target.kind === "change") {
        const model = await resolveAvailableDeepSeekModel("projectReplan", desktopApi.deepseek.apiModels);
        const { content } = await desktopApi.deepseek.weekChange({ model, input: { today, request: request.trim() } });
        setChanges(content.days.length ? content.days : [{ date: "", minutes: 0 }]);
        if (content.question || content.days.some((day) => !validWeekChange(day.date, today, day.minutes))) {
          setError(content.question || "请手动确认日期和可用时间。");
        }
      } else {
        const model = await resolveAvailableDeepSeekModel(target.kind === "create" ? "projectCreate" : "nextAction", desktopApi.deepseek.apiModels);
        const { content } = await desktopApi.deepseek.projectWeek({ model, input: {
          mode: target.kind, goal: request.trim(), targetDate,
          week: Array.from({ length: 7 }, (_, index) => {
            const day = weekDate(today, index);
            const capacity = dayMinutes(day, { ...state.settings, minutes }, new Set(state.rest));
            const occupied = state.actions.filter((action) => action.date === day && action.status !== "cancelled")
              .reduce((sum, action) => sum + action.minutes, 0);
            return { date: day, minutes: Math.max(0, capacity - occupied) };
          }),
          project: detail && {
            title: detail.project.title, outcome: detail.project.outcome, targetDate: detail.project.targetDate,
            stages: detail.milestones.filter((stage) => stage.status === "current").map(({ title, definitionOfDone }) => ({ title, definitionOfDone })),
            actions: detail.tasks.slice(0, 50).map(({ id, title, status, currentFocus, definitionOfDone }) => ({ id, title, status, currentFocus: currentFocus.slice(0, 180), definitionOfDone: definitionOfDone.slice(0, 180) })),
            recentProgress: detail.logs.filter((log) => ["task_progress", "task_completed"].includes(log.kind)).slice(0, 10).map((log) => log.body.slice(0, 500)),
            accumulations: detail.accumulations.slice(0, 8).map(({ title, content }) => ({ title, content: content.slice(0, 500) })),
          },
        } });
        setDraft(validateWeekDraft(content, detail?.tasks.map((task) => task.id) ?? []));
      }
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }

  function calculate() {
    if (!state) return;
    setError("");
    const datedChanges = changes.filter((day) => day.date);
    if (minutes.some((value) => !validWeekMinutes(value)) || datedChanges.some((day) => !validWeekChange(day.date, today, day.minutes))) {
      setError("请填写有效日期和 0 到 1440 之间的整数分钟。");
      return;
    }
    if (new Set(datedChanges.map((day) => day.date)).size !== datedChanges.length) {
      setError("同一天只需填写一条时间变更。");
      return;
    }
    if (target.kind === "create" && (!draft || !draft.title.trim() || !draft.outcome.trim() || !draft.actions.length)) {
      setError("请先生成项目草案，并核对目标与行动。");
      return;
    }
    if (target.kind === "change" && request.trim() && datedChanges.length !== changes.length) {
      setError("请先确认变更日期，或清空说明后整理已错过的安排。");
      return;
    }
    const settings = { ...state.settings, minutes, exceptions: { ...state.settings.exceptions } };
    settings.managed = { ...settings.managed };
    for (const [id, locked] of Object.entries(locks)) {
      if (settings.managed[id]) settings.managed[id] = { ...settings.managed[id], locked };
    }
    const rest = new Set(state.rest);
    const now = new Date().toISOString();
    const project = target.kind === "create" && draft ? {
      id: `project-week-${crypto.randomUUID()}`, title: draft.title.trim(), outcome: draft.outcome.trim(), motivation: request.trim(),
      projectType: "main", planningMode: draft.stages.length ? "staged" : "direct", parentProjectId: null,
      supportsMilestoneId: null, status: "active", category: "uncategorized", sortOrder: 0, isDraft: false,
      sourceNote: "", targetDate, targetDateKind: "target", reviewDate: "", completedAt: null, createdAt: now, updatedAt: now,
    } satisfies Project : undefined;
    const milestones: Milestone[] = project && draft ? draft.stages.map((stage, index) => ({
      id: `milestone-${crypto.randomUUID()}`, projectId: project.id, title: stage.title, definitionOfDone: stage.done,
      status: index ? "planned" : "current", dueDate: "", sortOrder: (index + 1) * 10, createdAt: now, updatedAt: now,
    })) : [];
    const owner = project ?? detail?.project;
    const stage = milestones[0] ?? detail?.milestones.find((item) => item.status === "current");
    const ids = new Map(draft?.actions.map((item) => [item.ref, `task-${crypto.randomUUID()}`]));
    const tasks: ProjectTask[] = owner && draft ? draft.actions.map((action, index) => ({
      id: ids.get(action.ref)!, projectId: owner.id, milestoneId: stage?.id ?? null, direction: owner.category,
      title: action.title, actionType: "organize", definitionOfDone: action.done, details: action.instruction,
      currentFocus: action.instruction, benefit: "", dueDate: "", status: "later", waitingFor: "", resumeAction: "",
      context: "anywhere", sortOrder: 100 + index, createdAt: now, updatedAt: now, completedAt: null,
      steps: action.starter.trim() ? [{ id: `step-${crypto.randomUUID()}`, title: action.starter.trim(), completed: false }] : [],
    })) : [];
    const dates = [{ date: owner?.targetDate, kind: owner?.targetDateKind }, { date: stage?.dueDate, kind: stage?.dueDateKind }];
    const due = dates.filter(item => item.kind === "deadline").map(item => item.date).filter(Boolean).sort()[0] ?? "";
    const goal = dates.filter(item => item.kind === "target").map(item => item.date).filter(Boolean).sort()[0] ?? "";
    const generated: WeekAction[] = tasks.map((task, index) => ({
      id: task.id, projectId: task.projectId, title: task.title, date: "", due, target: goal, minutes: draft!.actions[index].minutes,
      status: task.status, fixed: false, newlyGenerated: true, after: draft!.actions[index].after.map((id) => ids.get(id) ?? id),
    }));
    const actions = [...state.actions, ...generated];
    let affected = new Set(generated.map((action) => action.id));
    let over = 0;
    if (target.kind === "change") {
      for (const day of datedChanges) settings.exceptions[day.date] = day.minutes;
      const selectedDays = datedChanges.length ? datedChanges.map((day) => day.date) : [""];
      for (const date of selectedDays) {
        const change = affectedWeekActions(actions, date, today, date ? dayMinutes(date, settings, rest) : 0);
        for (const id of change.affected) affected.add(id);
        over += change.excess;
      }
    } else if (target.kind === "continue") {
      for (const action of state.actions) {
        if (action.projectId === target.projectId && (!action.date || action.date < today)) affected.add(action.id);
      }
    }
    const placements = scheduleWeek(today, actions, affected, settings, rest,
      target.kind === "change" ? datedChanges.map((day) => day.date) : []);
    setExcess(over);
    setPreview({
      revision: state.revision, settings, project, milestones, tasks, placements,
      reason: target.kind === "change" ? request.trim() || (datedChanges.length
        ? datedChanges.map((day) => `${day.date} 可用 ${day.minutes} 分钟`).join("，") : "重新安排错过的行动") : "",
    });
  }

  async function apply() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      await repository.applyProjectWeek(preview);
      await onSaved(preview.project?.id);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }

  const heading = target.kind === "create" ? "新建项目" : target.kind === "continue" ? "未来 7 天计划" : "计划有变";
  const projectActions = target.kind === "continue" ? state?.actions.filter((action) => action.projectId === target.projectId && action.date >= today && action.date <= lastDay && !["done", "cancelled"].includes(action.status)) : [];
  return <div className="task-closeout-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="task-closeout-dialog project-week-dialog" role="dialog" aria-modal="true" aria-label={heading} onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); } }}>
      <header><div><h2>{heading}</h2><p>{today} 至 {lastDay}</p></div><Button iconOnly aria-label="关闭" disabled={busy} onClick={onClose}>×</Button></header>
      {state && <fieldset disabled={busy}>
        <label><span>{target.kind === "create" ? "你想学会什么，或做成什么？" : target.kind === "change" ? "发生了什么变化？" : "这次想补充什么？（可选）"}</span>
          <textarea autoFocus value={request} onChange={(event) => { setRequest(event.target.value); setPreview(undefined); if (target.kind !== "change") setDraft(undefined); }}
            placeholder={target.kind === "change" ? "例如：周三临时有事，那天没时间了。" : "例如：四周学会用 Python 整理 Excel，每次投入半小时。"} />
        </label>
        {target.kind === "create" && <DateField label="目标日期（可选）" value={targetDate} onChange={(value) => { setTargetDate(value); setPreview(undefined); }} />}
        {target.kind !== "change" && <details open={target.kind === "create" && !draft}>
          <summary>每周可用时间（所有项目共用）</summary>
          <div className="project-week-capacity">{weekdays.map((day, index) => <label key={day}><span>{day}</span><input type="number" min="0" max="1440" value={minutes[index]} onChange={(event) => {
            setMinutes(minutes.map((value, slot) => slot === index ? Number(event.target.value) : value)); setPreview(undefined);
          }} /></label>)}</div><small>单位为分钟，填 0 表示当天通常没空。</small>
        </details>}
        <Button variant="secondary" disabled={target.kind !== "continue" && !request.trim()} onClick={() => void generate()}>
          {target.kind === "create" ? "生成项目和行动" : target.kind === "change" ? "让 AI 识别日期和时间" : "让 AI 补充下一步"}
        </Button>
        {target.kind === "continue" && <small>使用 AI 时会发送此项目的目标、行动与近期进展，以及未来 7 天的空闲分钟数。</small>}
        {target.kind === "change" && <div>
          {changes.map((day, index) => <div className="project-week-capacity" key={index}>
            <DateField label="变更日期（可直接填写）" value={day.date} onChange={(value) => { setChanges(changes.map((item, slot) => slot === index ? { ...item, date: value } : item)); setPreview(undefined); }} />
            <label><span>这天可用分钟</span><input type="number" min="0" max="1440" placeholder="请填写" value={day.minutes < 0 ? "" : day.minutes} onChange={(event) => {
              setChanges(changes.map((item, slot) => slot === index ? { ...item, minutes: event.target.value ? Number(event.target.value) : -1 } : item)); setPreview(undefined);
            }} /></label>
            {changes.length > 1 && <Button size="small" variant="ghost" onClick={() => { setChanges(changes.filter((_, slot) => slot !== index)); setPreview(undefined); }}>移除这天</Button>}
          </div>)}
          <Button size="small" variant="ghost" disabled={changes.length >= 7} onClick={() => { setChanges([...changes, { date: "", minutes: 0 }]); setPreview(undefined); }}>＋ 另一天</Button>
        </div>}
        {draft && target.kind === "create" && <section className="project-week-summary">
          <label><span>项目名称</span><input value={draft.title} onChange={(event) => { setDraft({ ...draft, title: event.target.value }); setPreview(undefined); }} /></label>
          <label><span>完成时要看到的结果</span><textarea value={draft.outcome} onChange={(event) => { setDraft({ ...draft, outcome: event.target.value }); setPreview(undefined); }} /></label>
          {draft.stages.length > 0 && <ol>{draft.stages.map((item, index) => <li key={index}><strong>{item.title}</strong><p>{item.done}</p></li>)}</ol>}
        </section>}
        {!!draft?.actions.length && <details><summary>查看 AI 拆出的 {draft.actions.length} 项行动</summary><ul>{draft.actions.map((action) =>
          <li key={action.ref}><strong>{action.title} · {action.minutes} 分钟</strong><p>{action.instruction}</p><small>完成标志：{action.done}{action.starter && ` · 起步：${action.starter}`}</small></li>)}</ul></details>}
        {!!projectActions?.length && <details><summary>已安排的行动</summary><ul>{projectActions.map((action) => <li key={action.id}>
          {action.date} · {action.title} · {action.minutes} 分钟
          {state.settings.managed[action.id]?.date === action.date && <label>
            <input type="checkbox" checked={locks[action.id] ?? state.settings.managed[action.id]?.locked ?? false}
              onChange={(event) => { setLocks({ ...locks, [action.id]: event.target.checked }); setPreview(undefined); }} />
            固定日期
          </label>}
        </li>)}</ul></details>}
        <Button variant="secondary" disabled={target.kind === "create" && !draft} onClick={calculate}>{target.kind === "change" ? "预览调整" : "预览安排"}</Button>
        {preview && <section className="project-week-summary" aria-live="polite">
          <strong>确认前预览</strong>
          {excess > 0 && <p>当天受保护的安排超出可用时间 {excess} 分钟，需要手动处理。</p>}
          {target.kind === "change" && changes.some((day) => day.date) && <p>{changes.filter((day) => day.date).map((day) => `${day.date} 可用 ${day.minutes} 分钟`).join(" · ")}</p>}
          {preview.placements.length === 0 && <p>{target.kind === "change" ? "没有需要移动的行动。" : "没有需要新安排的行动。"}</p>}
          <ul>{[...preview.placements].sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999")).map(({ action, date: next, reason }) =>
            <li key={action.id}><strong>{action.title} · {action.minutes} 分钟</strong><p>{action.date ? `${action.date} → ` : ""}{next || "待安排"}{reason && ` · ${reason}`}{action.due && ` · 截止 ${action.due}`}</p></li>)}</ul>
          {preview.placements.some((item) => !item.date) && <p>本周仍有行动未排下。可以增加可用时间，或进入项目调整目标范围和截止。</p>}
        </section>}
      </fieldset>}
      {error && <p role="alert" className="project-ai-error">{error}</p>}
      {busy && <p role="status">正在处理…</p>}
      <footer>
        {target.kind === "create" && <Button variant="ghost" disabled={busy} onClick={onManualCreate}>手动创建</Button>}
        {error && <Button variant="secondary" disabled={busy} onClick={() => void load()}>刷新数据</Button>}
        <Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button>
        <Button variant="primary" disabled={!preview || busy} onClick={() => void apply()}>{target.kind === "create" ? "确认创建并排入" : "确认安排"}</Button>
      </footer>
    </section>
  </div>;
}

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { ProjectRepository } from "../app/data/project-repository";
import type {
  ActionType,
  Milestone,
  Project,
  ProjectCategory,
  ProjectDetail,
  ProjectProposal,
  ProjectStatus,
  ProjectSummary,
  ProjectTask,
  ProjectTaskStatus,
  ProposalStatus,
} from "../app/project-types";

type ProjectTab = "overview" | "stages" | "proposals" | "history";

type ProjectWorkspaceProps = {
  repository: ProjectRepository;
  projects: ProjectSummary[];
  initialProjectId?: string | null;
  onProjectsChange: () => Promise<ProjectSummary[]>;
};

type WorkspaceDraft = {
  project: Project;
  milestones: Milestone[];
  task: ProjectTask;
};

const categoryLabels: Record<ProjectCategory, string> = {
  research: "科研学习",
  creative: "持续创作",
  product: "个人产品",
  maintenance: "长期维护",
  support: "支持工具",
  personal: "个人项目",
};

const categorySymbols: Record<ProjectCategory, string> = {
  research: "研",
  creative: "创",
  product: "造",
  maintenance: "维",
  support: "辅",
  personal: "行",
};

const statusLabels: Record<ProjectStatus, string> = {
  active: "正在推进",
  waiting: "等待中",
  paused: "已暂停",
  completed: "已完成",
};

const taskStatusLabels: Record<ProjectTaskStatus, string> = {
  next: "下一步",
  waiting: "等待中",
  later: "稍后",
  done: "已完成",
};

const actionTypeLabels: Record<ActionType, string> = {
  read: "阅读理解",
  write: "写作输出",
  experiment: "实验验证",
  decide: "决策判断",
  organize: "整理归纳",
  communicate: "沟通等待",
  life: "生活事务",
};

const actionTypeSymbols: Record<ActionType, string> = {
  read: "阅",
  write: "写",
  experiment: "验",
  decide: "判",
  organize: "理",
  communicate: "联",
  life: "生",
};

const proposalStatusLabels: Record<ProposalStatus, string> = {
  pending: "待评审",
  experiment: "先小范围尝试",
  accepted: "决定采纳",
  deferred: "暂缓",
  rejected: "不采纳",
};

export function ProjectWorkspace({
  repository,
  projects,
  initialProjectId,
  onProjectsChange,
}: ProjectWorkspaceProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const lastInitialProjectId = useRef<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ProjectStatus>("all");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<WorkspaceDraft | null>(null);
  const [logText, setLogText] = useState("");
  const [tab, setTab] = useState<ProjectTab>("overview");
  const [message, setMessage] = useState("");

  const visibleProjects = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    return projects.filter((project) => {
      if (statusFilter !== "all" && project.status !== statusFilter) return false;
      if (!needle) return true;
      return [
      project.title,
      project.outcome,
      project.motivation,
      project.currentMilestone?.title ?? "",
      project.nextTask?.title ?? "",
      ].join(" ").toLocaleLowerCase("zh-CN").includes(needle);
    });
  }, [projects, query, statusFilter]);

  useEffect(() => {
    if (!projects.length) {
      setSelectedId(null);
      setDetail(null);
      return;
    }
    const requested = initialProjectId
      && initialProjectId !== lastInitialProjectId.current
      && projects.some((project) => project.id === initialProjectId)
      ? initialProjectId
      : null;
    if (requested) {
      lastInitialProjectId.current = requested;
      if (requested !== selectedId) { setSelectedId(requested); setTab("overview"); }
    } else if (selectedId && !projects.some((project) => project.id === selectedId)) {
      setSelectedId(null);
      setDetail(null);
    }
  }, [initialProjectId, projects, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    setLoading(true);
    repository.get(selectedId)
      .then((next) => {
        if (active) setDetail(next);
      })
      .catch((error) => {
        if (active) showMessage(error instanceof Error ? error.message : "无法读取项目");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [repository, selectedId]);

  function showMessage(text: string) {
    setMessage(text);
    window.setTimeout(() => setMessage((current) => current === text ? "" : current), 3200);
  }

  async function reload(projectId = selectedId) {
    const nextProjects = await onProjectsChange();
    const resolvedId = projectId && nextProjects.some((project) => project.id === projectId)
      ? projectId
      : nextProjects[0]?.id ?? null;
    setSelectedId(resolvedId);
    if (resolvedId) setDetail(await repository.get(resolvedId));
    return nextProjects;
  }

  function startNewProject() {
    const now = new Date().toISOString();
    setDraft({
      project: {
        id: "",
        title: "",
        outcome: "",
        motivation: "",
        status: "active",
        category: "personal",
        sortOrder: (projects.length + 1) * 10,
        isDraft: false,
        sourceNote: "本人创建",
        reviewDate: "",
        createdAt: now,
        updatedAt: now,
      },
      milestones: [emptyMilestone("", now)],
      task: emptyTask("", "", now),
    });
    setEditing(true);
  }

  function startEditing() {
    if (!detail) return;
    const now = new Date().toISOString();
    const milestone = detail.milestones.find((item) => item.status === "current") ?? detail.milestones[0] ?? emptyMilestone(detail.project.id, now);
    const task = detail.tasks.find((item) => item.status === "next")
      ?? detail.tasks.find((item) => item.status === "waiting")
      ?? emptyTask(detail.project.id, milestone.id, now);
    setDraft({
      project: { ...detail.project },
      milestones: detail.milestones.length ? detail.milestones.map((item) => ({ ...item })) : [{ ...milestone }],
      task: { ...task },
    });
    setEditing(true);
  }

  async function saveDraft() {
    if (!draft || !draft.project.title.trim() || !draft.project.outcome.trim()) {
      showMessage("请先填写项目名称和期望结果。");
      return;
    }
    setSaving(true);
    try {
      const project = await repository.saveWorkspace(
        draft.project,
        draft.milestones,
        draft.task.title.trim() ? draft.task : null,
      );
      setEditing(false);
      await reload(project.id);
      showMessage("项目内容已经保存。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "项目保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function confirmProject() {
    if (!detail) return;
    setSaving(true);
    try {
      await repository.confirmProject(detail.project.id);
      await reload(detail.project.id);
      showMessage("项目已经确认，之后仍可随时修改。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "确认项目失败");
    } finally {
      setSaving(false);
    }
  }

  async function changeTaskStatus(task: ProjectTask, status: ProjectTaskStatus) {
    setSaving(true);
    try {
      if (status === "done") await repository.completeTask(task.id, `完成行动：${task.title}`);
      else await repository.updateTaskStatus(task.id, status);
      await reload(task.projectId);
      showMessage(status === "done" ? "已经记下这次完成。" : "下一步已经更新。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "行动更新失败");
    } finally {
      setSaving(false);
    }
  }

  async function addProgress(event: FormEvent) {
    event.preventDefault();
    if (!detail || !logText.trim()) return;
    setSaving(true);
    try {
      await repository.addLog(detail.project.id, logText);
      setLogText("");
      await reload(detail.project.id);
      showMessage("推进记录已经留下。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "推进记录保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function saveMilestone(milestone: Milestone) {
    if (!detail) return;
    setSaving(true);
    try {
      const created = !milestone.id;
      const saved = await repository.saveMilestone({ ...milestone, projectId: detail.project.id });
      await repository.addLog(detail.project.id, `${created ? "新增" : "调整"}阶段：${saved.title}`);
      await reload(detail.project.id);
      showMessage(created ? "阶段已经加入路线。" : "阶段已经更新。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "阶段保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function removeMilestone(milestone: Milestone) {
    if (!detail || !window.confirm(`确认删除阶段「${milestone.title}」吗？关联行动会保留，但不再归属该阶段。`)) return;
    setSaving(true);
    try {
      await repository.removeMilestone(milestone.id);
      await repository.addLog(detail.project.id, `移除阶段：${milestone.title}`);
      await reload(detail.project.id);
      showMessage("阶段已经移除，原有关联行动仍被保留。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "阶段删除失败");
    } finally {
      setSaving(false);
    }
  }

  async function saveProposal(proposal: ProjectProposal) {
    if (!detail) return;
    setSaving(true);
    try {
      await repository.saveProposal({ ...proposal, projectId: detail.project.id });
      await reload(detail.project.id);
      showMessage("想法已经进入项目提案池。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "想法保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function reviewProposal(proposal: ProjectProposal, status: ProposalStatus, reviewNote: string) {
    setSaving(true);
    try {
      await repository.updateProposalStatus(proposal.id, status, reviewNote);
      await repository.addLog(proposal.projectId, `评审想法「${proposal.title}」：${proposalStatusLabels[status]}`);
      await reload(proposal.projectId);
      showMessage("评审结论已经记录。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "评审保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
      <section className="project-workspace">
        {editing && draft ? (
          <ProjectEditor
            draft={draft}
            saving={saving}
            onChange={setDraft}
            onCancel={() => setEditing(false)}
            onSave={() => void saveDraft()}
          />
        ) : loading ? (
          <div className="project-loading">正在恢复项目上下文…</div>
        ) : detail ? (
          <ProjectPage
            detail={detail}
            saving={saving}
            tab={tab}
            onTabChange={setTab}
            logText={logText}
            onLogTextChange={setLogText}
            onAddProgress={addProgress}
            onConfirm={() => void confirmProject()}
            onEdit={startEditing}
            onBack={() => {
              lastInitialProjectId.current = null;
              setSelectedId(null);
              setDetail(null);
            }}
            onTaskStatus={(task, status) => void changeTaskStatus(task, status)}
            onSaveMilestone={(milestone) => void saveMilestone(milestone)}
            onRemoveMilestone={(milestone) => void removeMilestone(milestone)}
            onSaveProposal={(proposal) => void saveProposal(proposal)}
            onReviewProposal={(proposal, status, note) => void reviewProposal(proposal, status, note)}
          />
        ) : (
          <div className="project-gallery workspace-scroll">
            <header className="workspace-page-heading project-gallery-heading">
              <div><h1>项目大厅</h1><p>{projects.filter((project) => project.status === "active").length} 个正在推进 · {projects.length} 个项目</p></div>
              <button onClick={startNewProject}>＋ 新建项目</button>
            </header>
            <div className="project-gallery-controls">
              <nav aria-label="项目状态">
                {([ ["all", "全部"], ["active", "进行中"], ["waiting", "等待"], ["paused", "暂停"], ["completed", "已完成"] ] as const).map(([value, label]) => <button className={statusFilter === value ? "active" : ""} key={value} onClick={() => setStatusFilter(value)}>{label}</button>)}
              </nav>
              <label><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目" />{query && <button onClick={() => setQuery("")}>×</button>}</label>
            </div>
            <div className="project-gallery-grid" aria-live="polite">
              {visibleProjects.map((project) => {
                const total = project.milestoneCount;
                const progress = total ? Math.round(project.completedMilestoneCount / total * 100) : 0;
                return <button className={`project-gallery-card category-${project.category}`} key={project.id} onClick={() => { setSelectedId(project.id); setEditing(false); }}>
                  <header><i>{categorySymbols[project.category]}</i><span className={`project-status ${project.status}`}>{statusLabels[project.status]}</span></header>
                  <div><small>{categoryLabels[project.category]}{project.isDraft ? " · 待确认" : ""}</small><h2>{project.title}</h2><p>{project.outcome}</p></div>
                  <section><span>当前阶段</span><strong>{project.currentMilestone?.title || "尚未设置当前阶段"}</strong>{project.currentMilestone?.dueDate && <small>{formatDueDate(project.currentMilestone.dueDate)}</small>}</section>
                  <footer><i><b style={{ width: `${progress}%` }} /></i><span>{project.completedMilestoneCount}/{total || 0} 个阶段完成</span><em>进入项目 →</em></footer>
                </button>;
              })}
              {!visibleProjects.length && <div className="project-gallery-empty"><strong>{query ? "没有找到相关项目" : "这个分组还没有项目"}</strong><button onClick={startNewProject}>创建项目</button></div>}
            </div>
          </div>
        )}
        {message && <div className="desktop-toast" role="status">{message}</div>}
      </section>
  );
}

function ProjectPage({
  detail,
  saving,
  tab,
  onTabChange,
  logText,
  onLogTextChange,
  onAddProgress,
  onConfirm,
  onEdit,
  onBack,
  onTaskStatus,
  onSaveMilestone,
  onRemoveMilestone,
  onSaveProposal,
  onReviewProposal,
}: {
  detail: ProjectDetail;
  saving: boolean;
  tab: ProjectTab;
  onTabChange: (tab: ProjectTab) => void;
  logText: string;
  onLogTextChange: (value: string) => void;
  onAddProgress: (event: FormEvent) => void;
  onConfirm: () => void;
  onEdit: () => void;
  onBack: () => void;
  onTaskStatus: (task: ProjectTask, status: ProjectTaskStatus) => void;
  onSaveMilestone: (milestone: Milestone) => void;
  onRemoveMilestone: (milestone: Milestone) => void;
  onSaveProposal: (proposal: ProjectProposal) => void;
  onReviewProposal: (proposal: ProjectProposal, status: ProposalStatus, reviewNote: string) => void;
}) {
  const { project, milestones, tasks, logs, proposals } = detail;
  const currentMilestone = milestones.find((item) => item.status === "current") ?? null;
  const openTasks = tasks.filter((item) => item.status !== "done" && (!currentMilestone || item.milestoneId === currentMilestone.id)).sort((left, right) => left.sortOrder - right.sortOrder);
  const doneTasks = tasks.filter((item) => item.status === "done").slice(0, 5);
  const completedStages = milestones.filter((item) => item.status === "completed").length;
  const nextTask = openTasks.find((item) => item.status === "next") ?? openTasks[0] ?? null;

  return (
    <article className="project-page">
      <header className="project-toolbar">
        <div>
          <button className="project-back" onClick={onBack}>← 项目大厅</button>
          <span className={`project-status ${project.status}`}>{statusLabels[project.status]}</span>
          <span>{categoryLabels[project.category]}</span>
          <span className="project-local-badge">仅本机</span>
        </div>
        <div>
          {project.isDraft && <button disabled={saving} onClick={onConfirm}>确认项目</button>}
          <button className="primary" onClick={onEdit}>编辑项目</button>
        </div>
      </header>

      <div className="project-page-scroll">
        <header className="project-hero">
          {project.isDraft && <span>待确认草稿 · 根据 Codex 对话整理</span>}
          <h1>{project.title}</h1>
          <p>{project.outcome}</p>
        </header>

        <nav className="project-tabs" aria-label="项目视图">
          {([ ["overview", "项目概览"], ["stages", "阶段路线"], ["proposals", `想法与提案 ${proposals.filter((item) => item.status === "pending").length || ""}`], ["history", "决策与记录"] ] as const).map(([value, label]) => <button className={tab === value ? "active" : ""} key={value} onClick={() => onTabChange(value)}>{label}</button>)}
        </nav>

        {tab === "overview" && <>
          <section className="project-overview-focus">
            <div><span>当前阶段</span><strong>{currentMilestone?.title || "尚未选择当前阶段"}</strong><p>{currentMilestone?.definitionOfDone || "在阶段路线中补充这一阶段的完成标准。"}</p></div>
            <div><span>下一项行动</span><strong>{nextTask?.title || "尚未留下下一项行动"}</strong><p>{nextTask?.benefit || "从当前阶段选择一个最小、明确的下一步。"}</p></div>
            <div><span>下次评审</span><strong>{project.reviewDate ? formatDueDate(project.reviewDate) : "尚未设置"}</strong><p>{proposals.filter((item) => item.status === "pending").length} 条想法等待判断</p></div>
          </section>

          <div className="project-content-grid">
            <div className="project-content-main">
              <ProjectActions tasks={openTasks} doneTasks={doneTasks} milestones={milestones} saving={saving} onTaskStatus={onTaskStatus} />
              <section className="project-section project-history-preview">
                <header><div><span>最近发生</span></div><button onClick={() => onTabChange("history")}>查看全部 →</button></header>
                <ProjectTimeline logs={logs.slice(0, 4)} />
              </section>
            </div>
            <ProjectContext detail={detail} />
          </div>
        </>}

        {tab === "stages" && <StageRouteEditor projectId={project.id} milestones={milestones} tasks={tasks} saving={saving} onSave={onSaveMilestone} onRemove={onRemoveMilestone} />}

        {tab === "proposals" && <ProposalBoard projectId={project.id} proposals={proposals} saving={saving} onSave={onSaveProposal} onReview={onReviewProposal} />}

        {tab === "history" && <section className="project-section project-progress project-history-full">
          <header><div><span>项目轨迹</span><small>完成行动、调整阶段和评审想法会自动留下记录</small></div></header>
          <details className="manual-log-entry"><summary>补充一条结果或判断</summary><form onSubmit={onAddProgress}><textarea value={logText} onChange={(event) => onLogTextChange(event.target.value)} placeholder="写下确实发生的结果、变化或新判断" /><button disabled={saving || !logText.trim()} type="submit">保存记录</button></form></details>
          <ProjectTimeline logs={logs} />
        </section>}
      </div>
    </article>
  );
}

function ProjectActions({ tasks, doneTasks, milestones, saving, onTaskStatus }: { tasks: ProjectTask[]; doneTasks: ProjectTask[]; milestones: Milestone[]; saving: boolean; onTaskStatus: (task: ProjectTask, status: ProjectTaskStatus) => void }) {
  return <section className="project-section project-actions">
    <header><div><span>当前阶段的行动</span><small>具体做法默认折叠</small></div></header>
    {tasks.length ? tasks.map((task) => <article className={`project-task project-action-card ${task.status}`} key={task.id}>
      <i className="project-action-symbol">{actionTypeSymbols[task.actionType]}</i>
      <div className="project-action-main">
        <header><small>{actionTypeLabels[task.actionType]} · {taskStatusLabels[task.status]}</small>{task.dueDate && <time>{formatDueDate(task.dueDate)}</time>}</header>
        <strong>{task.title}</strong><span>{milestones.find((item) => item.id === task.milestoneId)?.title || "未关联阶段"}</span>
        <details className="action-disclosure"><summary>查看具体做法与收益</summary><div><p><b>具体做法</b>{task.details || "还没有补充具体做法。"}</p><p><b>推进价值</b>{task.benefit || "还没有记录它对项目的帮助。"}</p></div></details>
      </div>
      <div className="project-action-buttons">{task.status !== "next" && <button disabled={saving} onClick={() => onTaskStatus(task, "next")}>设为当前</button>}<button disabled={saving} onClick={() => onTaskStatus(task, "done")}>✓ 完成</button></div>
    </article>) : <p className="project-empty-copy">当前阶段还没有未完成行动。</p>}
    {doneTasks.length > 0 && <details className="project-done-list"><summary>最近完成 {doneTasks.length} 项</summary>{doneTasks.map((task) => <p key={task.id}>✓ {actionTypeLabels[task.actionType]} · {task.title}</p>)}</details>}
  </section>;
}

function ProjectContext({ detail }: { detail: ProjectDetail }) {
  const { project, milestones } = detail;
  return <aside className="project-context-panel"><section><span>为什么做</span><p>{project.motivation || "还没有记录这个项目为什么值得投入。"}</p></section><section><span>阶段概览</span><p>{milestones.filter((item) => item.status === "completed").length} 个已完成 · {milestones.filter((item) => item.status !== "completed").length} 个仍在路线中</p></section><section><span>最近更新</span><p>{formatProjectDate(project.updatedAt)}</p></section></aside>;
}

function ProjectTimeline({ logs }: { logs: ProjectDetail["logs"] }) {
  return <div className="project-timeline">{logs.length ? logs.map((log) => <div key={log.id}><time>{formatProjectDate(log.createdAt)}</time><p>{log.body}</p></div>) : <p className="project-empty-copy">项目发生变化后，轨迹会自动出现在这里。</p>}</div>;
}

function StageRouteEditor({ projectId, milestones, tasks, saving, onSave, onRemove }: { projectId: string; milestones: Milestone[]; tasks: ProjectTask[]; saving: boolean; onSave: (milestone: Milestone) => void; onRemove: (milestone: Milestone) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Milestone | null>(null);
  function edit(item?: Milestone) { const now = new Date().toISOString(); const next = item ? { ...item } : { ...emptyMilestone(projectId, now), status: milestones.length ? "planned" as const : "current" as const, sortOrder: (milestones.length + 1) * 10 }; setDraft(next); setEditingId(item?.id || "new"); }
  function submit(event: FormEvent) { event.preventDefault(); if (!draft?.title.trim()) return; onSave(draft); setDraft(null); setEditingId(null); }
  return <section className="project-stage-overview stage-route-page"><header><div><h2>阶段路线</h2><p>阶段可以在推进中随时增补和调整。</p></div><button onClick={() => edit()}>＋ 添加阶段</button></header><div className="project-stage-path">{milestones.map((milestone, index) => { const stageTasks = tasks.filter((task) => task.milestoneId === milestone.id); return <article className={`project-stage-node ${milestone.status}`} key={milestone.id}><button className="stage-node-button" onClick={() => edit(milestone)}><i>{milestone.status === "completed" ? "✓" : index + 1}</i><span><small>{milestone.status === "current" ? "当前阶段" : milestone.status === "completed" ? "已完成" : "待开始"}</small><strong>{milestone.title}</strong><em>{stageTasks.filter((task) => task.status === "done").length}/{stageTasks.length} 行动</em></span></button>{editingId === milestone.id && draft && <StageInlineForm draft={draft} saving={saving} onChange={setDraft} onCancel={() => { setDraft(null); setEditingId(null); }} onRemove={() => onRemove(milestone)} onSubmit={submit} />}</article>; })}{editingId === "new" && draft && <article className="project-stage-node current new"><StageInlineForm draft={draft} saving={saving} onChange={setDraft} onCancel={() => { setDraft(null); setEditingId(null); }} onSubmit={submit} /></article>}</div></section>;
}

function StageInlineForm({ draft, saving, onChange, onCancel, onRemove, onSubmit }: { draft: Milestone; saving: boolean; onChange: (draft: Milestone) => void; onCancel: () => void; onRemove?: () => void; onSubmit: (event: FormEvent) => void }) {
  return <form className="stage-inline-form" onSubmit={onSubmit}><input autoFocus value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} placeholder="阶段名称" /><textarea value={draft.definitionOfDone} onChange={(event) => onChange({ ...draft, definitionOfDone: event.target.value })} placeholder="怎样才算完成？" /><div><select value={draft.status} onChange={(event) => onChange({ ...draft, status: event.target.value as Milestone["status"] })}><option value="current">当前阶段</option><option value="planned">待开始</option><option value="completed">已完成</option></select><input type="date" value={draft.dueDate} onChange={(event) => onChange({ ...draft, dueDate: event.target.value })} /></div><footer>{onRemove && <button className="danger" type="button" onClick={onRemove}>删除阶段</button>}<span /><button type="button" onClick={onCancel}>取消</button><button className="primary" disabled={saving || !draft.title.trim()}>保存阶段</button></footer></form>;
}

function ProposalBoard({ projectId, proposals, saving, onSave, onReview }: { projectId: string; proposals: ProjectProposal[]; saving: boolean; onSave: (proposal: ProjectProposal) => void; onReview: (proposal: ProjectProposal, status: ProposalStatus, reviewNote: string) => void }) {
  const [showComposer, setShowComposer] = useState(false);
  const [draft, setDraft] = useState(() => emptyProposal(projectId));
  function submit(event: FormEvent) { event.preventDefault(); if (!draft.title.trim()) return; onSave(draft); setDraft(emptyProposal(projectId)); setShowComposer(false); }
  return <section className="proposal-board"><header><div><h2>想法与提案</h2><p>先收集，再判断价值和成本；不会自动变成任务。</p></div><button onClick={() => setShowComposer((value) => !value)}>{showComposer ? "收起" : "＋ 提交一个想法"}</button></header>{showComposer && <form className="proposal-composer" onSubmit={submit}><input autoFocus value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="想法是什么？" /><textarea value={draft.problem} onChange={(event) => setDraft({ ...draft, problem: event.target.value })} placeholder="它想解决什么问题？" /><div><input value={draft.expectedValue} onChange={(event) => setDraft({ ...draft, expectedValue: event.target.value })} placeholder="预期价值" /><input value={draft.cost} onChange={(event) => setDraft({ ...draft, cost: event.target.value })} placeholder="可能成本" /></div><button className="primary" disabled={saving || !draft.title.trim()}>放入提案池</button></form>}<div className="proposal-list">{proposals.length ? proposals.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} saving={saving} onReview={onReview} />) : <p className="project-empty-copy">还没有项目想法。想到新功能或方向时，可以先放在这里等待评审。</p>}</div></section>;
}

function ProposalCard({ proposal, saving, onReview }: { proposal: ProjectProposal; saving: boolean; onReview: (proposal: ProjectProposal, status: ProposalStatus, reviewNote: string) => void }) {
  const [open, setOpen] = useState(false); const [status, setStatus] = useState<ProposalStatus>(proposal.status); const [note, setNote] = useState(proposal.reviewNote);
  return <article className={`proposal-card ${proposal.status}`}><button onClick={() => setOpen((value) => !value)}><span><small>{proposalStatusLabels[proposal.status]}</small><strong>{proposal.title}</strong></span><em>{open ? "收起" : "评审"}</em></button>{open && <div><p><b>要解决的问题</b>{proposal.problem || "尚未补充"}</p><p><b>预期价值</b>{proposal.expectedValue || "尚未补充"}</p><p><b>可能成本</b>{proposal.cost || "尚未补充"}</p><label><span>评审结论</span><select value={status} onChange={(event) => setStatus(event.target.value as ProposalStatus)}>{Object.entries(proposalStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="为什么做出这个判断？" /><button className="primary" disabled={saving} onClick={() => onReview(proposal, status, note)}>保存评审</button></div>}</article>;
}

function ProjectEditor({
  draft,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  draft: WorkspaceDraft;
  saving: boolean;
  onChange: (draft: WorkspaceDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const updateProject = <Key extends keyof Project>(key: Key, value: Project[Key]) => {
    onChange({ ...draft, project: { ...draft.project, [key]: value } });
  };
  const updateMilestone = <Key extends keyof Milestone>(index: number, key: Key, value: Milestone[Key]) => {
    const next = draft.milestones.map((milestone, milestoneIndex) => {
      if (milestoneIndex === index) return { ...milestone, [key]: value };
      if (key === "status" && value === "current" && milestone.status === "current") return { ...milestone, status: "planned" as const };
      return milestone;
    });
    onChange({ ...draft, milestones: next });
  };
  const updateTask = <Key extends keyof ProjectTask>(key: Key, value: ProjectTask[Key]) => {
    onChange({ ...draft, task: { ...draft.task, [key]: value } });
  };

  return (
    <div className="project-editor">
      <header className="editor-toolbar">
        <div><button onClick={onCancel}>← 返回项目</button><span>{draft.project.id ? "编辑项目" : "新建项目"}</span></div>
        <button className="primary" disabled={saving} onClick={onSave}>{saving ? "保存中…" : "保存项目"}</button>
      </header>
      <div className="project-editor-scroll">
        <div className="project-editor-paper">
          <span>项目基本信息</span>
          <input
            className="project-editor-title"
            autoFocus
            value={draft.project.title}
            onChange={(event) => updateProject("title", event.target.value)}
            placeholder="项目名称"
          />
          <label>
            <span>期望结果</span>
            <textarea value={draft.project.outcome} onChange={(event) => updateProject("outcome", event.target.value)} placeholder="这个项目最终希望得到什么结果？" />
          </label>
          <label>
            <span>为什么值得做</span>
            <textarea value={draft.project.motivation} onChange={(event) => updateProject("motivation", event.target.value)} placeholder="为什么现在值得投入？" />
          </label>
          <div className="project-editor-grid">
            <label>
              <span>项目类型</span>
              <select value={draft.project.category} onChange={(event) => updateProject("category", event.target.value as ProjectCategory)}>
                {Object.entries(categoryLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </label>
            <label>
              <span>当前状态</span>
              <select value={draft.project.status} onChange={(event) => updateProject("status", event.target.value as ProjectStatus)}>
                {Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </label>
            <label>
              <span>下次复盘</span>
              <input type="date" value={draft.project.reviewDate} onChange={(event) => updateProject("reviewDate", event.target.value)} />
            </label>
          </div>

          <section className="project-editor-block">
            <header><strong>阶段路线</strong><button type="button" onClick={() => onChange({ ...draft, milestones: [...draft.milestones, { ...emptyMilestone(draft.project.id, new Date().toISOString()), status: "planned", sortOrder: (draft.milestones.length + 1) * 10 }] })}>＋ 添加阶段</button></header>
            <div className="project-stage-editor-list">
              {draft.milestones.map((milestone, index) => <article key={milestone.id || `new-stage-${index}`}>
                <header><span>阶段 {index + 1}</span><select value={milestone.status} onChange={(event) => updateMilestone(index, "status", event.target.value as Milestone["status"])}><option value="completed">已完成</option><option value="current">当前阶段</option><option value="planned">待开始</option></select></header>
                <label><span>阶段名称</span><input value={milestone.title} onChange={(event) => updateMilestone(index, "title", event.target.value)} placeholder="这一阶段要解决什么问题？" /></label>
                <div className="project-editor-grid"><label><span>截止时间</span><input type="date" value={milestone.dueDate} onChange={(event) => updateMilestone(index, "dueDate", event.target.value)} /></label><label><span>排序</span><input type="number" value={milestone.sortOrder} onChange={(event) => updateMilestone(index, "sortOrder", Number(event.target.value))} /></label></div>
                <label><span>完成标准</span><textarea value={milestone.definitionOfDone} onChange={(event) => updateMilestone(index, "definitionOfDone", event.target.value)} /></label>
              </article>)}
            </div>
          </section>

          <section className="project-editor-block">
            <header><strong>当前阶段的行动</strong><span>折叠状态保持轻量，需要时再看细节</span></header>
            <div className="project-editor-grid">
              <label>
                <span>行动类型</span>
                <select value={draft.task.actionType} onChange={(event) => updateTask("actionType", event.target.value as ActionType)}>{Object.entries(actionTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
              </label>
              <label>
                <span>行动状态</span>
                <select value={draft.task.status} onChange={(event) => updateTask("status", event.target.value as ProjectTaskStatus)}>
                  <option value="next">下一步</option>
                  <option value="later">稍后</option>
                  <option value="waiting">等待中</option>
                  <option value="done">已完成</option>
                </select>
              </label>
            </div>
            <label><span>折叠时显示的名称</span><input value={draft.task.title} onChange={(event) => updateTask("title", event.target.value)} placeholder="例如：阅读与判断" /></label>
            <label><span>具体做法</span><textarea value={draft.task.details} onChange={(event) => updateTask("details", event.target.value)} /></label>
            <label><span>完成它有什么帮助</span><textarea value={draft.task.benefit} onChange={(event) => updateTask("benefit", event.target.value)} /></label>
            <div className="project-editor-grid">
              <label><span>截止时间</span><input type="date" value={draft.task.dueDate} onChange={(event) => updateTask("dueDate", event.target.value)} /></label>
              <label><span>适合场景</span><select value={draft.task.context} onChange={(event) => updateTask("context", event.target.value as ProjectTask["context"])}><option value="anywhere">任何地方</option><option value="computer">需要电脑</option><option value="phone">手机可做</option></select></label>
            </div>
            {(draft.project.status === "waiting" || draft.task.status === "waiting") && (
              <div className="project-waiting-editor">
                <label><span>正在等待什么</span><input value={draft.task.waitingFor} onChange={(event) => updateTask("waitingFor", event.target.value)} /></label>
                <label><span>结果回来后先做什么</span><input value={draft.task.resumeAction} onChange={(event) => updateTask("resumeAction", event.target.value)} /></label>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function emptyMilestone(projectId: string, now: string): Milestone {
  return {
    id: "",
    projectId,
    title: "",
    definitionOfDone: "",
    status: "current",
    dueDate: "",
    sortOrder: 10,
    createdAt: now,
    updatedAt: now,
  };
}

function emptyTask(projectId: string, milestoneId: string, now: string): ProjectTask {
  return {
    id: "",
    projectId,
    milestoneId: milestoneId || null,
    title: "",
    actionType: "organize",
    details: "",
    benefit: "",
    dueDate: "",
    status: "next",
    waitingFor: "",
    resumeAction: "",
    context: "anywhere",
    sortOrder: 10,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

function emptyProposal(projectId: string): ProjectProposal {
  const now = new Date().toISOString();
  return { id: "", projectId, title: "", problem: "", expectedValue: "", cost: "", status: "pending", reviewNote: "", createdAt: now, updatedAt: now };
}

function contextLabel(context: ProjectTask["context"]) {
  if (context === "computer") return "需要电脑";
  if (context === "phone") return "手机可做";
  return "任何地方都可推进";
}

function formatProjectDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDueDate(value: string) {
  if (!value) return "";
  return new Date(`${value}T12:00:00`).toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
  });
}

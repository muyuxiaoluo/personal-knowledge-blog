import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { ProjectRepository } from "../app/data/project-repository";
import { LIFE_DOMAIN_LABELS, LIFE_DOMAIN_OPTIONS, normalizeLifeDomain } from "../app/domain-taxonomy";
import type {
  Milestone,
  Project,
  ProjectCategory,
  ProjectDetail,
  ProjectProposal,
  ProjectStatus,
  ProjectSummary,
  ProjectTask,
  ProjectTaskStatus,
  ProjectType,
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
  branches: Project[];
};

const categoryLabels = LIFE_DOMAIN_LABELS;
const categoryOptions = LIFE_DOMAIN_OPTIONS;

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

const proposalStatusLabels: Record<ProposalStatus, string> = {
  pending: "待评审",
  experiment: "先小范围尝试",
  accepted: "决定采纳",
  deferred: "暂缓",
  rejected: "不采纳",
};

const projectTypeLabels: Record<ProjectType, string> = {
  main: "主线项目",
  side: "支线项目",
  experiment: "实验支线",
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
  const [statusFilter, setStatusFilter] = useState<ProjectStatus>("active");
  const [domainFilter, setDomainFilter] = useState<"all" | ProjectCategory>("all");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<WorkspaceDraft | null>(null);
  const [logText, setLogText] = useState("");
  const [tab, setTab] = useState<ProjectTab>("overview");
  const [message, setMessage] = useState("");

  const visibleProjects = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    return projects.filter((project) => !project.parentProjectId).filter((project) => {
      if (project.status !== statusFilter) return false;
      if (domainFilter !== "all" && normalizeLifeDomain(project.category) !== domainFilter) return false;
      if (!needle) return true;
      const branches = projects.filter((candidate) => candidate.parentProjectId === project.id);
      return [
        project.title,
        project.outcome,
        project.motivation,
        project.currentMilestone?.title ?? "",
        project.nextTask?.title ?? "",
        ...branches.flatMap((branch) => [branch.title, branch.outcome, branch.motivation]),
      ].join(" ").toLocaleLowerCase("zh-CN").includes(needle);
    });
  }, [domainFilter, projects, query, statusFilter]);

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
        projectType: "main",
        parentProjectId: null,
        supportsMilestoneId: null,
        status: "active",
        category: "uncategorized",
        sortOrder: (projects.length + 1) * 10,
        isDraft: false,
        sourceNote: "本人创建",
        reviewDate: "",
        createdAt: now,
        updatedAt: now,
      },
      milestones: [emptyMilestone("", now)],
      task: emptyTask("", "", now),
      branches: [],
    });
    setEditing(true);
  }

  function startEditing() {
    if (!detail) return;
    const now = new Date().toISOString();
    const milestone = detail.milestones.find((item) => item.status === "current") ?? detail.milestones[0] ?? emptyMilestone(detail.project.id, now);
    const currentTasks = detail.tasks.filter((item) => item.status !== "done" && (!milestone.id || item.milestoneId === milestone.id));
    const task = currentTasks.find((item) => item.status === "next")
      ?? currentTasks.find((item) => item.status === "waiting")
      ?? currentTasks[0]
      ?? emptyTask(detail.project.id, milestone.id, now);
    setDraft({
      project: { ...detail.project, category: normalizeProjectCategory(detail.project.category) },
      milestones: detail.milestones.length ? detail.milestones.map((item) => ({ ...item })) : [{ ...milestone }],
      task: { ...task, status: task.status === "later" ? "next" : task.status },
      branches: detail.project.parentProjectId
        ? []
        : projects.filter((project) => project.parentProjectId === detail.project.id).map((project) => ({ ...project })),
    });
    setEditing(true);
  }

  async function saveDraft() {
    if (!draft || !draft.project.title.trim() || !draft.project.outcome.trim()) {
      showMessage("请先填写项目名称和期望结果。");
      return;
    }
    const incompleteBranch = draft.branches.find((branch) => branch.projectType !== "main" && (!branch.title.trim() || !branch.outcome.trim()));
    if (incompleteBranch) {
      showMessage("请补全支线名称和完成标准，或先移除这条新支线。");
      return;
    }
    setSaving(true);
    try {
      const project = await repository.saveWorkspace(
        draft.project,
        draft.milestones,
        draft.task.title.trim() ? draft.task : null,
        draft.branches,
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

  async function deleteCurrentProject() {
    if (!detail) return;
    const branchCount = projects.filter((project) => project.parentProjectId === detail.project.id).length;
    const consequence = branchCount
      ? `并同时删除 ${branchCount} 条支线及其阶段、行动和记录`
      : "及其阶段、行动和记录";
    if (!window.confirm(`确认永久删除项目「${detail.project.title}」${consequence}吗？关联文章只会解除项目关联，不会被删除。`)) return;
    setSaving(true);
    try {
      const parentProjectId = detail.project.parentProjectId;
      await repository.removeProject(detail.project.id);
      const nextProjects = await onProjectsChange();
      setEditing(false);
      setDraft(null);
      if (parentProjectId && nextProjects.some((project) => project.id === parentProjectId)) {
        setSelectedId(parentProjectId);
        setDetail(await repository.get(parentProjectId));
        setTab("overview");
      } else {
        setSelectedId(null);
        setDetail(null);
      }
      showMessage("项目已经删除，关联文章仍然保留。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "项目删除失败");
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

  async function addProgress(event: FormEvent, kind: "continuation" | "general" = "general") {
    event.preventDefault();
    if (!detail || !logText.trim()) return;
    setSaving(true);
    try {
      const currentMilestone = detail.milestones.find((item) => item.status === "current") ?? null;
      const currentTask = detail.tasks.find((item) => item.status === "next" && (!currentMilestone || item.milestoneId === currentMilestone.id))
        ?? detail.tasks.find((item) => item.status === "waiting" && (!currentMilestone || item.milestoneId === currentMilestone.id))
        ?? null;
      const body = kind === "continuation"
        ? encodeContinuationLog(currentTask?.id || currentMilestone?.id || detail.project.id, currentTask?.title || currentMilestone?.title || detail.project.title, logText)
        : logText;
      await repository.addLog(detail.project.id, body);
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
      const replacement = milestone.status === "current"
        ? detail.milestones.find((item) => item.id !== milestone.id && item.status === "planned") ?? null
        : null;
      await repository.removeMilestone(milestone.id);
      if (replacement) await repository.saveMilestone({ ...replacement, status: "current" });
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
            parentProject={draft.project.parentProjectId ? projects.find((project) => project.id === draft.project.parentProjectId) ?? null : null}
            saving={saving}
            onChange={setDraft}
            onCancel={() => setEditing(false)}
            onDelete={() => void deleteCurrentProject()}
            onSave={() => void saveDraft()}
          />
        ) : loading ? (
          <div className="project-loading">正在恢复项目上下文…</div>
        ) : detail ? (
          <ProjectPage
            detail={detail}
            branches={projects.filter((project) => project.parentProjectId === detail.project.id)}
            parentProject={detail.project.parentProjectId ? projects.find((project) => project.id === detail.project.parentProjectId) ?? null : null}
            saving={saving}
            tab={tab}
            onTabChange={setTab}
            logText={logText}
            onLogTextChange={setLogText}
            onAddProgress={addProgress}
            onConfirm={() => void confirmProject()}
            onEdit={startEditing}
            onOpenProject={(projectId) => { setSelectedId(projectId); setEditing(false); setTab("overview"); }}
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
              <div><h1>项目大厅</h1><p>{projects.filter((project) => !project.parentProjectId && project.status === "active").length} 条主线正在推进 · {projects.filter((project) => !project.parentProjectId).length} 个主项目</p></div>
              <button onClick={startNewProject}>＋ 新建项目</button>
            </header>
            <div className="project-gallery-controls">
              <nav aria-label="项目状态">
                {([ ["active", "进行中"], ["waiting", "等待"], ["paused", "暂停"], ["completed", "已完成"] ] as const).map(([value, label]) => <button className={statusFilter === value ? "active" : ""} key={value} onClick={() => setStatusFilter(value)}>{label}</button>)}
              </nav>
              <div className="project-gallery-filters">
                <label className="project-domain-filter"><span>领域</span><select value={domainFilter} onChange={(event) => setDomainFilter(event.target.value as "all" | ProjectCategory)}><option value="all">不限领域</option>{categoryOptions.filter((option) => option.value !== "uncategorized").map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}<option value="uncategorized">未分类</option></select></label>
                <label className="project-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目" />{query && <button onClick={() => setQuery("")}>×</button>}</label>
              </div>
            </div>
            <div className="project-gallery-grid" aria-live="polite">
              {visibleProjects.map((project) => {
                const total = project.milestoneCount;
                const progress = total ? Math.round(project.completedMilestoneCount / total * 100) : 0;
                const category = normalizeLifeDomain(project.category);
                const branchCount = projects.filter((candidate) => candidate.parentProjectId === project.id).length;
                return <button className={`project-gallery-card category-${category}`} key={project.id} onClick={() => { setSelectedId(project.id); setEditing(false); }}>
                  <header><span className="project-domain">{categoryLabels[category]}</span><span className={`project-status ${project.status}`}>{statusLabels[project.status]}</span></header>
                  <div>{project.isDraft && <small>待确认</small>}<h2>{project.title}</h2><p>{project.outcome}</p></div>
                  <section><span>当前阶段</span><strong>{project.currentMilestone?.title || "尚未设置当前阶段"}</strong>{project.currentMilestone?.dueDate && <small>阶段截止 · {formatDueDate(project.currentMilestone.dueDate)}</small>}</section>
                  <footer><i><b style={{ width: `${progress}%` }} /></i><span>{project.completedMilestoneCount}/{total || 0} 个阶段完成{branchCount ? ` · ${branchCount} 条支线` : ""}</span><em>进入项目 →</em></footer>
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
  branches,
  parentProject,
  saving,
  tab,
  onTabChange,
  logText,
  onLogTextChange,
  onAddProgress,
  onConfirm,
  onEdit,
  onOpenProject,
  onBack,
  onTaskStatus,
  onSaveMilestone,
  onRemoveMilestone,
  onSaveProposal,
  onReviewProposal,
}: {
  detail: ProjectDetail;
  branches: ProjectSummary[];
  parentProject: ProjectSummary | null;
  saving: boolean;
  tab: ProjectTab;
  onTabChange: (tab: ProjectTab) => void;
  logText: string;
  onLogTextChange: (value: string) => void;
  onAddProgress: (event: FormEvent, kind?: "continuation" | "general") => void;
  onConfirm: () => void;
  onEdit: () => void;
  onOpenProject: (projectId: string) => void;
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
  const continuationTargetId = nextTask?.id || currentMilestone?.id || project.id;
  const latestContinuation = logs.map((log) => ({ log, continuation: decodeContinuationLog(log.body) }))
    .find((entry) => entry.continuation?.targetId === continuationTargetId) ?? null;

  return (
    <article className="project-page">
      <header className="project-toolbar">
        <div>
          <button className="project-back" onClick={parentProject ? () => onOpenProject(parentProject.id) : onBack}>{parentProject ? `← 主线：${parentProject.title}` : "← 项目大厅"}</button>
          <span className={`project-status ${project.status}`}>{statusLabels[project.status]}</span>
          {project.parentProjectId && <span className="project-branch-badge">{projectTypeLabels[project.projectType]}</span>}
          {normalizeLifeDomain(project.category) !== "uncategorized" && <span>{categoryLabels[normalizeLifeDomain(project.category)]}</span>}
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
          {parentProject && <span>{projectTypeLabels[project.projectType]} · 服务于 {parentProject.title}</span>}
          <h1>{project.title}</h1>
          <p>{project.outcome}</p>
        </header>

        <nav className="project-tabs" aria-label="项目视图">
          {([ ["overview", "项目概览"], ["stages", "阶段路线"], ["proposals", `想法与提案 ${proposals.filter((item) => item.status === "pending").length || ""}`], ["history", "决策与记录"] ] as const).map(([value, label]) => <button className={tab === value ? "active" : ""} key={value} onClick={() => onTabChange(value)}>{label}</button>)}
        </nav>

        {tab === "overview" && <>
          <ProjectCurrentProgress
            currentMilestone={currentMilestone}
            nextTask={nextTask}
            otherTasks={openTasks.filter((task) => task.id !== nextTask?.id)}
            doneTasks={doneTasks}
            latestContinuation={latestContinuation}
            saving={saving}
            logText={logText}
            onLogTextChange={onLogTextChange}
            onAddContinuation={(event) => onAddProgress(event, "continuation")}
            onTaskStatus={onTaskStatus}
            onEdit={onEdit}
          />
          <StageTimelinePreview branches={branches} milestones={milestones} completedStages={completedStages} onOpen={() => onTabChange("stages")} onOpenProject={onOpenProject} />
          <div className="project-secondary-grid">
            <section className="project-section project-history-preview">
              <header><div><span>最近发生</span></div><button onClick={() => onTabChange("history")}>查看全部 →</button></header>
              <ProjectTimeline logs={logs.slice(0, 4)} />
            </section>
            <ProjectContext detail={detail} />
          </div>
        </>}

        {tab === "stages" && <StageRouteEditor projectId={project.id} milestones={milestones} tasks={tasks} branches={branches} saving={saving} onSave={onSaveMilestone} onRemove={onRemoveMilestone} onOpenProject={onOpenProject} />}

        {tab === "proposals" && <ProposalBoard projectId={project.id} proposals={proposals} saving={saving} onSave={onSaveProposal} onReview={onReviewProposal} />}

        {tab === "history" && <section className="project-section project-progress project-history-full">
          <header><div><span>项目轨迹</span><small>完成行动、调整阶段和评审想法会自动留下记录</small></div></header>
          <details className="manual-log-entry"><summary>补充一条结果或判断</summary><form onSubmit={(event) => onAddProgress(event, "general")}><textarea value={logText} onChange={(event) => onLogTextChange(event.target.value)} placeholder="写下确实发生的结果、变化或新判断" /><button disabled={saving || !logText.trim()} type="submit">保存记录</button></form></details>
          <ProjectTimeline logs={logs} />
        </section>}
      </div>
    </article>
  );
}

function ProjectCurrentProgress({ currentMilestone, nextTask, otherTasks, doneTasks, latestContinuation, saving, logText, onLogTextChange, onAddContinuation, onTaskStatus, onEdit }: {
  currentMilestone: Milestone | null;
  nextTask: ProjectTask | null;
  otherTasks: ProjectTask[];
  doneTasks: ProjectTask[];
  latestContinuation: { log: ProjectDetail["logs"][number]; continuation: ReturnType<typeof decodeContinuationLog> } | null;
  saving: boolean;
  logText: string;
  onLogTextChange: (value: string) => void;
  onAddContinuation: (event: FormEvent) => void;
  onTaskStatus: (task: ProjectTask, status: ProjectTaskStatus) => void;
  onEdit: () => void;
}) {
  return <section className="project-current-progress">
    <header className="project-current-stage">
      <div><span>当前推进</span><h2>{currentMilestone?.title || "尚未选择当前阶段"}</h2><p>{currentMilestone?.definitionOfDone || "先确定这一阶段要抵达的结果。"}</p></div>
    </header>
    <div className="project-current-body">
      <article className="project-next-action">
        <header><span>下一步</span>{nextTask && (nextTask.status !== "next" || nextTask.dueDate) && <small>{nextTask.status !== "next" ? taskStatusLabels[nextTask.status] : ""}{nextTask.status !== "next" && nextTask.dueDate ? " · " : ""}{nextTask.dueDate ? formatDueDate(nextTask.dueDate) : ""}</small>}</header>
        {nextTask ? <>
          <h3>{projectTaskDisplayTitle(nextTask)}</h3>
          <details className="action-disclosure"><summary>展开具体做法</summary><p>{nextTask.details || "还没有补充具体做法。"}</p>{nextTask.waitingFor && <p><b>正在等待</b>{nextTask.waitingFor}</p>}</details>
          <div className="project-action-buttons">{nextTask.status !== "next" && <button disabled={saving} onClick={() => onTaskStatus(nextTask, "next")}>设为当前</button>}<button disabled={saving} onClick={() => onTaskStatus(nextTask, "done")}>✓ 完成</button></div>
        </> : <div className="project-next-empty"><p>当前阶段还没有明确的下一步。</p><button onClick={onEdit}>补充下一步</button></div>}
      </article>
      <aside className="project-continuation">
        <header><span>接续记录</span><small>为下一次打开留下起点</small></header>
        {latestContinuation?.continuation && <div className="continuation-latest"><small>上次做到</small><p>{latestContinuation.continuation.text}</p><time>{formatProjectDate(latestContinuation.log.createdAt)}</time></div>}
        <form onSubmit={onAddContinuation}><textarea value={logText} onChange={(event) => onLogTextChange(event.target.value)} placeholder="今天做到哪里了？下一次从哪里继续？" /><button disabled={saving || !logText.trim()} type="submit">保存接续点</button></form>
      </aside>
    </div>
    {otherTasks.length > 0 && <details className="project-other-actions"><summary>本阶段还有 {otherTasks.length} 项行动</summary>{otherTasks.map((task) => <div key={task.id}><span>{taskStatusLabels[task.status]}</span><strong>{projectTaskDisplayTitle(task)}</strong>{task.status !== "next" && <button disabled={saving} onClick={() => onTaskStatus(task, "next")}>设为下一步</button>}</div>)}</details>}
    {doneTasks.length > 0 && <details className="project-done-list"><summary>最近完成 {doneTasks.length} 项</summary>{doneTasks.map((task) => <p key={task.id}>✓ {projectTaskDisplayTitle(task)}</p>)}</details>}
  </section>;
}

function StageTimelinePreview({ milestones, branches, completedStages, onOpen, onOpenProject }: { milestones: Milestone[]; branches: ProjectSummary[]; completedStages: number; onOpen: () => void; onOpenProject: (projectId: string) => void }) {
  const stageCount = Math.max(milestones.length, 1);
  const treeStyle = { "--route-stage-count": stageCount } as CSSProperties;
  return <section className="project-route-preview">
    <header><div><span>项目路线</span><small>{completedStages}/{milestones.length || 0} 个主线阶段完成{branches.length ? ` · ${branches.length} 条支线` : ""}</small></div><button onClick={onOpen}>调整路线 →</button></header>
    {milestones.length ? <div className="project-route-tree-scroll"><div className="project-route-tree" style={treeStyle}>
      <div className="project-route-line">{milestones.map((milestone, index) => <div className={milestone.status} key={milestone.id || index}><i>{milestone.status === "completed" ? "✓" : index + 1}</i><span><b>{milestone.title}</b>{milestone.dueDate && <small>截止 · {formatDueDate(milestone.dueDate)}</small>}</span></div>)}</div>
      {branches.length > 0 && <div className="project-route-branch-grid">{milestones.map((milestone, index) => {
        const stageBranches = branchesForStage(branches, milestones, index);
        return <div className={`project-route-branch-column ${stageBranches.length ? "has-branches" : ""}`} key={milestone.id || index}>{stageBranches.map((branch) => <RouteBranchCard branch={branch} key={branch.id} onOpen={() => onOpenProject(branch.id)} />)}</div>;
      })}</div>}
    </div></div> : <p className="project-empty-copy">还没有主线阶段。先添加阶段，支线会从对应阶段向下生长。</p>}
  </section>;
}

function RouteBranchCard({ branch, onOpen, compact = false }: { branch: ProjectSummary; onOpen: () => void; compact?: boolean }) {
  const total = branch.milestoneCount;
  const progress = total ? Math.round(branch.completedMilestoneCount / total * 100) : 0;
  return <button className={`route-branch-card ${branch.projectType} ${compact ? "compact" : ""}`} onClick={onOpen}>
    <header><span>↳ {projectTypeLabels[branch.projectType]}</span><i className={`project-status ${branch.status}`}>{statusLabels[branch.status]}</i></header>
    <strong>{branch.title}</strong>
    <p>{branch.nextTask?.title || branch.currentMilestone?.title || "等待补充下一步"}</p>
    <footer><i><b style={{ width: `${progress}%` }} /></i><em>{branch.completedMilestoneCount}/{total || 0} 阶段 · 进入 →</em></footer>
  </button>;
}

function branchesForStage(branches: ProjectSummary[], milestones: Milestone[], stageIndex: number) {
  const currentIndex = Math.max(0, milestones.findIndex((milestone) => milestone.status === "current"));
  return branches.filter((branch) => {
    const linkedIndex = milestones.findIndex((milestone) => milestone.id === branch.supportsMilestoneId);
    return (linkedIndex >= 0 ? linkedIndex : currentIndex) === stageIndex;
  });
}

function ProjectContext({ detail }: { detail: ProjectDetail }) {
  const { project, milestones } = detail;
  return <details className="project-context-panel"><summary><span>项目背景</span><small>目标缘由与低频信息</small></summary><div><section><span>为什么做</span><p>{project.motivation || "还没有记录这个项目为什么值得投入。"}</p></section><section><span>阶段概览</span><p>{milestones.filter((item) => item.status === "completed").length} 个已完成 · {milestones.filter((item) => item.status !== "completed").length} 个仍在路线中</p></section><section><span>最近更新</span><p>{formatProjectDate(project.updatedAt)}</p></section></div></details>;
}

function ProjectTimeline({ logs }: { logs: ProjectDetail["logs"] }) {
  return <div className="project-timeline">{logs.length ? logs.map((log) => { const continuation = decodeContinuationLog(log.body); return <div key={log.id}><time>{formatProjectDate(log.createdAt)}</time><p>{continuation ? <><strong>接续点 · {continuation.label}</strong>{continuation.text}</> : log.body}</p></div>; }) : <p className="project-empty-copy">项目发生变化后，轨迹会自动出现在这里。</p>}</div>;
}

function StageRouteEditor({ projectId, milestones, tasks, branches, saving, onSave, onRemove, onOpenProject }: { projectId: string; milestones: Milestone[]; tasks: ProjectTask[]; branches: ProjectSummary[]; saving: boolean; onSave: (milestone: Milestone) => void; onRemove: (milestone: Milestone) => void; onOpenProject: (projectId: string) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Milestone | null>(null);
  function closeEditor() { setDraft(null); setEditingId(null); }
  function edit(item?: Milestone) {
    const nextEditingId = item?.id || "new";
    if (editingId === nextEditingId) {
      closeEditor();
      return;
    }
    const now = new Date().toISOString();
    const next = item ? { ...item } : { ...emptyMilestone(projectId, now), status: milestones.length ? "planned" as const : "current" as const, sortOrder: (milestones.length + 1) * 10 };
    setDraft(next);
    setEditingId(nextEditingId);
  }
  function submit(event: FormEvent) { event.preventDefault(); if (!draft?.title.trim()) return; onSave(draft); setDraft(null); setEditingId(null); }
  return <section className="project-stage-overview stage-route-page">
    <header><div><h2>项目路线</h2><p>主线阶段横向前进，支线从它服务的阶段向下生长。点击阶段可查看或收起编辑区。</p></div><button aria-expanded={editingId === "new"} onClick={() => edit()}>{editingId === "new" ? "收起新阶段" : "＋ 添加阶段"}</button></header>
    <div className="project-stage-tree-scroll"><div className="project-stage-path" style={{ "--route-stage-count": Math.max(milestones.length, 1) } as CSSProperties}>{milestones.map((milestone, index) => {
      const stageTasks = tasks.filter((task) => task.milestoneId === milestone.id);
      const stageBranches = branchesForStage(branches, milestones, index);
      const isEditing = editingId === milestone.id;
      return <article className={`project-stage-node ${milestone.status} ${isEditing ? "editing" : ""}`} key={milestone.id}>
        <button aria-expanded={isEditing} className="stage-node-button" onClick={() => edit(milestone)}><i>{milestone.status === "completed" ? "✓" : index + 1}</i><span><small>{milestone.status === "current" ? "当前阶段" : milestone.status === "completed" ? "已完成" : "待开始"}</small><strong>{milestone.title}</strong><em>{stageTasks.filter((task) => task.status === "done").length}/{stageTasks.length} 行动{milestone.dueDate ? ` · 截止 ${formatDueDate(milestone.dueDate)}` : ""}</em></span><b className="stage-node-toggle">{isEditing ? "收起" : "编辑"}</b></button>
        {stageBranches.length > 0 && <div className="stage-node-branches"><span>从这里向下生长</span>{stageBranches.map((branch) => <RouteBranchCard branch={branch} compact key={branch.id} onOpen={() => onOpenProject(branch.id)} />)}</div>}
      </article>;
    })}</div></div>
    {draft && <section className="stage-editor-panel">
      <header><div><span>{editingId === "new" ? "新阶段" : "编辑阶段"}</span><strong>{editingId === "new" ? "为路线补充下一站" : draft.title || "未命名阶段"}</strong><p>阶段名称说明要抵达哪里，完成标准说明满足什么条件才算通过。</p></div><button type="button" onClick={closeEditor}>× 收起编辑</button></header>
      <StageInlineForm draft={draft} saving={saving} onChange={setDraft} onCancel={closeEditor} onRemove={editingId === "new" ? undefined : () => { onRemove(draft); closeEditor(); }} onSubmit={submit} />
    </section>}
    {!milestones.length && <p className="project-empty-copy">还没有主线阶段。添加第一个阶段后，就可以把支线挂到路线树上。</p>}
  </section>;
}

function StageInlineForm({ draft, saving, onChange, onCancel, onRemove, onSubmit }: { draft: Milestone; saving: boolean; onChange: (draft: Milestone) => void; onCancel: () => void; onRemove?: () => void; onSubmit: (event: FormEvent) => void }) {
  const statusOptions: Array<{ value: Milestone["status"]; label: string; description: string }> = [
    { value: "planned", label: "待开始", description: "保留在后续路线中" },
    { value: "current", label: "当前阶段", description: "项目此刻正在推进" },
    { value: "completed", label: "已完成", description: "这个阶段已经验收" },
  ];
  return <form className="stage-inline-form" onSubmit={onSubmit}>
    <div className="stage-form-fields">
      <label className="stage-form-field stage-form-field-wide"><span>阶段名称<small>用一句短语描述这一站要抵达的结果</small></span><input autoFocus value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} placeholder="例如：完成第一轮真实使用验证" /></label>
      <label className="stage-form-field stage-form-field-wide"><span>完成标准<small>写清楚什么证据出现后，可以把阶段标记为完成</small></span><textarea value={draft.definitionOfDone} onChange={(event) => onChange({ ...draft, definitionOfDone: event.target.value })} placeholder="例如：连续使用两周，完成主要问题清单并确定下一轮调整范围" /></label>
      <fieldset className="stage-status-field"><legend>阶段状态</legend><p>状态会决定它在路线中的强调方式。</p><div>{statusOptions.map((option) => <button className={draft.status === option.value ? "active" : ""} key={option.value} type="button" onClick={() => onChange({ ...draft, status: option.value })}><strong>{option.label}</strong><small>{option.description}</small></button>)}</div></fieldset>
      <label className="stage-form-field stage-date-field"><span>计划截止<small>可选，用于提醒这一阶段的时间边界</small></span><input type="date" value={draft.dueDate} onChange={(event) => onChange({ ...draft, dueDate: event.target.value })} /></label>
    </div>
    <footer>{onRemove && <button className="danger" type="button" onClick={onRemove}>删除阶段</button>}<span /><button type="button" onClick={onCancel}>收起</button><button className="primary" disabled={saving || !draft.title.trim()}>保存阶段</button></footer>
  </form>;
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
  parentProject,
  saving,
  onChange,
  onCancel,
  onDelete,
  onSave,
}: {
  draft: WorkspaceDraft;
  parentProject: ProjectSummary | null;
  saving: boolean;
  onChange: (draft: WorkspaceDraft) => void;
  onCancel: () => void;
  onDelete: () => void;
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
  const updateBranch = <Key extends keyof Project>(index: number, key: Key, value: Project[Key]) => {
    onChange({ ...draft, branches: draft.branches.map((branch, branchIndex) => branchIndex === index ? { ...branch, [key]: value } : branch) });
  };
  const addBranch = () => {
    onChange({ ...draft, branches: [...draft.branches, emptyBranch(draft.project, draft.branches.length)] });
  };
  const removeOrDetachBranch = (index: number) => {
    const branch = draft.branches[index];
    if (!branch.id) {
      onChange({ ...draft, branches: draft.branches.filter((_, branchIndex) => branchIndex !== index) });
      return;
    }
    if (!window.confirm(`将支线「${branch.title}」转为独立项目吗？它的阶段、行动和记录都会保留。`)) return;
    updateBranch(index, "projectType", "main");
  };
  const moveMilestone = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= draft.milestones.length) return;
    const next = [...draft.milestones];
    [next[index], next[target]] = [next[target], next[index]];
    onChange({ ...draft, milestones: next.map((milestone, milestoneIndex) => ({ ...milestone, sortOrder: (milestoneIndex + 1) * 10 })) });
  };
  const removeMilestoneAt = (index: number) => {
    const milestone = draft.milestones[index];
    if ((milestone.id || milestone.title.trim()) && !window.confirm(`确认删除阶段「${milestone.title || `阶段 ${index + 1}`}」吗？关联行动会保留，但不再归属这个阶段。`)) return;
    const next = draft.milestones.filter((_, milestoneIndex) => milestoneIndex !== index);
    if (milestone.status === "current" && next.length && !next.some((item) => item.status === "current")) {
      const replacement = Math.min(index, next.length - 1);
      next[replacement] = { ...next[replacement], status: "current" };
    }
    const normalized = next.map((item, milestoneIndex) => ({ ...item, sortOrder: (milestoneIndex + 1) * 10 }));
    const task = milestone.id && draft.task.milestoneId === milestone.id
      ? { ...draft.task, milestoneId: normalized.find((item) => item.status === "current")?.id || null }
      : draft.task;
    onChange({ ...draft, milestones: normalized, task });
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
          <details className="project-editor-optional">
            <summary>项目背景（可选）</summary>
            <label><span>为什么值得做</span><textarea value={draft.project.motivation} onChange={(event) => updateProject("motivation", event.target.value)} placeholder="需要时再记录它为什么值得投入" /></label>
          </details>
          <div className="project-editor-grid">
            <label>
              <span>所属领域 · 可选</span>
              <select value={draft.project.category} onChange={(event) => updateProject("category", event.target.value as ProjectCategory)}>
                {categoryOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label>
              <span>当前状态</span>
              <select value={draft.project.status} onChange={(event) => updateProject("status", event.target.value as ProjectStatus)}>
                {Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </label>
          </div>

          {parentProject && <section className="project-editor-parent">
            <span>{projectTypeLabels[draft.project.projectType]}</span>
            <strong>所属主线 · {parentProject.title}</strong>
            <p>{draft.project.motivation || "补充这条支线如何帮助主线，之后回看时会更容易判断是否值得继续。"}</p>
          </section>}

          {!draft.project.parentProjectId && <section className="project-editor-block project-branch-editor">
            <header><div><strong>关联支线</strong><span>适合需要多次推进、可独立验收，但服务于当前主线的短期项目</span></div><button type="button" onClick={addBranch}>＋ 添加支线</button></header>
            {draft.branches.length ? <div className="project-branch-editor-list">{draft.branches.map((branch, index) => <details key={branch.id || `new-branch-${index}`} open={!branch.id || branch.projectType === "main"}>
              <summary><span><small>{branch.projectType === "main" ? "待解除关联" : projectTypeLabels[branch.projectType]}</small><strong>{branch.title || `新支线 ${index + 1}`}</strong></span><em>{branch.projectType === "main" ? "保存后转为独立项目" : statusLabels[branch.status]}</em></summary>
              <div>
                {branch.projectType !== "main" && <div className="project-editor-grid">
                  <label><span>支线类型</span><select value={branch.projectType} onChange={(event) => updateBranch(index, "projectType", event.target.value as ProjectType)}><option value="side">支线项目</option><option value="experiment">实验支线</option></select></label>
                  <label><span>当前状态</span><select value={branch.status} onChange={(event) => updateBranch(index, "status", event.target.value as ProjectStatus)}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                </div>}
                <label><span>支线名称</span><input disabled={branch.projectType === "main"} value={branch.title} onChange={(event) => updateBranch(index, "title", event.target.value)} placeholder="例如：补充深度学习基础课程" /></label>
                <label><span>完成标准</span><textarea disabled={branch.projectType === "main"} value={branch.outcome} onChange={(event) => updateBranch(index, "outcome", event.target.value)} placeholder="学到什么程度、产出什么，才算支线结束？" /></label>
                <label><span>怎样帮助主线</span><textarea disabled={branch.projectType === "main"} value={branch.motivation} onChange={(event) => updateBranch(index, "motivation", event.target.value)} placeholder="它具体解决主线中的哪项能力或阻塞？" /></label>
                {branch.projectType !== "main" && <div className="project-editor-grid">
                  <label><span>关联主线阶段 · 可选</span><select value={branch.supportsMilestoneId || ""} onChange={(event) => updateBranch(index, "supportsMilestoneId", event.target.value || null)}><option value="">不限定阶段</option>{draft.milestones.filter((milestone) => milestone.id).map((milestone) => <option key={milestone.id} value={milestone.id}>{milestone.title || "未命名阶段"}</option>)}</select></label>
                  <label><span>复查日期 · 可选</span><input type="date" value={branch.reviewDate} onChange={(event) => updateBranch(index, "reviewDate", event.target.value)} /></label>
                </div>}
                <footer><span>{branch.id ? "解除后会作为独立项目出现在项目大厅" : "保存主项目后，即可进入支线补充阶段和下一步"}</span><button className="danger" type="button" onClick={() => removeOrDetachBranch(index)}>{branch.id ? "转为独立项目" : "移除"}</button></footer>
              </div>
            </details>)}</div> : <p className="project-editor-empty">当前没有支线。单次能完成的内容仍建议放在“下一步”中。</p>}
          </section>}

          <section className="project-editor-block">
            <header><strong>阶段路线</strong><button type="button" onClick={() => onChange({ ...draft, milestones: [...draft.milestones, { ...emptyMilestone(draft.project.id, new Date().toISOString()), status: "planned", sortOrder: (draft.milestones.length + 1) * 10 }] })}>＋ 添加阶段</button></header>
            <div className="project-stage-editor-list">
              {draft.milestones.map((milestone, index) => <article key={milestone.id || `new-stage-${index}`}>
                <header><span>阶段 {index + 1}</span><div className="stage-editor-actions"><button type="button" disabled={index === 0} onClick={() => moveMilestone(index, -1)} aria-label={`上移阶段 ${index + 1}`}>↑</button><button type="button" disabled={index === draft.milestones.length - 1} onClick={() => moveMilestone(index, 1)} aria-label={`下移阶段 ${index + 1}`}>↓</button><button className="danger" type="button" onClick={() => removeMilestoneAt(index)}>删除</button><select value={milestone.status} onChange={(event) => updateMilestone(index, "status", event.target.value as Milestone["status"])}><option value="completed">已完成</option><option value="current">当前阶段</option><option value="planned">待开始</option></select></div></header>
                <label><span>阶段名称</span><input value={milestone.title} onChange={(event) => updateMilestone(index, "title", event.target.value)} placeholder="这一阶段要解决什么问题？" /></label>
                <label><span>截止时间 · 可选</span><input type="date" value={milestone.dueDate} onChange={(event) => updateMilestone(index, "dueDate", event.target.value)} /></label>
                <label><span>完成标准</span><textarea value={milestone.definitionOfDone} onChange={(event) => updateMilestone(index, "definitionOfDone", event.target.value)} /></label>
              </article>)}
            </div>
          </section>

          <section className="project-editor-block">
            <header><strong>当前阶段的下一步</strong><span>只保留真正影响执行的信息</span></header>
            <div className="project-editor-grid">
              <label>
                <span>当前状态</span>
                <select value={draft.task.status} onChange={(event) => updateTask("status", event.target.value as ProjectTaskStatus)}><option value="next">当前要做</option><option value="waiting">等待中</option><option value="done">已完成</option></select>
              </label>
              <label><span>截止时间 · 可选</span><input type="date" value={draft.task.dueDate} onChange={(event) => updateTask("dueDate", event.target.value)} /></label>
            </div>
            <label><span>下一步要做什么</span><input value={draft.task.title} onChange={(event) => updateTask("title", event.target.value)} placeholder="例如：比较三个候选方向并写下结论" /></label>
            <label><span>具体做法</span><textarea value={draft.task.details} onChange={(event) => updateTask("details", event.target.value)} placeholder="准备开始时，需要按什么顺序做？" /></label>
            {(draft.project.status === "waiting" || draft.task.status === "waiting") && (
              <div className="project-waiting-editor">
                <label><span>正在等待什么</span><input value={draft.task.waitingFor} onChange={(event) => updateTask("waitingFor", event.target.value)} /></label>
                <label><span>结果回来后先做什么</span><input value={draft.task.resumeAction} onChange={(event) => updateTask("resumeAction", event.target.value)} /></label>
              </div>
            )}
          </section>

          {draft.project.id && <section className="project-editor-danger-zone">
            <div><strong>删除项目</strong><p>永久删除项目、阶段、行动、支线和项目记录；关联文章会保留并解除关联。</p></div>
            <button disabled={saving} type="button" onClick={onDelete}>删除这个项目</button>
          </section>}
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

function emptyBranch(parent: Project, index: number): Project {
  const now = new Date().toISOString();
  return {
    id: "",
    title: "",
    outcome: "",
    motivation: "",
    projectType: "side",
    parentProjectId: parent.id || null,
    supportsMilestoneId: null,
    status: "active",
    category: parent.category,
    sortOrder: (index + 1) * 10,
    isDraft: false,
    sourceNote: "从主项目编辑器创建",
    reviewDate: "",
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

function normalizeProjectCategory(category: ProjectCategory): ProjectCategory {
  return normalizeLifeDomain(category);
}

const genericProjectTaskTitles = new Set(["阅读与判断", "写作修订", "真实使用与反馈", "验收与整理", "方案判断"]);

function projectTaskDisplayTitle(task: ProjectTask) {
  if (!genericProjectTaskTitles.has(task.title.trim()) || !task.details.trim()) return task.title;
  const firstSentence = task.details.trim().split(/[。；\n]/)[0];
  return firstSentence.length > 38 ? `${firstSentence.slice(0, 38)}…` : firstSentence;
}

function encodeContinuationLog(targetId: string, label: string, text: string) {
  return `接续点｜${targetId}｜${label.replaceAll("｜", "-")}｜${text.trim()}`;
}

function decodeContinuationLog(body: string) {
  if (!body.startsWith("接续点｜")) return null;
  const [, targetId = "", label = "当前推进", ...content] = body.split("｜");
  return { targetId, label, text: content.join("｜").trim() };
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

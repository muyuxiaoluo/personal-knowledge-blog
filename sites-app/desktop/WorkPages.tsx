import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { isSourceArticle, isThoughtInboxArticle, pickRediscoverySource } from "../app/article-helpers";
import { calendarDayDifference, classifyDeadlineUrgency, formatRelativeDueDate } from "../app/date-helpers";
import type {
  ProjectDetail,
  ProjectStatus,
  ProjectSummary,
  ProjectTask,
} from "../app/project-types";
import type { StoredArticle } from "../app/types";
import type { DailyCloseout, FocusSession, TaskPlan, WeeklyFocus } from "../app/work-types";
import type { IntegrationRepository } from "../app/data/integration-repository";
import type { DashboardRepository } from "../app/data/dashboard-repository";
import type { CalendarEvent, DashboardPreferences, ExternalSourceInput } from "../app/dashboard-types";
import {
  captureMetadata,
  captureRelations,
  formatPlaybackTime,
  type CaptureRelation,
} from "../app/entertainment-capture";
import { DateField, SearchField, SelectMenu } from "./DesktopControls";
import { BrandLogo } from "./BrandLogo";
import { HomeIntegrationCards } from "./ToolCenter";
import { MorningInformation, MorningOverview } from "./MorningDashboard";

export type WorkspaceTask = ProjectTask & {
  projectTitle: string;
  projectStatus: ProjectStatus;
  stageTitle: string;
  stageDueDate: string;
  stageIndex: number;
  stageCount: number;
  stageCompletedTasks: number;
  stageTaskCount: number;
  plan: TaskPlan | null;
};

export type NewActionInput = {
  projectId: string;
  milestoneId: string | null;
  title: string;
  details: string;
  dueDate: string;
  plannedToday: boolean;
};

export type SourceOrganizationInput =
  | { kind: "note"; title: string; body: string; tags: string[] }
  | { kind: "action"; projectId: string; milestoneId: string | null; title: string; details: string; dueDate: string }
  | { kind: "proposal"; projectId: string; title: string; problem: string; expectedValue: string; cost: string };

type TaskActions = {
  onCompleteTask: (task: WorkspaceTask) => void;
  onPlanToday: (task: WorkspaceTask) => void;
  onRemoveFromToday: (task: WorkspaceTask) => void;
  onStartFocus: (task: WorkspaceTask) => void;
  onStopFocus: () => void;
  activeSession: FocusSession | null;
  focusSessions: FocusSession[];
};

export function HomeDashboard({
  today,
  tasks,
  articles,
  weeklyFocus,
  integrationRepository,
  dashboardRepository,
  dashboardPreferences,
  calendarEvents,
  onOpenTools,
  onSaveWeeklyFocus,
  onOpenArticle,
  onOpenProject,
  onOpenTasks,
  onSaveDashboardPreferences,
  onSaveCalendarEvent,
  onDeleteCalendarEvent,
  onSaveSource,
  onNotice,
  ...taskActions
}: {
  today: string;
  tasks: WorkspaceTask[];
  articles: StoredArticle[];
  weeklyFocus: WeeklyFocus | null;
  integrationRepository: IntegrationRepository;
  dashboardRepository: DashboardRepository;
  dashboardPreferences: DashboardPreferences;
  calendarEvents: CalendarEvent[];
  onOpenTools: () => void;
  onSaveWeeklyFocus: (primaryOutcome: string, secondaryOutcome: string) => Promise<void>;
  onOpenArticle: (article: StoredArticle) => void;
  onOpenProject: (projectId: string) => void;
  onOpenTasks: () => void;
  onSaveDashboardPreferences: (preferences: DashboardPreferences) => Promise<void>;
  onSaveCalendarEvent: (event: CalendarEvent) => Promise<CalendarEvent>;
  onDeleteCalendarEvent: (id: string) => Promise<void>;
  onSaveSource: (input: ExternalSourceInput) => Promise<boolean>;
  onNotice: (message: string) => void;
} & TaskActions) {
  const [focusOpen, setFocusOpen] = useState(false);
  const [primaryOutcome, setPrimaryOutcome] = useState(weeklyFocus?.primaryOutcome ?? "");
  const [secondaryOutcome, setSecondaryOutcome] = useState(weeklyFocus?.secondaryOutcome ?? "");
  useEffect(() => {
    setPrimaryOutcome(weeklyFocus?.primaryOutcome ?? "");
    setSecondaryOutcome(weeklyFocus?.secondaryOutcome ?? "");
  }, [weeklyFocus]);
  // 与“添加行动”下拉框保持一致：只要项目未完成（含支线、等待中、已暂停），其任务都可以被安排到今天。
  const available = tasks
    .filter((task) => task.status !== "done" && task.status !== "waiting" && task.projectStatus !== "completed")
    .sort((left, right) => taskRank(left, today) - taskRank(right, today));
  const planned = available.filter((task) => task.plan?.plannedDate === today);
  const primaryTask = planned[0] ?? null;
  const alternatives = planned.slice(1, 3);
  const echo = selectContextualEcho(articles, primaryTask, today);
  const rediscovery = pickRediscoverySource(
    articles,
    primaryTask ? `${primaryTask.projectTitle} ${primaryTask.stageTitle} ${primaryTask.title} ${primaryTask.details}` : weeklyFocus?.primaryOutcome || "",
    today,
  );
  const completedToday = tasks.filter((task) => task.completedAt?.slice(0, 10) === today).length;
  const notesToday = articles.filter((article) => !isSourceArticle(article) && !isThoughtInboxArticle(article) && (article.updated || article.created).slice(0, 10) === today).length;
  const focusNow = useLiveNow(Boolean(taskActions.activeSession));
  const primaryFocusSeconds = primaryTask
    ? taskFocusSeconds(primaryTask.id, taskActions.focusSessions, today, taskActions.activeSession, focusNow)
    : 0;

  return (
    <div className="home-dashboard home-launchpad workspace-scroll">
      <header className="home-context-line">
        <div><span>{formatLongDate(today)}</span><strong>{greeting()}，{weeklyFocus?.primaryOutcome || "先选出本周最重要的结果"}</strong></div>
        <div className="home-context-actions"><button onClick={() => setFocusOpen((value) => !value)}>本周聚焦</button><button onClick={onOpenTasks}>安排今日行动 →</button></div>
      </header>

      {focusOpen && <form className="weekly-focus-card workspace-card" onSubmit={async (event) => {
        event.preventDefault();
        await onSaveWeeklyFocus(primaryOutcome, secondaryOutcome);
        setFocusOpen(false);
      }}>
        <div><span>主结果</span><input autoFocus value={primaryOutcome} onChange={(event) => setPrimaryOutcome(event.target.value)} placeholder="这一周最值得完成的结果" /></div>
        <div><span>副结果</span><input value={secondaryOutcome} onChange={(event) => setSecondaryOutcome(event.target.value)} placeholder="有余力时推进的第二结果" /></div>
        <button>保存本周聚焦</button>
      </form>}

      <div className={`home-primary-grid ${alternatives.length ? "with-alternatives" : ""}`}>
        <section className="home-strategy-card workspace-card">
          <header>
            <div><span>今日行动</span><strong>{primaryTask?.projectTitle || "尚未安排"}</strong></div>
            <div className="home-strategy-header-side">
              <div className="home-result-summary" aria-label={`今天完成 ${completedToday} 项行动，更新 ${notesToday} 条笔记`}>
                <p>今天留下</p>
                <span><i>{completedToday}</i> 项行动</span>
                <span><i>{notesToday}</i> 条笔记</span>
              </div>
              {primaryTask && <button onClick={() => onOpenProject(primaryTask.projectId)}>进入项目</button>}
            </div>
          </header>
          {primaryTask ? (
            <div className="home-strategy-body">
              <div className="home-action-core">
                <p><span>阶段 {primaryTask.stageIndex}/{primaryTask.stageCount}</span><b>{primaryTask.stageTitle || "未关联阶段"}</b>{actionDueDate(primaryTask) && <time className={classifyDeadlineUrgency(actionDueDate(primaryTask), today)?.tone ?? ""}>{deadlineLabel(primaryTask, today)}</time>}</p>
                <h1>{actionDisplayTitle(primaryTask)}</h1>
                {primaryFocusSeconds > 0 && <div className={`home-focus-status ${taskActions.activeSession?.taskId === primaryTask.id ? "active" : ""}`}><span>{taskActions.activeSession?.taskId === primaryTask.id ? "正在投入" : "今天已投入"}</span><strong>{formatFocusDuration(primaryFocusSeconds, true)}</strong></div>}
                <StageProgress task={primaryTask} />
                <details className="action-disclosure">
                  <summary>准备开始时展开具体做法</summary>
                  <p>{primaryTask.details || "还没有补充具体做法。可以进入项目后编辑这条行动。"}</p>
                </details>
                <div className="home-strategy-actions">
                  <button className="primary" onClick={() => taskActions.onCompleteTask(primaryTask)}>✓ 记为完成</button>
                  {taskActions.activeSession?.taskId === primaryTask.id
                    ? <button onClick={taskActions.onStopFocus}>Ⅱ 暂停投入</button>
                    : !taskActions.activeSession && <button onClick={() => taskActions.onStartFocus(primaryTask)}>▷ 开始投入</button>}
                  <button onClick={() => taskActions.onRemoveFromToday(primaryTask)}>取消今日安排</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="home-empty-today"><EmptyState title="今天还没有安排" body="挑选一项真正准备推进的行动，首页才会显示它。" /><button onClick={onOpenTasks}>安排今日行动 →</button></div>
          )}
        </section>

        {alternatives.length > 0 && <aside className="home-primary-side">
          <section className="workspace-card home-alternatives">
            <CardHeader title="接下来" subtitle="今日已安排" />
            {alternatives.map((task) => (
              <button key={task.id} onClick={onOpenTasks}>
                <span><strong>{actionDisplayTitle(task)}</strong><small>{task.projectTitle} · {task.stageTitle || "未关联阶段"}</small></span>
                <em className={actionDueDate(task) ? classifyDeadlineUrgency(actionDueDate(task), today)?.tone ?? "" : ""}>{actionDueDate(task) ? deadlineLabel(task, today) : "稍后"}</em>
              </button>
            ))}
          </section>
        </aside>}
      </div>

      <MorningOverview
        today={today}
        repository={dashboardRepository}
        preferences={dashboardPreferences}
        events={calendarEvents}
        onSavePreferences={onSaveDashboardPreferences}
        onSaveEvent={onSaveCalendarEvent}
        onDeleteEvent={onDeleteCalendarEvent}
        onNotice={onNotice}
      />

      <MorningInformation
        today={today}
        repository={dashboardRepository}
        preferences={dashboardPreferences}
        onSavePreferences={onSaveDashboardPreferences}
        onSaveSource={onSaveSource}
        onNotice={onNotice}
      />

      <div className="home-bottom-grid">
        <HomeIntegrationCards repository={integrationRepository} onOpenTools={onOpenTools} />
        <section className="workspace-card home-context-card">
          <CardHeader title="一条相关旧经验" subtitle={primaryTask ? `与你今天推进的「${primaryTask.projectTitle}」有关` : "安排今日行动后再寻找"} />
          {echo ? (
            <details className="home-context-echo">
              <summary><span>{echo.reason}</span><strong>{echo.article.title}</strong><small>展开看看</small></summary>
              <p>{echo.article.summary || plainExcerpt(echo.article.body)}</p>
              <button onClick={() => onOpenArticle(echo.article)}>打开完整笔记 →</button>
            </details>
          ) : <p className="compact-empty">还没有找到和当前阶段足够相关的旧记录。</p>}
        </section>
        {rediscovery && <section className="workspace-card home-rediscovery-card">
          <CardHeader title="收藏回响" subtitle="让收藏在需要时重新出现" />
          <div>
            <span>{rediscovery.reason}</span>
            <strong>{rediscovery.article.title}</strong>
            <p>{rediscovery.article.summary || plainExcerpt(rediscovery.article.body)}</p>
          </div>
          {sourceUrl(rediscovery.article) && <button onClick={() => void openSourceUrl(sourceUrl(rediscovery.article))}>重新打开 ↗</button>}
        </section>}
      </div>
    </div>
  );
}

export function TasksPage({
  today,
  tasks,
  projects,
  projectDetails,
  onAddTask,
  onRemoveTask,
  onOpenProject,
  ...taskActions
}: {
  today: string;
  tasks: WorkspaceTask[];
  projects: ProjectSummary[];
  projectDetails: ProjectDetail[];
  onAddTask: (input: NewActionInput) => Promise<void>;
  onRemoveTask: (task: WorkspaceTask) => void;
  onOpenProject: (projectId: string) => void;
} & TaskActions) {
  const [showComposer, setShowComposer] = useState(false);
  const [showPlanner, setShowPlanner] = useState(false);
  const initialProjectId = projects.find((item) => item.status === "active")?.id || "";
  const [projectId, setProjectId] = useState(initialProjectId);
  const [milestoneId, setMilestoneId] = useState("");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [planOnSave, setPlanOnSave] = useState(false);
  useEffect(() => {
    if (!showComposer && !showPlanner) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowComposer(false);
        setShowPlanner(false);
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [showComposer, showPlanner]);
  const available = tasks.filter((task) => task.status !== "done" && task.status !== "waiting" && task.projectStatus === "active").sort((a, b) => taskRank(a, today) - taskRank(b, today));
  const plannedToday = available.filter((task) => task.plan?.plannedDate === today);
  const candidates = available.filter((task) => task.plan?.plannedDate !== today).sort((left, right) => planningRank(left, today) - planningRank(right, today) || taskRank(left, today) - taskRank(right, today));
  const overdue = candidates.filter((task) => isTaskOverdue(task, today));
  const focusNow = useLiveNow(Boolean(taskActions.activeSession));
  const selectedProject = projectDetails.find((detail) => detail.project.id === projectId);

  function chooseProject(value: string) {
    setProjectId(value);
    const detail = projectDetails.find((item) => item.project.id === value);
    setMilestoneId(detail?.milestones.find((item) => item.status === "current")?.id || "");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !projectId) return;
    await onAddTask({ projectId, milestoneId: milestoneId || null, title: title.trim(), details: details.trim(), dueDate, plannedToday: planOnSave });
    setTitle(""); setDetails(""); setDueDate(""); setPlanOnSave(false); setShowComposer(false);
  }

  return (
    <div className="tasks-page action-center workspace-scroll">
      <header className="workspace-page-heading">
        <div><h1>今日行动</h1><p>这里只保留今天真正准备推进的内容。</p></div>
        <div className="today-heading-actions"><button onClick={() => { chooseProject(projectId || initialProjectId); setShowComposer(true); }}>＋ 新建项目行动</button><button className="primary" onClick={() => setShowPlanner(true)}>从项目中安排 <span>{candidates.length}</span></button></div>
      </header>

      {overdue.length > 0 && <button className="today-overdue-alert" onClick={() => setShowPlanner(true)}><span>有 {overdue.length} 项计划或截止时间已经过去</span><strong>重新安排 →</strong></button>}

      <section className="task-list-shell action-list-shell">
        <header><div><strong>今天已安排</strong><span>{plannedToday.length} 项</span></div></header>
        <div className="task-list-large">
          {plannedToday.length ? plannedToday.map((task) => (
            <ActionRow
              key={task.id}
              task={task}
              today={today}
              onOpenProject={onOpenProject}
              onRemoveTask={onRemoveTask}
              now={focusNow}
              {...taskActions}
            />
          )) : <div className="today-empty-state"><EmptyState title="今天还没有安排" body="从正在推进的项目中挑一两项，今天只关注真正准备开始的内容。" /><button onClick={() => setShowPlanner(true)}>从项目中安排</button></div>}
        </div>
      </section>

      {showPlanner && (
        <div className="task-drawer-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setShowPlanner(false); }}>
          <aside className="task-drawer plan-today-drawer" role="dialog" aria-modal="true" aria-label="从项目中安排今日行动">
            <header><div><span>项目行动</span><h2>安排到今天</h2><p>只显示正在推进的项目；逾期和临近截止会优先出现。</p></div><button onClick={() => setShowPlanner(false)} aria-label="关闭">×</button></header>
            <div className="plan-today-list">
              {candidates.length ? candidates.map((task) => {
                const urgency = planningUrgency(task, today);
                return <article key={task.id}><button className="plan-task-main" onClick={() => onOpenProject(task.projectId)}><span>{task.projectTitle}</span><strong>{actionDisplayTitle(task)}</strong><small>{task.stageTitle || "未关联阶段"}</small></button><div>{urgency && <em className={urgency.tone}>{urgency.label}</em>}<button onClick={() => void Promise.resolve(taskActions.onPlanToday(task))}>安排到今天</button></div></article>;
              }) : <EmptyState title="暂时没有可安排的行动" body="正在推进的项目里还没有未完成行动，可以先回到项目补充下一步。" />}
            </div>
          </aside>
        </div>
      )}

      {showComposer && (
        <div className="task-drawer-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setShowComposer(false); }}>
          <aside className="task-drawer action-drawer" role="dialog" aria-modal="true" aria-label="添加行动">
            <header><div><span>新的行动</span><h2>添加阶段行动</h2></div><button onClick={() => setShowComposer(false)} aria-label="关闭">×</button></header>
            <form onSubmit={submit}>
              <label><span>所属项目</span><SelectMenu label="所属项目" value={projectId} onChange={chooseProject} options={[{ value: "", label: "选择项目" }, ...projects.filter((project) => project.status === "active").map((project) => ({ value: project.id, label: project.title }))]} /></label>
              <label><span>所属阶段</span><SelectMenu label="所属阶段" value={milestoneId} onChange={setMilestoneId} options={[{ value: "", label: "暂不关联" }, ...(selectedProject?.milestones ?? []).map((milestone) => ({ value: milestone.id, label: `${milestone.status === "current" ? "当前 · " : ""}${milestone.title}` }))]} /></label>
              <label><span>下一步要做什么</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：比较三个方向并写下结论" /></label>
              <label><span>具体做法</span><textarea value={details} onChange={(event) => setDetails(event.target.value)} placeholder="真正准备开始时，需要按什么顺序做？" /></label>
              <DateField label="截止时间" value={dueDate} onChange={setDueDate} />
              <label className="task-today-toggle"><input type="checkbox" checked={planOnSave} onChange={(event) => setPlanOnSave(event.target.checked)} /><span><strong>安排到今天</strong><small>不会启动计时，也可以随时撤销</small></span></label>
              <footer><button type="button" onClick={() => setShowComposer(false)}>取消</button><button className="primary" disabled={!title.trim() || !projectId}>保存行动</button></footer>
            </form>
          </aside>
        </div>
      )}
    </div>
  );
}

export function ArchivePage({ projects, tasks, focusSessions, onOpenProject, onRestoreTask }: {
  projects: ProjectSummary[];
  tasks: WorkspaceTask[];
  focusSessions: FocusSession[];
  onOpenProject: (projectId: string) => void;
  onRestoreTask: (task: WorkspaceTask) => void;
}) {
  const [view, setView] = useState<"projects" | "actions">("projects");
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase("zh-CN");
  const completedProjects = projects
    .filter((project) => project.status === "completed")
    .filter((project) => !needle || `${project.title} ${project.outcome} ${project.motivation}`.toLocaleLowerCase("zh-CN").includes(needle))
    .sort((left, right) => (right.completedAt || right.updatedAt).localeCompare(left.completedAt || left.updatedAt));
  const completedTasks = tasks
    .filter((task) => task.status === "done")
    .filter((task) => !needle || `${task.title} ${task.projectTitle} ${task.stageTitle} ${task.details}`.toLocaleLowerCase("zh-CN").includes(needle))
    .sort((left, right) => (right.completedAt || right.updatedAt).localeCompare(left.completedAt || left.updatedAt));

  return <div className="archive-page workspace-scroll">
    <header className="workspace-page-heading"><div><h1>归档</h1><p>已经完成的项目与行动从日常工作区退场，在这里保留结果和投入记录。</p></div><SearchField label="搜索归档" value={query} onChange={setQuery} placeholder="搜索项目或行动" /></header>
    <nav className="archive-tabs" aria-label="归档类型"><button className={view === "projects" ? "active" : ""} onClick={() => setView("projects")}>已完成项目 <span>{projects.filter((item) => item.status === "completed").length}</span></button><button className={view === "actions" ? "active" : ""} onClick={() => setView("actions")}>已完成行动 <span>{tasks.filter((item) => item.status === "done").length}</span></button></nav>
    {view === "projects" ? <section className="archive-project-grid">{completedProjects.map((project) => <article key={project.id}><header><span>{project.parentProjectId ? "已完成支线" : "已完成项目"}</span><time>{formatArchiveDate(project.completedAt || project.updatedAt)}</time></header><h2>{project.title}</h2><p>{project.outcome}</p><div><span><strong>{project.completedMilestoneCount}</strong>/{project.milestoneCount || 0} 阶段</span><span><strong>{project.completedTaskCount}</strong> 项行动</span></div><button onClick={() => onOpenProject(project.id)}>查看档案或重新开启 →</button></article>)}{!completedProjects.length && <EmptyState title={query ? "没有找到匹配项目" : "还没有已完成项目"} body="项目完结后会自动出现在这里，并保留全部阶段、行动和记录。" />}</section>
      : <section className="archive-action-list">{completedTasks.map((task) => { const focusSeconds = focusSessions.filter((session) => session.taskId === task.id && session.endedAt).reduce((sum, session) => sum + session.durationSeconds, 0); return <article key={task.id}><div><span>{task.projectTitle}{task.stageTitle ? ` · ${task.stageTitle}` : ""}</span><h2>{actionDisplayTitle(task)}</h2><p>{task.details || "没有补充具体做法。"}</p></div><aside><time>{formatArchiveDate(task.completedAt || task.updatedAt)}</time>{focusSeconds > 0 && <small>累计投入 {formatFocusDuration(focusSeconds)}</small>}<button onClick={() => onRestoreTask(task)}>恢复行动</button></aside></article>; })}{!completedTasks.length && <EmptyState title={query ? "没有找到匹配行动" : "还没有已完成行动"} body="完成行动后，它会离开今日行动并自动进入这里。" />}</section>}
  </div>;
}

export function ExplorePage({ articles, projects, projectDetails, onSaveLink, onArchive, onDelete, onOpenArticle, onOpenProject, onOrganize }: {
  articles: StoredArticle[];
  projects: ProjectSummary[];
  projectDetails: ProjectDetail[];
  onSaveLink: (url: string, note: string) => Promise<boolean>;
  onArchive: (article: StoredArticle, archived: boolean) => Promise<void>;
  onDelete: (article: StoredArticle) => Promise<void>;
  onOpenArticle: (article: StoredArticle) => void;
  onOpenProject: (projectId: string) => void;
  onOrganize: (article: StoredArticle, input: SourceOrganizationInput) => Promise<boolean>;
}) {
  const [capture, setCapture] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [view, setView] = useState<"pending" | "organized">("pending");
  const [organizing, setOrganizing] = useState<StoredArticle | null>(null);
  const sources = articles.filter(isSourceArticle);
  const savedSources = sources.filter((article) => article.branch !== "已归档");
  const archivedSources = sources.filter((article) => article.branch === "已归档");
  const pendingSources = savedSources.filter((article) => article.stage !== "已整理" && captureRelations(article).length === 0);
  const organizedSources = savedSources.filter((article) => article.stage === "已整理" || captureRelations(article).length > 0);
  const visibleSources = view === "pending" ? pendingSources : organizedSources;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const url = extractFirstUrl(capture);
    if (!url) {
      setError("没有识别到有效链接，请检查粘贴内容。");
      return;
    }
    const saved = await onSaveLink(url, note.trim());
    if (!saved) return;
    setCapture("");
    setNote("");
    setError("");
  }

  return (
    <div className="explore-page workspace-scroll">
      <header className="workspace-page-heading"><div><h1>探索库</h1><p>保存感兴趣的内容；当它与当前行动相关或沉寂较久时，首页会重新提醒你。</p></div></header>
      <form className="link-capture-card" onSubmit={submit}>
        <div><span>添加收藏</span><strong>支持直接粘贴分享文案或链接</strong></div>
        <input value={capture} onChange={(event) => { setCapture(event.target.value); setError(""); }} placeholder="粘贴 B站、抖音、文章链接或整段分享文案" />
        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="为什么收藏它？可选，能帮助以后重新发现" />
        <button disabled={!capture.trim()}>收藏</button>
        {error && <p className="capture-error">{error}</p>}
      </form>
      <section className="source-inbox source-workbench">
        <header className="source-workbench-heading"><div><span>我的收藏</span><strong>{savedSources.length} 条</strong></div><nav><button className={view === "pending" ? "active" : ""} onClick={() => setView("pending")}>待整理 <i>{pendingSources.length}</i></button><button className={view === "organized" ? "active" : ""} onClick={() => setView("organized")}>已整理 <i>{organizedSources.length}</i></button></nav></header>
        <div>{visibleSources.length ? visibleSources.map((article) => <SourceItem key={article.id} article={article} articles={articles} projectDetails={projectDetails} onArchive={onArchive} onDelete={onDelete} onOrganize={setOrganizing} onOpenArticle={onOpenArticle} onOpenProject={onOpenProject} />) : <EmptyState title={savedSources.length ? (view === "pending" ? "收藏都已经整理好了" : "还没有整理结果") : "探索库还是空的"} body={savedSources.length ? (view === "pending" ? "新的主动收藏会先出现在这里。" : "把一条资料整理成笔记、行动或提案后，会保留在这里。") : "下一次遇到真正想留下的内容时，从娱乐窗口主动收集即可。"} />}</div>
      </section>
      {archivedSources.length > 0 && <details className="source-archive"><summary>已归档 · {archivedSources.length}</summary><div>{archivedSources.map((article) => <SourceItem key={article.id} article={article} articles={articles} projectDetails={projectDetails} archived onArchive={onArchive} onDelete={onDelete} onOrganize={setOrganizing} onOpenArticle={onOpenArticle} onOpenProject={onOpenProject} />)}</div></details>}
      {organizing && <SourceOrganizerDrawer article={organizing} projects={projects} projectDetails={projectDetails} onClose={() => setOrganizing(null)} onSubmit={async (input) => { const saved = await onOrganize(organizing, input); if (saved) setOrganizing(null); }} />}
    </div>
  );
}

function SourceItem({ article, articles, projectDetails, archived = false, onArchive, onDelete, onOrganize, onOpenArticle, onOpenProject }: {
  article: StoredArticle;
  articles: StoredArticle[];
  projectDetails: ProjectDetail[];
  archived?: boolean;
  onArchive: (article: StoredArticle, archived: boolean) => Promise<void>;
  onDelete: (article: StoredArticle) => Promise<void>;
  onOrganize: (article: StoredArticle) => void;
  onOpenArticle: (article: StoredArticle) => void;
  onOpenProject: (projectId: string) => void;
}) {
  const url = sourceUrl(article);
  const metadata = captureMetadata(article);
  const relations = captureRelations(article);
  const playback = formatPlaybackTime(metadata?.playbackSeconds);
  const brand = metadata?.provider === "bilibili" ? "bilibili" : metadata?.provider === "douyin" ? "tiktok" : null;
  return <article className="source-item">
    <div className="source-item-main">{brand && <i className={`source-brand ${metadata?.provider}`}><BrandLogo brand={brand} /></i>}<span><small>{article.source[0] || "外部资料"}{metadata?.author ? ` · ${metadata.author}` : ""} · {formatRelativeDate(metadata?.capturedAt || article.created)}</small><strong>{article.title}</strong><p>{article.summary || plainExcerpt(article.body)}</p><em>{playback && <b>视频 {playback}</b>}{relations.length > 0 && <b className="organized">已整理 · {relations.length} 项</b>}</em></span></div>
    {relations.length > 0 && <div className="source-relation-list">{relations.map((relation, index) => <SourceRelationButton key={`${relation.kind}-${relation.id}-${index}`} relation={relation} articles={articles} projectDetails={projectDetails} onOpenArticle={onOpenArticle} onOpenProject={onOpenProject} />)}</div>}
    <div className="source-item-actions">
      {url && <button className="primary" onClick={() => void openSourceUrl(url)}>打开原内容 ↗</button>}
      {!archived && <button onClick={() => onOrganize(article)}>整理</button>}
      <button onClick={() => void onArchive(article, !archived)}>{archived ? "恢复" : "归档"}</button>
      <button className="danger" onClick={() => void onDelete(article)}>删除</button>
    </div>
  </article>;
}

function SourceRelationButton({ relation, articles, projectDetails, onOpenArticle, onOpenProject }: {
  relation: CaptureRelation;
  articles: StoredArticle[];
  projectDetails: ProjectDetail[];
  onOpenArticle: (article: StoredArticle) => void;
  onOpenProject: (projectId: string) => void;
}) {
  if (relation.kind === "note") {
    const note = articles.find((article) => article.id === relation.id);
    return <button disabled={!note} onClick={() => note && onOpenArticle(note)}><span>笔记</span><strong>{note?.title || "关联笔记已删除"}</strong></button>;
  }
  const project = projectDetails.find((detail) => relation.kind === "task"
    ? detail.tasks.some((task) => task.id === relation.id)
    : detail.proposals.some((proposal) => proposal.id === relation.id));
  const item = relation.kind === "task"
    ? project?.tasks.find((task) => task.id === relation.id)
    : project?.proposals.find((proposal) => proposal.id === relation.id);
  return <button disabled={!project} onClick={() => project && onOpenProject(project.project.id)}><span>{relation.kind === "task" ? "行动" : "提案"}</span><strong>{item?.title || `关联${relation.kind === "task" ? "行动" : "提案"}已删除`}</strong></button>;
}

function SourceOrganizerDrawer({ article, projects, projectDetails, onClose, onSubmit }: {
  article: StoredArticle;
  projects: ProjectSummary[];
  projectDetails: ProjectDetail[];
  onClose: () => void;
  onSubmit: (input: SourceOrganizationInput) => Promise<void>;
}) {
  const [kind, setKind] = useState<SourceOrganizationInput["kind"]>("note");
  const [title, setTitle] = useState(article.title);
  const [body, setBody] = useState(article.summary || plainExcerpt(article.body));
  const [tags, setTags] = useState(article.tags.join("、"));
  const initialProject = projects.find((project) => project.status === "active")?.id || projects.find((project) => project.status !== "completed")?.id || "";
  const [projectId, setProjectId] = useState(initialProject);
  const [milestoneId, setMilestoneId] = useState(projectDetails.find((detail) => detail.project.id === initialProject)?.milestones.find((milestone) => milestone.status === "current")?.id || "");
  const [dueDate, setDueDate] = useState("");
  const [expectedValue, setExpectedValue] = useState("");
  const [cost, setCost] = useState("");
  const [saving, setSaving] = useState(false);
  const selectedProject = projectDetails.find((detail) => detail.project.id === projectId);

  function chooseProject(value: string) {
    setProjectId(value);
    setMilestoneId(projectDetails.find((detail) => detail.project.id === value)?.milestones.find((milestone) => milestone.status === "current")?.id || "");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !body.trim() || (kind !== "note" && !projectId) || saving) return;
    setSaving(true);
    try {
      if (kind === "note") await onSubmit({ kind, title: title.trim(), body: body.trim(), tags: tags.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) });
      else if (kind === "action") await onSubmit({ kind, projectId, milestoneId: milestoneId || null, title: title.trim(), details: body.trim(), dueDate });
      else await onSubmit({ kind, projectId, title: title.trim(), problem: body.trim(), expectedValue: expectedValue.trim(), cost: cost.trim() });
    } finally {
      setSaving(false);
    }
  }

  return <div className="task-drawer-backdrop source-organizer-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><aside className="task-drawer source-organizer-drawer" role="dialog" aria-modal="true" aria-label="整理探索资料"><header><div><span>整理探索资料</span><h2>{article.title}</h2><p>原内容会继续留在探索库，并与整理结果保持关联。</p></div><button onClick={onClose} aria-label="关闭">×</button></header><nav><button type="button" className={kind === "note" ? "active" : ""} onClick={() => setKind("note")}>转为笔记</button><button type="button" className={kind === "action" ? "active" : ""} onClick={() => setKind("action")}>转为行动</button><button type="button" className={kind === "proposal" ? "active" : ""} onClick={() => setKind("proposal")}>转为提案</button></nav><form onSubmit={submit}><label><span>标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label><span>{kind === "note" ? "笔记内容" : kind === "action" ? "具体做法" : "需要判断的问题"}</span><textarea value={body} onChange={(event) => setBody(event.target.value)} /></label>{kind === "note" ? <label><span>标签</span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="多个标签用顿号隔开" /></label> : <><label><span>所属项目</span><SelectMenu label="所属项目" value={projectId} onChange={chooseProject} options={[{ value: "", label: "选择项目" }, ...projects.filter((project) => project.status !== "completed").map((project) => ({ value: project.id, label: project.title }))]} /></label>{kind === "action" ? <><label><span>所属阶段</span><SelectMenu label="所属阶段" value={milestoneId} onChange={setMilestoneId} options={[{ value: "", label: "暂不关联" }, ...(selectedProject?.milestones ?? []).map((milestone) => ({ value: milestone.id, label: milestone.title }))]} /></label><DateField label="截止时间" value={dueDate} onChange={setDueDate} /></> : <><label><span>预期价值</span><textarea value={expectedValue} onChange={(event) => setExpectedValue(event.target.value)} placeholder="如果值得做，可能带来什么？" /></label><label><span>成本与顾虑</span><textarea value={cost} onChange={(event) => setCost(event.target.value)} placeholder="需要投入什么，可能遇到什么问题？" /></label></>}</>}<footer><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={saving || !title.trim() || !body.trim() || (kind !== "note" && !projectId)}>{saving ? "正在保存…" : kind === "note" ? "生成笔记" : kind === "action" ? "创建行动" : "创建提案"}</button></footer></form></aside></div>;
}

export function InboxPage({ articles, projects, onOpenArticle, onNewCapture, onMoveArticle, onConvertToAction, onConvertToProposal, onDelete }: {
  articles: StoredArticle[];
  projects: ProjectSummary[];
  onOpenArticle: (article: StoredArticle) => void;
  onNewCapture: () => void;
  onMoveArticle: (article: StoredArticle, destination: "note" | "explore") => Promise<void>;
  onConvertToAction: (article: StoredArticle, projectId: string) => Promise<void>;
  onConvertToProposal: (article: StoredArticle, projectId: string) => Promise<void>;
  onDelete: (article: StoredArticle) => Promise<void>;
}) {
  const thoughts = articles.filter(isThoughtInboxArticle);
  return (
    <div className="inbox-page workspace-scroll">
      <header className="workspace-page-heading">
        <div><h1>待整理</h1><p>这是临时入口，不需要当场分类；处理后它就会离开这里。</p></div>
        <button onClick={onNewCapture}>＋ 随手记一条</button>
      </header>
      <div className="inbox-groups">
        <InboxGroup title="零散想法" items={thoughts} projects={projects} empty="目前没有待整理的想法。" onOpenArticle={onOpenArticle} onMoveArticle={onMoveArticle} onConvertToAction={onConvertToAction} onConvertToProposal={onConvertToProposal} onDelete={onDelete} />
      </div>
    </div>
  );
}

function InboxGroup({ title, items, projects, empty, onOpenArticle, onMoveArticle, onConvertToAction, onConvertToProposal, onDelete }: {
  title: string;
  items: StoredArticle[];
  projects: ProjectSummary[];
  empty: string;
  onOpenArticle: (article: StoredArticle) => void;
  onMoveArticle: (article: StoredArticle, destination: "note" | "explore") => Promise<void>;
  onConvertToAction: (article: StoredArticle, projectId: string) => Promise<void>;
  onConvertToProposal: (article: StoredArticle, projectId: string) => Promise<void>;
  onDelete: (article: StoredArticle) => Promise<void>;
}) {
  return <section className="workspace-card inbox-group"><CardHeader title={title} subtitle={`${items.length} 条`} />{items.length ? <div>{items.map((article) => <InboxItem key={article.id} article={article} projects={projects} onOpenArticle={onOpenArticle} onMoveArticle={onMoveArticle} onConvertToAction={onConvertToAction} onConvertToProposal={onConvertToProposal} onDelete={onDelete} />)}</div> : <p className="compact-empty">{empty}</p>}</section>;
}

function InboxItem({ article, projects, onOpenArticle, onMoveArticle, onConvertToAction, onConvertToProposal, onDelete }: {
  article: StoredArticle;
  projects: ProjectSummary[];
  onOpenArticle: (article: StoredArticle) => void;
  onMoveArticle: (article: StoredArticle, destination: "note" | "explore") => Promise<void>;
  onConvertToAction: (article: StoredArticle, projectId: string) => Promise<void>;
  onConvertToProposal: (article: StoredArticle, projectId: string) => Promise<void>;
  onDelete: (article: StoredArticle) => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(projects.find((project) => project.status === "active")?.id ?? "");
  const [organizingProject, setOrganizingProject] = useState(false);
  const quickCapture = article.source.includes("快速记录");
  const preview = article.summary || plainExcerpt(article.body);
  return <article className="inbox-item">
    <button className="inbox-item-main" onClick={() => onOpenArticle(article)}><i>{sourceMark(article)}</i><span className="inbox-item-copy"><strong>{quickCapture ? preview : article.title}</strong>{!quickCapture && preview && preview !== article.title && <p>{preview}</p>}<small>{article.source[0] || article.type} · {formatRelativeDate(article.updated || article.created)}</small></span><em>查看详情 →</em></button>
    <div className="inbox-item-actions"><button onClick={() => void onMoveArticle(article, "note")}>整理为笔记</button><button onClick={() => void onMoveArticle(article, "explore")}>放入探索库</button><button className={organizingProject ? "active" : ""} onClick={() => setOrganizingProject((value) => !value)}>纳入项目{organizingProject ? " ↑" : "…"}</button><button className="danger" aria-label={`删除 ${article.title}`} onClick={() => void onDelete(article)}>删除</button></div>
    {organizingProject && <section className="inbox-project-panel"><div><strong>把它放进哪个项目？</strong><p>转为行动适合已经明确要做的事；转为提案适合还需要判断价值和成本的想法。</p></div><SelectMenu label="选择项目" value={projectId} onChange={setProjectId} options={[{ value: "", label: "选择项目" }, ...projects.filter((project) => project.status !== "completed").map((project) => ({ value: project.id, label: project.title }))]} /><footer><button disabled={!projectId} onClick={() => void onConvertToAction(article, projectId)}>转为行动</button><button disabled={!projectId} onClick={() => void onConvertToProposal(article, projectId)}>转为提案</button></footer></section>}
  </article>;
}

export function ReviewPage({ projects, projectDetails, articles, tasks, weeklyFocus, closeouts, today, onSaveCloseout }: {
  projects: ProjectSummary[];
  projectDetails: ProjectDetail[];
  articles: StoredArticle[];
  tasks: WorkspaceTask[];
  weeklyFocus: WeeklyFocus | null;
  closeouts: DailyCloseout[];
  today: string;
  onSaveCloseout: (result: string, lesson: string, tomorrow: string) => Promise<void>;
}) {
  const currentCloseout = closeouts.find((item) => item.date === today);
  const [result, setResult] = useState(currentCloseout?.result ?? "");
  const [lesson, setLesson] = useState(currentCloseout?.lesson ?? "");
  const [tomorrow, setTomorrow] = useState(currentCloseout?.tomorrow ?? "");
  useEffect(() => {
    setResult(currentCloseout?.result ?? "");
    setLesson(currentCloseout?.lesson ?? "");
    setTomorrow(currentCloseout?.tomorrow ?? "");
  }, [currentCloseout]);
  const weekStart = startOfLocalWeek();
  const weekArticles = articles.filter((article) => !isSourceArticle(article) && !isThoughtInboxArticle(article) && (article.updated || article.created) >= weekStart.slice(0, 10));
  const weekCompleted = tasks.filter((task) => task.completedAt && task.completedAt >= weekStart);
  const continuationRecords = projectDetails.flatMap((detail) => detail.logs.flatMap((log) => {
    const continuation = decodeContinuationLog(log.body);
    if (!continuation || log.createdAt < weekStart) return [];
    return [{ id: log.id, projectId: detail.project.id, projectTitle: detail.project.title, title: continuation.text, detail: continuation.label, kind: "接续记录" }];
  }));
  const weekProgress = [
    ...weekCompleted.map((task) => ({ id: task.id, projectId: task.projectId, projectTitle: task.projectTitle, title: actionDisplayTitle(task), detail: task.stageTitle || "未关联阶段", kind: "完成" })),
    ...continuationRecords,
  ];
  const progressGroups = [...weekProgress.reduce((groups, item) => {
    const group = groups.get(item.projectId) ?? { projectId: item.projectId, projectTitle: item.projectTitle, items: [] as typeof weekProgress };
    group.items.push(item);
    groups.set(item.projectId, group);
    return groups;
  }, new Map<string, { projectId: string; projectTitle: string; items: typeof weekProgress }>()).values()];
  const completedStages = projects.reduce((sum, project) => sum + project.completedMilestoneCount, 0);
  return (
    <div className="review-page workspace-scroll">
      <header className="workspace-page-heading"><div><h1>本周回顾</h1><p>{weeklyFocus?.primaryOutcome ? `本周主结果：${weeklyFocus.primaryOutcome}` : "查看留下了什么结果、判断与经验，而不是用计时证明自己很忙。"}</p></div></header>
      <div className="review-metrics"><article><span>本周完成行动</span><strong>{weekCompleted.length}</strong><small>项行动在本周完成</small></article><article><span>全部累计阶段</span><strong>{completedStages}</strong><small>个项目阶段已经走过</small></article><article><span>本周更新笔记</span><strong>{weekArticles.length}</strong><small>条笔记或资料有更新</small></article></div>
      <div className="review-grid">
        <section className="workspace-card review-project-time"><CardHeader title="项目进展" subtitle={weekProgress.length ? `${progressGroups.length} 个项目 · ${weekProgress.length} 条记录` : "完成与接续记录"} />{progressGroups.length ? <div className="review-project-groups">{progressGroups.map((group) => <article className="review-project-group" key={group.projectId}><header><strong>{group.projectTitle}</strong><span>{group.items.length} 条</span></header><div>{group.items.map((item) => <div className="review-progress-row" key={item.id}><i>{item.kind}</i><span><strong>{item.title}</strong><small>{item.detail}</small></span></div>)}</div></article>)}</div> : <div className="review-compact-empty"><strong>本周还没有项目进展</strong><p>完成行动或写下“今天做到哪里”，这里就会按项目归拢。</p></div>}</section>
        <section className="workspace-card review-growth"><CardHeader title="本周留下了什么" subtitle="最近更新的经验、思考和资料" />{weekArticles.slice(0, 6).map((article) => <p key={article.id}><span>{natureLabel(article)}</span><strong>{article.title}</strong><small>{formatRelativeDate(article.updated || article.created)}</small></p>)}{!weekArticles.length && <EmptyState title="还没有新的沉淀" body="完成工作后留一句发现，也是一种可见的成长。" />}</section>
      </div>
      <form className="workspace-card daily-closeout-card" onSubmit={async (event) => { event.preventDefault(); await onSaveCloseout(result, lesson, tomorrow); }}>
        <CardHeader title="今日收尾" subtitle={currentCloseout ? "今天的记录可以继续修改" : "用三句话为明天留下起点"} />
        <label><span>今天真正留下了什么结果？</span><textarea value={result} onChange={(event) => setResult(event.target.value)} /></label>
        <label><span>有什么判断或经验值得带走？</span><textarea value={lesson} onChange={(event) => setLesson(event.target.value)} /></label>
        <label><span>明天从哪里继续？</span><textarea value={tomorrow} onChange={(event) => setTomorrow(event.target.value)} /></label>
        <button disabled={!result.trim() && !lesson.trim() && !tomorrow.trim()}>保存今日收尾</button>
      </form>
    </div>
  );
}

function ActionRow({ task, today, now, onOpenProject, onRemoveTask, onCompleteTask, onRemoveFromToday, onStartFocus, onStopFocus, activeSession, focusSessions }: { task: WorkspaceTask; today: string; now: number; onOpenProject: (projectId: string) => void; onRemoveTask: (task: WorkspaceTask) => void } & TaskActions) {
  const plannedToday = task.plan?.plannedDate === today;
  const title = actionDisplayTitle(task);
  const urgency = actionDueDate(task) ? classifyDeadlineUrgency(actionDueDate(task), today) : null;
  const isActive = activeSession?.taskId === task.id;
  const focusSeconds = taskFocusSeconds(task.id, focusSessions, today, activeSession, now);
  return (
    <article className={`workspace-task action-row ${plannedToday ? "is-today" : ""} ${isActive ? "is-focusing" : ""}`}>
      <div className="action-row-main">
        <header><button className="action-context" onClick={() => onOpenProject(task.projectId)}>{task.projectTitle} <i>›</i></button><span>阶段 {task.stageIndex}/{task.stageCount}</span>{plannedToday && <b>已安排到今天</b>}</header>
        <h2>{title}</h2>
        {task.stageTitle && title !== task.stageTitle && <p className="action-stage-title">当前阶段：{task.stageTitle}</p>}
        <div className="action-row-meta"><span className={`${actionDueDate(task) ? "has-due" : ""} ${urgency?.tone ?? ""}`}>{urgency?.label ?? (actionDueDate(task) ? formatDueDate(actionDueDate(task)) : "无硬性截止")}</span><StageProgress task={task} compact /></div>
      </div>
      {focusSeconds > 0 && <div className={`action-focus-readout ${isActive ? "active" : ""}`}><span>{isActive ? "正在投入" : "今天已投入"}</span><strong>{formatFocusDuration(focusSeconds, true)}</strong></div>}
      <details className="action-disclosure"><summary>展开具体做法</summary><div><p>{task.details || "还没有补充具体做法。"}</p>{task.waitingFor && <p><strong>正在等待</strong>{task.waitingFor}</p>}</div></details>
      <footer className="action-row-actions"><button onClick={() => onCompleteTask(task)}>✓ 完成</button>{isActive ? <button className="focus-pause" onClick={onStopFocus}>Ⅱ 暂停投入</button> : !activeSession && <button className="focus-start" onClick={() => onStartFocus(task)}>▷ 开始投入</button>}<button onClick={() => onRemoveFromToday(task)}>移出今天</button><details className="action-more"><summary aria-label="更多操作">⋯</summary><button className="danger" onClick={() => onRemoveTask(task)}>删除行动</button></details></footer>
    </article>
  );
}

function StageProgress({ task, compact = false }: { task: WorkspaceTask; compact?: boolean }) {
  const total = Math.max(task.stageTaskCount, 1);
  const ratio = Math.min(100, Math.round(task.stageCompletedTasks / total * 100));
  return <div className={`stage-progress ${compact ? "compact" : ""}`}><i><b style={{ width: `${ratio}%` }} /></i><span>{task.stageCompletedTasks}/{task.stageTaskCount || 0} 个阶段行动完成</span></div>;
}

function CardHeader({ title, subtitle, action, onAction }: { title: string; subtitle: string; action?: string; onAction?: () => void }) { return <header className="card-header"><div><strong>{title}</strong><span>{subtitle}</span></div>{action && <button onClick={onAction}>{action} →</button>}</header>; }
function EmptyState({ title, body }: { title: string; body: string }) { return <div className="workspace-empty"><strong>{title}</strong><p>{body}</p></div>; }
async function openSourceUrl(url: string) {
  if (!isTauri()) { window.open(url, "_blank", "noopener,noreferrer"); return; }
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "bilibili.com" || host.endsWith(".bilibili.com") || host === "b23.tv" || host.endsWith(".b23.tv") || host === "douyin.com" || host.endsWith(".douyin.com") || host === "bytedance.com" || host.endsWith(".bytedance.com")) {
      await invoke("entertainment_open", { url });
      return;
    }
  } catch { /* 交给系统打开器显示原有错误。 */ }
  await openUrl(url);
}
function taskRank(task: WorkspaceTask, today: string) { const todayRank = task.plan?.plannedDate === today ? 0 : task.status === "next" ? 4 : 10; const dueDifference = actionDueDate(task) ? calendarDayDifference(actionDueDate(task), today) : null; const dueRank = dueDifference === null ? 30 : Math.max(0, dueDifference); return todayRank + dueRank / 100 + task.sortOrder / 1000; }
function deadlineDifference(task: WorkspaceTask, today: string) { const due = actionDueDate(task); return due ? calendarDayDifference(due, today) : null; }
function isDueSoon(task: WorkspaceTask, today: string) { const difference = deadlineDifference(task, today); return difference !== null && difference >= 0 && difference <= 2; }
function isTaskOverdue(task: WorkspaceTask, today: string) { const deadline = deadlineDifference(task, today); return Boolean(task.plan?.plannedDate && task.plan.plannedDate < today) || (deadline !== null && deadline < 0); }
function planningUrgency(task: WorkspaceTask, today: string) {
  if (isTaskOverdue(task, today)) return { tone: "overdue", label: "需要重新安排" };
  if (isDueSoon(task, today)) return { tone: "soon", label: deadlineLabel(task, today) };
  return actionDueDate(task) ? { tone: "quiet", label: deadlineLabel(task, today) } : null;
}
function planningRank(task: WorkspaceTask, today: string) { return isTaskOverdue(task, today) ? 0 : isDueSoon(task, today) ? 1 : 2; }
function actionDueDate(task: WorkspaceTask) { return task.dueDate || task.stageDueDate; }
function deadlineLabel(task: WorkspaceTask, today: string) { const due = actionDueDate(task); return due ? classifyDeadlineUrgency(due, today)?.label ?? formatDueDate(due) : ""; }
function formatDueDate(value: string) { return formatRelativeDueDate(value); }
function selectContextualEcho(articles: StoredArticle[], task: WorkspaceTask | null, today: string) {
  if (!task) return null;
  const source = `${task.projectTitle} ${task.stageTitle} ${task.title} ${task.benefit}`;
  const tokens = [...new Set(source.split(/[\s、，。；：/·（）()《》]+/).map((item) => item.trim()).filter((item) => item.length >= 2))];
  const scored = articles.filter((article) => article.collection !== "sources" && (article.updated || article.created).slice(0, 10) < today).map((article) => { const haystack = `${article.title} ${article.summary} ${article.body} ${article.project} ${article.tags.join(" ")}`; const matched = tokens.filter((token) => haystack.includes(token)); return { article, matched, score: matched.length + (article.project && source.includes(article.project) ? 3 : 0) }; }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  const best = scored[0];
  return best ? { article: best.article, reason: best.matched.length ? `与 ${best.matched.slice(0, 2).join("、")} 相关` : "与当前项目相关" } : null;
}
function greeting() { const hour = new Date().getHours(); if (hour < 6) return "夜深了"; if (hour < 11) return "早上好"; if (hour < 14) return "中午好"; if (hour < 18) return "下午好"; return "晚上好"; }
function formatLongDate(value: string) { return new Date(`${value}T12:00:00`).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" }); }
function formatDate(value: string) { return value ? value.slice(0, 10).replaceAll("-", ".") : "未记录日期"; }
function formatRelativeDate(value: string) { if (!value) return "未记录"; const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value); const diff = Math.floor((Date.now() - date.getTime()) / 86_400_000); if (diff <= 0) return "今天"; if (diff === 1) return "昨天"; if (diff < 7) return `${diff} 天前`; return formatDate(value); }
function formatArchiveDate(value: string) { return new Date(value).toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" }); }
export function formatFocusDuration(seconds: number, clock = false) {
  const normalized = Math.max(0, Math.floor(seconds));
  if (clock) {
    const hours = Math.floor(normalized / 3600);
    const minutes = Math.floor(normalized % 3600 / 60);
    const remaining = normalized % 60;
    return `${hours > 0 ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
  }
  if (normalized < 60) return `${Math.max(1, normalized)} 秒`;
  const totalMinutes = Math.max(1, Math.round(normalized / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours} 小时${minutes ? ` ${minutes} 分钟` : ""}` : `${minutes} 分钟`;
}
function useLiveNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) { setNow(Date.now()); return; }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
function localDateKey(value: string) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function taskFocusSeconds(taskId: string, sessions: FocusSession[], today: string, activeSession: FocusSession | null, now: number) {
  return sessions.filter((session) => session.taskId === taskId && localDateKey(session.startedAt) === today).reduce((sum, session) => {
    if (!session.endedAt && activeSession?.id === session.id) return sum + Math.max(0, Math.floor((now - new Date(session.startedAt).getTime()) / 1000));
    return sum + session.durationSeconds;
  }, 0);
}
function plainExcerpt(text: string) { return text.replace(/[#>*`\-\[\]()]/g, "").replace(/\s+/g, " ").trim().slice(0, 110); }
function startOfLocalWeek() { const date = new Date(); const day = date.getDay() || 7; date.setDate(date.getDate() - day + 1); date.setHours(0, 0, 0, 0); return date.toISOString(); }
const genericActionTitles = new Set(["阅读与判断", "写作修订", "真实使用与反馈", "验收与整理", "方案判断"]);
function actionDisplayTitle(task: WorkspaceTask) { return genericActionTitles.has(task.title.trim()) && task.stageTitle ? task.stageTitle : task.title; }
function decodeContinuationLog(body: string) { if (!body.startsWith("接续点｜")) return null; const [, , label = "当前推进", ...content] = body.split("｜"); const text = content.join("｜").trim(); return text ? { label, text } : null; }
function sourceMark(article: StoredArticle) { const source = article.source.join(" ").toLocaleLowerCase(); if (source.includes("bilibili") || source.includes("哔哩")) return <BrandLogo brand="bilibili" />; if (source.includes("douyin") || source.includes("抖音")) return <BrandLogo brand="tiktok" />; return article.type === "外部资料" ? "链" : "记"; }
function sourceUrl(article: StoredArticle) { return article.source.find((item) => /^https?:\/\//i.test(item)) || ""; }
function extractFirstUrl(value: string) { return value.match(/https?:\/\/[^\s<>'\"]+/i)?.[0]?.replace(/[，。！？、；：)）\]}]+$/, "") || ""; }
function natureLabel(article: StoredArticle) { const value = article.type.split(/[，,]/).find(Boolean)?.trim(); return value && value !== "记录" ? value : "笔记"; }

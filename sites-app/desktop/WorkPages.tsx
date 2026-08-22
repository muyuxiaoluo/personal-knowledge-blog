import { isTauri } from "@tauri-apps/api/core";
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
import { DateField, SelectMenu } from "./DesktopControls";
import { HomeIntegrationCards } from "./ToolCenter";

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

type TaskActions = {
  onCompleteTask: (task: WorkspaceTask) => void;
  onPlanToday: (task: WorkspaceTask) => void;
  onRemoveFromToday: (task: WorkspaceTask) => void;
  onStartFocus: (task: WorkspaceTask) => void;
  onStopFocus: () => void;
  activeSession: FocusSession | null;
};

export function HomeDashboard({
  today,
  tasks,
  articles,
  weeklyFocus,
  integrationRepository,
  onOpenTools,
  onSaveWeeklyFocus,
  onOpenArticle,
  onOpenProject,
  onOpenTasks,
  ...taskActions
}: {
  today: string;
  tasks: WorkspaceTask[];
  articles: StoredArticle[];
  weeklyFocus: WeeklyFocus | null;
  integrationRepository: IntegrationRepository;
  onOpenTools: () => void;
  onSaveWeeklyFocus: (primaryOutcome: string, secondaryOutcome: string) => Promise<void>;
  onOpenArticle: (article: StoredArticle) => void;
  onOpenProject: (projectId: string) => void;
  onOpenTasks: () => void;
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
            {primaryTask && <button onClick={() => onOpenProject(primaryTask.projectId)}>进入项目</button>}
          </header>
          {primaryTask ? (
            <div className="home-strategy-body">
              <div className="home-action-core">
                <p><span>阶段 {primaryTask.stageIndex}/{primaryTask.stageCount}</span><b>{primaryTask.stageTitle || "未关联阶段"}</b>{actionDueDate(primaryTask) && <time className={classifyDeadlineUrgency(actionDueDate(primaryTask), today)?.tone ?? ""}>{deadlineLabel(primaryTask, today)}</time>}</p>
                <h1>{actionDisplayTitle(primaryTask)}</h1>
                <StageProgress task={primaryTask} />
                <details className="action-disclosure">
                  <summary>准备开始时展开具体做法</summary>
                  <p>{primaryTask.details || "还没有补充具体做法。可以进入项目后编辑这条行动。"}</p>
                </details>
                <div className="home-strategy-actions">
                  <button className="primary" onClick={() => taskActions.onCompleteTask(primaryTask)}>✓ 记为完成</button>
                  {taskActions.activeSession?.taskId === primaryTask.id
                    ? <button onClick={taskActions.onStopFocus}>■ 结束投入</button>
                    : !taskActions.activeSession && <button onClick={() => taskActions.onStartFocus(primaryTask)}>▷ 开始投入</button>}
                  <button onClick={() => taskActions.onRemoveFromToday(primaryTask)}>取消今日安排</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="home-empty-today"><EmptyState title="今天还没有安排" body="挑选一项真正准备推进的行动，首页才会显示它。" /><button onClick={onOpenTasks}>安排今日行动 →</button></div>
          )}
        </section>

        <aside className="home-primary-side">
          <section className="workspace-card home-footprint">
            <CardHeader title="今天留下的结果" subtitle="" />
            <div><span><strong>{completedToday}</strong> 项行动完成</span><span><strong>{notesToday}</strong> 条笔记更新</span></div>
          </section>
          {alternatives.length > 0 && <section className="workspace-card home-alternatives">
            <CardHeader title="接下来" subtitle="今日已安排" />
            {alternatives.map((task) => (
              <button key={task.id} onClick={onOpenTasks}>
                <span><strong>{actionDisplayTitle(task)}</strong><small>{task.projectTitle} · {task.stageTitle || "未关联阶段"}</small></span>
                <em className={actionDueDate(task) ? classifyDeadlineUrgency(actionDueDate(task), today)?.tone ?? "" : ""}>{actionDueDate(task) ? deadlineLabel(task, today) : "稍后"}</em>
              </button>
            ))}
          </section>}
        </aside>
      </div>

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
          {sourceUrl(rediscovery.article) && <button onClick={() => void openExternalUrl(sourceUrl(rediscovery.article))}>重新打开 ↗</button>}
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
  onRestoreTask,
  onRemoveTask,
  onOpenProject,
  ...taskActions
}: {
  today: string;
  tasks: WorkspaceTask[];
  projects: ProjectSummary[];
  projectDetails: ProjectDetail[];
  onAddTask: (input: NewActionInput) => Promise<void>;
  onRestoreTask: (task: WorkspaceTask) => void;
  onRemoveTask: (task: WorkspaceTask) => void;
  onOpenProject: (projectId: string) => void;
} & TaskActions) {
  const [tab, setTab] = useState<"today" | "overdue" | "soon" | "candidate" | "waiting" | "done">("today");
  const [showComposer, setShowComposer] = useState(false);
  const initialProjectId = projects.find((item) => item.status === "active")?.id || "";
  const [projectId, setProjectId] = useState(initialProjectId);
  const [milestoneId, setMilestoneId] = useState("");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [planOnSave, setPlanOnSave] = useState(false);
  useEffect(() => {
    if (!showComposer) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowComposer(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [showComposer]);
  // 与“添加行动”下拉框保持一致：只要项目未完成（含支线、等待中、已暂停），其任务都可以被安排到今天。
  const available = tasks.filter((task) => task.status !== "done" && task.status !== "waiting" && task.projectStatus !== "completed").sort((a, b) => taskRank(a, today) - taskRank(b, today));
  const plannedToday = available.filter((task) => task.plan?.plannedDate === today);
  const overdue = available.filter((task) => task.plan?.plannedDate !== today && deadlineDifference(task, today) !== null && deadlineDifference(task, today)! < 0);
  const soon = available.filter((task) => task.plan?.plannedDate !== today && isDueSoon(task, today));
  const candidates = available.filter((task) => task.plan?.plannedDate !== today && !isDueSoon(task, today) && !overdue.some((item) => item.id === task.id));
  const waiting = tasks.filter((task) => task.status === "waiting");
  const done = tasks.filter((task) => task.status === "done");
  const visible = tab === "today" ? plannedToday : tab === "overdue" ? overdue : tab === "soon" ? soon : tab === "candidate" ? candidates : tab === "waiting" ? waiting : done;
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
        <div><h1>今日行动</h1><p>这里只负责今天做什么；目标、阶段和取舍留在项目中。</p></div>
        <button onClick={() => { chooseProject(projectId || initialProjectId); setShowComposer(true); }}>＋ 添加行动</button>
      </header>

      <nav className="task-tabs" aria-label="行动视图">
        <button className={tab === "today" ? "active" : ""} onClick={() => setTab("today")}>今天 <span>{plannedToday.length}</span></button>
        <button className={tab === "overdue" ? "active overdue" : ""} onClick={() => setTab("overdue")}>已逾期 <span>{overdue.length}</span></button>
        <button className={tab === "soon" ? "active" : ""} onClick={() => setTab("soon")}>临近截止 <span>{soon.length}</span></button>
        <button className={tab === "candidate" ? "active" : ""} onClick={() => setTab("candidate")}>候选 <span>{candidates.length}</span></button>
        <button className={tab === "waiting" ? "active" : ""} onClick={() => setTab("waiting")}>等待反馈 <span>{waiting.length}</span></button>
        <button className={tab === "done" ? "active" : ""} onClick={() => setTab("done")}>已完成 <span>{done.length}</span></button>
      </nav>

      <section className="task-list-shell action-list-shell">
        <header><div><strong>{tab === "today" ? "今天已经选择" : tab === "overdue" ? "需要立即处理或调整日期" : tab === "soon" ? "未来两天需要留意" : tab === "candidate" ? "从项目阶段中挑选" : tab === "waiting" ? "暂时不用盯着" : "已经留下的结果"}</strong></div></header>
        <div className="task-list-large">
          {visible.length ? visible.map((task) => (
            <ActionRow
              key={task.id}
              task={task}
              today={today}
              done={tab === "done"}
              onOpenProject={onOpenProject}
              onRestoreTask={onRestoreTask}
              onRemoveTask={onRemoveTask}
              {...taskActions}
            />
          )) : <EmptyState title={tab === "done" ? "还没有已完成行动" : "这个视图暂时是空的"} body="行动会归属到项目阶段，而不是孤零零地堆在这里。" />}
        </div>
      </section>

      {showComposer && (
        <div className="task-drawer-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setShowComposer(false); }}>
          <aside className="task-drawer action-drawer" role="dialog" aria-modal="true" aria-label="添加行动">
            <header><div><span>新的行动</span><h2>添加阶段行动</h2></div><button onClick={() => setShowComposer(false)} aria-label="关闭">×</button></header>
            <form onSubmit={submit}>
              <label><span>所属项目</span><SelectMenu label="所属项目" value={projectId} onChange={chooseProject} options={[{ value: "", label: "选择项目" }, ...projects.filter((project) => project.status !== "completed").map((project) => ({ value: project.id, label: project.title }))]} /></label>
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

export function ExplorePage({ articles, onSaveLink, onArchive, onDelete }: {
  articles: StoredArticle[];
  onSaveLink: (url: string, note: string) => Promise<boolean>;
  onArchive: (article: StoredArticle, archived: boolean) => Promise<void>;
  onDelete: (article: StoredArticle) => Promise<void>;
}) {
  const [capture, setCapture] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const sources = articles.filter(isSourceArticle);
  const savedSources = sources.filter((article) => article.branch !== "已归档");
  const archivedSources = sources.filter((article) => article.branch === "已归档");

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
        <CardHeader title="我的收藏" subtitle={`${savedSources.length} 条`} />
        <div>{savedSources.length ? savedSources.map((article) => <SourceItem key={article.id} article={article} onArchive={onArchive} onDelete={onDelete} />) : <EmptyState title="探索库还是空的" body="下一次遇到感兴趣的内容时，先收藏下来，首页会在合适的时机帮你重新发现。" />}</div>
      </section>
      {archivedSources.length > 0 && <details className="source-archive"><summary>已归档 · {archivedSources.length}</summary><div>{archivedSources.map((article) => <SourceItem key={article.id} article={article} archived onArchive={onArchive} onDelete={onDelete} />)}</div></details>}
    </div>
  );
}

function SourceItem({ article, archived = false, onArchive, onDelete }: {
  article: StoredArticle;
  archived?: boolean;
  onArchive: (article: StoredArticle, archived: boolean) => Promise<void>;
  onDelete: (article: StoredArticle) => Promise<void>;
}) {
  const url = sourceUrl(article);
  return <article className="source-item">
    <div className="source-item-main"><span><small>{article.source[0] || "外部资料"} · {formatRelativeDate(article.created)}</small><strong>{article.title}</strong><p>{article.summary || plainExcerpt(article.body)}</p>{url && <code title={url}>{url}</code>}</span></div>
    <div className="source-item-actions">
      {url && <button className="primary" onClick={() => void openExternalUrl(url)}>打开原链接 ↗</button>}
      <button onClick={() => void onArchive(article, !archived)}>{archived ? "恢复" : "归档"}</button>
      <button className="danger" onClick={() => void onDelete(article)}>删除</button>
    </div>
  </article>;
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

function ActionRow({ task, today, done, onOpenProject, onRestoreTask, onRemoveTask, onCompleteTask, onPlanToday, onRemoveFromToday, onStartFocus, onStopFocus, activeSession }: { task: WorkspaceTask; today: string; done: boolean; onOpenProject: (projectId: string) => void; onRestoreTask: (task: WorkspaceTask) => void; onRemoveTask: (task: WorkspaceTask) => void } & TaskActions) {
  const plannedToday = task.plan?.plannedDate === today;
  const title = actionDisplayTitle(task);
  const urgency = actionDueDate(task) ? classifyDeadlineUrgency(actionDueDate(task), today) : null;
  return (
    <article className={`workspace-task action-row ${plannedToday ? "is-today" : ""} ${done ? "is-done" : ""}`}>
      <div className="action-row-main">
        <header><button className="action-context" onClick={() => onOpenProject(task.projectId)}>{task.projectTitle} <i>›</i></button><span>阶段 {task.stageIndex}/{task.stageCount}</span>{plannedToday && <b>已安排到今天</b>}</header>
        <h2>{title}</h2>
        {task.stageTitle && title !== task.stageTitle && <p className="action-stage-title">当前阶段：{task.stageTitle}</p>}
        <div className="action-row-meta"><span className={`${actionDueDate(task) ? "has-due" : ""} ${urgency?.tone ?? ""}`}>{urgency?.label ?? (actionDueDate(task) ? formatDueDate(actionDueDate(task)) : "无硬性截止")}</span><StageProgress task={task} compact /></div>
        <details className="action-disclosure"><summary>展开具体做法</summary><div><p>{task.details || "还没有补充具体做法。"}</p>{task.waitingFor && <p><strong>正在等待</strong>{task.waitingFor}</p>}</div></details>
      </div>
      <div className="action-row-actions">{done ? <button onClick={() => onRestoreTask(task)}>恢复</button> : <><button onClick={() => onCompleteTask(task)}>✓ 完成</button>{activeSession?.taskId === task.id ? <button onClick={onStopFocus}>■ 结束投入</button> : !activeSession && <button onClick={() => onStartFocus(task)}>▷ 开始投入</button>}{plannedToday ? <button onClick={() => onRemoveFromToday(task)}>取消今日安排</button> : <button onClick={() => onPlanToday(task)}>安排到今天</button>}<button className="danger" onClick={() => onRemoveTask(task)}>删除</button></>}</div>
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
async function openExternalUrl(url: string) { if (isTauri()) { await openUrl(url); return; } window.open(url, "_blank", "noopener,noreferrer"); }
function taskRank(task: WorkspaceTask, today: string) { const todayRank = task.plan?.plannedDate === today ? 0 : task.status === "next" ? 4 : 10; const dueDifference = actionDueDate(task) ? calendarDayDifference(actionDueDate(task), today) : null; const dueRank = dueDifference === null ? 30 : Math.max(0, dueDifference); return todayRank + dueRank / 100 + task.sortOrder / 1000; }
function deadlineDifference(task: WorkspaceTask, today: string) { const due = actionDueDate(task); return due ? calendarDayDifference(due, today) : null; }
function isDueSoon(task: WorkspaceTask, today: string) { const difference = deadlineDifference(task, today); return difference !== null && difference >= 0 && difference <= 2; }
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
function plainExcerpt(text: string) { return text.replace(/[#>*`\-\[\]()]/g, "").replace(/\s+/g, " ").trim().slice(0, 110); }
function startOfLocalWeek() { const date = new Date(); const day = date.getDay() || 7; date.setDate(date.getDate() - day + 1); date.setHours(0, 0, 0, 0); return date.toISOString(); }
const genericActionTitles = new Set(["阅读与判断", "写作修订", "真实使用与反馈", "验收与整理", "方案判断"]);
function actionDisplayTitle(task: WorkspaceTask) { return genericActionTitles.has(task.title.trim()) && task.stageTitle ? task.stageTitle : task.title; }
function decodeContinuationLog(body: string) { if (!body.startsWith("接续点｜")) return null; const [, , label = "当前推进", ...content] = body.split("｜"); const text = content.join("｜").trim(); return text ? { label, text } : null; }
function sourceMark(article: StoredArticle) { const source = article.source.join(" ").toLocaleLowerCase(); if (source.includes("bilibili") || source.includes("哔哩")) return "B"; if (source.includes("douyin") || source.includes("抖音")) return "抖"; return article.type === "外部资料" ? "链" : "记"; }
function sourceUrl(article: StoredArticle) { return article.source.find((item) => /^https?:\/\//i.test(item)) || ""; }
function extractFirstUrl(value: string) { return value.match(/https?:\/\/[^\s<>'\"]+/i)?.[0]?.replace(/[，。！？、；：)）\]}]+$/, "") || ""; }
function natureLabel(article: StoredArticle) { const value = article.type.split(/[，,]/).find(Boolean)?.trim(); return value && value !== "记录" ? value : "笔记"; }

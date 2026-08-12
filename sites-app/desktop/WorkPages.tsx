import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { isInboxArticle } from "../app/article-helpers";
import type {
  ActionType,
  ProjectDetail,
  ProjectStatus,
  ProjectSummary,
  ProjectTask,
} from "../app/project-types";
import type { StoredArticle } from "../app/types";
import type { DailyCloseout, FocusSession, TaskPlan, WeeklyFocus } from "../app/work-types";

export type WorkspaceTask = ProjectTask & {
  projectTitle: string;
  projectStatus: ProjectStatus;
  projectReviewDate: string;
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
  actionType: ActionType;
  details: string;
  benefit: string;
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

const actionMeta: Record<ActionType, { label: string; symbol: string }> = {
  read: { label: "阅读理解", symbol: "阅" },
  write: { label: "写作输出", symbol: "写" },
  experiment: { label: "实验验证", symbol: "验" },
  decide: { label: "决策判断", symbol: "判" },
  organize: { label: "整理归纳", symbol: "理" },
  communicate: { label: "沟通等待", symbol: "联" },
  life: { label: "生活事务", symbol: "生" },
};

export function HomeDashboard({
  today,
  tasks,
  articles,
  weeklyFocus,
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
  const available = tasks
    .filter((task) => task.status !== "done" && task.status !== "waiting" && task.projectStatus === "active")
    .sort((left, right) => taskRank(left, today) - taskRank(right, today));
  const planned = available.filter((task) => task.plan?.plannedDate === today);
  const urgent = available.filter((task) => !planned.includes(task) && isDueSoon(task, today));
  const suggested = available.filter((task) => !planned.includes(task) && !urgent.includes(task) && task.status === "next");
  const primaryTask = planned[0] ?? urgent[0] ?? suggested[0] ?? null;
  const alternatives = [...planned.slice(primaryTask === planned[0] ? 1 : 0), ...urgent.filter((task) => task.id !== primaryTask?.id), ...suggested.filter((task) => task.id !== primaryTask?.id)].slice(0, 2);
  const echo = selectContextualEcho(articles, primaryTask, today);
  const completedToday = tasks.filter((task) => task.completedAt?.slice(0, 10) === today).length;
  const notesToday = articles.filter((article) => (article.updated || article.created).slice(0, 10) === today).length;

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

      <section className="home-strategy-card workspace-card">
        <header>
          <div><span>{planned.includes(primaryTask!) ? "今日行动" : urgent.includes(primaryTask!) ? "临近截止" : "建议选择"}</span><strong>{primaryTask?.projectTitle || "今天还没有安排行动"}</strong></div>
          {primaryTask && <button onClick={() => onOpenProject(primaryTask.projectId)}>进入项目</button>}
        </header>
        {primaryTask ? (
          <div className="home-strategy-body">
            <div className="home-action-mark"><i>{actionMeta[primaryTask.actionType].symbol}</i><span>{actionMeta[primaryTask.actionType].label}</span></div>
            <div className="home-action-core">
              <p><span>阶段 {primaryTask.stageIndex}/{primaryTask.stageCount}</span><b>{primaryTask.stageTitle || "未关联阶段"}</b>{actionDueDate(primaryTask) && <time>{formatDueDate(actionDueDate(primaryTask))}</time>}</p>
              <h1>{primaryTask.title}</h1>
              {primaryTask.benefit && <blockquote>{primaryTask.benefit}</blockquote>}
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
                {primaryTask.plan?.plannedDate === today
                  ? <button onClick={() => taskActions.onRemoveFromToday(primaryTask)}>取消今日标记</button>
                  : <button onClick={() => taskActions.onPlanToday(primaryTask)}>标记为今日推进</button>}
              </div>
            </div>
          </div>
        ) : (
          <EmptyState title="今天还没有行动" body="可以去今日行动中挑选一项，也可以先进入项目看看当前阶段。" />
        )}
      </section>

      <div className="home-support-grid">
        <section className="workspace-card home-alternatives">
          <CardHeader title="之后可以做" subtitle="只保留两项可选行动" />
          {alternatives.length ? alternatives.map((task) => (
            <button key={task.id} onClick={onOpenTasks}>
              <i>{actionMeta[task.actionType].symbol}</i>
              <span><strong>{task.title}</strong><small>{task.projectTitle} · {task.stageTitle || "未关联阶段"}</small></span>
              <em>{actionDueDate(task) ? formatDueDate(actionDueDate(task)) : "无硬性截止"}</em>
            </button>
          )) : <p className="compact-empty">没有额外候选项。</p>}
        </section>

        <section className="workspace-card home-footprint">
          <CardHeader title="今天留下的结果" subtitle="由完成行动和内容更新自动形成" />
          <div><span><strong>{completedToday}</strong> 项行动完成</span><span><strong>{notesToday}</strong> 条内容更新</span></div>
          <p>{completedToday || notesToday ? "今天已经留下可追溯的结果。" : "还没有记录也没关系，完成或写下一点结果后会出现在这里。"}</p>
        </section>
      </div>

      <div className="home-bottom-grid">
        <QuickLinks />
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
  onOpenProject,
  ...taskActions
}: {
  today: string;
  tasks: WorkspaceTask[];
  projects: ProjectSummary[];
  projectDetails: ProjectDetail[];
  onAddTask: (input: NewActionInput) => Promise<void>;
  onRestoreTask: (task: WorkspaceTask) => void;
  onOpenProject: (projectId: string) => void;
} & TaskActions) {
  const [tab, setTab] = useState<"today" | "soon" | "candidate" | "waiting" | "done">("today");
  const [showComposer, setShowComposer] = useState(false);
  const initialProjectId = projects.find((item) => item.status === "active")?.id || "";
  const [projectId, setProjectId] = useState(initialProjectId);
  const [milestoneId, setMilestoneId] = useState("");
  const [title, setTitle] = useState("");
  const [actionType, setActionType] = useState<ActionType>("organize");
  const [details, setDetails] = useState("");
  const [benefit, setBenefit] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [planOnSave, setPlanOnSave] = useState(false);
  const available = tasks.filter((task) => task.status !== "done" && task.status !== "waiting" && task.projectStatus === "active").sort((a, b) => taskRank(a, today) - taskRank(b, today));
  const plannedToday = available.filter((task) => task.plan?.plannedDate === today);
  const soon = available.filter((task) => task.plan?.plannedDate !== today && isDueSoon(task, today));
  const candidates = available.filter((task) => task.plan?.plannedDate !== today && !isDueSoon(task, today));
  const waiting = tasks.filter((task) => task.status === "waiting");
  const done = tasks.filter((task) => task.status === "done");
  const visible = tab === "today" ? plannedToday : tab === "soon" ? soon : tab === "candidate" ? candidates : tab === "waiting" ? waiting : done;
  const selectedProject = projectDetails.find((detail) => detail.project.id === projectId);

  function chooseProject(value: string) {
    setProjectId(value);
    const detail = projectDetails.find((item) => item.project.id === value);
    setMilestoneId(detail?.milestones.find((item) => item.status === "current")?.id || "");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !projectId) return;
    await onAddTask({ projectId, milestoneId: milestoneId || null, title: title.trim(), actionType, details: details.trim(), benefit: benefit.trim(), dueDate, plannedToday: planOnSave });
    setTitle(""); setDetails(""); setBenefit(""); setDueDate(""); setActionType("organize"); setPlanOnSave(false); setShowComposer(false);
  }

  return (
    <div className="tasks-page action-center workspace-scroll">
      <header className="workspace-page-heading">
        <div><h1>今日行动</h1><p>这里只负责今天做什么；目标、阶段和取舍留在项目中。</p></div>
        <button onClick={() => { chooseProject(projectId || initialProjectId); setShowComposer(true); }}>＋ 添加行动</button>
      </header>

      <nav className="task-tabs" aria-label="行动视图">
        <button className={tab === "today" ? "active" : ""} onClick={() => setTab("today")}>今天 <span>{plannedToday.length}</span></button>
        <button className={tab === "soon" ? "active" : ""} onClick={() => setTab("soon")}>临近截止 <span>{soon.length}</span></button>
        <button className={tab === "candidate" ? "active" : ""} onClick={() => setTab("candidate")}>候选 <span>{candidates.length}</span></button>
        <button className={tab === "waiting" ? "active" : ""} onClick={() => setTab("waiting")}>等待反馈 <span>{waiting.length}</span></button>
        <button className={tab === "done" ? "active" : ""} onClick={() => setTab("done")}>已完成 <span>{done.length}</span></button>
      </nav>

      <section className="task-list-shell action-list-shell">
        <header><div><strong>{tab === "today" ? "今天已经选择" : tab === "soon" ? "需要留意的截止" : tab === "candidate" ? "从项目阶段中挑选" : tab === "waiting" ? "暂时不用盯着" : "已经留下的结果"}</strong></div></header>
        <div className="task-list-large">
          {visible.length ? visible.map((task, index) => (
            <ActionRow
              key={task.id}
              task={task}
              index={index}
              today={today}
              done={tab === "done"}
              onOpenProject={onOpenProject}
              onRestoreTask={onRestoreTask}
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
              <label><span>所属项目</span><select value={projectId} onChange={(event) => chooseProject(event.target.value)}><option value="">选择项目</option>{projects.filter((project) => project.status !== "completed").map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
              <label><span>所属阶段</span><select value={milestoneId} onChange={(event) => setMilestoneId(event.target.value)}><option value="">暂不关联</option>{selectedProject?.milestones.map((milestone) => <option key={milestone.id} value={milestone.id}>{milestone.status === "current" ? "当前 · " : ""}{milestone.title}</option>)}</select></label>
              <div className="task-drawer-grid">
                <label><span>行动类型</span><select value={actionType} onChange={(event) => setActionType(event.target.value as ActionType)}>{Object.entries(actionMeta).map(([value, meta]) => <option value={value} key={value}>{meta.label}</option>)}</select></label>
                <label><span>截止时间</span><input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
              </div>
              <label><span>折叠时显示的名称</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：阅读与判断、第一章修订" /></label>
              <label><span>展开后的具体做法</span><textarea value={details} onChange={(event) => setDetails(event.target.value)} placeholder="真正准备开始时，需要具体做什么？" /></label>
              <label><span>完成它有什么帮助</span><textarea value={benefit} onChange={(event) => setBenefit(event.target.value)} placeholder="它会推动哪个判断、结果或阶段？" /></label>
              <label className="task-today-toggle"><input type="checkbox" checked={planOnSave} onChange={(event) => setPlanOnSave(event.target.checked)} /><span><strong>安排到今天</strong><small>不会启动计时，也可以随时撤销</small></span></label>
              <footer><button type="button" onClick={() => setShowComposer(false)}>取消</button><button className="primary" disabled={!title.trim() || !projectId}>保存行动</button></footer>
            </form>
          </aside>
        </div>
      )}
    </div>
  );
}

export function ExplorePage({ articles, onSaveLink, onOpenArticle }: { articles: StoredArticle[]; onSaveLink: (url: string, note: string) => Promise<void>; onOpenArticle: (article: StoredArticle) => void }) {
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const sources = articles.filter((article) => article.collection === "sources" || article.type === "外部资料");
  async function submit(event: FormEvent) { event.preventDefault(); if (!url.trim()) return; await onSaveLink(url.trim(), note.trim()); setUrl(""); setNote(""); }
  return (
    <div className="explore-page workspace-scroll">
      <header className="workspace-page-heading"><div><h1>探索库</h1><p>留下外部链接和兴趣线索，之后再决定是否值得转化为自己的内容。</p></div></header>
      <form className="link-capture-card" onSubmit={submit}><div><span>收进探索库</span><strong>粘贴 B站、抖音、文章或其他链接</strong></div><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://..." /><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="为什么想留下它？可选" /><button disabled={!url.trim()}>保存链接</button></form>
      <section className="source-inbox"><CardHeader title="兴趣线索" subtitle="打开后可以整理、补充判断或移除" /><div>{sources.length ? sources.map((article) => <button key={article.id} onClick={() => onOpenArticle(article)}><i>{sourceMark(article)}</i><span><strong>{article.title}</strong><p>{article.summary || plainExcerpt(article.body)}</p><small>{article.source[0] || "外部资料"} · {formatRelativeDate(article.created)}</small></span></button>) : <EmptyState title="探索库是空的" body="下一次遇到感兴趣的内容时，先写一句为什么值得留下。" />}</div></section>
    </div>
  );
}

export function InboxPage({ articles, projects, onOpenArticle, onNewCapture, onMoveArticle, onConvertToAction, onConvertToProposal }: {
  articles: StoredArticle[];
  projects: ProjectSummary[];
  onOpenArticle: (article: StoredArticle) => void;
  onNewCapture: () => void;
  onMoveArticle: (article: StoredArticle, destination: "note" | "explore") => Promise<void>;
  onConvertToAction: (article: StoredArticle, projectId: string) => Promise<void>;
  onConvertToProposal: (article: StoredArticle, projectId: string) => Promise<void>;
}) {
  const inbox = articles.filter(isInboxArticle);
  const thoughts = inbox.filter((article) => article.collection !== "sources" && article.type !== "外部资料");
  const sources = inbox.filter((article) => article.collection === "sources" || article.type === "外部资料");
  return (
    <div className="inbox-page workspace-scroll">
      <header className="workspace-page-heading">
        <div><h1>待整理</h1><p>这是临时入口，不需要当场分类；处理后它就会离开这里。</p></div>
        <button onClick={onNewCapture}>＋ 随手记一条</button>
      </header>
      <div className="inbox-groups">
        <InboxGroup title="零散想法" items={thoughts} projects={projects} empty="目前没有待整理的想法。" onOpenArticle={onOpenArticle} onMoveArticle={onMoveArticle} onConvertToAction={onConvertToAction} onConvertToProposal={onConvertToProposal} />
        <InboxGroup title="待处理资料" items={sources} projects={projects} empty="目前没有待处理的外部资料。" onOpenArticle={onOpenArticle} onMoveArticle={onMoveArticle} onConvertToAction={onConvertToAction} onConvertToProposal={onConvertToProposal} />
      </div>
    </div>
  );
}

function InboxGroup({ title, items, projects, empty, onOpenArticle, onMoveArticle, onConvertToAction, onConvertToProposal }: {
  title: string;
  items: StoredArticle[];
  projects: ProjectSummary[];
  empty: string;
  onOpenArticle: (article: StoredArticle) => void;
  onMoveArticle: (article: StoredArticle, destination: "note" | "explore") => Promise<void>;
  onConvertToAction: (article: StoredArticle, projectId: string) => Promise<void>;
  onConvertToProposal: (article: StoredArticle, projectId: string) => Promise<void>;
}) {
  return <section className="workspace-card inbox-group"><CardHeader title={title} subtitle={`${items.length} 条`} />{items.length ? <div>{items.map((article) => <InboxItem key={article.id} article={article} projects={projects} onOpenArticle={onOpenArticle} onMoveArticle={onMoveArticle} onConvertToAction={onConvertToAction} onConvertToProposal={onConvertToProposal} />)}</div> : <p className="compact-empty">{empty}</p>}</section>;
}

function InboxItem({ article, projects, onOpenArticle, onMoveArticle, onConvertToAction, onConvertToProposal }: {
  article: StoredArticle;
  projects: ProjectSummary[];
  onOpenArticle: (article: StoredArticle) => void;
  onMoveArticle: (article: StoredArticle, destination: "note" | "explore") => Promise<void>;
  onConvertToAction: (article: StoredArticle, projectId: string) => Promise<void>;
  onConvertToProposal: (article: StoredArticle, projectId: string) => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(projects.find((project) => project.status === "active")?.id ?? "");
  return <article className="inbox-item">
    <button className="inbox-item-main" onClick={() => onOpenArticle(article)}><i>{sourceMark(article)}</i><span><strong>{article.title}</strong><p>{article.summary || plainExcerpt(article.body)}</p><small>{formatRelativeDate(article.updated || article.created)}</small></span><em>打开 →</em></button>
    <div className="inbox-item-actions"><button onClick={() => void onMoveArticle(article, "note")}>转笔记</button><button onClick={() => void onMoveArticle(article, "explore")}>转探索</button><select aria-label="选择项目" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">选择项目</option>{projects.filter((project) => project.status !== "completed").map((project) => <option value={project.id} key={project.id}>{project.title}</option>)}</select><button disabled={!projectId} onClick={() => void onConvertToAction(article, projectId)}>转行动</button><button disabled={!projectId} onClick={() => void onConvertToProposal(article, projectId)}>转提案</button></div>
  </article>;
}

export function ReviewPage({ projects, articles, tasks, weeklyFocus, closeouts, today, onSaveCloseout }: {
  projects: ProjectSummary[];
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
  const weekArticles = articles.filter((article) => (article.updated || article.created) >= weekStart.slice(0, 10));
  const weekCompleted = tasks.filter((task) => task.completedAt && task.completedAt >= weekStart);
  const completedStages = projects.reduce((sum, project) => sum + project.completedMilestoneCount, 0);
  return (
    <div className="review-page workspace-scroll">
      <header className="workspace-page-heading"><div><h1>本周回顾</h1><p>{weeklyFocus?.primaryOutcome ? `本周主结果：${weeklyFocus.primaryOutcome}` : "查看留下了什么结果、判断与经验，而不是用计时证明自己很忙。"}</p></div></header>
      <div className="review-metrics"><article><span>行动结果</span><strong>{weekCompleted.length}</strong><small>项行动在本周完成</small></article><article><span>阶段达成</span><strong>{completedStages}</strong><small>个项目阶段已经走过</small></article><article><span>知识沉淀</span><strong>{weekArticles.length}</strong><small>条笔记或资料有更新</small></article></div>
      <div className="review-grid">
        <section className="workspace-card review-project-time"><CardHeader title="本周推进了什么" subtitle="结果按项目归拢" />{weekCompleted.length ? weekCompleted.map((task) => <div className="review-result-row" key={task.id}><span>{actionMeta[task.actionType].label}</span><strong>{task.title}</strong><small>{task.projectTitle} · {task.stageTitle}</small></div>) : <EmptyState title="本周还没有完成记录" body="完成行动或写下推进结果后，会自动汇总到这里。" />}</section>
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

function ActionRow({ task, index, today, done, onOpenProject, onRestoreTask, onCompleteTask, onPlanToday, onRemoveFromToday, onStartFocus, onStopFocus, activeSession }: { task: WorkspaceTask; index: number; today: string; done: boolean; onOpenProject: (projectId: string) => void; onRestoreTask: (task: WorkspaceTask) => void } & TaskActions) {
  const plannedToday = task.plan?.plannedDate === today;
  return (
    <article className={`workspace-task action-row ${plannedToday ? "is-today" : ""} ${done ? "is-done" : ""}`}>
      <i className="action-type-icon">{actionMeta[task.actionType].symbol}</i>
      <div className="action-row-main">
        <header><span>{actionMeta[task.actionType].label}</span>{plannedToday && <b>今日推进</b>}{index === 0 && !done && <b>当前</b>}</header>
        <h2>{task.title}</h2>
        <button className="action-context" onClick={() => onOpenProject(task.projectId)}>{task.projectTitle} <i>›</i> 阶段 {task.stageIndex}/{task.stageCount}：{task.stageTitle || "未关联阶段"}</button>
        <div className="action-row-meta"><span>{actionDueDate(task) ? `截止 ${formatDueDate(actionDueDate(task))}` : "无硬性截止"}</span><StageProgress task={task} compact /></div>
        <details className="action-disclosure"><summary>查看具体做法与收益</summary><div><p><strong>具体做法</strong>{task.details || "还没有补充具体做法。"}</p><p><strong>推进价值</strong>{task.benefit || "还没有记录它对阶段的帮助。"}</p>{task.waitingFor && <p><strong>正在等待</strong>{task.waitingFor}</p>}</div></details>
      </div>
      <div className="action-row-actions">{done ? <button onClick={() => onRestoreTask(task)}>恢复</button> : <><button onClick={() => onCompleteTask(task)}>✓ 完成</button>{activeSession?.taskId === task.id ? <button onClick={onStopFocus}>■ 结束投入</button> : !activeSession && <button onClick={() => onStartFocus(task)}>▷ 开始投入</button>}{plannedToday ? <button onClick={() => onRemoveFromToday(task)}>取消今日</button> : <button onClick={() => onPlanToday(task)}>标记今日</button>}</>}</div>
    </article>
  );
}

function StageProgress({ task, compact = false }: { task: WorkspaceTask; compact?: boolean }) {
  const total = Math.max(task.stageTaskCount, 1);
  const ratio = Math.min(100, Math.round(task.stageCompletedTasks / total * 100));
  return <div className={`stage-progress ${compact ? "compact" : ""}`}><i><b style={{ width: `${ratio}%` }} /></i><span>{task.stageCompletedTasks}/{task.stageTaskCount || 0} 个阶段行动完成</span></div>;
}

type QuickLinkCategory = "research" | "creative" | "content" | "general";
type QuickLink = { id: string; title: string; url: string; category: QuickLinkCategory; pinned: boolean; order: number };
const quickLinkCategories: Record<QuickLinkCategory, string> = { research: "科研学习", creative: "创作开发", content: "内容平台", general: "常用工具" };

function QuickLinks() {
  const [links, setLinks] = useState<QuickLink[]>(readQuickLinks);
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState<QuickLinkCategory>("general");
  const [openError, setOpenError] = useState("");
  const [deleted, setDeleted] = useState<{ link: QuickLink; index: number } | null>(null);
  const pinned = [...links].filter((link) => link.pinned).sort((a, b) => a.order - b.order).slice(0, 4);

  function save(next: QuickLink[]) { setLinks(next); localStorage.setItem("life-strategy.quick-links-v2", JSON.stringify(next)); }
  function submit(event: FormEvent) { event.preventDefault(); if (!title.trim() || !url.trim()) return; const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`; save([...links, { id: `link-${Date.now()}`, title: title.trim(), url: normalized, category, pinned: pinned.length < 4, order: links.length }]); setTitle(""); setUrl(""); setAdding(false); }
  function remove(link: QuickLink) { const index = links.findIndex((item) => item.id === link.id); save(links.filter((item) => item.id !== link.id)); setDeleted({ link, index }); }
  function undoDelete() { if (!deleted) return; const next = [...links]; next.splice(deleted.index, 0, deleted.link); save(next); setDeleted(null); }
  function togglePin(link: QuickLink) { save(links.map((item) => item.id === link.id ? { ...item, pinned: !item.pinned } : item)); }
  async function openLink(target: string) { setOpenError(""); try { await openExternalUrl(target); } catch { setOpenError("未能打开该入口，请检查网址或系统默认浏览器设置。"); } }

  return (
    <section className="workspace-card quick-links-card tool-shelf">
      <CardHeader title="常用工具" subtitle="只在首页露出最多四个置顶入口" action={expanded ? "收起" : "全部工具"} onAction={() => setExpanded((value) => !value)} />
      <div className="pinned-tools">{pinned.map((link) => <button type="button" onClick={() => void openLink(link.url)} key={link.id}><i>{link.title.slice(0, 1)}</i><span>{link.title}</span></button>)}</div>
      {expanded && <div className="tool-library">
        <header><strong>工具抽屉</strong><button onClick={() => setAdding((value) => !value)}>{adding ? "取消" : "＋ 添加入口"}</button></header>
        {adding && <form onSubmit={submit}><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="名称" /><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="网址" /><select value={category} onChange={(event) => setCategory(event.target.value as QuickLinkCategory)}>{Object.entries(quickLinkCategories).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><button>保存</button></form>}
        {Object.entries(quickLinkCategories).map(([value, label]) => {
          const categoryLinks = links.filter((link) => link.category === value);
          if (!categoryLinks.length) return null;
          return <details key={value} open={value === "research" || value === "general"}><summary>{label}<span>{categoryLinks.length}</span></summary><div>{categoryLinks.map((link) => <div className="tool-row" key={link.id}><button onClick={() => void openLink(link.url)}><i>{link.title.slice(0, 1)}</i><span><strong>{link.title}</strong><small>{safeHost(link.url)}</small></span></button><button className={link.pinned ? "pinned" : ""} onClick={() => togglePin(link)} title={link.pinned ? "取消置顶" : "置顶"}>☆</button><button onClick={() => remove(link)} title="删除">×</button></div>)}</div></details>;
        })}
        {deleted && <div className="tool-undo"><span>已删除“{deleted.link.title}”</span><button onClick={undoDelete}>撤销</button></div>}
      </div>}
      {openError && <p className="quick-link-error" role="alert">{openError}</p>}
    </section>
  );
}

function readQuickLinks(): QuickLink[] {
  try {
    const current = localStorage.getItem("life-strategy.quick-links-v2");
    if (current) return JSON.parse(current) as QuickLink[];
    const legacy = localStorage.getItem("life-strategy.quick-links");
    if (legacy) return (JSON.parse(legacy) as Array<{ title: string; url: string }>).map((link, index) => ({ id: `legacy-${index}`, ...link, category: inferLinkCategory(link.url), pinned: index < 4, order: index }));
  } catch { /* fall through to defaults */ }
  return defaultQuickLinks;
}

const defaultQuickLinks: QuickLink[] = [
  { id: "bilibili", title: "哔哩哔哩", url: "https://www.bilibili.com", category: "content", pinned: true, order: 0 },
  { id: "douyin", title: "抖音", url: "https://www.douyin.com", category: "content", pinned: false, order: 1 },
  { id: "zotero", title: "Zotero", url: "https://www.zotero.org", category: "research", pinned: true, order: 2 },
  { id: "github", title: "GitHub", url: "https://github.com", category: "creative", pinned: true, order: 3 },
  { id: "arxiv", title: "arXiv", url: "https://arxiv.org", category: "research", pinned: true, order: 4 },
  { id: "scholar", title: "Google 学术", url: "https://scholar.google.com", category: "research", pinned: false, order: 5 },
];

function CardHeader({ title, subtitle, action, onAction }: { title: string; subtitle: string; action?: string; onAction?: () => void }) { return <header className="card-header"><div><strong>{title}</strong><span>{subtitle}</span></div>{action && <button onClick={onAction}>{action} →</button>}</header>; }
function EmptyState({ title, body }: { title: string; body: string }) { return <div className="workspace-empty"><strong>{title}</strong><p>{body}</p></div>; }
async function openExternalUrl(url: string) { if (isTauri()) { await openUrl(url); return; } window.open(url, "_blank", "noopener,noreferrer"); }
function taskRank(task: WorkspaceTask, today: string) { const todayRank = task.plan?.plannedDate === today ? 0 : task.status === "next" ? 4 : 10; const dueRank = actionDueDate(task) ? Math.max(0, Math.floor((new Date(actionDueDate(task)).getTime() - Date.now()) / 86_400_000)) : 30; return todayRank + dueRank / 100 + task.sortOrder / 1000; }
function isDueSoon(task: WorkspaceTask, today: string) { const due = actionDueDate(task); if (!due) return false; const from = new Date(`${today}T00:00:00`).getTime(); const to = new Date(`${due}T23:59:59`).getTime(); return to <= from + 2 * 86_400_000; }
function actionDueDate(task: WorkspaceTask) { return task.dueDate || task.stageDueDate || task.projectReviewDate; }
function formatDueDate(value: string) { if (!value) return ""; const date = new Date(`${value}T12:00:00`); const diff = Math.ceil((date.getTime() - Date.now()) / 86_400_000); if (diff < 0) return `已过期 ${Math.abs(diff)} 天`; if (diff === 0) return "今天截止"; if (diff === 1) return "明天截止"; return `${date.getMonth() + 1}月${date.getDate()}日`; }
function selectContextualEcho(articles: StoredArticle[], task: WorkspaceTask | null, today: string) {
  if (!task) return null;
  const source = `${task.projectTitle} ${task.stageTitle} ${task.title} ${task.benefit}`;
  const tokens = [...new Set(source.split(/[\s、，。；：/·（）()《》]+/).map((item) => item.trim()).filter((item) => item.length >= 2))];
  const scored = articles.filter((article) => article.collection !== "sources" && (article.updated || article.created).slice(0, 10) < today).map((article) => { const haystack = `${article.title} ${article.summary} ${article.body} ${article.project} ${article.tags.join(" ")}`; const matched = tokens.filter((token) => haystack.includes(token)); return { article, matched, score: matched.length + (article.project && source.includes(article.project) ? 3 : 0) }; }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  const best = scored[0];
  return best ? { article: best.article, reason: best.matched.length ? `与 ${best.matched.slice(0, 2).join("、")} 相关` : "与当前项目相关" } : null;
}
function inferLinkCategory(url: string): QuickLinkCategory { const value = url.toLocaleLowerCase(); if (/arxiv|scholar|zotero/.test(value)) return "research"; if (/github|figma|notion/.test(value)) return "creative"; if (/bilibili|douyin|youtube/.test(value)) return "content"; return "general"; }
function safeHost(url: string) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } }
function greeting() { const hour = new Date().getHours(); if (hour < 6) return "夜深了"; if (hour < 11) return "早上好"; if (hour < 14) return "中午好"; if (hour < 18) return "下午好"; return "晚上好"; }
function formatLongDate(value: string) { return new Date(`${value}T12:00:00`).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" }); }
function formatDate(value: string) { return value ? value.slice(0, 10).replaceAll("-", ".") : "未记录日期"; }
function formatRelativeDate(value: string) { if (!value) return "未记录"; const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value); const diff = Math.floor((Date.now() - date.getTime()) / 86_400_000); if (diff <= 0) return "今天"; if (diff === 1) return "昨天"; if (diff < 7) return `${diff} 天前`; return formatDate(value); }
function plainExcerpt(text: string) { return text.replace(/[#>*`\-\[\]()]/g, "").replace(/\s+/g, " ").trim().slice(0, 110); }
function startOfLocalWeek() { const date = new Date(); const day = date.getDay() || 7; date.setDate(date.getDate() - day + 1); date.setHours(0, 0, 0, 0); return date.toISOString(); }
function sourceMark(article: StoredArticle) { const source = article.source.join(" ").toLocaleLowerCase(); if (source.includes("bilibili") || source.includes("哔哩")) return "B"; if (source.includes("douyin") || source.includes("抖音")) return "抖"; return article.type === "外部资料" ? "链" : "记"; }
function natureLabel(article: StoredArticle) { const value = article.type.split(/[，,]/).find(Boolean)?.trim(); return value && value !== "记录" ? value : "笔记"; }

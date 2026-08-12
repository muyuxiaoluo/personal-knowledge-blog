import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import type { ArticleRepository } from "../app/data/article-repository";
import { isInboxArticle } from "../app/article-helpers";
import type { ProjectRepository } from "../app/data/project-repository";
import type { WorkRepository } from "../app/data/work-repository";
import type { ProjectDetail, ProjectProposal, ProjectSummary, ProjectTask } from "../app/project-types";
import type { Article, StoredArticle } from "../app/types";
import type { DailyCloseout, FocusSession, TaskPlan, WeeklyFocus } from "../app/work-types";
import { MarkdownDocument } from "./MarkdownDocument";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { WorkbenchIcon, type WorkbenchIconName } from "./WorkbenchIcon";
import {
  ExplorePage,
  HomeDashboard,
  InboxPage,
  ReviewPage,
  TasksPage,
  type NewActionInput,
  type WorkspaceTask,
} from "./WorkPages";

export type ThemeMode = "minimal" | "magic" | "immersive";

type DeskSection = "home" | "tasks" | "projects" | "notes" | "explore" | "inbox" | "review";
type NoteView = "all" | "thoughts" | "experience" | "research" | "creative";
type UndoOffer = { message: string; run: () => Promise<void> };

type DesktopWorkbenchProps = {
  repository: ArticleRepository;
  projectRepository: ProjectRepository;
  workRepository: WorkRepository;
  onRepositoryChange?: () => void;
  accountDock: ReactNode;
  themeMode: ThemeMode;
};

const sections: Array<{
  id: DeskSection;
  label: string;
  icon: WorkbenchIconName;
  group: "action" | "knowledge";
}> = [
  { id: "home", label: "首页", icon: "home", group: "action" },
  { id: "tasks", label: "今日行动", icon: "today", group: "action" },
  { id: "projects", label: "项目", icon: "projects", group: "action" },
  { id: "notes", label: "笔记", icon: "notes", group: "knowledge" },
  { id: "explore", label: "探索库", icon: "explore", group: "knowledge" },
  { id: "inbox", label: "待整理", icon: "inbox", group: "knowledge" },
  { id: "review", label: "回顾", icon: "review", group: "knowledge" },
];

const noteViews: Array<{ id: NoteView; label: string }> = [
  { id: "all", label: "全部笔记" },
  { id: "thoughts", label: "思考与灵感" },
  { id: "experience", label: "经验与方法" },
  { id: "research", label: "科研相关" },
  { id: "creative", label: "创作相关" },
];

const natureOptions = ["思考", "经验", "方法", "问题", "灵感", "复盘"];
const sourceOptions = ["自写", "文章", "视频", "书籍", "对话", "其他"];

const emptyDraft: Article = {
  id: "",
  slug: "",
  collection: "notes",
  collectionLabel: "笔记",
  title: "",
  created: "",
  updated: "",
  branch: "未整理",
  subbranch: "",
  stage: "常青",
  validity: "",
  category: "笔记",
  tags: [],
  type: "思考",
  project: "",
  projectId: "",
  confidence: "",
  source: ["自写"],
  reviewDate: "",
  summary: "",
  next: "",
  body: "",
};

export function DesktopWorkbench({
  repository,
  projectRepository,
  workRepository,
  onRepositoryChange,
  accountDock,
  themeMode,
}: DesktopWorkbenchProps) {
  const [articles, setArticles] = useState<StoredArticle[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectDetails, setProjectDetails] = useState<ProjectDetail[]>([]);
  const [plans, setPlans] = useState<TaskPlan[]>([]);
  const [sessions, setSessions] = useState<FocusSession[]>([]);
  const [activeSession, setActiveSession] = useState<FocusSession | null>(null);
  const [weeklyFocus, setWeeklyFocus] = useState<WeeklyFocus | null>(null);
  const [closeouts, setCloseouts] = useState<DailyCloseout[]>([]);
  const [section, setSection] = useState<DeskSection>("home");
  const [noteView, setNoteView] = useState<NoteView>("all");
  const [requestedProjectId, setRequestedProjectId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Article>({ ...emptyDraft });
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
  const [quickText, setQuickText] = useState("");
  const [message, setMessage] = useState("");
  const [undoOffer, setUndoOffer] = useState<UndoOffer | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("life-strategy.sidebar-collapsed") === "true",
  );
  const messageTimer = useRef<number | null>(null);
  const undoTimer = useRef<number | null>(null);
  const today = useMemo(() => localDate(), []);

  const showMessage = useCallback((text: string) => {
    setUndoOffer(null);
    setMessage(text);
    if (messageTimer.current) window.clearTimeout(messageTimer.current);
    messageTimer.current = window.setTimeout(() => setMessage(""), 3200);
  }, []);

  const offerUndo = useCallback((message: string, run: () => Promise<void>) => {
    setMessage("");
    setUndoOffer({ message, run });
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndoOffer(null), 8000);
  }, []);

  async function runUndo() {
    if (!undoOffer) return;
    const action = undoOffer.run;
    setUndoOffer(null);
    try {
      await action();
      showMessage("操作已经撤销。 ");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "撤销失败");
    }
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      localStorage.setItem("life-strategy.sidebar-collapsed", String(next));
      return next;
    });
  }

  const refreshArticles = useCallback(async () => {
    const next = await repository.list();
    setArticles(next);
    return next;
  }, [repository]);

  const refreshProjects = useCallback(async () => {
    const next = await projectRepository.list();
    const details = (await Promise.all(next.map((project) => projectRepository.get(project.id))))
      .filter((detail): detail is ProjectDetail => Boolean(detail));
    setProjects(next);
    setProjectDetails(details);
    return next;
  }, [projectRepository]);

  const refreshWork = useCallback(async () => {
    const weekStart = startOfLocalWeekDate();
    const [nextPlans, nextSessions, nextActive, nextFocus, nextCloseouts] = await Promise.all([
      workRepository.listPlans(),
      workRepository.listSessions(startOfMonth()),
      workRepository.getActiveSession(),
      workRepository.getWeeklyFocus(weekStart),
      workRepository.listDailyCloseouts(weekStart),
    ]);
    setPlans(nextPlans);
    setSessions(nextSessions);
    setActiveSession(nextActive);
    setWeeklyFocus(nextFocus);
    setCloseouts(nextCloseouts);
  }, [workRepository]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([refreshArticles(), refreshProjects(), refreshWork()])
      .catch((error) => {
        if (active) showMessage(error instanceof Error ? error.message : "无法读取本地工作台");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [refreshArticles, refreshProjects, refreshWork, showMessage]);

  useEffect(() => {
    const openCapture = () => setQuickCaptureOpen(true);
    let unlisten: UnlistenFn | undefined;
    window.addEventListener("mind-garden:quick-capture", openCapture);
    void listen("open-quick-capture", openCapture).then((dispose) => { unlisten = dispose; });
    return () => {
      window.removeEventListener("mind-garden:quick-capture", openCapture);
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    function handleKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (quickCaptureOpen) setQuickCaptureOpen(false);
        else if (selectedId || editing) closeDocument();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && editing) {
        event.preventDefault();
        void saveDraft();
      }
    }
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  });

  const workspaceTasks = useMemo<WorkspaceTask[]>(() => projectDetails.flatMap((detail) =>
    detail.tasks.map((task) => {
      const milestone = detail.milestones.find((item) => item.id === task.milestoneId) ?? null;
      const stageTasks = detail.tasks.filter((item) => item.milestoneId === task.milestoneId);
      const stageIndex = milestone ? detail.milestones.findIndex((item) => item.id === milestone.id) + 1 : 0;
      return {
        ...task,
        projectTitle: detail.project.title,
        projectStatus: detail.project.status,
        projectReviewDate: detail.project.reviewDate,
        stageTitle: milestone?.title ?? "",
        stageDueDate: milestone?.dueDate ?? "",
        stageIndex,
        stageCount: detail.milestones.length,
        stageCompletedTasks: stageTasks.filter((item) => item.status === "done").length,
        stageTaskCount: stageTasks.length,
        plan: plans.find((plan) => plan.taskId === task.id) ?? null,
      };
    }),
  ), [plans, projectDetails]);

  const selected = useMemo(
    () => articles.find((article) => article.id === selectedId) ?? null,
    [articles, selectedId],
  );

  const inboxCount = useMemo(() => articles.filter(isInboxArticle).length, [articles]);
  const noteArticles = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    return articles.filter((article) => {
      if (article.collection === "sources" || article.type === "外部资料") return false;
      if (!matchesNoteView(article, noteView)) return false;
      return !needle || articleSearchText(article).includes(needle);
    });
  }, [articles, noteView, query]);

  const counts: Record<DeskSection, number | null> = {
    home: null,
    tasks: workspaceTasks.filter((task) => task.status !== "done" && task.plan?.plannedDate === today).length,
    projects: projects.filter((project) => project.status === "active" || project.status === "waiting").length,
    notes: articles.filter((article) => article.collection !== "sources" && article.type !== "外部资料").length,
    explore: articles.filter((article) => article.collection === "sources" || article.type === "外部资料").length,
    inbox: inboxCount,
    review: sessions.length,
  };

  function switchSection(next: DeskSection) {
    setSection(next);
    setSelectedId(null);
    setEditing(false);
    setQuery("");
  }

  function openProject(projectId: string) {
    setRequestedProjectId(projectId);
    switchSection("projects");
  }

  function openArticle(article: StoredArticle) {
    setSelectedId(article.id);
    setDraft(toEditableArticle(article));
    setEditing(false);
  }

  function startNewArticle() {
    setSelectedId(null);
    setDraft({ ...emptyDraft, tags: [], source: ["自写"], created: today });
    setEditing(true);
  }

  function startEditing(article: StoredArticle, append = false) {
    const next = toEditableArticle(article);
    if (append) next.body = `${next.body.trim()}\n\n## ${today} · 追加想法\n\n`;
    setDraft(next);
    setEditing(true);
  }

  function closeDocument() {
    setEditing(false);
    setSelectedId(null);
    setDraft({ ...emptyDraft });
  }

  async function persist(article: Article, success: string) {
    setSaving(true);
    try {
      const saved = await repository.save(article);
      await refreshArticles();
      setSelectedId(saved.id);
      onRepositoryChange?.();
      showMessage(success);
      return saved;
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "保存失败");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function saveDraft() {
    const title = draft.title.trim();
    const body = draft.body.trim();
    if (!title || !body) {
      showMessage("请先填写标题和正文。");
      return;
    }
    const linkedProject = projects.find((project) => project.id === draft.projectId)
      ?? projects.find((project) => project.title === draft.project);
    const saved = await persist({
      ...draft,
      projectId: linkedProject?.id || "",
      project: linkedProject?.title || "",
      title,
      body,
      collection: draft.collection === "sources" ? "sources" : "notes",
      collectionLabel: draft.collection === "sources" ? "探索资料" : "笔记",
      category: draft.collection === "sources" ? "探索资料" : "笔记",
      branch: draft.branch === "待分类" ? "已整理" : draft.branch || "已整理",
      summary: plainExcerpt(body),
      next: "",
    }, draft.id ? "修改已经保存。" : "笔记已经保存。 ");
    if (saved) {
      setDraft(toEditableArticle(saved));
      setEditing(false);
    }
  }

  async function quickCapture(event: FormEvent) {
    event.preventDefault();
    const body = quickText.trim();
    if (!body) return;
    const saved = await persist({
      ...emptyDraft,
      tags: [],
      source: ["快速记录"],
      title: captureTitle(body),
      body,
      type: "灵感",
      branch: "待分类",
      stage: "种子",
      summary: plainExcerpt(body),
      created: today,
    }, "已经放进待整理内容。 ");
    if (saved) {
      setQuickText("");
      setQuickCaptureOpen(false);
      switchSection("inbox");
    }
  }

  async function saveExternalLink(url: string, note: string) {
    const platform = linkPlatform(url);
    const title = note ? captureTitle(note) : `${platform} · 待看内容`;
    await persist({
      ...emptyDraft,
      collection: "sources",
      collectionLabel: "探索资料",
      category: "探索资料",
      type: "外部资料",
      title,
      body: `${note ? `${note}\n\n` : ""}[打开原内容](${url})`,
      source: [platform, url],
      branch: "待分类",
      stage: "种子",
      summary: note || `来自 ${platform} 的待处理链接`,
      created: today,
    }, "链接已经收进探索库。 ");
  }

  async function removeArticle(article: StoredArticle) {
    if (!window.confirm(`确认移除《${article.title}》吗？`)) return;
    setSaving(true);
    try {
      await repository.remove(article.id);
      await refreshArticles();
      closeDocument();
      onRepositoryChange?.();
      showMessage("内容已经移除。 ");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "移除失败");
    } finally {
      setSaving(false);
    }
  }

  async function planToday(task: WorkspaceTask) {
    await workRepository.savePlan({
      taskId: task.id,
      plannedDate: today,
      priority: task.plan?.priority || "normal",
      estimateMinutes: task.plan?.estimateMinutes || 0,
      sortOrder: task.plan?.sortOrder || workspaceTasks.filter((item) => item.plan?.plannedDate === today).length,
      updatedAt: "",
    });
    await refreshWork();
    offerUndo("已安排到今天", async () => {
      await workRepository.removePlan(task.id);
      await refreshWork();
    });
  }

  async function removeFromToday(task: WorkspaceTask) {
    const previous = task.plan;
    if (!previous) return;
    await workRepository.removePlan(task.id);
    await refreshWork();
    offerUndo("已移出今天", async () => {
      await workRepository.savePlan(previous);
      await refreshWork();
    });
  }

  async function startFocus(task: WorkspaceTask) {
    try {
      const session = await workRepository.startSession({ taskId: task.id, projectId: task.projectId, label: task.title });
      setActiveSession(session);
      setSessions((current) => [session, ...current]);
      showMessage("专注计时已经开始。 ");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "无法开始专注");
    }
  }

  async function stopFocus() {
    if (!activeSession) return;
    try {
      await workRepository.stopSession(activeSession.id);
      await refreshWork();
      showMessage("本次投入已经记录。 ");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "无法结束专注");
    }
  }

  async function completeTask(task: WorkspaceTask) {
    try {
      if (activeSession?.taskId === task.id) await workRepository.stopSession(activeSession.id);
      await projectRepository.completeTask(task.id, `完成行动：${task.title}`);
      await Promise.all([refreshProjects(), refreshWork()]);
      offerUndo("任务已完成", async () => {
        await projectRepository.updateTaskStatus(task.id, task.status);
        await refreshProjects();
      });
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "无法完成任务");
    }
  }

  async function restoreTask(task: WorkspaceTask) {
    try {
      await projectRepository.updateTaskStatus(task.id, "later");
      await refreshProjects();
      offerUndo("任务已经恢复", async () => {
        await projectRepository.updateTaskStatus(task.id, "done");
        await refreshProjects();
      });
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "无法恢复任务");
    }
  }

  async function addTask(input: NewActionInput) {
    const now = new Date().toISOString();
    const task: ProjectTask = {
      id: "",
      projectId: input.projectId,
      milestoneId: input.milestoneId,
      title: input.title,
      actionType: input.actionType,
      details: input.details,
      benefit: input.benefit,
      dueDate: input.dueDate,
      status: "later",
      waitingFor: "",
      resumeAction: "",
      context: "anywhere",
      sortOrder: workspaceTasks.filter((item) => item.projectId === input.projectId).length,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    try {
      const saved = await projectRepository.saveTask(task);
      if (input.plannedToday) {
        await workRepository.savePlan({ taskId: saved.id, plannedDate: today, priority: "normal", estimateMinutes: 0, sortOrder: 99, updatedAt: "" });
      }
      await Promise.all([refreshProjects(), refreshWork()]);
      showMessage("任务已经添加。 ");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "无法添加任务");
    }
  }

  async function saveWeeklyFocus(primaryOutcome: string, secondaryOutcome: string) {
    try {
      await workRepository.saveWeeklyFocus({
        weekStart: startOfLocalWeekDate(),
        primaryOutcome,
        secondaryOutcome,
        updatedAt: "",
      });
      await refreshWork();
      showMessage("本周聚焦已经保存。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "本周聚焦保存失败");
    }
  }

  async function saveCloseout(result: string, lesson: string, tomorrow: string) {
    try {
      await workRepository.saveDailyCloseout({ date: today, result, lesson, tomorrow, updatedAt: "" });
      await refreshWork();
      showMessage("今日收尾已经保存。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "今日收尾保存失败");
    }
  }

  async function moveInboxArticle(article: StoredArticle, destination: "note" | "explore") {
    const saved = await persist({
      ...article,
      collection: destination === "explore" ? "sources" : "notes",
      collectionLabel: destination === "explore" ? "探索资料" : "笔记",
      category: destination === "explore" ? "探索资料" : "笔记",
      type: destination === "explore" ? "外部资料" : article.type === "外部资料" ? "思考" : article.type,
      branch: "已整理",
    }, destination === "explore" ? "已转入探索库。" : "已整理为笔记。");
    if (saved) closeDocument();
  }

  async function convertInboxToAction(article: StoredArticle, projectId: string) {
    const project = projectDetails.find((item) => item.project.id === projectId);
    if (!project) return;
    await addTask({
      projectId,
      milestoneId: project.milestones.find((item) => item.status === "current")?.id ?? null,
      title: article.title,
      actionType: "organize",
      details: article.body,
      benefit: "由待整理内容转化，保留原始上下文。",
      dueDate: "",
      plannedToday: false,
    });
    await moveInboxArticle(article, "note");
  }

  async function convertInboxToProposal(article: StoredArticle, projectId: string) {
    const now = new Date().toISOString();
    const proposal: ProjectProposal = {
      id: "",
      projectId,
      title: article.title,
      problem: plainExcerpt(article.body),
      expectedValue: "",
      cost: "",
      status: "pending",
      reviewNote: "由待整理内容转化",
      createdAt: now,
      updatedAt: now,
    };
    try {
      await projectRepository.saveProposal(proposal);
      await refreshProjects();
      await moveInboxArticle(article, "note");
      showMessage("已转为项目提案并保留原始笔记。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "转为提案失败");
    }
  }

  const documentMode = Boolean(selected || editing);
  const rootClass = [
    "desktop-workbench",
    "workbench-v2",
    documentMode ? "document-mode" : "",
    section === "projects" && !documentMode ? "projects-mode" : "",
    section === "notes" && !documentMode ? "notes-mode" : "",
    sidebarCollapsed && !documentMode ? "sidebar-collapsed" : "",
    `theme-${themeMode}`,
  ].filter(Boolean).join(" ");
  const taskActions = {
    onCompleteTask: completeTask,
    onPlanToday: planToday,
    onRemoveFromToday: removeFromToday,
    onStartFocus: startFocus,
    onStopFocus: stopFocus,
    activeSession,
  };

  return (
    <main className={rootClass}>
      {!documentMode && (
        <WorkbenchSidebar
          section={section}
          counts={counts}
          inboxCount={inboxCount}
          collapsed={sidebarCollapsed}
          onSwitch={switchSection}
          onToggle={toggleSidebar}
          accountDock={accountDock}
        />
      )}

      {!documentMode && themeMode !== "minimal" && <MagicParticles intensity={themeMode === "immersive" ? 24 : 14} />}

      {documentMode ? (
        <section className="document-stage">
          {editing ? (
            <ArticleEditor
              draft={draft}
              projects={projects}
              saving={saving}
              onChange={setDraft}
              onCancel={() => selected ? setEditing(false) : closeDocument()}
              onSave={() => void saveDraft()}
            />
          ) : selected ? (
            <ArticleReader
              article={selected}
              saving={saving}
              onBack={closeDocument}
              onEdit={() => startEditing(selected)}
              onAppend={() => startEditing(selected, true)}
              onRemove={() => void removeArticle(selected)}
            />
          ) : null}
        </section>
      ) : section === "projects" ? (
        <ProjectWorkspace
          repository={projectRepository}
          projects={projects}
          initialProjectId={requestedProjectId}
          onProjectsChange={refreshProjects}
        />
      ) : section === "notes" ? (
        <NotesWorkspace
          articles={noteArticles}
          loading={loading}
          query={query}
          view={noteView}
          onQuery={setQuery}
          onView={setNoteView}
          onOpen={openArticle}
          onNew={startNewArticle}
        />
      ) : (
        <section className="workspace-main-stage">
          {section === "home" && <HomeDashboard today={today} tasks={workspaceTasks} articles={articles} weeklyFocus={weeklyFocus} onSaveWeeklyFocus={saveWeeklyFocus} onOpenArticle={openArticle} onOpenProject={openProject} onOpenTasks={() => switchSection("tasks")} {...taskActions} />}
          {section === "tasks" && <TasksPage today={today} tasks={workspaceTasks} projects={projects} projectDetails={projectDetails} onAddTask={addTask} onRestoreTask={restoreTask} onOpenProject={openProject} {...taskActions} />}
          {section === "explore" && <ExplorePage articles={articles} onSaveLink={saveExternalLink} onOpenArticle={openArticle} />}
          {section === "inbox" && <InboxPage articles={articles} projects={projects} onOpenArticle={openArticle} onNewCapture={() => setQuickCaptureOpen(true)} onMoveArticle={moveInboxArticle} onConvertToAction={convertInboxToAction} onConvertToProposal={convertInboxToProposal} />}
          {section === "review" && <ReviewPage projects={projects} articles={articles} tasks={workspaceTasks} weeklyFocus={weeklyFocus} closeouts={closeouts} today={today} onSaveCloseout={saveCloseout} />}
        </section>
      )}

      {quickCaptureOpen && (
        <div className="capture-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setQuickCaptureOpen(false);
        }}>
          <form className="capture-dialog" onSubmit={quickCapture}>
            <header><span>随手记录</span><button type="button" onClick={() => setQuickCaptureOpen(false)} aria-label="关闭快速记录">×</button></header>
            <h2>先把它留下来</h2>
            <p>不必分类、不必写完整，保存后会进入独立的待整理清单。</p>
            <textarea autoFocus value={quickText} onChange={(event) => setQuickText(event.target.value)} onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
            }} placeholder="一句念头、一段感受，或突然想写下的东西……" />
            <footer><span><kbd>Ctrl</kbd> + <kbd>Enter</kbd> 保存</span><button disabled={saving || !quickText.trim()} type="submit">{saving ? "正在保存…" : "放进待整理"}</button></footer>
          </form>
        </div>
      )}

      {message && <div className="desktop-toast" role="status">{message}</div>}
      {undoOffer && <div className="desktop-toast undo-toast" role="status"><span>{undoOffer.message}</span><button onClick={() => void runUndo()}>撤销</button></div>}
    </main>
  );
}

function WorkbenchSidebar({
  section,
  counts,
  inboxCount,
  collapsed,
  onSwitch,
  onToggle,
  accountDock,
}: {
  section: DeskSection;
  counts: Record<DeskSection, number | null>;
  inboxCount: number;
  collapsed: boolean;
  onSwitch: (section: DeskSection) => void;
  onToggle: () => void;
  accountDock: ReactNode;
}) {
  return (
    <aside className="workbench-sidebar">
      <button className="sidebar-collapse-toggle" onClick={onToggle} aria-label={collapsed ? "展开侧栏" : "收起侧栏"} title={collapsed ? "展开侧栏" : "收起侧栏"}>{collapsed ? "›" : "‹"}</button>
      <div className="sidebar-brand"><span className="sidebar-brand-mark"><WorkbenchIcon name="brand" /></span><span><strong>人生攻略库</strong><small>理清方向，留下成长</small></span></div>
      <nav className="sidebar-navigation" aria-label="工作台导航">
        {(["action", "knowledge"] as const).map((group) => (
          <div className="sidebar-group" key={group}>
            <span className="sidebar-caption">{group === "action" ? "行动" : "积累"}</span>
            {sections.filter((item) => item.group === group).map((item) => (
              <button className={section === item.id ? "active" : ""} key={item.id} onClick={() => onSwitch(item.id)} title={collapsed ? item.label : undefined} aria-label={item.label}>
                <i><WorkbenchIcon name={item.icon} /></i><span>{item.label}</span>{counts[item.id] !== null && <small>{counts[item.id]}</small>}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-foot">
        {accountDock}
      </div>
    </aside>
  );
}

function MagicParticles({ intensity }: { intensity: number }) {
  return <div className="magic-particles" aria-hidden="true">{Array.from({ length: intensity }, (_, index) => {
    const style = {
      "--particle-x": `${(index * 37 + 11) % 96}%`,
      "--particle-y": `${(index * 53 + 7) % 92}%`,
      "--particle-delay": `${-(index % 9) * 1.7}s`,
      "--particle-duration": `${12 + index % 8}s`,
      "--particle-size": `${2 + index % 4}px`,
    } as CSSProperties;
    return <i key={index} style={style} />;
  })}</div>;
}

function NotesWorkspace({ articles, loading, query, view, onQuery, onView, onOpen, onNew }: {
  articles: StoredArticle[];
  loading: boolean;
  query: string;
  view: NoteView;
  onQuery: (value: string) => void;
  onView: (view: NoteView) => void;
  onOpen: (article: StoredArticle) => void;
  onNew: () => void;
}) {
  return (
    <>
      <section className="notes-filter-pane">
        <header><span>知识积累</span><h1>笔记</h1><p>一条内容可以同时属于思考、经验与多个主题。</p></header>
        <nav>{noteViews.map((item) => <button className={view === item.id ? "active" : ""} key={item.id} onClick={() => onView(item.id)}><span>{item.label}</span><small>{item.id === "all" ? articles.length : ""}</small></button>)}</nav>
        <div><strong>分类原则</strong><p>不使用互斥文件夹。性质说明内容是什么，主题说明它在谈什么。</p></div>
      </section>
      <section className="notes-list-stage">
        <header className="notes-list-header"><div><strong>{noteViews.find((item) => item.id === view)?.label}</strong><span>{articles.length} 条</span></div><button onClick={onNew}>＋ 新建</button></header>
        <label className="desktop-search"><span>⌕</span><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索标题、正文、主题…" />{query && <button onClick={() => onQuery("")} aria-label="清空搜索">×</button>}</label>
        <div className="notes-card-list">
          {loading ? <div className="list-empty"><span>正在读取笔记…</span></div> : articles.length ? articles.map((article) => (
            <button key={article.id} onClick={() => onOpen(article)}>
              <span className="note-natures">{getNatures(article).slice(0, 2).map((nature) => <i key={nature}>{nature}</i>)}</span>
              <strong>{article.title}</strong>
              <p>{article.summary || plainExcerpt(article.body)}</p>
              <footer><span>{article.project || article.tags.slice(0, 2).join(" · ") || "未关联主题"}</span><time>{formatRelativeDate(article.updated || article.created)}</time></footer>
            </button>
          )) : <div className="list-empty"><span>{query ? "没有找到相关笔记" : "这个视图还没有内容"}</span><button onClick={onNew}>写下第一条</button></div>}
        </div>
      </section>
    </>
  );
}

function ArticleReader({ article, saving, onBack, onEdit, onAppend, onRemove }: {
  article: StoredArticle;
  saving: boolean;
  onBack: () => void;
  onEdit: () => void;
  onAppend: () => void;
  onRemove: () => void;
}) {
  const sourceUrl = article.source.find((item) => /^https?:\/\//i.test(item));
  return (
    <article className="desktop-reader immersive-reader">
      <header className="reader-toolbar">
        <button className="reader-back" onClick={onBack}>← 返回笔记</button>
        <div><span>最后修改于 {formatDate(article.updated || article.created)}</span><button disabled={saving} onClick={onRemove}>移除</button><button onClick={onAppend}>追加想法</button><button className="primary" onClick={onEdit}>编辑</button></div>
      </header>
      <div className="reader-scroll">
        <div className="reader-document">
          <div className="reader-kicker"><span>{article.collection === "sources" ? "探索资料" : "个人笔记"}</span><small>{formatDate(article.created)}</small></div>
          <h1>{article.title}</h1>
          <div className="reader-tags">
            {getNatures(article).map((nature) => <span className="nature" key={nature}>{nature}</span>)}
            {article.tags.map((tag) => <span key={tag}>#{tag}</span>)}
            {article.project && <span>关联：{article.project}</span>}
          </div>
          <MarkdownDocument body={article.body} title={article.title} />
          <footer className="reader-history"><div><strong>这篇内容仍可继续生长</strong><span>直接编辑会更新修改时间；“追加想法”会保留原文并增加带日期的新段落。</span></div>{sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer">打开原始来源 ↗</a>}</footer>
        </div>
      </div>
    </article>
  );
}

function ArticleEditor({ draft, projects, saving, onChange, onCancel, onSave }: {
  draft: Article;
  projects: ProjectSummary[];
  saving: boolean;
  onChange: (article: Article) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const natures = getNatures(draft);
  const sourceUrl = draft.source.find((item) => /^https?:\/\//i.test(item)) || "";
  const sourceKind = draft.source.find((item) => !/^https?:\/\//i.test(item)) || "自写";

  function update<Key extends keyof Article>(key: Key, value: Article[Key]) {
    onChange({ ...draft, [key]: value });
  }

  function toggleNature(nature: string) {
    const next = natures.includes(nature) ? natures.filter((item) => item !== nature) : [...natures, nature];
    update("type", (next.length ? next : ["思考"]).join("，"));
  }

  function updateSource(kind: string, url = sourceUrl) {
    update("source", [kind, ...(url.trim() ? [url.trim()] : [])]);
  }

  function insertMarkdown(before: string, after = "") {
    const input = bodyRef.current;
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selected = draft.body.slice(start, end);
    update("body", `${draft.body.slice(0, start)}${before}${selected}${after}${draft.body.slice(end)}`);
    window.setTimeout(() => { input.focus(); input.setSelectionRange(start + before.length, end + before.length); }, 0);
  }

  return (
    <div className="workbench-editor immersive-editor">
      <header className="editor-toolbar"><div><button onClick={onCancel}>← 取消</button><span>{draft.id ? "编辑笔记" : "新建笔记"}</span></div><div><small><kbd>Ctrl</kbd> + <kbd>S</kbd></small><button className="primary" disabled={saving} onClick={onSave}>{saving ? "保存中…" : "保存"}</button></div></header>
      <div className="editor-scroll"><div className="editor-paper">
        <input className="editor-title" autoFocus value={draft.title} onChange={(event) => update("title", event.target.value)} placeholder="这篇笔记的标题" />
        <div className="markdown-toolbar" aria-label="Markdown 格式工具"><button onClick={() => insertMarkdown("## ")}>标题</button><button onClick={() => insertMarkdown("**", "**")}>加粗</button><button onClick={() => insertMarkdown("> ")}>引用</button><button onClick={() => insertMarkdown("- ")}>列表</button><button onClick={() => insertMarkdown("[", "](https://)")}>链接</button><span>Markdown 会在阅读时完整排版</span></div>
        <textarea ref={bodyRef} className="editor-body" value={draft.body} onChange={(event) => update("body", event.target.value)} placeholder="从这里开始写。可以直接使用标题、列表、引用、链接、表格和任务清单……" />
        <section className="editor-metadata new-note-metadata">
          <header><div><strong>笔记关系</strong><span>都可以留空，保存不会被分类打断</span></div></header>
          <fieldset><legend>内容性质 · 可多选</legend><div className="nature-picker">{natureOptions.map((nature) => <button className={natures.includes(nature) ? "active" : ""} type="button" key={nature} onClick={() => toggleNature(nature)}>{nature}</button>)}</div></fieldset>
          <div className="metadata-grid">
            <label><span>主题</span><input value={draft.tags.join("，")} onChange={(event) => update("tags", splitTags(event.target.value))} placeholder="科研，创作，工具……" /></label>
            <label><span>关联项目</span><select value={draft.projectId || projects.find((project) => project.title === draft.project)?.id || ""} onChange={(event) => { const project = projects.find((item) => item.id === event.target.value); onChange({ ...draft, projectId: project?.id || "", project: project?.title || "" }); }}><option value="">不关联项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
            <label><span>来源</span><select value={sourceKind} onChange={(event) => updateSource(event.target.value)}>{sourceOptions.map((source) => <option key={source}>{source}</option>)}</select></label>
            <label><span>来源链接</span><input type="url" value={sourceUrl} onChange={(event) => updateSource(sourceKind, event.target.value)} placeholder="可选" /></label>
          </div>
          <small className="metadata-auto-note">摘要、创建时间、修改时间和版本信息由系统自动维护。</small>
        </section>
      </div></div>
    </div>
  );
}

function matchesNoteView(article: StoredArticle, view: NoteView) {
  if (view === "all") return true;
  const natures = getNatures(article);
  const topics = article.tags.join(" ") + article.project;
  if (view === "thoughts") return natures.some((item) => ["思考", "灵感", "问题"].includes(item));
  if (view === "experience") return natures.some((item) => ["经验", "方法", "复盘"].includes(item));
  if (view === "research") return /科研|研究|论文|学习|学术/.test(topics + article.collectionLabel);
  return /创作|小说|视频|写作|术途异道/.test(topics + article.body);
}

function getNatures(article: Pick<Article, "type">) {
  const values = article.type.split(/[，,]/).map((item) => item.trim()).filter(Boolean);
  if (!values.length || values.every((item) => item === "记录" || item === "文章")) return ["思考"];
  return values.filter((item) => item !== "记录" && item !== "文章");
}

function articleSearchText(article: StoredArticle) {
  return [article.title, article.summary, article.body, article.project, article.type, article.tags.join(" ")].join(" ").toLocaleLowerCase("zh-CN");
}

function toEditableArticle(article: StoredArticle): Article {
  return { ...article, tags: [...article.tags], source: [...article.source] };
}

function splitTags(value: string) {
  return Array.from(new Set(value.split(/[，,]/).map((item) => item.trim()).filter(Boolean)));
}

function captureTitle(text: string) {
  const first = text.split("\n").find((line) => line.trim())?.trim() || "一条未命名灵感";
  return first.length > 34 ? `${first.slice(0, 34)}…` : first;
}

function plainExcerpt(text: string) {
  return text.replace(/[#>*`\-\[\]()]/g, "").replace(/\s+/g, " ").trim().slice(0, 92);
}

function linkPlatform(value: string) {
  try {
    const host = new URL(value).hostname.toLocaleLowerCase();
    if (host.includes("bilibili")) return "哔哩哔哩";
    if (host.includes("douyin")) return "抖音";
    if (host.includes("zhihu")) return "知乎";
    if (host.includes("github")) return "GitHub";
    return host.replace(/^www\./, "");
  } catch {
    return "外部链接";
  }
}

function localDate(value = new Date()) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 10);
}

function startOfMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

function startOfLocalWeekDate() {
  const date = new Date();
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return localDate(date);
}

function formatDate(value: string) {
  return value ? value.slice(0, 10).replaceAll("-", ".") : "未记录日期";
}

function formatRelativeDate(value: string) {
  if (!value) return "未记录";
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  const diff = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 7) return `${diff} 天前`;
  return formatDate(value);
}

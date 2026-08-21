import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as readAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { ArticleRepository } from "../app/data/article-repository";
import { isSourceArticle, isThoughtInboxArticle } from "../app/article-helpers";
import { localDate } from "../app/date-helpers";
import { inferLifeDomain, LIFE_DOMAIN_LABELS, LIFE_DOMAIN_OPTIONS, type LifeDomain } from "../app/domain-taxonomy";
import type { ProjectRepository } from "../app/data/project-repository";
import type { WorkRepository } from "../app/data/work-repository";
import { rootProjectStatusCounts } from "../app/project-selectors";
import type { ProjectDetail, ProjectProposal, ProjectSummary, ProjectTask } from "../app/project-types";
import type { Article, StoredArticle } from "../app/types";
import { workspaceTitle, type QuickLink } from "../app/workspace-preferences";
import type { DailyCloseout, FocusSession, TaskPlan, WeeklyFocus } from "../app/work-types";
import { MarkdownDocument } from "./MarkdownDocument";
import { ProjectWorkspace } from "./ProjectWorkspace";
import {
  DEFAULT_UPDATE_PROXY_PORT,
  loadUpdateProxyPort,
  saveUpdateProxyPort,
  validateUpdateProxyPort,
} from "./updateProxy";
import { WorkbenchIcon, type WorkbenchIconName } from "./WorkbenchIcon";
import { SearchField, SelectMenu, useConfirmDialog } from "./DesktopControls";
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

type DeskSection = "home" | "tasks" | "projects" | "notes" | "explore" | "inbox" | "review" | "settings";
type NoteView = "recent" | "knowledge" | "ideas" | "methods" | "experience" | "decisions" | "review";
type UndoOffer = { message: string; run: () => Promise<void> };
type ArticleEditorField = "title" | "body" | "tags" | "sourceUrl";
type ArticleEditorSelection = {
  field: ArticleEditorField;
  start: number;
  end: number;
  inputScrollTop: number;
  editorScrollTop: number;
};
type ArticleEditorHistoryEntry = { article: Article; selection: ArticleEditorSelection | null };

type DesktopWorkbenchProps = {
  repository: ArticleRepository;
  projectRepository: ProjectRepository;
  workRepository: WorkRepository;
  displayName: string;
  quickLinks: QuickLink[];
  dataRevision: number;
  onRepositoryChange?: () => void;
  onEditingStateChange?: (editing: boolean) => void;
  accountDock: ReactNode;
  themeMode: ThemeMode;
  backingUp: boolean;
  onThemeChange: (mode: ThemeMode) => void;
  onCreateBackup: () => void;
  onRestoreBackup: () => void;
  onSaveDisplayName: (name: string) => Promise<void>;
  onSaveQuickLinks: (links: QuickLink[]) => Promise<void>;
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
  { id: "recent", label: "最近更新" },
  { id: "knowledge", label: "知识" },
  { id: "ideas", label: "想法" },
  { id: "methods", label: "方法" },
  { id: "experience", label: "经验" },
  { id: "decisions", label: "决策" },
  { id: "review", label: "复盘" },
];

const natureOptions = ["知识", "想法", "方法", "经验", "决策", "复盘"];
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
  category: "uncategorized",
  tags: [],
  type: "想法",
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
  displayName,
  quickLinks,
  dataRevision,
  onRepositoryChange,
  onEditingStateChange,
  accountDock,
  themeMode,
  backingUp,
  onThemeChange,
  onCreateBackup,
  onRestoreBackup,
  onSaveDisplayName,
  onSaveQuickLinks,
}: DesktopWorkbenchProps) {
  const confirm = useConfirmDialog();
  const [articles, setArticles] = useState<StoredArticle[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectDetails, setProjectDetails] = useState<ProjectDetail[]>([]);
  const [plans, setPlans] = useState<TaskPlan[]>([]);
  const [activeSession, setActiveSession] = useState<FocusSession | null>(null);
  const [weeklyFocus, setWeeklyFocus] = useState<WeeklyFocus | null>(null);
  const [closeouts, setCloseouts] = useState<DailyCloseout[]>([]);
  const [section, setSection] = useState<DeskSection>("home");
  const [noteView, setNoteView] = useState<NoteView>("recent");
  const [noteDomain, setNoteDomain] = useState<"all" | LifeDomain>("all");
  const [requestedProjectId, setRequestedProjectId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [appending, setAppending] = useState(false);
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
  const [today, setToday] = useState(() => localDate());

  useEffect(() => {
    const refreshDate = () => setToday(localDate());
    const timer = window.setInterval(refreshDate, 60_000);
    window.addEventListener("focus", refreshDate);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshDate);
    };
  }, []);

  useEffect(() => {
    onEditingStateChange?.(editing || (quickCaptureOpen && Boolean(quickText.trim())));
  }, [editing, onEditingStateChange, quickCaptureOpen, quickText]);

  useEffect(() => () => onEditingStateChange?.(false), [onEditingStateChange]);

  useEffect(() => {
    const hasUnsavedInput = (editing && draftDirty) || (quickCaptureOpen && Boolean(quickText.trim()));
    if (!hasUnsavedInput) return;
    const preventClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventClose);
    return () => window.removeEventListener("beforeunload", preventClose);
  }, [draftDirty, editing, quickCaptureOpen, quickText]);

  useEffect(() => () => {
    if (messageTimer.current) window.clearTimeout(messageTimer.current);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
  }, []);

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
    const [nextPlans, nextActive, nextFocus, nextCloseouts] = await Promise.all([
      workRepository.listPlans(),
      workRepository.getActiveSession(),
      workRepository.getWeeklyFocus(weekStart),
      workRepository.listDailyCloseouts(weekStart),
    ]);
    setPlans(nextPlans);
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
    if (!dataRevision) return;
    void refreshArticles().catch((error) => {
      showMessage(error instanceof Error ? error.message : "同步后无法刷新笔记列表");
    });
  }, [dataRevision, refreshArticles, showMessage]);

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
    /** 全局键盘处理：modal 弹层（更新/账户）打开时忽略 Escape，避免穿透到背后文档。 */
    function handleKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (document.querySelector(".update-backdrop, .account-backdrop")) return;
        if (quickCaptureOpen) closeQuickCapture();
        else if (selectedId || editing) requestCloseDocument();
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

  const inboxCount = useMemo(() => articles.filter(isThoughtInboxArticle).length, [articles]);
  const noteArticles = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    return articles.filter((article) => {
      if (isSourceArticle(article) || isThoughtInboxArticle(article)) return false;
      if (noteDomain !== "all" && articleLifeDomain(article) !== noteDomain) return false;
      if (!needle && !matchesNoteView(article, noteView)) return false;
      return !needle || articleSearchText(article).includes(needle);
    });
  }, [articles, noteDomain, noteView, query]);

  const projectCounts = rootProjectStatusCounts(projects);
  const counts: Record<DeskSection, number | null> = {
    home: null,
    tasks: workspaceTasks.filter((task) => task.status !== "done" && task.plan?.plannedDate === today).length,
    projects: projectCounts.active,
    notes: articles.filter((article) => !isSourceArticle(article) && !isThoughtInboxArticle(article)).length,
    explore: articles.filter(isSourceArticle).filter((article) => article.branch !== "已归档").length,
    inbox: inboxCount,
    review: null,
    settings: null,
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
    setDraftDirty(false);
    setEditing(false);
    setAppending(false);
  }

  function startNewArticle() {
    setSelectedId(null);
    setDraft({ ...emptyDraft, tags: [], source: ["自写"], created: today });
    setDraftDirty(false);
    setEditing(true);
    setAppending(false);
  }

  function startEditing(article: StoredArticle, append = false) {
    const next = toEditableArticle(article);
    if (append) next.body = `${next.body.trim()}\n\n## ${today} · 追加想法\n\n`;
    setDraft(next);
    setDraftDirty(false);
    setEditing(true);
    setAppending(append);
  }

  function closeDocument() {
    setDraftDirty(false);
    setEditing(false);
    setAppending(false);
    setSelectedId(null);
    setDraft({ ...emptyDraft });
  }

  async function requestCloseDocument() {
    if (editing && draftDirty && !await confirm({ title: "放弃未保存的修改？", description: "这次编辑的内容尚未保存，关闭后无法恢复。", confirmLabel: "放弃修改", tone: "warning" })) return false;
    closeDocument();
    return true;
  }

  async function closeQuickCapture() {
    if (quickText.trim() && !await confirm({ title: "放弃这条快速记录？", description: "尚未保存的文字会丢失。", confirmLabel: "放弃记录", tone: "warning" })) return false;
    setQuickText("");
    setQuickCaptureOpen(false);
    return true;
  }

  async function persist(article: Article, success: string, selectAfterSave = true) {
    setSaving(true);
    try {
      const saved = await repository.save(article);
      await refreshArticles();
      if (selectAfterSave) setSelectedId(saved.id);
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
    const body = draft.body;
    if (!title || !body.trim()) {
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
      category: draft.collection === "sources" ? "探索资料" : articleLifeDomain(draft),
      branch: draft.branch === "待分类" ? "已整理" : draft.branch || "已整理",
      summary: plainExcerpt(body),
      next: "",
    }, draft.id ? "修改已经保存。" : "笔记已经保存。 ");
    if (saved) {
      setDraft(toEditableArticle(saved));
      setDraftDirty(false);
      setEditing(false);
      setAppending(false);
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
      type: "想法",
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
    const saved = await persist({
      ...emptyDraft,
      collection: "sources",
      collectionLabel: "探索资料",
      category: "探索资料",
      type: "外部资料",
      title,
      body: `${note ? `${note}\n\n` : ""}[打开原内容](${url})`,
      source: [platform, url],
      branch: "收藏中",
      stage: "已收藏",
      summary: note || `来自 ${platform} 的收藏`,
      created: today,
    }, "链接已经收进探索库。 ", false);
    return Boolean(saved);
  }

  async function removeArticle(article: StoredArticle) {
    const source = isSourceArticle(article);
    if (!await confirm({
      title: `删除《${article.title}》？`,
      description: source ? "这条收藏会从探索库删除，删除后可在提示消失前撤销。" : "这篇笔记会被删除，删除后可在提示消失前撤销。",
      confirmLabel: "删除",
      tone: "danger",
    })) return;
    setSaving(true);
    try {
      await repository.remove(article.id);
      await refreshArticles();
      closeDocument();
      onRepositoryChange?.();
      offerUndo(source ? "收藏已经删除" : "笔记已经删除", async () => {
        await repository.restore(article.id);
        await refreshArticles();
        onRepositoryChange?.();
      });
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "删除失败");
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

  async function removeTask(task: ProjectTask) {
    if (!await confirm({
      title: `删除行动“${task.title}”？`,
      description: "它会从项目和今日安排中移除；已产生的专注记录会保留。删除后可在 8 秒内撤销。",
      confirmLabel: "删除行动",
      tone: "danger",
    })) return;
    try {
      if (activeSession?.taskId === task.id) await workRepository.stopSession(activeSession.id);
      await projectRepository.removeTask(task.id);
      await Promise.all([refreshProjects(), refreshWork()]);
      offerUndo("行动已经删除", async () => {
        await projectRepository.restoreTask(task.id);
        await Promise.all([refreshProjects(), refreshWork()]);
      });
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "无法删除行动");
    }
  }

  async function createTask(input: NewActionInput) {
    const now = new Date().toISOString();
    const task: ProjectTask = {
      id: "",
      projectId: input.projectId,
      milestoneId: input.milestoneId,
      title: input.title,
      actionType: "organize",
      details: input.details,
      benefit: "",
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
      return true;
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "无法添加任务");
      return false;
    }
  }

  async function addTask(input: NewActionInput) {
    await createTask(input);
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
      category: destination === "explore" ? "探索资料" : articleLifeDomain(article),
      type: destination === "explore" ? "外部资料" : article.type === "外部资料" ? "想法" : article.type,
      branch: destination === "explore" ? "收藏中" : "已整理",
    }, destination === "explore" ? "已转入探索库。" : "已整理为笔记。");
    if (saved) closeDocument();
  }

  async function convertInboxToAction(article: StoredArticle, projectId: string) {
    const project = projectDetails.find((item) => item.project.id === projectId);
    if (!project) return;
    const created = await createTask({
      projectId,
      milestoneId: project.milestones.find((item) => item.status === "current")?.id ?? null,
      title: article.title,
      details: article.body,
      dueDate: "",
      plannedToday: false,
    });
    if (created) await finishConvertedCapture(article, "已转为项目行动，原收藏已归档。");
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
      await finishConvertedCapture(article, "已转为项目提案，原收藏已归档。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "转为提案失败");
    }
  }

  async function finishConvertedCapture(article: StoredArticle, sourceMessage: string) {
    if (isSourceArticle(article)) {
      await persist({ ...article, branch: "已归档" }, sourceMessage, false);
      return;
    }
    await moveInboxArticle(article, "note");
  }

  async function archiveSource(article: StoredArticle, archived: boolean) {
    await persist({ ...article, branch: archived ? "已归档" : "收藏中" }, archived ? "收藏已经归档。" : "收藏已经恢复。", false);
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
        title={workspaceTitle(displayName)}
          collapsed={sidebarCollapsed}
          onSwitch={switchSection}
          onToggle={toggleSidebar}
          accountDock={accountDock}
        />
      )}

      {!documentMode && themeMode !== "minimal" && (
        <MagicParticles intensity={themeMode === "immersive" ? 12 : 8} />
      )}

      {documentMode ? (
        <section className="document-stage">
          {editing ? (
            <ArticleEditor
              draft={draft}
              projects={projects}
              saving={saving}
              appendMode={appending}
              onChange={(next) => {
                setDraft(next);
                setDraftDirty(true);
              }}
              onCancel={requestCloseDocument}
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
          onBackToHall={() => setRequestedProjectId(null)}
          onRemoveTask={removeTask}
        />
      ) : section === "notes" ? (
        <NotesWorkspace
          articles={noteArticles}
          loading={loading}
          query={query}
          view={noteView}
          domain={noteDomain}
          onQuery={setQuery}
          onView={setNoteView}
          onDomain={setNoteDomain}
          onOpen={openArticle}
          onNew={startNewArticle}
        />
      ) : (
        <section className="workspace-main-stage">
          {section === "home" && <HomeDashboard today={today} tasks={workspaceTasks} articles={articles} weeklyFocus={weeklyFocus} quickLinks={quickLinks} onSaveQuickLinks={onSaveQuickLinks} onSaveWeeklyFocus={saveWeeklyFocus} onOpenArticle={openArticle} onOpenProject={openProject} onOpenTasks={() => switchSection("tasks")} {...taskActions} />}
          {section === "tasks" && <TasksPage today={today} tasks={workspaceTasks} projects={projects} projectDetails={projectDetails} onAddTask={addTask} onRestoreTask={restoreTask} onRemoveTask={removeTask} onOpenProject={openProject} {...taskActions} />}
          {section === "explore" && <ExplorePage articles={articles} onSaveLink={saveExternalLink} onArchive={archiveSource} onDelete={removeArticle} />}
          {section === "inbox" && <InboxPage articles={articles} projects={projects} onOpenArticle={openArticle} onNewCapture={() => setQuickCaptureOpen(true)} onMoveArticle={moveInboxArticle} onConvertToAction={convertInboxToAction} onConvertToProposal={convertInboxToProposal} onDelete={removeArticle} />}
          {section === "review" && <ReviewPage projects={projects} projectDetails={projectDetails} articles={articles} tasks={workspaceTasks} weeklyFocus={weeklyFocus} closeouts={closeouts} today={today} onSaveCloseout={saveCloseout} />}
          {section === "settings" && <SettingsPage displayName={displayName} themeMode={themeMode} backingUp={backingUp} onSaveDisplayName={onSaveDisplayName} onThemeChange={onThemeChange} onCreateBackup={onCreateBackup} onRestoreBackup={onRestoreBackup} />}
        </section>
      )}

      {quickCaptureOpen && (
        <div className="capture-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) closeQuickCapture();
        }}>
          <form className="capture-dialog" onSubmit={quickCapture}>
            <header><span>随手记录</span><button type="button" onClick={closeQuickCapture} aria-label="关闭快速记录">×</button></header>
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
  title,
}: {
  section: DeskSection;
  counts: Record<DeskSection, number | null>;
  inboxCount: number;
  collapsed: boolean;
  onSwitch: (section: DeskSection) => void;
  onToggle: () => void;
  accountDock: ReactNode;
  title: string;
}) {
  return (
    <aside className="workbench-sidebar">
      <button className="sidebar-collapse-toggle" onClick={onToggle} aria-label={collapsed ? "展开侧栏" : "收起侧栏"} title={collapsed ? "展开侧栏" : "收起侧栏"}>{collapsed ? "›" : "‹"}</button>
      <div className="sidebar-brand"><span className="sidebar-brand-mark"><WorkbenchIcon name="brand" /></span><span><strong title={title}>{title}</strong><small>理清方向，留下成长</small></span></div>
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
        <button className={`settings-nav-entry ${section === "settings" ? "active" : ""}`} onClick={() => onSwitch("settings")} title={collapsed ? "设置" : undefined} aria-label="设置"><i><WorkbenchIcon name="settings" /></i><span>设置</span></button>
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
      "--particle-size": `${2 + index % 4}px`,
    } as CSSProperties;
    return <i key={index} style={style} />;
  })}</div>;
}

function SettingsPage({ displayName, themeMode, backingUp, onSaveDisplayName, onThemeChange, onCreateBackup, onRestoreBackup }: {
  displayName: string;
  themeMode: ThemeMode;
  backingUp: boolean;
  onThemeChange: (mode: ThemeMode) => void;
  onCreateBackup: () => void;
  onRestoreBackup: () => void;
  onSaveDisplayName: (name: string) => Promise<void>;
}) {
  const [nameDraft, setNameDraft] = useState(displayName);
  const [nameMessage, setNameMessage] = useState("");
  const [updateProxyPort, setUpdateProxyPort] = useState(loadUpdateProxyPort);
  const [proxyMessage, setProxyMessage] = useState("");
  const [autostartOn, setAutostartOn] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartMessage, setAutostartMessage] = useState("");

  useEffect(() => setNameDraft(displayName), [displayName]);

  async function saveName(event: FormEvent) {
    event.preventDefault();
    await onSaveDisplayName(nameDraft);
    setNameMessage(nameDraft.trim() ? `工作台将显示为“${workspaceTitle(nameDraft)}”。` : "已恢复为“个人工作台”。");
  }

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    readAutostartEnabled()
      .then((enabled) => {
        if (!cancelled) setAutostartOn(enabled);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /** 切换开机自启动：写入系统启动项，成功后回显状态，失败时保留原开关并提示。 */
  async function toggleAutostart() {
    if (autostartBusy) return;
    setAutostartBusy(true);
    setAutostartMessage("");
    try {
      if (autostartOn) {
        await disableAutostart();
        setAutostartOn(false);
        setAutostartMessage("已关闭，下次开机不会再自动启动。");
      } else {
        await enableAutostart();
        setAutostartOn(true);
        setAutostartMessage("已开启，下次开机后会自动启动并停留在托盘。");
      }
    } catch (error) {
      setAutostartMessage(
        error instanceof Error ? `设置未生效：${error.message}` : "设置开机自启动失败，请稍后重试。",
      );
    } finally {
      setAutostartBusy(false);
    }
  }

  function saveProxySettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const error = validateUpdateProxyPort(updateProxyPort);
    if (error) {
      setProxyMessage(error);
      return;
    }

    const normalized = updateProxyPort.trim();
    try {
      saveUpdateProxyPort(normalized);
      setUpdateProxyPort(normalized);
      setProxyMessage(normalized ? "已保存，下次检查更新时生效。" : "已关闭指定代理，将使用系统网络。");
    } catch {
      setProxyMessage("保存失败，请稍后重试。");
    }
  }

  return (
    <div className="settings-page workspace-scroll">
      <header className="workspace-page-heading"><div><h1>设置</h1><p>统一管理外观、数据与以后新增的工作台偏好。</p></div></header>
      <div className="settings-grid">
        <section className="workspace-card settings-section settings-identity-section">
          <header><span>身份</span><h2>工作台称呼</h2><p>只用于这台设备上的标题展示，不会修改同步账户。</p></header>
          <form className="settings-name-form" onSubmit={saveName}>
            <label htmlFor="workspace-display-name">你的名称</label>
            <div><input id="workspace-display-name" maxLength={24} value={nameDraft} onChange={(event) => { setNameDraft(event.target.value); setNameMessage(""); }} placeholder="例如：小洛" /><button type="submit">保存称呼</button></div>
            <small>预览：{workspaceTitle(nameDraft)} · 最多 24 个字符</small>
            <p role="status">{nameMessage}</p>
          </form>
        </section>
        <section className="workspace-card settings-section">
          <header><span>外观</span><h2>主题与阅读氛围</h2><p>只改变视觉强度，不影响资料内容。</p></header>
          <div className="settings-theme-options">{([ ["minimal", "简洁", "更少装饰，优先清晰阅读"], ["magic", "魔法", "保留主题氛围与轻量粒子"], ["immersive", "沉浸", "完整背景与更强视觉层次"] ] as const).map(([value, label, description]) => <button className={themeMode === value ? "active" : ""} key={value} onClick={() => onThemeChange(value)}><i>{themeMode === value ? "✓" : ""}</i><span><strong>{label}</strong><small>{description}</small></span></button>)}</div>
        </section>
        <section className="workspace-card settings-section settings-startup-section">
          <header><span>启动</span><h2>开机自启动</h2><p>登录系统后自动在后台启动应用，随时可以在这里关闭。</p></header>
          <div className="settings-toggle-row">
            <button
              type="button"
              role="switch"
              aria-checked={autostartOn}
              disabled={autostartBusy}
              className={autostartOn ? "settings-switch on" : "settings-switch"}
              onClick={() => void toggleAutostart()}
              aria-describedby="settings-autostart-message"
            >
              <i />
            </button>
            <div>
              <strong>{autostartBusy ? "正在保存…" : autostartOn ? "已开启" : "已关闭"}</strong>
              <small>开启后，电脑开机登录时会自动启动个人工作台并停留在系统托盘。</small>
            </div>
          </div>
          <p className="settings-toggle-message" id="settings-autostart-message" role="status">{autostartMessage}</p>
        </section>
        <section className="workspace-card settings-section settings-data-section">
          <header><span>数据</span><h2>备份与恢复</h2><p>项目、行动、笔记和回顾会一起保存在完整本地备份中。</p></header>
          <div className="settings-data-actions">
            <button disabled={backingUp} onClick={onCreateBackup}><i>⇩</i><span><strong>{backingUp ? "正在备份" : "创建本地备份"}</strong><small>导出当前资料库的完整副本</small></span></button>
            <button disabled={backingUp} onClick={onRestoreBackup}><i>↺</i><span><strong>恢复最近备份</strong><small>恢复前会自动保留当前资料库</small></span></button>
          </div>
          <aside><strong>数据边界</strong><p>云同步目前覆盖笔记；跨设备迁移完整工作台时，请使用这里的本地备份。</p></aside>
        </section>
        <section className="workspace-card settings-section settings-network-section">
          <header><span>更新网络</span><h2>本地代理端口</h2><p>仅用于检查和下载应用更新，不影响同步与其他网络请求。</p></header>
          <form className="settings-proxy-form" onSubmit={saveProxySettings}>
            <label htmlFor="update-proxy-port">HTTP 代理端口</label>
            <div>
              <span>127.0.0.1</span>
              <input
                id="update-proxy-port"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={updateProxyPort}
                onChange={(event) => {
                  setUpdateProxyPort(event.target.value);
                  setProxyMessage("");
                }}
                placeholder={DEFAULT_UPDATE_PROXY_PORT}
                aria-describedby="update-proxy-help update-proxy-message"
              />
              <button type="submit">保存</button>
            </div>
            <small id="update-proxy-help">默认 {DEFAULT_UPDATE_PROXY_PORT}；留空后仅使用系统网络。代理连接失败时也会自动回退到系统网络。</small>
            <p id="update-proxy-message" role="status">{proxyMessage}</p>
          </form>
        </section>
      </div>
    </div>
  );
}

function NotesWorkspace({ articles, loading, query, view, domain, onQuery, onView, onDomain, onOpen, onNew }: {
  articles: StoredArticle[];
  loading: boolean;
  query: string;
  view: NoteView;
  domain: "all" | LifeDomain;
  onQuery: (value: string) => void;
  onView: (view: NoteView) => void;
  onDomain: (domain: "all" | LifeDomain) => void;
  onOpen: (article: StoredArticle) => void;
  onNew: () => void;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <>
      <section className="notes-filter-pane">
        <header><div><span>知识积累</span><button className="notes-help-toggle" aria-label="查看笔记分类说明" aria-expanded={helpOpen} onClick={() => setHelpOpen((value) => !value)}>?</button></div><h1>笔记</h1><p>先看内容性质，也可以按生活领域缩小范围。</p></header>
        <nav>{noteViews.map((item) => <button className={view === item.id ? "active" : ""} key={item.id} onClick={() => onView(item.id)}><span>{item.label}</span></button>)}</nav>
        <label className="notes-domain-filter"><span>所属领域</span><SelectMenu label="按领域筛选笔记" value={domain} onChange={(value) => onDomain(value as "all" | LifeDomain)} options={[{ value: "all", label: "不限领域" }, ...LIFE_DOMAIN_OPTIONS]} /></label>
        {helpOpen && <aside className="notes-help-popover" role="dialog" aria-label="笔记分类说明"><header><strong>笔记如何分类</strong><button aria-label="关闭说明" onClick={() => setHelpOpen(false)}>×</button></header><p>领域说明内容与生活的哪一部分有关；性质说明这篇内容本身是什么。</p><dl><div><dt>领域</dt><dd>与项目共用学习、工作、创作、生活等九个稳定入口。</dd></div><div><dt>性质</dt><dd>知识、想法、方法、经验、决策或复盘，可以多选。</dd></div><div><dt>主题</dt><dd>继续自由填写更具体的关键词。</dd></div></dl></aside>}
      </section>
      <section className="notes-list-stage">
        <header className="notes-list-header"><div><strong>{query ? "搜索结果" : noteViews.find((item) => item.id === view)?.label}</strong><span>{articles.length} 条</span></div><button onClick={onNew}>＋ 新建</button></header>
        <SearchField value={query} onChange={onQuery} placeholder="搜索标题、正文、主题…" label="搜索笔记" />
        <div className="notes-card-list">
          {loading ? <div className="list-empty"><span>正在读取笔记…</span></div> : articles.length ? articles.map((article) => (
            <button key={article.id} onClick={() => onOpen(article)}>
              <span className="note-natures">{getNatures(article).slice(0, 2).map((nature) => <i key={nature}>{nature}</i>)}</span>
              <strong>{article.title}</strong>
              <p>{article.summary || plainExcerpt(article.body)}</p>
              <footer><span>{LIFE_DOMAIN_LABELS[articleLifeDomain(article)]}{article.project ? ` · ${article.project}` : ""}</span><time>{formatRelativeDate(article.updated || article.created)}</time></footer>
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
        <div><span>最后修改于 {formatDate(article.updated || article.created)}</span><button className="danger" disabled={saving} onClick={onRemove}>删除</button><button className="primary" onClick={onEdit}>编辑</button></div>
      </header>
      <div className="reader-scroll">
        <div className="reader-document">
          <div className="reader-kicker"><span>{article.collection === "sources" ? "探索资料" : LIFE_DOMAIN_LABELS[articleLifeDomain(article)]}</span><small>{formatDate(article.created)}</small></div>
          <h1>{article.title}</h1>
          <div className="reader-tags">
            {getNatures(article).map((nature) => <span className="nature" key={nature}>{nature}</span>)}
            {article.tags.map((tag) => <span key={tag}>#{tag}</span>)}
            {article.project && <span>关联：{article.project}</span>}
          </div>
          <MarkdownDocument body={article.body} title={article.title} />
          <footer className="reader-history"><div><strong>读到这里，有新的想法吗？</strong><span>追加会在原文末尾新建一个带日期的段落，保留前文的连贯性。</span></div><div className="reader-history-actions">{sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer">打开原始来源 ↗</a>}<button onClick={onAppend}>＋ 在文末追加想法</button></div></footer>
        </div>
      </div>
    </article>
  );
}

function ArticleEditor({ draft, projects, saving, appendMode, onChange, onCancel, onSave }: {
  draft: Article;
  projects: ProjectSummary[];
  saving: boolean;
  appendMode: boolean;
  onChange: (article: Article) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const editorScrollRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const tagsRef = useRef<HTMLInputElement>(null);
  const sourceUrlRef = useRef<HTMLInputElement>(null);
  const beforeInputSelectionRef = useRef<ArticleEditorSelection | null>(null);
  const pasteStatusTimerRef = useRef<number | null>(null);
  const undoHistoryRef = useRef<ArticleEditorHistoryEntry[]>([]);
  const redoHistoryRef = useRef<ArticleEditorHistoryEntry[]>([]);
  const [historyAvailability, setHistoryAvailability] = useState({ canUndo: false, canRedo: false });
  const [previewVisible, setPreviewVisible] = useState(true);
  const [pasteStatus, setPasteStatus] = useState("");
  const natures = getNatures(draft);
  const sourceUrl = draft.source.find((item) => /^https?:\/\//i.test(item)) || "";
  const sourceKind = draft.source.find((item) => !/^https?:\/\//i.test(item)) || "自写";

  useEffect(() => {
    if (!appendMode || !bodyRef.current) return;
    const input = bodyRef.current;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    window.setTimeout(() => input.scrollIntoView({ block: "end", behavior: "smooth" }), 0);
  }, [appendMode]);

  useEffect(() => () => {
    if (pasteStatusTimerRef.current) window.clearTimeout(pasteStatusTimerRef.current);
  }, []);

  function syncHistoryAvailability() {
    setHistoryAvailability({
      canUndo: undoHistoryRef.current.length > 0,
      canRedo: redoHistoryRef.current.length > 0,
    });
  }

  function inputForField(field: ArticleEditorField) {
    if (field === "title") return titleRef.current;
    if (field === "body") return bodyRef.current;
    if (field === "tags") return tagsRef.current;
    return sourceUrlRef.current;
  }

  function captureSelection(field: ArticleEditorField, input: HTMLInputElement | HTMLTextAreaElement) {
    return {
      field,
      start: input.selectionStart ?? 0,
      end: input.selectionEnd ?? input.selectionStart ?? 0,
      inputScrollTop: input.scrollTop,
      editorScrollTop: editorScrollRef.current?.scrollTop ?? 0,
    } satisfies ArticleEditorSelection;
  }

  function selectionForTarget(target: EventTarget | null) {
    if (target === titleRef.current && titleRef.current) return captureSelection("title", titleRef.current);
    if (target === bodyRef.current && bodyRef.current) return captureSelection("body", bodyRef.current);
    if (target === tagsRef.current && tagsRef.current) return captureSelection("tags", tagsRef.current);
    if (target === sourceUrlRef.current && sourceUrlRef.current) return captureSelection("sourceUrl", sourceUrlRef.current);
    return null;
  }

  function rememberSelection(field: ArticleEditorField, input: HTMLInputElement | HTMLTextAreaElement) {
    beforeInputSelectionRef.current = captureSelection(field, input);
  }

  function takePreviousSelection() {
    const selection = beforeInputSelectionRef.current ?? selectionForTarget(document.activeElement);
    beforeInputSelectionRef.current = null;
    return selection;
  }

  function commit(next: Article, previousSelection: ArticleEditorSelection | null = takePreviousSelection()) {
    undoHistoryRef.current.push({ article: draft, selection: previousSelection });
    if (undoHistoryRef.current.length > 150) undoHistoryRef.current.shift();
    redoHistoryRef.current = [];
    onChange(next);
    syncHistoryAvailability();
  }

  function restoreInputSelection(selection: ArticleEditorSelection | null) {
    if (!selection) return;
    window.requestAnimationFrame(() => {
      const input = inputForField(selection.field);
      if (!input) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(
        Math.min(selection.start, input.value.length),
        Math.min(selection.end, input.value.length),
      );
      input.scrollTop = selection.inputScrollTop;
      if (editorScrollRef.current) editorScrollRef.current.scrollTop = selection.editorScrollTop;
    });
  }

  function stepHistory(direction: "undo" | "redo", focusTarget: EventTarget | null = null) {
    const from = direction === "undo" ? undoHistoryRef.current : redoHistoryRef.current;
    const to = direction === "undo" ? redoHistoryRef.current : undoHistoryRef.current;
    const next = from.pop();
    if (!next) return false;
    to.push({ article: draft, selection: selectionForTarget(focusTarget) ?? selectionForTarget(document.activeElement) });
    onChange(next.article);
    syncHistoryAvailability();
    restoreInputSelection(next.selection);
    return true;
  }

  function handleEditorKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const currentSelection = selectionForTarget(event.target);
    if (currentSelection && !(event.ctrlKey || event.metaKey || event.altKey)) {
      beforeInputSelectionRef.current = currentSelection;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    const direction = key === "y" || (key === "z" && event.shiftKey) ? "redo" : key === "z" ? "undo" : null;
    if (!direction) return;
    if (stepHistory(direction, event.target)) event.preventDefault();
  }

  function update<Key extends keyof Article>(key: Key, value: Article[Key]) {
    commit({ ...draft, [key]: value });
  }

  function toggleNature(nature: string) {
    const next = natures.includes(nature) ? natures.filter((item) => item !== nature) : [...natures, nature];
    update("type", (next.length ? next : ["想法"]).join("，"));
  }

  function updateSource(kind: string, url = sourceUrl) {
    update("source", [kind, ...(url.trim() ? [url.trim()] : [])]);
  }

  function insertMarkdown(before: string, after = "") {
    const input = bodyRef.current;
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const previousSelection = captureSelection("body", input);
    const selected = draft.body.slice(start, end);
    commit(
      { ...draft, body: `${draft.body.slice(0, start)}${before}${selected}${after}${draft.body.slice(end)}` },
      previousSelection,
    );
    restoreInputSelection({
      ...previousSelection,
      start: start + before.length,
      end: end + before.length,
    });
  }

  function showPasteStatus(message: string) {
    setPasteStatus(message);
    if (pasteStatusTimerRef.current) window.clearTimeout(pasteStatusTimerRef.current);
    pasteStatusTimerRef.current = window.setTimeout(() => setPasteStatus(""), 3600);
  }

  async function pasteImages(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) return;
    event.preventDefault();

    const supportedFiles = imageFiles.filter((file) => /^image\/(?:png|jpe?g|gif|webp|bmp)$/i.test(file.type));
    if (supportedFiles.length !== imageFiles.length) {
      showPasteStatus("暂不支持该图片格式，请使用 PNG、JPG、GIF、WebP 或 BMP。");
      return;
    }
    if (supportedFiles.some((file) => file.size > 8 * 1024 * 1024)) {
      showPasteStatus("单张粘贴图片不能超过 8 MB。");
      return;
    }

    const input = event.currentTarget;
    const previousSelection = captureSelection("body", input);
    const bodyBeforePaste = draft.body;
    showPasteStatus("正在插入图片…");

    try {
      const dataUrls = await Promise.all(supportedFiles.map(readImageAsDataUrl));
      const referenceBase = `clipboard-${Date.now()}`;
      const references = dataUrls.map((dataUrl, index) => ({
        id: `${referenceBase}-${index + 1}`,
        dataUrl,
      }));
      const imageMarkdown = references
        .map((reference, index) => `![粘贴图片${references.length > 1 ? index + 1 : ""}][${reference.id}]`)
        .join("\n\n");
      const insertedBody = `${bodyBeforePaste.slice(0, previousSelection.start)}${imageMarkdown}${bodyBeforePaste.slice(previousSelection.end)}`;
      const referenceGap = insertedBody.endsWith("\n\n") ? "" : insertedBody.endsWith("\n") ? "\n" : "\n\n";
      const referenceMarkdown = references.map((reference) => `[${reference.id}]: ${reference.dataUrl}`).join("\n");
      commit({ ...draft, body: `${insertedBody}${referenceGap}${referenceMarkdown}` }, previousSelection);
      restoreInputSelection({
        ...previousSelection,
        start: previousSelection.start + imageMarkdown.length,
        end: previousSelection.start + imageMarkdown.length,
      });
      showPasteStatus(references.length > 1 ? `已插入 ${references.length} 张图片。` : "图片已插入，可在右侧预览。");
    } catch {
      showPasteStatus("图片读取失败，请重新复制后再试。");
    }
  }

  return (
    <div className="workbench-editor immersive-editor" onKeyDown={handleEditorKeyDown}>
      <header className="editor-toolbar"><div><button onClick={onCancel}>← 取消</button><span>{draft.id ? "编辑笔记" : "新建笔记"}</span></div><div className="editor-toolbar-actions"><div className="editor-history-actions" aria-label="编辑历史"><button type="button" disabled={!historyAvailability.canUndo} onClick={() => stepHistory("undo")} title="撤回（Ctrl+Z）">↶ 撤回</button><button type="button" disabled={!historyAvailability.canRedo} onClick={() => stepHistory("redo")} title="重做（Ctrl+Shift+Z / Ctrl+Y）">↷ 重做</button></div><small><kbd>Ctrl</kbd> + <kbd>S</kbd></small><button className="primary" disabled={saving} onClick={onSave}>{saving ? "保存中…" : "保存"}</button></div></header>
      <div className="editor-scroll" ref={editorScrollRef}><div className="editor-paper">
        <details className="editor-metadata new-note-metadata">
          <summary><div><strong>整理关系</strong><span>领域、性质、项目与来源都可以稍后补充</span></div><em>展开整理</em></summary>
          <fieldset><legend>内容性质 · 可多选</legend><div className="nature-picker">{natureOptions.map((nature) => <button className={natures.includes(nature) ? "active" : ""} type="button" key={nature} onClick={() => toggleNature(nature)}>{nature}</button>)}</div></fieldset>
          <div className="metadata-grid">
            <label><span>所属领域</span><SelectMenu label="所属领域" value={articleLifeDomain(draft)} onChange={(value) => update("category", value)} options={LIFE_DOMAIN_OPTIONS} /></label>
            <label><span>主题</span><input ref={tagsRef} value={draft.tags.join("，")} onBeforeInput={(event) => rememberSelection("tags", event.currentTarget)} onChange={(event) => update("tags", splitTags(event.target.value))} placeholder="科研，创作，工具……" /></label>
            <label><span>关联项目</span><SelectMenu label="关联项目" value={draft.projectId || projects.find((project) => project.title === draft.project)?.id || ""} onChange={(value) => { const project = projects.find((item) => item.id === value); commit({ ...draft, projectId: project?.id || "", project: project?.title || "" }); }} options={[{ value: "", label: "不关联项目" }, ...projects.map((project) => ({ value: project.id, label: project.title }))]} /></label>
            <label><span>来源</span><SelectMenu label="来源" value={sourceKind} onChange={updateSource} options={sourceOptions.map((source) => ({ value: source, label: source }))} /></label>
            <label><span>来源链接</span><input ref={sourceUrlRef} type="url" value={sourceUrl} onBeforeInput={(event) => rememberSelection("sourceUrl", event.currentTarget)} onChange={(event) => updateSource(sourceKind, event.target.value)} placeholder="可选" /></label>
          </div>
          <small className="metadata-auto-note">摘要、创建时间、修改时间和版本信息由系统自动维护。</small>
        </details>
        <section className="editor-writing-pane">
          <input ref={titleRef} className="editor-title" autoFocus={!appendMode} value={draft.title} onBeforeInput={(event) => rememberSelection("title", event.currentTarget)} onChange={(event) => update("title", event.target.value)} placeholder="这篇笔记的标题" />
          <div className="markdown-toolbar" aria-label="Markdown 格式工具">
            <div className="markdown-format-actions">
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertMarkdown("# ")}>一级标题</button>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertMarkdown("## ")}>二级标题</button>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertMarkdown("**", "**")}>加粗</button>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertMarkdown("> ")}>引用</button>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertMarkdown("- ")}>列表</button>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertMarkdown("[", "](https://)")}>链接</button>
            </div>
            <div className="editor-preview-toggle" aria-label="预览模式">
              <button className={!previewVisible ? "active" : ""} type="button" onClick={() => setPreviewVisible(false)}>专注写作</button>
              <button className={previewVisible ? "active" : ""} type="button" onClick={() => setPreviewVisible(true)}>分屏预览</button>
            </div>
          </div>
          <div className={`editor-compose ${previewVisible ? "with-preview" : ""}`}>
            <div className="editor-source-pane">
              <div className="editor-pane-label"><strong>正文</strong><span className={pasteStatus ? "status" : ""}>{pasteStatus || "支持直接 Ctrl+V 粘贴图片"}</span></div>
              <textarea ref={bodyRef} className="editor-body" value={draft.body} onBeforeInput={(event) => rememberSelection("body", event.currentTarget)} onChange={(event) => update("body", event.target.value)} onPaste={(event) => void pasteImages(event)} placeholder="从这里开始写。可以直接使用标题、列表、引用、链接、表格和任务清单……" />
            </div>
            {previewVisible && <section className="editor-live-preview" aria-label="实时预览"><div className="editor-pane-label"><strong>实时预览</strong><span>与阅读页同步</span></div><div className="editor-preview-document"><h1>{draft.title || "未命名笔记"}</h1>{draft.body.trim() ? <MarkdownDocument body={draft.body} title={draft.title} /> : <p className="editor-preview-empty">开始输入后，这里会显示最终排版。</p>}</div></section>}
          </div>
        </section>
      </div></div>
    </div>
  );
}

function readImageAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Invalid image data")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Unable to read image")));
    reader.readAsDataURL(file);
  });
}

function matchesNoteView(article: StoredArticle, view: NoteView) {
  if (view === "recent") return true;
  const natures = getNatures(article);
  if (view === "knowledge") return natures.includes("知识");
  if (view === "ideas") return natures.includes("想法");
  if (view === "methods") return natures.includes("方法");
  if (view === "experience") return natures.includes("经验");
  if (view === "decisions") return natures.includes("决策");
  return natures.includes("复盘");
}

function getNatures(article: Pick<Article, "type">) {
  const values = article.type.split(/[，,]/).map((item) => item.trim()).filter(Boolean);
  if (!values.length || values.every((item) => item === "记录" || item === "文章")) return ["知识"];
  return [...new Set(values.map((item) => {
    if (["思考", "灵感", "问题"].includes(item)) return "想法";
    if (["模板", "教程", "步骤"].includes(item)) return "方法";
    if (["结论", "资料", "文章", "记录"].includes(item)) return "知识";
    return item;
  }))];
}

function articleLifeDomain(article: Pick<Article, "category" | "tags" | "title" | "summary">) {
  return inferLifeDomain(article.category, article.tags.join(" "), article.title, article.summary);
}

function articleSearchText(article: StoredArticle) {
  return [article.title, article.summary, article.body, article.project, article.type, article.category, LIFE_DOMAIN_LABELS[articleLifeDomain(article)], article.tags.join(" ")].join(" ").toLocaleLowerCase("zh-CN");
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

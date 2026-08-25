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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
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
import type { SqliteAiRepository } from "../app/data/sqlite-ai-repository";
import type { IntegrationRepository } from "../app/data/integration-repository";
import type { DashboardRepository } from "../app/data/dashboard-repository";
import { rootProjectStatusCounts } from "../app/project-selectors";
import type { ProjectDetail, ProjectProposal, ProjectSummary, ProjectTask } from "../app/project-types";
import type { Article, StoredArticle } from "../app/types";
import {
  appendCaptureRelation,
  captureMetadata,
  formatPlaybackTime,
  preserveCaptureSourceMetadata,
  sourceForCapturedResult,
} from "../app/entertainment-capture";
import { workspaceTitle, type QuickLink } from "../app/workspace-preferences";
import type { DailyCloseout, FocusSession, TaskPlan, WeeklyFocus } from "../app/work-types";
import { defaultDashboardPreferences, type CalendarEvent, type DashboardPreferences, type ExternalSourceInput } from "../app/dashboard-types";
import { normalizeExternalSourceInput } from "../app/dashboard-helpers";
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
import { AiAssistantDialog } from "./AiAssistantDialog";
import { ToolCenterPage } from "./ToolCenter";
import { DashboardSettingsSection } from "./MorningDashboard";
import {
  ExplorePage,
  ArchivePage,
  formatFocusDuration,
  HomeDashboard,
  InboxPage,
  ReviewPage,
  TasksPage,
  type NewActionInput,
  type SourceOrganizationInput,
  type WorkspaceTask,
} from "./WorkPages";
import { DESKTOP_THEMES, ThemeArtwork, type ThemeId } from "./DesktopThemes";

export type DeskSection = "home" | "tasks" | "projects" | "notes" | "explore" | "inbox" | "review" | "archive" | "tools" | "settings";
type NoteView = "recent" | "knowledge" | "ideas" | "methods" | "experience" | "decisions" | "review";
type UndoOffer = { message: string; run: () => Promise<void> };
type ArticleEditorMode = "visual" | "markdown";
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
  aiRepository: SqliteAiRepository;
  integrationRepository: IntegrationRepository;
  dashboardRepository: DashboardRepository;
  displayName: string;
  avatarDataUrl: string;
  quickLinks: QuickLink[];
  dataRevision: number;
  onRepositoryChange?: () => void;
  onEditingStateChange?: (editing: boolean) => void;
  accountDock: ReactNode;
  themeId: ThemeId;
  backingUp: boolean;
  onThemeChange: (themeId: ThemeId) => void;
  onCreateBackup: () => void;
  onRestoreBackup: () => void;
  onSaveDisplayName: (name: string) => Promise<void>;
  onSaveAvatarDataUrl: (dataUrl: string) => Promise<void>;
  onSaveQuickLinks: (links: QuickLink[]) => Promise<void>;
  startupActiveFocusId: string | null;
};

const sections: Array<{
  id: DeskSection;
  label: string;
  icon: WorkbenchIconName;
  group: "action" | "knowledge" | "tools";
}> = [
  { id: "home", label: "首页", icon: "home", group: "action" },
  { id: "tasks", label: "今日行动", icon: "today", group: "action" },
  { id: "projects", label: "项目", icon: "projects", group: "action" },
  { id: "notes", label: "笔记", icon: "notes", group: "knowledge" },
  { id: "explore", label: "探索库", icon: "explore", group: "knowledge" },
  { id: "inbox", label: "待整理", icon: "inbox", group: "knowledge" },
  { id: "review", label: "回顾", icon: "review", group: "knowledge" },
  { id: "archive", label: "归档", icon: "archive", group: "knowledge" },
  { id: "tools", label: "工具中心", icon: "tools", group: "tools" },
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
  aiRepository,
  integrationRepository,
  dashboardRepository,
  displayName,
  avatarDataUrl,
  quickLinks,
  dataRevision,
  onRepositoryChange,
  onEditingStateChange,
  accountDock,
  themeId,
  backingUp,
  onThemeChange,
  onCreateBackup,
  onRestoreBackup,
  onSaveDisplayName,
  onSaveAvatarDataUrl,
  onSaveQuickLinks,
  startupActiveFocusId,
}: DesktopWorkbenchProps) {
  const confirm = useConfirmDialog();
  const [articles, setArticles] = useState<StoredArticle[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectDetails, setProjectDetails] = useState<ProjectDetail[]>([]);
  const [plans, setPlans] = useState<TaskPlan[]>([]);
  const [activeSession, setActiveSession] = useState<FocusSession | null>(null);
  const [focusSessions, setFocusSessions] = useState<FocusSession[]>([]);
  const [weeklyFocus, setWeeklyFocus] = useState<WeeklyFocus | null>(null);
  const [closeouts, setCloseouts] = useState<DailyCloseout[]>([]);
  const [dashboardPreferences, setDashboardPreferences] = useState<DashboardPreferences>(() => structuredClone(defaultDashboardPreferences));
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
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
  const [aiAssistantOpen, setAiAssistantOpen] = useState(false);
  const [quickText, setQuickText] = useState("");
  const [message, setMessage] = useState("");
  const [undoOffer, setUndoOffer] = useState<UndoOffer | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("life-strategy.sidebar-collapsed") === "true",
  );
  const messageTimer = useRef<number | null>(null);
  const undoTimer = useRef<number | null>(null);
  const [today, setToday] = useState(() => localDate());
  const [focusRecoveryId, setFocusRecoveryId] = useState(startupActiveFocusId);
  const [focusRecoveryEnd, setFocusRecoveryEnd] = useState(() => toLocalDateTimeInput(new Date()));

  useEffect(() => {
    if (startupActiveFocusId) setFocusRecoveryId(startupActiveFocusId);
  }, [startupActiveFocusId]);

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
    const [nextPlans, nextActive, nextSessions, nextFocus, nextCloseouts] = await Promise.all([
      workRepository.listPlans(),
      workRepository.getActiveSession(),
      workRepository.listSessions(),
      workRepository.getWeeklyFocus(weekStart),
      workRepository.listDailyCloseouts(weekStart),
    ]);
    setPlans(nextPlans);
    setActiveSession(nextActive);
    setFocusSessions(nextSessions);
    setWeeklyFocus(nextFocus);
    setCloseouts(nextCloseouts);
  }, [workRepository]);

  const refreshDashboardLocal = useCallback(async () => {
    const [preferences, events] = await Promise.all([
      dashboardRepository.getPreferences(),
      dashboardRepository.listEvents(),
    ]);
    setDashboardPreferences(preferences);
    setCalendarEvents(events);
  }, [dashboardRepository]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([refreshArticles(), refreshProjects(), refreshWork(), refreshDashboardLocal()])
      .catch((error) => {
        if (active) showMessage(error instanceof Error ? error.message : "无法读取本地工作台");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [refreshArticles, refreshDashboardLocal, refreshProjects, refreshWork, showMessage]);

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
  const noteViewCounts = useMemo(() => {
    const candidates = articles.filter((article) => (
      !isSourceArticle(article)
      && !isThoughtInboxArticle(article)
      && (noteDomain === "all" || articleLifeDomain(article) === noteDomain)
    ));
    return noteViews.reduce<Record<NoteView, number>>((result, item) => {
      result[item.id] = candidates.filter((article) => matchesNoteView(article, item.id)).length;
      return result;
    }, { recent: 0, knowledge: 0, ideas: 0, methods: 0, experience: 0, decisions: 0, review: 0 });
  }, [articles, noteDomain]);

  const projectCounts = rootProjectStatusCounts(projects);
  const counts: Record<DeskSection, number | null> = {
    home: null,
    tasks: workspaceTasks.filter((task) => task.status !== "done" && task.plan?.plannedDate === today).length,
    projects: projectCounts.active,
    notes: articles.filter((article) => !isSourceArticle(article) && !isThoughtInboxArticle(article)).length,
    explore: articles.filter(isSourceArticle).filter((article) => article.branch !== "已归档").length,
    inbox: inboxCount,
    review: null,
    archive: projects.filter((project) => project.status === "completed").length + workspaceTasks.filter((task) => task.status === "done").length,
    tools: null,
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

  async function saveExternalSource(input: ExternalSourceInput) {
    const normalized = normalizeExternalSourceInput(input, linkPlatform(input.url));
    const saved = await persist({
      ...emptyDraft,
      collection: "sources",
      collectionLabel: "探索资料",
      category: "探索资料",
      type: "外部资料",
      title: normalized.title,
      body: `${normalized.summary ? `${normalized.summary}\n\n` : ""}[打开原内容](${normalized.url})`,
      source: [normalized.sourceLabel, normalized.url],
      branch: "收藏中",
      stage: "已收藏",
      summary: normalized.summary || `来自 ${normalized.sourceLabel} 的收藏`,
      created: today,
    }, "链接已经收进探索库。 ", false);
    return Boolean(saved);
  }

  async function saveExternalLink(url: string, note: string) {
    return saveExternalSource({ url, title: note ? captureTitle(note) : undefined, summary: note });
  }

  async function saveDashboardPreferences(preferences: DashboardPreferences) {
    await dashboardRepository.savePreferences(preferences);
    setDashboardPreferences(preferences);
    showMessage("晨间首页设置已经保存。 ");
  }

  async function saveCalendarEvent(event: CalendarEvent) {
    const saved = await dashboardRepository.saveEvent(event);
    await refreshDashboardLocal();
    showMessage(event.id ? "重要日期已经更新。 " : "重要日期已经添加。 ");
    return saved;
  }

  async function deleteCalendarEvent(id: string) {
    await dashboardRepository.deleteEvent(id);
    await refreshDashboardLocal();
    showMessage("重要日期已经删除。 ");
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
      setFocusSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
      showMessage("已经开始记录这次投入。 ");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "无法开始专注");
    }
  }

  async function stopFocus() {
    if (!activeSession) return;
    try {
      const stopped = await workRepository.stopSession(activeSession.id);
      await refreshWork();
      showMessage(`本次投入 ${formatFocusDuration(stopped.durationSeconds)}，已经记录。`);
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "无法结束专注");
    }
  }

  async function finishRecoveredFocus() {
    if (!activeSession || activeSession.id !== focusRecoveryId) return;
    try {
      const endedAt = new Date(focusRecoveryEnd).toISOString();
      const stopped = await workRepository.stopSession({ id: activeSession.id, endedAt });
      setFocusRecoveryId(null);
      await refreshWork();
      showMessage(`上次投入已按 ${formatFocusDuration(stopped.durationSeconds)} 记录。`);
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "无法修正上次投入");
    }
  }

  async function completeTask(task: WorkspaceTask) {
    try {
      const stopped = activeSession?.taskId === task.id ? await workRepository.stopSession(activeSession.id) : null;
      await projectRepository.completeTask(task.id, `完成行动：${task.title}`);
      await Promise.all([refreshProjects(), refreshWork()]);
      offerUndo(stopped ? `任务已完成 · 本次投入 ${formatFocusDuration(stopped.durationSeconds)}` : "任务已完成", async () => {
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
      return saved;
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "无法添加任务");
      return null;
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
    if (created) await finishConvertedCapture(article, { kind: "task", id: created.id }, "已转为项目行动，原记录已整理为笔记。");
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
      const saved = await projectRepository.saveProposal(proposal);
      await refreshProjects();
      await finishConvertedCapture(article, { kind: "proposal", id: saved.id }, "已转为项目提案，原记录已整理为笔记。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "转为提案失败");
    }
  }

  async function finishConvertedCapture(article: StoredArticle, relation: { kind: "task" | "proposal"; id: string }, sourceMessage: string) {
    if (isSourceArticle(article)) {
      await persist(appendCaptureRelation(article, relation), sourceMessage, false);
      return;
    }
    await persist(appendCaptureRelation({
      ...article,
      collection: "notes",
      collectionLabel: "笔记",
      category: articleLifeDomain(article),
      branch: "已整理",
    }, relation), sourceMessage, false);
  }

  async function organizeSource(article: StoredArticle, input: SourceOrganizationInput) {
    const sourceAppendix = captureSourceAppendix(article);
    try {
      if (input.kind === "note") {
        const saved = await repository.save({
          ...emptyDraft,
          title: input.title,
          body: `${input.body}${sourceAppendix}`,
          tags: input.tags,
          source: sourceForCapturedResult(article.source, article.id),
          branch: "已整理",
          stage: "常青",
          type: "想法",
          category: articleLifeDomain({ category: "uncategorized", title: input.title, summary: plainExcerpt(input.body), tags: input.tags }),
          summary: plainExcerpt(input.body),
          created: today,
        });
        await repository.save(appendCaptureRelation(article, { kind: "note", id: saved.id }));
        await refreshArticles();
        onRepositoryChange?.();
        showMessage("已经生成笔记，原资料仍保留在探索库。");
        return true;
      }

      if (input.kind === "action") {
        const now = new Date().toISOString();
        const saved = await projectRepository.saveTask({
          id: "",
          projectId: input.projectId,
          milestoneId: input.milestoneId,
          title: input.title,
          actionType: "organize",
          details: `${input.details}${sourceAppendix}`,
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
        });
        await repository.save(appendCaptureRelation(article, { kind: "task", id: saved.id }));
        await Promise.all([refreshArticles(), refreshProjects()]);
        onRepositoryChange?.();
        showMessage("已经创建项目行动，原资料仍保留在探索库。");
        return true;
      }

      const now = new Date().toISOString();
      const saved = await projectRepository.saveProposal({
        id: "",
        projectId: input.projectId,
        title: input.title,
        problem: `${input.problem}${sourceAppendix}`,
        expectedValue: input.expectedValue,
        cost: input.cost,
        status: "pending",
        reviewNote: "由探索资料整理",
        createdAt: now,
        updatedAt: now,
      });
      await repository.save(appendCaptureRelation(article, { kind: "proposal", id: saved.id }));
      await Promise.all([refreshArticles(), refreshProjects()]);
      onRepositoryChange?.();
      showMessage("已经创建项目提案，原资料仍保留在探索库。");
      return true;
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "整理资料失败");
      return false;
    }
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
    `theme-${themeId}`,
  ].filter(Boolean).join(" ");
  const taskActions = {
    onCompleteTask: completeTask,
    onPlanToday: planToday,
    onRemoveFromToday: removeFromToday,
    onStartFocus: startFocus,
    onStopFocus: stopFocus,
    activeSession,
    focusSessions,
  };

  return (
    <main className={rootClass}>
      {!documentMode && (
      <WorkbenchSidebar
        section={section}
        counts={counts}
        inboxCount={inboxCount}
        title={workspaceTitle(displayName)}
        avatarDataUrl={avatarDataUrl}
        collapsed={sidebarCollapsed}
        onSwitch={switchSection}
        onToggle={toggleSidebar}
        onOpenAi={() => setAiAssistantOpen(true)}
        accountDock={accountDock}
      />
      )}

      <ThemeArtwork themeId={themeId} section={section} documentMode={documentMode} />

      {activeSession && <GlobalFocusBar session={activeSession} task={workspaceTasks.find((task) => task.id === activeSession.taskId) ?? null} onShow={() => switchSection("tasks")} onPause={() => void stopFocus()} />}

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
          counts={noteViewCounts}
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
          {section === "home" && <HomeDashboard today={today} tasks={workspaceTasks} articles={articles} weeklyFocus={weeklyFocus} integrationRepository={integrationRepository} dashboardRepository={dashboardRepository} dashboardPreferences={dashboardPreferences} calendarEvents={calendarEvents} onOpenTools={() => switchSection("tools")} onSaveWeeklyFocus={saveWeeklyFocus} onSaveDashboardPreferences={saveDashboardPreferences} onSaveCalendarEvent={saveCalendarEvent} onDeleteCalendarEvent={deleteCalendarEvent} onSaveSource={saveExternalSource} onNotice={showMessage} onOpenArticle={openArticle} onOpenProject={openProject} onOpenTasks={() => switchSection("tasks")} {...taskActions} />}
          {section === "tasks" && <TasksPage today={today} tasks={workspaceTasks} projects={projects} projectDetails={projectDetails} onAddTask={addTask} onRemoveTask={removeTask} onOpenProject={openProject} {...taskActions} />}
          {section === "explore" && <ExplorePage articles={articles} projects={projects} projectDetails={projectDetails} onSaveLink={saveExternalLink} onArchive={archiveSource} onDelete={removeArticle} onOpenArticle={openArticle} onOpenProject={openProject} onOrganize={organizeSource} />}
          {section === "inbox" && <InboxPage articles={articles} projects={projects} onOpenArticle={openArticle} onNewCapture={() => setQuickCaptureOpen(true)} onMoveArticle={moveInboxArticle} onConvertToAction={convertInboxToAction} onConvertToProposal={convertInboxToProposal} onDelete={removeArticle} />}
          {section === "review" && <ReviewPage projects={projects} projectDetails={projectDetails} articles={articles} tasks={workspaceTasks} weeklyFocus={weeklyFocus} closeouts={closeouts} today={today} onSaveCloseout={saveCloseout} />}
          {section === "archive" && <ArchivePage projects={projects} tasks={workspaceTasks} focusSessions={focusSessions} onOpenProject={openProject} onRestoreTask={restoreTask} />}
          {section === "tools" && <ToolCenterPage repository={integrationRepository} quickLinks={quickLinks} onSaveQuickLinks={onSaveQuickLinks} onOpenAi={() => setAiAssistantOpen(true)} />}
          {section === "settings" && <SettingsPage displayName={displayName} avatarDataUrl={avatarDataUrl} themeId={themeId} backingUp={backingUp} dashboardPreferences={dashboardPreferences} onSaveDashboardPreferences={saveDashboardPreferences} onSaveDisplayName={onSaveDisplayName} onSaveAvatarDataUrl={onSaveAvatarDataUrl} onThemeChange={onThemeChange} onCreateBackup={onCreateBackup} onRestoreBackup={onRestoreBackup} />}
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

      <AiAssistantDialog open={aiAssistantOpen} repository={aiRepository} onClose={() => setAiAssistantOpen(false)} />

      {activeSession?.id === focusRecoveryId && <div className="focus-recovery-backdrop"><section className="focus-recovery-dialog" role="dialog" aria-modal="true" aria-label="处理上次未结束的投入"><span>投入记录恢复</span><h2>上次投入没有正常结束</h2><p>“{activeSession.label}”开始于 {new Date(activeSession.startedAt).toLocaleString("zh-CN")}。请选择实际结束时间，或者继续本次投入。</p><label><span>实际结束时间</span><input type="datetime-local" min={toLocalDateTimeInput(new Date(activeSession.startedAt))} max={toLocalDateTimeInput(new Date())} value={focusRecoveryEnd} onChange={(event) => setFocusRecoveryEnd(event.target.value)} /></label><footer><button onClick={() => setFocusRecoveryId(null)}>继续投入</button><button className="primary" onClick={() => void finishRecoveredFocus()}>按此时间暂停并记录</button></footer></section></div>}

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
  onOpenAi,
  accountDock,
  title,
  avatarDataUrl,
}: {
  section: DeskSection;
  counts: Record<DeskSection, number | null>;
  inboxCount: number;
  collapsed: boolean;
  onSwitch: (section: DeskSection) => void;
  onToggle: () => void;
  onOpenAi: () => void;
  accountDock: ReactNode;
  title: string;
  avatarDataUrl: string;
}) {
  return (
    <aside className="workbench-sidebar">
      <button className="sidebar-collapse-toggle" onClick={onToggle} aria-label={collapsed ? "展开侧栏" : "收起侧栏"} title={collapsed ? "展开侧栏" : "收起侧栏"}>{collapsed ? "›" : "‹"}</button>
      <div className="sidebar-brand"><span className={`sidebar-brand-mark${avatarDataUrl ? " has-image" : ""}`}>{avatarDataUrl ? <img src={avatarDataUrl} alt="" /> : <WorkbenchIcon name="brand" />}</span><span><strong title={title}>{title}</strong></span></div>
      <nav className="sidebar-navigation" aria-label="工作台导航">
        {(["action", "knowledge", "tools"] as const).map((group) => (
          <div className="sidebar-group" key={group}>
            <span className="sidebar-caption">{group === "action" ? "行动" : group === "knowledge" ? "积累" : "工具"}</span>
            {group === "tools" && <button onClick={onOpenAi} title={collapsed ? "AI 助手" : undefined} aria-label="AI 助手"><i><WorkbenchIcon name="ai" /></i><span>AI 助手</span></button>}
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

function GlobalFocusBar({ session, task, onShow, onPause }: {
  session: FocusSession;
  task: WorkspaceTask | null;
  onShow: () => void;
  onPause: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [session.id]);
  const elapsed = Math.max(0, Math.floor((now - new Date(session.startedAt).getTime()) / 1_000));
  return <aside className="global-focus-bar" aria-live="polite"><button className="global-focus-main" onClick={onShow}><i /><span><small>正在投入{task?.projectTitle ? ` · ${task.projectTitle}` : ""}</small><strong>{task ? task.title : session.label}</strong></span><time>{formatFocusDuration(elapsed, true)}</time></button><button className="global-focus-pause" onClick={onPause}>Ⅱ 暂停</button></aside>;
}

const avatarImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

async function createAvatarDataUrl(file: File) {
  if (!avatarImageTypes.has(file.type)) throw new Error("请选择 JPG、PNG 或 WebP 图片。");
  if (file.size > 8 * 1024 * 1024) throw new Error("图片不能超过 8 MB。");

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const candidate = new Image();
      candidate.onload = () => resolve(candidate);
      candidate.onerror = () => reject(new Error("无法读取这张图片，请换一张重试。"));
      candidate.src = objectUrl;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("这张图片没有可用的尺寸信息。");

    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前设备暂时无法处理头像图片。");
    const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
    const sourceX = (image.naturalWidth - sourceSize) / 2;
    const sourceY = (image.naturalHeight - sourceSize) / 2;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/webp", 0.86);
    if (!dataUrl.startsWith("data:image/webp;base64,")) throw new Error("头像图片转换失败，请换一张重试。");
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function SettingsPage({ displayName, avatarDataUrl, themeId, backingUp, dashboardPreferences, onSaveDashboardPreferences, onSaveDisplayName, onSaveAvatarDataUrl, onThemeChange, onCreateBackup, onRestoreBackup }: {
  displayName: string;
  avatarDataUrl: string;
  themeId: ThemeId;
  backingUp: boolean;
  dashboardPreferences: DashboardPreferences;
  onSaveDashboardPreferences: (preferences: DashboardPreferences) => Promise<void>;
  onThemeChange: (themeId: ThemeId) => void;
  onCreateBackup: () => void;
  onRestoreBackup: () => void;
  onSaveDisplayName: (name: string) => Promise<void>;
  onSaveAvatarDataUrl: (dataUrl: string) => Promise<void>;
}) {
  const [nameDraft, setNameDraft] = useState(displayName);
  const [nameMessage, setNameMessage] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarMessage, setAvatarMessage] = useState("");
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [updateProxyPort, setUpdateProxyPort] = useState(loadUpdateProxyPort);
  const [proxyMessage, setProxyMessage] = useState("");
  const [autostartOn, setAutostartOn] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartMessage, setAutostartMessage] = useState("");

  useEffect(() => setNameDraft(displayName), [displayName]);

  async function saveName(event: FormEvent) {
    event.preventDefault();
    try {
      await onSaveDisplayName(nameDraft);
      setNameMessage("名称已保存。");
    } catch (error) {
      setNameMessage(error instanceof Error ? `名称保存失败：${error.message}` : "名称保存失败，请稍后重试。");
    }
  }

  async function chooseAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setAvatarBusy(true);
    setAvatarMessage("");
    try {
      const dataUrl = await createAvatarDataUrl(file);
      await onSaveAvatarDataUrl(dataUrl);
      setAvatarMessage("头像已更新。");
    } catch (error) {
      setAvatarMessage(error instanceof Error ? error.message : "头像更新失败，请换一张图片重试。");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function removeAvatar() {
    setAvatarBusy(true);
    setAvatarMessage("");
    try {
      await onSaveAvatarDataUrl("");
      setAvatarMessage("已恢复默认头像。");
    } catch (error) {
      setAvatarMessage(error instanceof Error ? `头像移除失败：${error.message}` : "头像移除失败，请稍后重试。");
    } finally {
      setAvatarBusy(false);
    }
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
          <header><span>身份</span><h2>名称与头像</h2></header>
          <div className="settings-identity-content">
            <div className="settings-avatar-row">
              <span className={`settings-avatar-preview${avatarDataUrl ? " has-image" : ""}`}>{avatarDataUrl ? <img src={avatarDataUrl} alt="当前头像" /> : <WorkbenchIcon name="brand" />}</span>
              <div className="settings-avatar-details">
                <strong>个人头像</strong>
                <small>支持 JPG、PNG、WebP，图片会自动居中裁成方形。</small>
                <div className="settings-avatar-actions">
                  <button type="button" disabled={avatarBusy} onClick={() => avatarInputRef.current?.click()}>{avatarBusy ? "处理中…" : avatarDataUrl ? "更换图片" : "上传图片"}</button>
                  {avatarDataUrl && <button type="button" className="quiet" disabled={avatarBusy} onClick={() => void removeAvatar()}>移除</button>}
                </div>
                <input ref={avatarInputRef} className="settings-avatar-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void chooseAvatar(event)} />
                <p role="status">{avatarMessage}</p>
              </div>
            </div>
            <form className="settings-name-form" onSubmit={saveName}>
              <label htmlFor="workspace-display-name"><span>名称</span><small id="workspace-display-name-count">{[...nameDraft].length}/24</small></label>
              <div><input id="workspace-display-name" value={nameDraft} onChange={(event) => { setNameDraft([...event.target.value].slice(0, 24).join("")); setNameMessage(""); }} placeholder="例如：小洛" aria-describedby="workspace-display-name-count workspace-display-name-message" /><button type="submit">保存名称</button></div>
              <p id="workspace-display-name-message" role="status">{nameMessage}</p>
            </form>
          </div>
        </section>
        <section className="workspace-card settings-section">
          <header><span>外观</span><h2>工作台主题</h2><p>默认主题专注阅读；角色主题只在有足够留白时显示立绘。</p></header>
          <div className="settings-theme-options">
            {DESKTOP_THEMES.map((theme) => (
              <button
                className={themeId === theme.id ? "active" : ""}
                key={theme.id}
                type="button"
                aria-pressed={themeId === theme.id}
                onClick={() => onThemeChange(theme.id)}
              >
                <span className={`settings-theme-preview preview-${theme.id}`}>
                  {theme.characterImage && <img src={theme.characterImage} alt="" draggable={false} />}
                  <i>{themeId === theme.id ? "✓" : ""}</i>
                </span>
                <span><strong>{theme.label}</strong><small>{theme.description}</small></span>
              </button>
            ))}
          </div>
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
        <DashboardSettingsSection preferences={dashboardPreferences} onSave={onSaveDashboardPreferences} />
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

function NotesWorkspace({ articles, counts, loading, query, view, domain, onQuery, onView, onDomain, onOpen, onNew }: {
  articles: StoredArticle[];
  counts: Record<NoteView, number>;
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
        <nav>{noteViews.map((item) => <button className={view === item.id ? "active" : ""} key={item.id} onClick={() => onView(item.id)}><span>{item.label}</span><small>{counts[item.id]}</small></button>)}</nav>
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
  const richEditorRef = useRef<HTMLDivElement>(null);
  const richSeedRef = useRef<HTMLDivElement>(null);
  const lastRichBodyRef = useRef<string | null>(null);
  const tagsRef = useRef<HTMLInputElement>(null);
  const sourceUrlRef = useRef<HTMLInputElement>(null);
  const beforeInputSelectionRef = useRef<ArticleEditorSelection | null>(null);
  const pasteStatusTimerRef = useRef<number | null>(null);
  const undoHistoryRef = useRef<ArticleEditorHistoryEntry[]>([]);
  const redoHistoryRef = useRef<ArticleEditorHistoryEntry[]>([]);
  const [historyAvailability, setHistoryAvailability] = useState({ canUndo: false, canRedo: false });
  const [editorMode, setEditorMode] = useState<ArticleEditorMode>("visual");
  const [pasteStatus, setPasteStatus] = useState("");
  const natures = getNatures(draft);
  const sourceUrl = draft.source.find((item) => /^https?:\/\//i.test(item)) || "";
  const sourceKind = draft.source.find((item) => !/^https?:\/\//i.test(item)) || "自写";

  useLayoutEffect(() => {
    if (editorMode !== "visual" || !richEditorRef.current || !richSeedRef.current) return;
    if (lastRichBodyRef.current === draft.body && richEditorRef.current.childNodes.length) return;
    const rendered = richSeedRef.current.querySelector<HTMLElement>(".desktop-markdown");
    richEditorRef.current.innerHTML = rendered?.innerHTML || "";
    lastRichBodyRef.current = draft.body;
  }, [draft.body, editorMode]);

  useEffect(() => {
    if (!appendMode) return;
    window.requestAnimationFrame(() => {
      if (editorMode === "visual" && richEditorRef.current) {
        richEditorRef.current.focus({ preventScroll: true });
        placeCaretAtEnd(richEditorRef.current);
        richEditorRef.current.scrollIntoView({ block: "end", behavior: "smooth" });
        return;
      }
      const input = bodyRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      input.scrollIntoView({ block: "end", behavior: "smooth" });
    });
  }, [appendMode, editorMode]);

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
    if ((event.target as HTMLElement).closest(".editor-rich-surface")) return;
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
    update("source", preserveCaptureSourceMetadata(draft.source, kind, url));
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

  function syncRichBody() {
    const editor = richEditorRef.current;
    if (!editor) return;
    const body = richTextToMarkdown(editor);
    lastRichBodyRef.current = body;
    if (body !== draft.body) onChange({ ...draft, body });
  }

  function runRichCommand(command: string, value?: string) {
    const editor = richEditorRef.current;
    if (!editor) return;
    editor.focus({ preventScroll: true });
    document.execCommand(command, false, value);
    syncRichBody();
  }

  function applyFormat(markdownBefore: string, markdownAfter: string, richCommand: string, richValue?: string) {
    if (editorMode === "markdown") {
      insertMarkdown(markdownBefore, markdownAfter);
      return;
    }
    runRichCommand(richCommand, richValue);
  }

  function applyLink() {
    if (editorMode === "markdown") {
      insertMarkdown("[", "](https://)");
      return;
    }
    const selection = window.getSelection();
    if (!selection?.toString().trim()) {
      showPasteStatus("请先选中要添加链接的文字。");
      return;
    }
    const url = window.prompt("输入链接地址", "https://");
    if (url?.trim()) runRichCommand("createLink", url.trim());
  }

  function runEditorHistory(direction: "undo" | "redo") {
    const activeElement = document.activeElement;
    const richEditor = richEditorRef.current;
    if (richEditor && activeElement && richEditor.contains(activeElement)) {
      runRichCommand(direction);
      return;
    }
    if (!stepHistory(direction, activeElement) && editorMode === "visual") runRichCommand(direction);
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

  async function pasteIntoRichEditor(event: ReactClipboardEvent<HTMLDivElement>) {
    const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) {
      const text = event.clipboardData.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      document.execCommand("insertText", false, text);
      syncRichBody();
      return;
    }
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

    const editor = richEditorRef.current;
    const selection = window.getSelection();
    const activeRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const savedRange = editor && activeRange && editor.contains(activeRange.commonAncestorContainer)
      ? activeRange.cloneRange()
      : null;
    showPasteStatus("正在插入图片…");

    try {
      const dataUrls = await Promise.all(supportedFiles.map(readImageAsDataUrl));
      if (!editor) return;
      editor.focus({ preventScroll: true });
      if (savedRange && selection) {
        selection.removeAllRanges();
        selection.addRange(savedRange);
      } else {
        placeCaretAtEnd(editor);
      }
      dataUrls.forEach((dataUrl, index) => {
        const suffix = dataUrls.length > 1 ? index + 1 : "";
        document.execCommand("insertHTML", false, `<img src="${dataUrl}" alt="粘贴图片${suffix}"><br>`);
      });
      syncRichBody();
      showPasteStatus(dataUrls.length > 1 ? `已插入 ${dataUrls.length} 张图片。` : "图片已插入正文。");
    } catch {
      showPasteStatus("图片读取失败，请重新复制后再试。");
    }
  }

  return (
    <div className="workbench-editor immersive-editor" onKeyDown={handleEditorKeyDown}>
      <header className="editor-toolbar"><div><button onClick={onCancel}>← 取消</button><span>{draft.id ? "编辑笔记" : "新建笔记"}</span></div><div className="editor-toolbar-actions"><div className="editor-history-actions" aria-label="编辑历史"><button type="button" disabled={editorMode === "markdown" && !historyAvailability.canUndo} onMouseDown={(event) => event.preventDefault()} onClick={() => runEditorHistory("undo")} title="撤回（Ctrl+Z）">↶ 撤回</button><button type="button" disabled={editorMode === "markdown" && !historyAvailability.canRedo} onMouseDown={(event) => event.preventDefault()} onClick={() => runEditorHistory("redo")} title="重做（Ctrl+Shift+Z / Ctrl+Y）">↷ 重做</button></div><small><kbd>Ctrl</kbd> + <kbd>S</kbd></small><button className="primary" disabled={saving} onClick={onSave}>{saving ? "保存中…" : "保存"}</button></div></header>
      <div className="editor-scroll" ref={editorScrollRef}><div className="editor-paper">
        <details className="editor-metadata new-note-metadata">
          <summary><div><strong>整理关系</strong><span>领域、性质、项目与来源都可以稍后补充</span></div><em>展开整理</em></summary>
          <fieldset><legend>内容性质 · 可多选</legend><div className="nature-picker">{natureOptions.map((nature) => <button className={natures.includes(nature) ? "active" : ""} type="button" key={nature} onClick={() => toggleNature(nature)}>{nature}</button>)}</div></fieldset>
          <div className="metadata-grid">
            <label className="metadata-domain"><span>所属领域</span><SelectMenu label="所属领域" value={articleLifeDomain(draft)} onChange={(value) => update("category", value)} options={LIFE_DOMAIN_OPTIONS} /></label>
            <label className="metadata-topic"><span>主题</span><input ref={tagsRef} value={draft.tags.join("，")} onBeforeInput={(event) => rememberSelection("tags", event.currentTarget)} onChange={(event) => update("tags", splitTags(event.target.value))} placeholder="科研，创作，工具……" /></label>
            <label className="metadata-project"><span>关联项目</span><SelectMenu label="关联项目" value={draft.projectId || projects.find((project) => project.title === draft.project)?.id || ""} onChange={(value) => { const project = projects.find((item) => item.id === value); commit({ ...draft, projectId: project?.id || "", project: project?.title || "" }); }} options={[{ value: "", label: "不关联项目" }, ...projects.map((project) => ({ value: project.id, label: project.title }))]} /></label>
            <label className="metadata-source"><span>来源</span><SelectMenu label="来源" value={sourceKind} onChange={updateSource} options={sourceOptions.map((source) => ({ value: source, label: source }))} /></label>
            <label className="metadata-source-link"><span>来源链接</span><input ref={sourceUrlRef} type="url" value={sourceUrl} onBeforeInput={(event) => rememberSelection("sourceUrl", event.currentTarget)} onChange={(event) => updateSource(sourceKind, event.target.value)} placeholder="可选" /></label>
          </div>
          <small className="metadata-auto-note">摘要、创建时间、修改时间和版本信息由系统自动维护。</small>
        </details>
        <section className="editor-writing-pane">
          <input ref={titleRef} className="editor-title" autoFocus={!appendMode} value={draft.title} onBeforeInput={(event) => rememberSelection("title", event.currentTarget)} onChange={(event) => update("title", event.target.value)} placeholder="这篇笔记的标题" />
          <div className="markdown-toolbar" aria-label="正文格式工具">
            <div className="markdown-format-actions">
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat("# ", "", "formatBlock", "h1")}>一级标题</button>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat("## ", "", "formatBlock", "h2")}>二级标题</button>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat("**", "**", "bold")}>加粗</button>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat("> ", "", "formatBlock", "blockquote")}>引用</button>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat("- ", "", "insertUnorderedList")}>列表</button>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={applyLink}>链接</button>
            </div>
            <div className="editor-preview-toggle" aria-label="编辑模式">
              <button className={editorMode === "visual" ? "active" : ""} type="button" onClick={() => setEditorMode("visual")}>所见即所得</button>
              <button className={editorMode === "markdown" ? "active" : ""} type="button" onClick={() => setEditorMode("markdown")}>Markdown 源码</button>
            </div>
          </div>
          <div className={`editor-compose ${editorMode === "markdown" ? "with-preview markdown-mode" : "visual-mode"}`}>
            <div className={`editor-visual-pane ${editorMode === "visual" ? "" : "editor-pane-hidden"}`}>
              <div className="editor-pane-label"><strong>正文</strong><span className={pasteStatus ? "status" : ""}>{pasteStatus || "直接排版输入 · 支持 Ctrl+V 粘贴图片"}</span></div>
              <div ref={richEditorRef} className={`editor-rich-surface desktop-markdown ${draft.body.trim() ? "" : "empty"}`} contentEditable suppressContentEditableWarning role="textbox" aria-label="笔记正文，可直接排版编辑" aria-multiline="true" data-placeholder="从这里开始写。选中文字后可设置标题、加粗、引用、列表和链接。" onInput={syncRichBody} onPaste={(event) => void pasteIntoRichEditor(event)} />
            </div>
            <div className={`editor-source-pane ${editorMode === "markdown" ? "" : "editor-pane-hidden"}`}>
              <div className="editor-pane-label"><strong>正文</strong><span className={pasteStatus ? "status" : ""}>{pasteStatus || "支持直接 Ctrl+V 粘贴图片"}</span></div>
              <textarea ref={bodyRef} className="editor-body" value={draft.body} onBeforeInput={(event) => rememberSelection("body", event.currentTarget)} onChange={(event) => update("body", event.target.value)} onPaste={(event) => void pasteImages(event)} placeholder="从这里开始写。可以直接使用标题、列表、引用、链接、表格和任务清单……" />
            </div>
            <section className={`editor-live-preview ${editorMode === "markdown" ? "" : "editor-pane-hidden"}`} aria-label="实时预览"><div className="editor-pane-label"><strong>实时预览</strong><span>与阅读页同步</span></div><div className="editor-preview-document"><h1>{draft.title || "未命名笔记"}</h1>{draft.body.trim() ? <MarkdownDocument body={draft.body} title={draft.title} /> : <p className="editor-preview-empty">开始输入后，这里会显示最终排版。</p>}</div></section>
            <div ref={richSeedRef} className="editor-rich-seed" aria-hidden="true"><MarkdownDocument body={draft.body} /></div>
          </div>
        </section>
      </div></div>
    </div>
  );
}

type RichMarkdownState = {
  images: Array<{ id: string; source: string }>;
  imageIds: Map<string, string>;
};

function richTextToMarkdown(root: HTMLElement) {
  const state: RichMarkdownState = { images: [], imageIds: new Map() };
  const content = Array.from(root.childNodes).map((node) => serializeRichNode(node, state)).join("");
  const body = content
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!state.images.length) return body;
  const references = state.images.map((image) => `[${image.id}]: ${image.source}`).join("\n");
  return `${body}${body ? "\n\n" : ""}${references}`;
}

function serializeRichNode(node: Node, state: RichMarkdownState): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeRichText(node.textContent || "");
  if (!(node instanceof HTMLElement)) return "";
  const tag = node.tagName.toLowerCase();
  const children = () => Array.from(node.childNodes).map((child) => serializeRichNode(child, state)).join("");
  const block = (prefix = "") => {
    const value = children().trim();
    return value ? `${prefix}${value}\n\n` : "";
  };

  if (tag === "br") return "\n";
  if (tag === "p" || tag === "div") return block();
  if (/^h[1-6]$/.test(tag)) return block(`${"#".repeat(Number(tag[1]))} `);
  if (tag === "strong" || tag === "b") return `**${children()}**`;
  if (tag === "em" || tag === "i") return `*${children()}*`;
  if (tag === "del" || tag === "s") return `~~${children()}~~`;
  if (tag === "blockquote") {
    const value = children().trim();
    return value ? `${value.split("\n").map((line) => `> ${line}`).join("\n")}\n\n` : "";
  }
  if (tag === "ul" || tag === "ol") return serializeRichList(node, state, tag === "ol");
  if (tag === "li") return children();
  if (tag === "a") {
    const href = node.getAttribute("href")?.trim();
    const label = children() || escapeRichText(href || "链接");
    return href ? `[${label}](${href.replace(/\s/g, "%20").replace(/\)/g, "%29")})` : label;
  }
  if (tag === "img") {
    const source = node.getAttribute("src")?.trim() || "";
    if (!source) return "";
    const alt = (node.getAttribute("alt") || "图片").replace(/[\[\]]/g, "");
    if (/^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,/i.test(source)) {
      let id = state.imageIds.get(source);
      if (!id) {
        id = `visual-image-${state.images.length + 1}`;
        state.imageIds.set(source, id);
        state.images.push({ id, source });
      }
      return `![${alt}][${id}]`;
    }
    return `![${alt}](${source.replace(/\s/g, "%20").replace(/\)/g, "%29")})`;
  }
  if (tag === "pre") return `\`\`\`\n${node.textContent || ""}\n\`\`\`\n\n`;
  if (tag === "code") return `\`${(node.textContent || "").replace(/`/g, "\\`")}\``;
  if (tag === "hr") return "---\n\n";
  if (tag === "table") return serializeRichTable(node, state);
  if (tag === "input") return "";
  return children();
}

function serializeRichList(list: HTMLElement, state: RichMarkdownState, ordered: boolean) {
  const items = Array.from(list.children).filter((child) => child.tagName.toLowerCase() === "li");
  const lines = items.map((item, index) => {
    const checkbox = Array.from(item.children).find((child) => (
      child instanceof HTMLInputElement && child.type === "checkbox"
    )) as HTMLInputElement | undefined;
    const content = Array.from(item.childNodes)
      .filter((child) => child !== checkbox)
      .map((child) => serializeRichNode(child, state))
      .join("")
      .trim()
      .replace(/\n{2,}/g, "\n")
      .replace(/\n/g, "\n  ");
    const marker = ordered ? `${index + 1}. ` : checkbox ? `- [${checkbox.checked ? "x" : " "}] ` : "- ";
    return `${marker}${content}`;
  });
  return lines.length ? `${lines.join("\n")}\n\n` : "";
}

function serializeRichTable(table: HTMLElement, state: RichMarkdownState) {
  const rows = Array.from(table.querySelectorAll("tr")).map((row) => Array.from(row.children)
    .filter((cell) => ["th", "td"].includes(cell.tagName.toLowerCase()))
    .map((cell) => Array.from(cell.childNodes).map((child) => serializeRichNode(child, state)).join("").replace(/\s+/g, " ").trim()));
  if (!rows.length || !rows[0].length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const renderRow = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] || "").join(" | ")} |`;
  return `${renderRow(rows[0])}\n${renderRow(Array.from({ length: width }, () => "---"))}\n${rows.slice(1).map(renderRow).join("\n")}\n\n`;
}

function escapeRichText(value: string) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\|/g, "\\|")
    .replace(/(^|\n)(\s*)([#>+\-])(?=\s)/g, "$1$2\\$3")
    .replace(/(^|\n)(\s*)(\d+)\.(?=\s)/g, "$1$2$3\\.");
}

function placeCaretAtEnd(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
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

function captureSourceAppendix(article: StoredArticle) {
  const url = article.source.find((item) => /^https?:\/\//i.test(item));
  if (!url) return "";
  const metadata = captureMetadata(article);
  const playback = formatPlaybackTime(metadata?.playbackSeconds);
  return `\n\n---\n\n来源：[${article.title}](${url})${playback ? ` · 视频 ${playback}` : ""}`;
}

function startOfLocalWeekDate() {
  const date = new Date();
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return localDate(date);
}

function toLocalDateTimeInput(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 19);
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

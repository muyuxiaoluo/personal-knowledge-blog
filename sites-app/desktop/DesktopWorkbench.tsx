import { invoke, isTauri } from "@tauri-apps/api/core";
import { companionApi } from "./companionApi";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as readAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  lazy,
  Suspense,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { ArticleRepository } from "../app/data/article-repository";
import {
  attachmentUri,
  type AttachmentRepository,
} from "../app/data/attachment-repository";
import { isSourceArticle, isThoughtInboxArticle } from "../app/article-helpers";
import { localDate } from "../app/date-helpers";
import { inferNoteCategory, NOTE_CATEGORY_LABELS, NOTE_CATEGORY_OPTIONS, type NoteCategory } from "../app/note-taxonomy";
import { toggleMarkdownHeading } from "../app/markdown-heading";
import type { ProjectRepository } from "../app/data/project-repository";
import type { WorkRepository } from "../app/data/work-repository";
import type { WorkspacePreferencesRepository } from "../app/data/workspace-preferences-repository";
import type { SqliteAiRepository } from "../app/data/sqlite-ai-repository";
import type { IntegrationRepository } from "../app/data/integration-repository";
import type { DashboardRepository } from "../app/data/dashboard-repository";
import type { HealthRepository } from "../app/data/health-repository";
import type { FinanceRepository } from "../app/data/finance-repository";
import type { DeepSeekModel, DeepSeekModelSettings } from "../app/ai-api-types";
import {
  cacheDeepSeekModels,
  loadCachedDeepSeekModels,
  loadDeepSeekModelSettings,
  saveDeepSeekModelSettings,
} from "../app/ai-model-settings";
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
import type { HealthReminderPreferences } from "../app/reminder-preferences";
import type { DailySituation, SituationPlanChange, TaskPlanHistory, FocusSession, TaskPlan, WeeklyFocus, WeeklyReview } from "../app/work-types";
import { DailySituationDialog } from "./DailySituationDialog";
import { ProjectWeekDialog, type ProjectWeekTarget } from "./ProjectWeekDialog";
import type { WeekSettings } from "../app/project-week";
import { isContinuablePlan } from "../app/action-planning";
import { defaultDashboardPreferences, type CalendarEvent, type DashboardPreferences, type ExternalSourceInput, type RestDay } from "../app/dashboard-types";
import { emptyHealthDailyLog, emptyHealthProfile, type HealthDailyLog, type HealthMeal, type HealthProfile } from "../app/health-types";
import { normalizeExternalSourceInput } from "../app/dashboard-normalization";
import { MarkdownDocument } from "./MarkdownDocument";
import {
  DEFAULT_UPDATE_PROXY_PORT,
  loadUpdateProxyPort,
  saveUpdateProxyPort,
  validateUpdateProxyPort,
} from "./updateProxy";
import { WorkbenchIcon, type WorkbenchIconName } from "./WorkbenchIcon";
import { Button, SearchField, SelectMenu, useConfirmDialog } from "./DesktopControls";
import type {
  NewActionInput,
  SourceOrganizationInput,
  WorkspaceTask,
} from "./WorkPages";
import { formatFocusDuration } from "./focus-format";
import { DESKTOP_THEMES, ThemeArtwork, ThemeSticker, useDefaultThemePalette, type ThemeId } from "./DesktopThemes";
import { DEFAULT_THEME_PALETTES } from "../app/desktop-theme-preferences";
import { DESKTOP_FONT_PRESETS, type FontPresetId } from "./DesktopTypography";
import { desktopApi } from "./integrationApi";
import { ObserverIndicator } from "./WorkObserverIndicator";
import type { AsabaFocusCommand, AsabaNote, CompanionAction } from "../app/companion-types";
import { AsabaShotPreview } from "./AsabaDetails";
const CompanionBridge = lazy(async () => ({ default: (await import("./CompanionBridge")).CompanionBridge }));

const ProjectWorkspace = lazy(async () => ({ default: (await import("./ProjectWorkspace")).ProjectWorkspace }));
const AiAssistantDialog = lazy(async () => ({ default: (await import("./AiAssistantDialog")).AiAssistantDialog }));
const ToolCenterPage = lazy(async () => ({ default: (await import("./ToolCenter")).ToolCenterPage }));
const DashboardSettingsSection = lazy(async () => ({ default: (await import("./MorningDashboard")).DashboardSettingsSection }));
const HomeDashboard = lazy(async () => ({ default: (await import("./WorkPages")).HomeDashboard }));
const HealthPage = lazy(async () => ({ default: (await import("./HealthPage")).HealthPage }));
const WealthPage = lazy(async () => ({ default: (await import("./WealthPage")).WealthPage }));
const TasksPage = lazy(async () => ({ default: (await import("./WorkPages")).TasksPage }));
const WorkObserverPage = lazy(async () => ({ default: (await import("./WorkObserverPage")).WorkObserverPage }));
const FocusTools = lazy(async () => ({ default: (await import("./FocusTools")).FocusTools }));
const ExplorePage = lazy(async () => ({ default: (await import("./WorkPages")).ExplorePage }));
const InboxPage = lazy(async () => ({ default: (await import("./WorkPages")).InboxPage }));
const ReviewPage = lazy(async () => ({ default: (await import("./WorkPages")).ReviewPage }));
const ArchivePage = lazy(async () => ({ default: (await import("./WorkPages")).ArchivePage }));

const NotesStyles = lazy(async () => { await import("./notes-entry.css"); return { default: () => null }; });
const SettingsStyles = lazy(async () => { await import("./styles/avatar-settings.css"); return { default: () => null }; });

export type DeskSection = "home" | "tasks" | "health" | "wealth" | "projects" | "notes" | "explore" | "inbox" | "review" | "archive" | "ai" | "tools" | "settings" | "observer";
type UndoOffer = { message: string; run: () => Promise<void> };
type ArticleOrganizationPatch = {
  category?: NoteCategory;
  tags?: string[];
  projectId?: string;
  project?: string;
  source?: string[];
};
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
  attachmentRepository: AttachmentRepository;
  projectRepository: ProjectRepository;
  workRepository: WorkRepository;
  preferencesRepository: WorkspacePreferencesRepository;
  aiRepository: SqliteAiRepository;
  integrationRepository: IntegrationRepository;
  dashboardRepository: DashboardRepository;
  healthRepository: HealthRepository;
  financeRepository: FinanceRepository;
  displayName: string;
  avatarDataUrl: string;
  quickLinks: QuickLink[];
  healthReminder: HealthReminderPreferences;
  dataRevision: number;
  onRepositoryChange?: () => void;
  onEditingStateChange?: (editing: boolean) => void;
  accountDock: ReactNode;
  themeId: ThemeId;
  fontPresetId: FontPresetId;
  backingUp: boolean;
  onThemeChange: (themeId: ThemeId) => void;
  onFontPresetChange: (fontPresetId: FontPresetId) => void;
  onCreateBackup: () => void;
  onRestoreBackup: () => void;
  onSaveDisplayName: (name: string) => Promise<void>;
  onSaveAvatarDataUrl: (dataUrl: string) => Promise<void>;
  onSaveQuickLinks: (links: QuickLink[]) => Promise<void>;
  onSaveHealthReminder: (preferences: HealthReminderPreferences) => Promise<void>;
  onTestHealthReminder: () => Promise<void>;
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
  { id: "health", label: "健康", icon: "health", group: "action" },
  { id: "wealth", label: "财富", icon: "wealth", group: "action" },
  { id: "projects", label: "项目", icon: "projects", group: "action" },
  { id: "notes", label: "笔记", icon: "notes", group: "knowledge" },
  { id: "explore", label: "探索库", icon: "explore", group: "knowledge" },
  { id: "inbox", label: "待整理", icon: "inbox", group: "knowledge" },
  { id: "review", label: "回顾", icon: "review", group: "knowledge" },
  { id: "archive", label: "归档", icon: "archive", group: "knowledge" },
  { id: "ai", label: "AI 助手", icon: "ai", group: "tools" },
  { id: "observer", label: "工作记录", icon: "review", group: "tools" },
  { id: "tools", label: "工具中心", icon: "tools", group: "tools" },
];

/** 笔记只保留一套互斥主分类；自由标签用于表达家庭、沟通、写作等具体主题。 */
const noteCategoryViews: Array<{ id: "recent" | NoteCategory; label: string }> = [
  { id: "recent", label: "最近更新" },
  ...NOTE_CATEGORY_OPTIONS.map((option) => ({ id: option.value, label: option.label })),
];

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
  type: "记录",
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
  attachmentRepository,
  projectRepository,
  workRepository,
  preferencesRepository,
  aiRepository,
  integrationRepository,
  dashboardRepository,
  healthRepository,
  financeRepository,
  displayName,
  avatarDataUrl,
  quickLinks,
  healthReminder,
  dataRevision,
  onRepositoryChange,
  onEditingStateChange,
  accountDock,
  themeId,
  fontPresetId,
  backingUp,
  onThemeChange,
  onFontPresetChange,
  onCreateBackup,
  onRestoreBackup,
  onSaveDisplayName,
  onSaveAvatarDataUrl,
  onSaveQuickLinks,
  onSaveHealthReminder,
  onTestHealthReminder,
  startupActiveFocusId,
}: DesktopWorkbenchProps) {
  const confirm = useConfirmDialog();
  const [articles, setArticles] = useState<StoredArticle[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectDetails, setProjectDetails] = useState<ProjectDetail[]>([]);
  const [standaloneTasks, setStandaloneTasks] = useState<ProjectTask[]>([]);
  const [plans, setPlans] = useState<TaskPlan[]>([]);
  const [planHistory, setPlanHistory] = useState<TaskPlanHistory[]>([]);
  const [dailySituations, setDailySituations] = useState<DailySituation[]>([]);
  const [situationDate, setSituationDate] = useState<string | null>(null);
  const [projectWeekTarget, setProjectWeekTarget] = useState<ProjectWeekTarget>();
  const [projectWeekRevision, setProjectWeekRevision] = useState(0);
  const [projectWeekManaged, setProjectWeekManaged] = useState<WeekSettings["managed"]>({});
  const manualProjectCreate = useRef<(() => void) | null>(null);
  const [activeSession, setActiveSession] = useState<FocusSession | null>(null);
  const [focusSessions, setFocusSessions] = useState<FocusSession[]>([]);
  const [focusEditorSession, setFocusEditorSession] = useState<FocusSession | null>(null);
  const [focusHistoryOpen, setFocusHistoryOpen] = useState(false);
  const [weeklyFocus, setWeeklyFocus] = useState<WeeklyFocus | null>(null);
  const [weeklyReview, setWeeklyReview] = useState<WeeklyReview | null>(null);
  const [previousWeeklyReview, setPreviousWeeklyReview] = useState<WeeklyReview | null>(null);
  const [dashboardPreferences, setDashboardPreferences] = useState<DashboardPreferences>(() => structuredClone(defaultDashboardPreferences));
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [restDays, setRestDays] = useState<RestDay[]>([]);
  const [healthProfile, setHealthProfile] = useState<HealthProfile>(() => structuredClone(emptyHealthProfile));
  const [healthToday, setHealthToday] = useState<HealthDailyLog>(() => emptyHealthDailyLog(localDate()));
  const [healthMealsToday, setHealthMealsToday] = useState<HealthMeal[]>([]);
  const [section, setSection] = useState<DeskSection>("home");
  const [noteView, setNoteView] = useState<"recent" | NoteCategory>("recent");
  const [organizeId, setOrganizeId] = useState<string | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [batchIds, setBatchIds] = useState<Set<string>>(new Set());
  const [requestedProjectId, setRequestedProjectId] = useState<string | null>(null);
  const [requestedTaskId, setRequestedTaskId] = useState<string | null>(null);
  const [selectedArticle, setSelectedArticle] = useState<StoredArticle | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [projectEditing, setProjectEditing] = useState(false);
  const [appending, setAppending] = useState(false);
  const [draft, setDraft] = useState<Article>({ ...emptyDraft });
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
  const [expenseCaptureRequested, setExpenseCaptureRequested] = useState(false);
  const [healthReminderPrompt, setHealthReminderPrompt] = useState("");
  const [aiResponsePending, setAiResponsePending] = useState(false);
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
    const openHealth = () => setSection("health");
    const openExpense = () => {
      setSection("wealth");
      setExpenseCaptureRequested(true);
    };
    let unlistenHealth: UnlistenFn | undefined;
    let unlistenExpense: UnlistenFn | undefined;
    let unlistenReminder: UnlistenFn | undefined;
    let cancelled = false;
    const showPendingHealthReminder = async (fallback = "") => {
      const pending = await invoke<{ body: string } | null>("take_pending_health_reminder").catch(() => null);
      const body = pending?.body || fallback;
      if (!cancelled && body) setHealthReminderPrompt(body);
    };
    window.addEventListener("mind-garden:quick-expense", openExpense);
    void listen("open-health-record", openHealth).then((dispose) => { unlistenHealth = dispose; });
    void listen("open-expense-capture", openExpense).then((dispose) => { unlistenExpense = dispose; });
    void listen<{ body: string }>("health-reminder-due", ({ payload }) => {
      void showPendingHealthReminder(payload.body);
    }).then((dispose) => {
      unlistenReminder = dispose;
      void showPendingHealthReminder();
    });
    return () => {
      cancelled = true;
      window.removeEventListener("mind-garden:quick-expense", openExpense);
      unlistenHealth?.();
      unlistenExpense?.();
      unlistenReminder?.();
    };
  }, []);

  useEffect(() => {
    onEditingStateChange?.(editing || projectEditing || (quickCaptureOpen && Boolean(quickText.trim())));
  }, [editing, onEditingStateChange, projectEditing, quickCaptureOpen, quickText]);

  useEffect(() => () => onEditingStateChange?.(false), [onEditingStateChange]);

  useEffect(() => {
    const hasUnsavedInput = (editing && draftDirty) || projectEditing || (quickCaptureOpen && Boolean(quickText.trim()));
    if (!hasUnsavedInput) return;
    const preventClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventClose);
    return () => window.removeEventListener("beforeunload", preventClose);
  }, [draftDirty, editing, projectEditing, quickCaptureOpen, quickText]);

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
    const next = await repository.listSummaries(50, 0);
    setArticles(next);
    return next;
  }, [repository]);

  const refreshProjects = useCallback(async () => {
    const next = await projectRepository.list();
    const [details, standalone] = await Promise.all([
      projectRepository.listPlanningDetails(),
      projectRepository.listStandaloneTasks(),
    ]);
    setProjects(next);
    setProjectDetails(details);
    setStandaloneTasks(standalone);
    return next;
  }, [projectRepository]);

  const refreshWork = useCallback(async () => {
    const weekStart = startOfLocalWeekDate();
    const previousWeekStart = shiftLocalDate(weekStart, -7);
    const focusHistoryFrom = new Date();
    focusHistoryFrom.setFullYear(focusHistoryFrom.getFullYear() - 1);
    const [nextPlans, nextActive, nextSessions, nextFocus, nextReview, previousReview, nextHistory, nextSituations, week] = await Promise.all([
      workRepository.listPlans(),
      workRepository.getActiveSession(),
      workRepository.listSessions(focusHistoryFrom.toISOString(), 2000),
      workRepository.getWeeklyFocus(weekStart),
      workRepository.getWeeklyReview(weekStart),
      workRepository.getWeeklyReview(previousWeekStart),
      workRepository.listPlanHistory(),
      workRepository.listDailySituations(),
      projectRepository.readProjectWeek().catch(() => null),
    ]);
    if (week) setProjectWeekManaged(week.settings.managed);
    setPlans(nextPlans);
    setPlanHistory(nextHistory);
    setDailySituations(nextSituations);
    setActiveSession(nextActive);
    setFocusSessions(nextSessions);
    setWeeklyFocus(nextFocus);
    setWeeklyReview(nextReview);
    setPreviousWeeklyReview(previousReview);
  }, [workRepository, projectRepository]);

  const refreshDashboardLocal = useCallback(async () => {
    const [preferences, events, rests] = await Promise.all([
      dashboardRepository.getPreferences(),
      dashboardRepository.listEvents(),
      dashboardRepository.listRestDays(),
    ]);
    setDashboardPreferences(preferences);
    setCalendarEvents(events);
    setRestDays(rests);
  }, [dashboardRepository]);

  const refreshHealth = useCallback(async () => {
    const date = localDate();
    const [nextProfile, nextDaily, nextMeals] = await Promise.all([
      healthRepository.getProfile(),
      healthRepository.getDaily(date),
      healthRepository.listMeals(date),
    ]);
    setHealthProfile(nextProfile);
    setHealthToday(nextDaily);
    setHealthMealsToday(nextMeals);
  }, [healthRepository]);

  useEffect(() => {
    let active = true;
    let stop = () => {};
    void import("./xiaomi-sync").then(({ startXiaomiAutoSync }) => { if (active) stop = startXiaomiAutoSync(healthRepository); });
    const changed = () => { void refreshHealth(); };
    window.addEventListener("mind-garden:xiaomi-synced", changed);
    return () => { active = false; stop(); window.removeEventListener("mind-garden:xiaomi-synced", changed); };
  }, [healthRepository, refreshHealth]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([refreshArticles(), refreshProjects(), refreshWork(), refreshDashboardLocal(), refreshHealth()])
      .catch((error) => {
        if (active) showMessage(error instanceof Error ? error.message : "无法读取本地工作台");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [refreshArticles, refreshDashboardLocal, refreshHealth, refreshProjects, refreshWork, showMessage]);

  const articleSearchInitialized = useRef(false);
  useEffect(() => {
    if (!articleSearchInitialized.current) {
      articleSearchInitialized.current = true;
      return;
    }
    const timer = window.setTimeout(() => {
      void repository.listSummaries(50, 0, query)
        .then(setArticles)
        .catch((error) => showMessage(error instanceof Error ? error.message : "搜索笔记失败"));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query, repository, showMessage]);

  useEffect(() => {
    if (!dataRevision) return;
    void Promise.all([refreshProjects(), refreshWork()]).catch((error) => {
      showMessage(error instanceof Error ? error.message : "同步后无法刷新行动");
    });
    void refreshArticles().catch((error) => {
      showMessage(error instanceof Error ? error.message : "同步后无法刷新笔记列表");
    });
    const selectedArticleId = selectedArticle?.id;
    if (!selectedArticleId) return;
    let active = true;
    void repository.get(selectedArticleId)
      .then((article) => {
        if (!active) return;
        setSelectedArticle((current) => current?.id === selectedArticleId ? article : current);
      })
      .catch((error) => {
        if (active) showMessage(error instanceof Error ? error.message : "同步后无法刷新当前笔记");
      });
    return () => { active = false; };
  }, [dataRevision, refreshArticles, refreshProjects, refreshWork, repository, selectedArticle?.id, showMessage]);

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
        else if (selectedArticle || editing) requestCloseDocument();
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

  const workspaceTasks = useMemo<WorkspaceTask[]>(() => {
    const completed = new Set(projectDetails.flatMap((detail) => detail.tasks.filter((task) => task.status === "done").map((task) => task.id)));
    const projectTasks = projectDetails.flatMap((detail) => detail.tasks.map((task) => {
      const activeMilestones = detail.milestones.filter((item) => item.status !== "superseded");
      const milestone = activeMilestones.find((item) => item.id === task.milestoneId) ?? null;
      const stageTasks = detail.tasks.filter((item) => item.milestoneId === task.milestoneId);
      const stageIndex = milestone ? activeMilestones.findIndex((item) => item.id === milestone.id) + 1 : 0;
      const storedPlan = plans.find((plan) => plan.taskId === task.id) ?? null;
      const planCarriedFrom = storedPlan && task.status !== "done" && storedPlan.plannedDate < today
        ? storedPlan.plannedDate
        : "";
      return {
        ...task,
        projectTitle: detail.project.title,
        projectStatus: detail.project.status,
        stageTitle: milestone?.title ?? "",
        stageDueDate: milestone?.dueDate ?? "",
        stageIndex,
        stageCount: activeMilestones.length,
        stageCompletedTasks: stageTasks.filter((item) => item.status === "done").length,
        stageTaskCount: stageTasks.length,
        plan: storedPlan,
        planCarriedFrom,
        weekBlocked: Boolean(projectWeekManaged[task.id]?.after.some((id) => !completed.has(id)) ||
          (projectWeekManaged[task.id]?.date === "" && storedPlan?.plannedDate === "")),
      };
    }));
    const independentTasks = standaloneTasks.map((task): WorkspaceTask => {
      const storedPlan = plans.find((plan) => plan.taskId === task.id) ?? null;
      const planCarriedFrom = storedPlan && task.status !== "done" && storedPlan.plannedDate < today
        ? storedPlan.plannedDate
        : "";
      return {
        ...task,
        projectTitle: "独立行动",
        projectStatus: null,
        stageTitle: "",
        stageDueDate: "",
        stageIndex: 0,
        stageCount: 0,
        stageCompletedTasks: 0,
        stageTaskCount: 0,
        plan: storedPlan,
        planCarriedFrom,
      };
    });
    return [...projectTasks, ...independentTasks];
  }, [plans, projectDetails, standaloneTasks, today, projectWeekManaged]);

  useEffect(() => {
    if (loading) return;
    void workRepository.autoScheduleDueTasks(today).then((count) => {
      if (count > 0) return refreshWork();
    }).catch((error) => showMessage(error instanceof Error ? error.message : "无法自动安排今日行动"));
  }, [loading, today, workspaceTasks, workRepository, refreshWork, showMessage]);

  const inboxCount = useMemo(() => articles.filter(isThoughtInboxArticle).length, [articles]);
  const noteArticles = useMemo(() => {
    return articles.filter((article) => {
      if (isSourceArticle(article) || isThoughtInboxArticle(article)) return false;
      if (noteView !== "recent" && articleNoteCategory(article) !== noteView) return false;
      return true;
    });
  }, [articles, noteView]);
  /** 「最近更新」统计全部笔记，其余入口按新的互斥主分类归集。 */
  const noteViewCounts = useMemo(() => {
    const candidates = articles.filter((article) => (
      !isSourceArticle(article)
      && !isThoughtInboxArticle(article)
    ));
    return noteCategoryViews.reduce<Record<string, number>>((result, item) => {
      result[item.id] = item.id === "recent"
        ? candidates.length
        : candidates.filter((article) => articleNoteCategory(article) === item.id).length;
      return result;
    }, {});
  }, [articles]);

  const projectCounts = rootProjectStatusCounts(projects);
  const counts: Record<DeskSection, number | null> = {
    home: null,
    tasks: workspaceTasks.filter((task) => !["done", "cancelled", "waiting"].includes(task.status) && (task.plan?.plannedDate === today || isContinuablePlan(task.plan, today))).length,
    health: null,
    wealth: null,
    projects: projectCounts.active,
    notes: articles.filter((article) => !isSourceArticle(article) && !isThoughtInboxArticle(article)).length,
    explore: articles.filter(isSourceArticle).filter((article) => article.branch !== "已归档").length,
    inbox: inboxCount,
    review: null,
    archive: projects.filter((project) => project.status === "completed").length + workspaceTasks.filter((task) => task.status === "done" || task.status === "cancelled").length,
    ai: null,
    observer: null,
    tools: null,
    settings: null,
  };

  async function switchSection(next: DeskSection) {
    if (next === section) return true;
    if (section === "ai" && next !== "ai" && aiResponsePending) {
      showMessage("DeepSeek 正在生成回答，请先等待完成或点击停止。");
      return false;
    }
    if (section === "projects" && next !== "projects" && projectEditing) {
      if (!await confirm({
        title: "离开项目编辑页？",
        description: "当前项目编辑尚未保存，离开后这些修改将被放弃。",
        confirmLabel: "放弃并离开",
        tone: "danger",
      })) return false;
      setProjectEditing(false);
    }
    setSection(next);
    setSelectedArticle(null);
    setOrganizeId(null);
    setEditing(false);
    setQuery("");
    return true;
  }

  async function openProject(projectId: string) {
    if (!await switchSection("projects")) return;
    setRequestedProjectId(projectId);
  }

  async function openTask(taskId: string) {
    if (!await switchSection("tasks")) return;
    setRequestedTaskId(taskId);
  }

  async function openArticle(article: StoredArticle) {
    try {
      const hydrated = await hydrateArticle(article);
      setOrganizeId(null);
      setSelectedArticle(hydrated);
      setDraft(toEditableArticle(hydrated));
      setDraftDirty(false);
      setEditing(false);
      setAppending(false);
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "无法打开笔记");
    }
  }

  async function hydrateArticle(article: StoredArticle) {
    if (article.body) return article;
    const hydrated = await repository.get(article.id);
    if (!hydrated) throw new Error("这篇笔记已经不存在");
    return hydrated;
  }

  function startNewArticle() {
    setOrganizeId(null);
    setSelectedArticle(null);
    setDraft({ ...emptyDraft, tags: [], source: ["自写"], created: today });
    setDraftDirty(false);
    setEditing(true);
    setAppending(false);
  }

  async function startEditing(article: StoredArticle, append = false) {
    try {
      const hydrated = await repository.get(article.id);
      if (!hydrated) throw new Error("这篇笔记已经不存在");
      const next = toEditableArticle(hydrated);
      if (append) next.body = `${next.body.trim()}\n\n## ${today} · 追加想法\n\n`;
      setSelectedArticle(hydrated);
      setDraft(next);
      setDraftDirty(false);
      setEditing(true);
      setAppending(append);
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "无法读取笔记正文");
    }
  }

  function closeDocument() {
    setDraftDirty(false);
    setEditing(false);
    setAppending(false);
    setSelectedArticle(null);
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
      await attachmentRepository.replaceArticleReferences(saved.id, saved.body);
      setSelectedArticle((current) => selectAfterSave || current?.id === saved.id ? saved : current);
      await refreshArticles();
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

  /** 单条整理：分类、标签和可选关联即时保存，无需打开编辑器。 */
  async function organizeArticle(article: StoredArticle, patch: ArticleOrganizationPatch) {
    article = await hydrateArticle(article);
    const next: Article = { ...article, tags: [...article.tags], source: [...article.source] };
    if (patch.category !== undefined) next.category = patch.category;
    if (patch.tags !== undefined) next.tags = [...patch.tags];
    if (patch.projectId !== undefined) next.projectId = patch.projectId;
    if (patch.project !== undefined) next.project = patch.project;
    if (patch.source !== undefined) next.source = [...patch.source];
    const saved = await persist(next, "已经更新整理。", false);
    if (saved && draft.id === saved.id) setDraft(toEditableArticle(saved));
    return Boolean(saved);
  }

  /** 批量整理只处理主分类和自由标签，不再维护第二套固定性质。 */
  async function batchOrganize(patch: { category?: NoteCategory; addTag?: string; removeTag?: string }) {
    const targets = articles.filter((article) => batchIds.has(article.id));
    if (!targets.length) return;
    setSaving(true);
    try {
      for (const article of targets) {
        const hydrated = await hydrateArticle(article);
        const next: Article = { ...hydrated, tags: [...hydrated.tags], source: [...hydrated.source] };
        if (patch.category !== undefined) next.category = patch.category;
        if (patch.addTag) next.tags = [...new Set([...hydrated.tags, patch.addTag])];
        if (patch.removeTag) next.tags = hydrated.tags.filter((tag) => tag !== patch.removeTag);
        await repository.save(next);
      }
      await refreshArticles();
      onRepositoryChange?.();
      showMessage(`已经整理 ${targets.length} 条笔记。`);
      setBatchIds(new Set());
      setBatchMode(false);
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "批量整理失败");
    } finally {
      setSaving(false);
    }
  }

  /** 切换某条笔记在批量模式中的勾选状态 */
  function toggleBatchId(id: string) {
    setBatchIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** 退出批量模式并清空勾选 */
  function exitBatchMode() {
    setBatchMode(false);
    setBatchIds(new Set());
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
      category: draft.collection === "sources" ? "探索资料" : articleNoteCategory(draft),
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
      await switchSection("inbox");
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

  async function prepareDelegation(note: StoredArticle, reveal = false) {
    if (!note.body.trim()) throw new Error("请先补充笔记内容。");
    if (reveal) await companionApi.window(true);
    await emitTo("companion", "asaba-prepare-note", {
      noteId: note.id, title: note.title, projectId: note.projectId || "",
      description: note.body.slice(0, 4000), repository: "",
    });
  }

  async function saveAsabaNote(note: AsabaNote) {
    if (!/^[0-9a-f-]{36}$/i.test(note.id)) throw new Error("便签编号无效。");
    const text = note.text.trim();
    if (text.length > 4000 || note.url.length > 2048) throw new Error("便签内容过长。");
    const project = projects.find(project => project.id === note.projectId);
    if (note.projectId && !project) throw new Error("项目已变化，请重新选择。");
    const url = note.url.trim() ? new URL(note.url.trim()) : null;
    if (url && !["http:", "https:"].includes(url.protocol)) throw new Error("请粘贴一个网页链接。");
    if (!text && !url) throw new Error("请写点内容或粘贴链接。");
    const collection = "notes";
    const id = `${collection}/asaba-${note.id}`;
    if (await repository.get(id)) return id;
    const source = ["浅羽随手记"];
    if (url) source.push(url.href);
    if (note.application) source.push(`应用 · ${note.application.slice(0, 100)}`);
    if (note.shotId && /^[0-9a-f-]{36}$/i.test(note.shotId)) source.push(`浅羽画面 · ${note.shotId}`);
    const saved = await persist({
      ...emptyDraft, id, slug: `asaba-${note.id}`, collection,
      collectionLabel: "笔记",
      category: "uncategorized",
      title: text ? captureTitle(text) : url!.hostname,
      body: url ? `${text ? `${text}\n\n` : ""}[打开原内容](<${url.href}>)` : text,
      type: "想法", branch: "待分类", stage: "种子",
      projectId: project?.id || "", project: project?.title || "", summary: plainExcerpt(text) || url?.hostname || "",
      created: today, source,
    }, "已保存到笔记 · 待分类。", false);
    if (!saved) throw new Error("便签未能保存，请重试。");
    return saved.id;
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

  async function setRestDay(date: string, rested: boolean) {
    if (rested) await dashboardRepository.saveRestDay(date);
    else await dashboardRepository.deleteRestDay(date);
    await refreshDashboardLocal();
    showMessage(rested ? "已经把这一天记为休息日。" : "已经恢复这一天的正常安排。");
  }

  async function removeArticle(article: StoredArticle) {
    const source = isSourceArticle(article);
    if (!await confirm({
      title: source ? "删除这条收藏？" : "删除这篇笔记？",
      subject: article.title,
      description: source ? "这条收藏会从探索库删除，删除后可在提示消失前撤销。" : "这篇笔记会被删除，删除后可在提示消失前撤销。",
      descriptionIcon: "↶",
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
    if (task.autoSchedulePaused) await workRepository.resumeAutoSchedule(task.id);
    await workRepository.savePlan({
      taskId: task.id,
      plannedDate: today,
      source: "manual",
      skipAutoDate: "",
      priority: task.plan?.priority || "normal",
      estimateMinutes: task.plan?.estimateMinutes || 0,
      sortOrder: task.plan?.sortOrder || workspaceTasks.filter((item) => item.plan?.plannedDate === today).length,
      updatedAt: "",
    });
    await Promise.all([refreshProjects(), refreshWork()]);
    offerUndo("已安排到今天", async () => {
      await workRepository.removePlan(task.id);
      if (task.autoSchedulePaused) await workRepository.pauseAutoSchedule(task.id, today);
      await Promise.all([refreshProjects(), refreshWork()]);
    });
  }

  async function removeFromToday(task: WorkspaceTask) {
    const previous = task.plan;
    if (!previous) return;
    const moveToPending = previous.plannedDate === today;
    const pauseAutomatic = moveToPending && Boolean(task.dueDate && task.estimatedDays);
    if (pauseAutomatic) await workRepository.pauseAutoSchedule(task.id, today);
    else if (moveToPending) await workRepository.savePlan({ ...previous, plannedDate: "" });
    else await workRepository.removePlan(task.id);
    await Promise.all([refreshProjects(), refreshWork()]);
    offerUndo(moveToPending ? "已移入待继续，有空再做" : "已暂时收起，可从已有行动找回", async () => {
      if (pauseAutomatic) await workRepository.resumeAutoSchedule(task.id);
      await workRepository.savePlan(previous);
      await Promise.all([refreshProjects(), refreshWork()]);
    });
  }

  async function resumeAutoSchedule(task: WorkspaceTask) {
    await workRepository.resumeAutoSchedule(task.id);
    await refreshProjects();
  }

  async function startFocus(task: Pick<ProjectTask, "id" | "projectId" | "title">) {
    try {
      if (projectWeekManaged[task.id]?.after.length) {
        const schedule = await projectRepository.readProjectWeek();
        const action = schedule.actions.find((item) => item.id === task.id);
        if (action?.after.some((id) => schedule.actions.find((item) => item.id === id)?.status !== "done")) {
          showMessage("请先完成这项行动的前置任务。");
          return false;
        }
      }
      const session = await workRepository.startSession({ taskId: task.id, projectId: task.projectId, label: task.title });
      setActiveSession(session);
      setFocusSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
      showMessage("已经开始记录这次投入。 ");
      return true;
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "无法开始专注");
      return false;
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

  async function companionFocus(command: AsabaFocusCommand) {
    if (command.operation === "stop") {
      const current = await workRepository.getActiveSession();
      if (!current || current.id !== command.sessionId) throw new Error("当前投入已变化，请刷新后再结束。");
      await workRepository.stopSession(current.id);
      await refreshWork();
      return;
    }
    if (command.operation !== "start") throw new Error("无法识别投入操作。");
    if (command.taskId) {
      const task = workspaceTasks.find(task => task.id === command.taskId && !["done", "cancelled", "waiting"].includes(task.status));
      if (!task) throw new Error("这项行动目前无法开始。");
      const session = await workRepository.startSession({ taskId: task.id, projectId: task.projectId, label: task.title });
      setActiveSession(session);
      setFocusSessions(current => [session, ...current.filter(item => item.id !== session.id)]);
    } else {
      const label = command.label?.trim();
      if (!label || label.length > 120) throw new Error("请给这次投入写一个简短名字。");
      const project = projects.find(project => project.id === command.projectId);
      if (command.projectId && !project) throw new Error("项目已变化，请重新选择。");
      const session = await workRepository.startSession({ label, projectId: project?.id || null });
      setActiveSession(session);
      setFocusSessions(current => [session, ...current.filter(item => item.id !== session.id)]);
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
      offerUndo(stopped ? `行动已完成 · 本次投入 ${formatFocusDuration(stopped.durationSeconds)}` : "行动已完成", async () => {
        await projectRepository.updateTaskStatus(task.id, task.status);
        await refreshProjects();
      });
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "无法完成行动");
    }
  }

  async function updateTask(task: WorkspaceTask) {
    try {
      await projectRepository.saveTask(task);
      await refreshProjects();
      return true;
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "无法保存行动");
      return false;
    }
  }

  async function saveDailySituation(situation: DailySituation, changes: SituationPlanChange[]) {
    await workRepository.saveDailySituation(situation, changes);
    await refreshWork();
    showMessage("当天情况已保存，后续可以从留下的行动继续。");
  }

  async function closeToday(task: WorkspaceTask, result: string, nextFocus: string) {
    try {
      if (activeSession?.taskId === task.id) await workRepository.stopSession(activeSession.id);
      await projectRepository.recordTaskProgress(task.id, result, nextFocus);
      await workRepository.savePlan({
        taskId: task.id,
        plannedDate: "",
        skipAutoDate: today,
        priority: task.plan?.priority || "normal",
        estimateMinutes: task.plan?.estimateMinutes || 0,
        sortOrder: task.plan?.sortOrder || 0,
        updatedAt: "",
      });
      await Promise.all([refreshProjects(), refreshWork()]);
      showMessage("进展已记录，行动留在待继续，有空再做。");
      return true;
    } catch (error) {
      await Promise.all([refreshProjects(), refreshWork()]);
      showMessage(error instanceof Error ? error.message : "无法保存今日进展");
      return false;
    }
  }

  async function restoreTask(task: WorkspaceTask) {
    try {
      await projectRepository.updateTaskStatus(task.id, "later");
      await refreshProjects();
      offerUndo("行动已经恢复", async () => {
        await projectRepository.updateTaskStatus(task.id, task.status);
        await refreshProjects();
      });
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "无法恢复行动");
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
      direction: input.direction,
      title: input.title,
      actionType: "organize",
      definitionOfDone: input.definitionOfDone,
      steps: input.steps,
      currentFocus: input.currentFocus,
      details: input.details,
      benefit: "",
      dueDate: input.dueDate,
      estimatedDays: input.estimatedDays || 0,
      status: input.status || "later",
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
      if (input.plannedToday || input.keepAvailable) {
        await workRepository.savePlan({ taskId: saved.id, plannedDate: input.plannedToday ? today : "", priority: "normal", estimateMinutes: 0, sortOrder: 99, updatedAt: "" });
      }
      await Promise.all([refreshProjects(), refreshWork()]);
      showMessage("行动已经添加。");
      return saved;
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "无法添加行动");
      return null;
    }
  }

  async function addTask(input: NewActionInput) {
    return Boolean(await createTask(input));
  }

  async function quickStart(title: string) {
    const saved = await createTask({
      projectId: null,
      milestoneId: null,
      direction: "uncategorized",
      title,
      definitionOfDone: `完成“${title}”眼前这一小步`,
      steps: [],
      currentFocus: title,
      details: "",
      dueDate: "",
      plannedToday: true,
      keepAvailable: true,
    });
    return saved ? startFocus(saved) : false;
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

  async function saveWeeklyReview(review: Omit<WeeklyReview, "weekStart" | "updatedAt">) {
    try {
      await workRepository.saveWeeklyReview({
        weekStart: startOfLocalWeekDate(),
        ...review,
        updatedAt: "",
      });
      await refreshWork();
      showMessage("本周校准已经保存。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "本周校准保存失败");
    }
  }

  async function moveInboxArticle(article: StoredArticle, destination: "note" | "explore") {
    article = await hydrateArticle(article);
    const saved = await persist({
      ...article,
      collection: destination === "explore" ? "sources" : "notes",
      collectionLabel: destination === "explore" ? "探索资料" : "笔记",
      category: destination === "explore" ? "探索资料" : articleNoteCategory(article),
      type: destination === "explore" ? "外部资料" : article.type === "外部资料" ? "想法" : article.type,
      branch: destination === "explore" ? "收藏中" : "已整理",
    }, destination === "explore" ? "已转入探索库。" : "已整理为笔记。");
    if (saved) closeDocument();
  }

  async function convertInboxToAction(article: StoredArticle, projectId: string) {
    article = await hydrateArticle(article);
    const project = projectDetails.find((item) => item.project.id === projectId);
    if (!project) return;
    const created = await createTask({
      projectId,
      milestoneId: project.milestones.find((item) => item.status === "current")?.id ?? null,
      direction: project.project.category,
      title: article.title,
      definitionOfDone: "",
      steps: [],
      currentFocus: article.title,
      details: article.body,
      dueDate: "",
      plannedToday: false,
    });
    if (created) await finishConvertedCapture(article, { kind: "task", id: created.id }, "已转为项目行动，原记录已整理为笔记。");
  }

  async function convertInboxToProposal(article: StoredArticle, projectId: string) {
    article = await hydrateArticle(article);
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
      category: articleNoteCategory(article),
      branch: "已整理",
    }, relation), sourceMessage, false);
  }

  async function organizeSource(article: StoredArticle, input: SourceOrganizationInput) {
    article = await hydrateArticle(article);
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
          category: inferNoteCategory({ title: input.title, summary: plainExcerpt(input.body), tags: input.tags }),
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
          direction: input.direction,
          title: input.title,
          actionType: "organize",
          definitionOfDone: input.definitionOfDone,
          steps: input.steps,
          currentFocus: input.currentFocus,
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
    article = await hydrateArticle(article);
    await persist({ ...article, branch: archived ? "已归档" : "收藏中" }, archived ? "收藏已经归档。" : "收藏已经恢复。", false);
  }

  const documentMode = Boolean(selectedArticle || editing);
  const rootClass = [
    "desktop-workbench",
    "workbench-v2",
    documentMode ? "document-mode" : "",
    section === "projects" && !documentMode ? "projects-mode" : "",
    section === "notes" && !documentMode ? "notes-mode" : "",
    sidebarCollapsed && !documentMode ? "sidebar-collapsed" : "",
    `theme-${themeId}`,
    `font-preset-${fontPresetId}`,
  ].filter(Boolean).join(" ");
  const taskActions = {
    onChangeWeek: () => setProjectWeekTarget({ kind: "change" }),
    onCompleteTask: completeTask,
    onUpdateTask: updateTask,
    onCloseToday: closeToday,
    onPlanToday: planToday,
    onRemoveFromToday: removeFromToday,
    onResumeAutoSchedule: resumeAutoSchedule,
    onStartFocus: startFocus,
    onQuickStart: quickStart,
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
        title={workspaceTitle(displayName)}
        avatarDataUrl={avatarDataUrl}
        collapsed={sidebarCollapsed}
        onSwitch={switchSection}
        onToggle={toggleSidebar}
        accountDock={accountDock}
      />
      )}

      <ThemeArtwork themeId={themeId} section={section} documentMode={documentMode} />

      {activeSession && <GlobalFocusBar session={activeSession} task={workspaceTasks.find((task) => task.id === activeSession.taskId) ?? null} onShow={() => activeSession.taskId ? openTask(activeSession.taskId) : switchSection("tasks")} onPause={() => void stopFocus()} onCorrect={() => setFocusEditorSession(activeSession)} />}
      <Suspense fallback={null}><FocusTools activeSession={activeSession} repository={workRepository} preferencesRepository={preferencesRepository} editorSession={focusEditorSession} onEdit={setFocusEditorSession} historyOpen={focusHistoryOpen} onCloseHistory={() => setFocusHistoryOpen(false)} onChanged={refreshWork} onMessage={showMessage} /></Suspense>
      <ObserverIndicator onOpen={() => void switchSection("observer")} />
      <Suspense fallback={null}><CompanionBridge projects={projects} tasks={workspaceTasks} articles={articles} dashboardRepository={dashboardRepository} dashboardPreferences={dashboardPreferences} activeSession={activeSession} onFocus={companionFocus} onError={showMessage} onSaveNote={saveAsabaNote} onAction={async (action: CompanionAction) => {
        if (action.kind === "prepare_note") {
          const note = await repository.get(action.id);
          if (!note) throw new Error("这篇笔记已不存在。");
          await prepareDelegation(note);
        } else if (action.kind === "open_note") {
          const note = await repository.get(action.id);
          if (!note) throw new Error("这篇笔记已不存在。");
          await openArticle(note);
        } else if (action.kind === "open_project") {
          if (!projects.some(project => project.id === action.id)) throw new Error("项目已发生变化，请刷新后再试。");
          await openProject(action.id);
        } else if (action.kind === "start_task") {
          const task = workspaceTasks.find(task => task.id === action.id && !["done", "cancelled", "waiting"].includes(task.status));
          if (!task) throw new Error("这项行动目前无法开始。");
          if (activeSession) throw new Error("已有投入正在记录，请先暂停当前投入。");
          if (!await startFocus(task)) throw new Error("未能开始记录投入，请查看工作台提示。");
        } else if (action.kind === "capture") {
          setQuickText(action.text || ""); setQuickCaptureOpen(true);
        } else if (action.kind === "open_observer") await switchSection("observer");
        else if (action.kind === "open_settings") await switchSection("settings");
      }} /></Suspense>

      <Suspense fallback={<section className="workspace-page-loading"><span>个人工作台</span><strong>正在打开这一页…</strong></section>}>
      {(documentMode || section === "notes") && <NotesStyles />}
      {documentMode ? (
        <section className="document-stage">
          {editing ? (
            <ArticleEditor
              draft={draft}
              attachmentRepository={attachmentRepository}
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
          ) : selectedArticle ? (
            <ArticleReader
              article={selectedArticle}
              attachmentRepository={attachmentRepository}
              saving={saving}
              onBack={closeDocument}
              onEdit={() => void startEditing(selectedArticle)}
              onAppend={() => void startEditing(selectedArticle, true)}
              onDelegate={isTauri() && selectedArticle.body.trim() ? () => void prepareDelegation(selectedArticle, true).catch(error => showMessage(String(error))) : undefined}
              onRemove={() => void removeArticle(selectedArticle)}
            />
          ) : null}
        </section>
      ) : section === "projects" ? (
        <ProjectWorkspace
          onCreateWeek={(manual) => { manualProjectCreate.current = manual; setProjectWeekTarget({ kind: "create" }); }}
          onContinueWeek={(projectId) => setProjectWeekTarget({ kind: "continue", projectId })}
          onChangeWeek={taskActions.onChangeWeek}
          weekRevision={projectWeekRevision}
          plannedDates={Object.fromEntries(plans.map((plan) => [plan.taskId, plan.plannedDate]))}
          today={today}
          repository={projectRepository}
          projects={projects}
          articles={articles}
          onOpenArticle={openArticle}
          initialProjectId={requestedProjectId}
          onProjectsChange={refreshProjects}
          onBackToHall={() => setRequestedProjectId(null)}
          onRemoveTask={removeTask}
          onEditingStateChange={setProjectEditing}
        />
      ) : section === "notes" ? (
        <><NotesWorkspace
          articles={noteArticles}
          projects={projects}
          counts={noteViewCounts}
          loading={loading}
          query={query}
          view={noteView}
          batchMode={batchMode}
          batchIds={batchIds}
          organizeId={organizeId}
          organizingArticle={articles.find((article) => article.id === organizeId) ?? null}
          onQuery={setQuery}
          onView={setNoteView}
          onOpen={openArticle}
          onNew={startNewArticle}
          onOrganizeToggle={setOrganizeId}
          onToggleBatch={toggleBatchId}
          onToggleAll={() => setBatchIds((current) => {
            const next = new Set(current);
            const allVisibleSelected = noteArticles.length > 0 && noteArticles.every((article) => next.has(article.id));
            noteArticles.forEach((article) => allVisibleSelected ? next.delete(article.id) : next.add(article.id));
            return next;
          })}
          onEnterBatch={() => { setOrganizeId(null); setBatchMode(true); }}
          onExitBatch={exitBatchMode}
          onOrganize={organizeArticle}
          onBatchOrganize={batchOrganize}
        /></>
      ) : (
        <section className="workspace-main-stage">
          {section === "home" && <HomeDashboard planningHistoryRepository={aiRepository} projectDetails={projectDetails} dailySituations={dailySituations} onSupplementDay={setSituationDate} today={today} tasks={workspaceTasks} articles={articles} articleRepository={repository} weeklyFocus={weeklyFocus} integrationRepository={integrationRepository} dashboardRepository={dashboardRepository} dashboardPreferences={dashboardPreferences} calendarEvents={calendarEvents} restDays={restDays} healthProfile={healthProfile} healthToday={healthToday} healthMeals={healthMealsToday} onOpenHealth={() => switchSection("health")} onOpenTools={() => switchSection("tools")} onSaveWeeklyFocus={saveWeeklyFocus} onSaveDashboardPreferences={saveDashboardPreferences} onSaveCalendarEvent={saveCalendarEvent} onDeleteCalendarEvent={deleteCalendarEvent} onSetRestDay={setRestDay} onSaveSource={saveExternalSource} onNotice={showMessage} onOpenArticle={openArticle} onOpenProject={openProject} onOpenTask={openTask} onOpenTasks={() => switchSection("tasks")} {...taskActions} />}
          {section === "tasks" && <TasksPage onOpenFocusHistory={() => setFocusHistoryOpen(true)} onSupplementDay={setSituationDate} dailySituations={dailySituations} today={today} tasks={workspaceTasks} projects={projects} projectDetails={projectDetails} initialTaskId={requestedTaskId} onTaskOpened={() => setRequestedTaskId(null)} onAddTask={addTask} onRemoveTask={removeTask} onOpenProject={openProject} {...taskActions} />}
          {section === "observer" && <WorkObserverPage tasks={workspaceTasks} activeSession={activeSession} onOpenTask={openTask} />}
          {section === "health" && <HealthPage repository={healthRepository} today={today} onChanged={() => void refreshHealth()} onNotice={showMessage} onOpenAiSettings={() => switchSection("settings")} />}
          {section === "wealth" && <WealthPage repository={financeRepository} projects={projects} today={today} onNotice={showMessage} quickCaptureRequested={expenseCaptureRequested} onQuickCaptureOpened={() => setExpenseCaptureRequested(false)} />}
          {section === "explore" && <ExplorePage articles={articles} projects={projects} projectDetails={projectDetails} onSaveLink={saveExternalLink} onArchive={archiveSource} onDelete={removeArticle} onOpenArticle={openArticle} onOpenProject={openProject} onOrganize={organizeSource} />}
          {section === "inbox" && <InboxPage articles={articles} projects={projects} onOpenArticle={openArticle} onNewCapture={() => setQuickCaptureOpen(true)} onMoveArticle={moveInboxArticle} onConvertToAction={convertInboxToAction} onConvertToProposal={convertInboxToProposal} onDelete={removeArticle} />}
          {section === "review" && <ReviewPage dailySituations={dailySituations} onSupplementDay={setSituationDate} projects={projects} projectDetails={projectDetails} articles={articles} tasks={workspaceTasks} weeklyFocus={weeklyFocus} weeklyReview={weeklyReview} previousWeeklyReview={previousWeeklyReview} onSaveWeeklyReview={saveWeeklyReview} onOpenTask={openTask} />}
          {section === "archive" && <ArchivePage projects={projects} tasks={workspaceTasks} focusSessions={focusSessions} onOpenProject={openProject} onOpenTask={openTask} onRestoreTask={restoreTask} />}
          {section === "ai" && <AiAssistantDialog open repository={aiRepository} embedded onPendingChange={setAiResponsePending} />}
          {section === "tools" && <ToolCenterPage repository={integrationRepository} quickLinks={quickLinks} onSaveQuickLinks={onSaveQuickLinks} onOpenAi={() => switchSection("ai")} onOpenAiSettings={() => switchSection("settings")} />}
          {section === "settings" && <><SettingsStyles /><SettingsPage displayName={displayName} avatarDataUrl={avatarDataUrl} themeId={themeId} fontPresetId={fontPresetId} backingUp={backingUp} dashboardPreferences={dashboardPreferences} healthReminder={healthReminder} onSaveDashboardPreferences={saveDashboardPreferences} onSaveHealthReminder={onSaveHealthReminder} onTestHealthReminder={onTestHealthReminder} onSaveDisplayName={onSaveDisplayName} onSaveAvatarDataUrl={onSaveAvatarDataUrl} onThemeChange={onThemeChange} onFontPresetChange={onFontPresetChange} onCreateBackup={onCreateBackup} onRestoreBackup={onRestoreBackup} /></>}
        </section>
      )}
      </Suspense>

      {quickCaptureOpen && (
        <div className="capture-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) closeQuickCapture();
        }}>
          <form className="capture-dialog" onSubmit={quickCapture}>
            <header><span>随手记录</span><Button variant="secondary" size="small" iconOnly type="button" onClick={closeQuickCapture} aria-label="关闭快速记录">×</Button></header>
            <h2>先把它留下来</h2>
            <p>不必分类、不必写完整，保存后会进入独立的待整理清单。</p>
            <textarea autoFocus value={quickText} onChange={(event) => setQuickText(event.target.value)} onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
            }} placeholder="一句念头、一段感受，或突然想写下的东西……" />
            <footer><span><kbd>Ctrl</kbd> + <kbd>Enter</kbd> 保存</span><Button variant="primary" disabled={saving || !quickText.trim()} type="submit">{saving ? "正在保存…" : "放进待整理"}</Button></footer>
          </form>
        </div>
      )}

      {healthReminderPrompt && (
        <div className="capture-backdrop" role="presentation">
          <section className="capture-dialog health-reminder-dialog" role="alertdialog" aria-modal="true" aria-labelledby="health-reminder-title">
            <header><span>每日健康提醒</span></header>
            <h2 id="health-reminder-title">今晚还差一点记录</h2>
            <p>{healthReminderPrompt}</p>
            <footer><Button variant="secondary" type="button" onClick={() => setHealthReminderPrompt("")}>稍后再说</Button><Button variant="primary" type="button" onClick={() => { setHealthReminderPrompt(""); setSection("health"); }}>现在记录</Button></footer>
          </section>
        </div>
      )}

      {situationDate && <DailySituationDialog date={situationDate} today={today} tasks={workspaceTasks} history={planHistory} situations={dailySituations} activeTaskId={activeSession?.taskId} onClose={() => setSituationDate(null)} onSave={saveDailySituation} />}
      {projectWeekTarget && <ProjectWeekDialog repository={projectRepository} target={projectWeekTarget} today={today}
        onClose={() => setProjectWeekTarget(undefined)}
        onManualCreate={() => { setProjectWeekTarget(undefined); manualProjectCreate.current?.(); }}
        onSaved={async (projectId) => {
          setProjectWeekTarget(undefined);
          setProjectWeekRevision((value) => value + 1);
          await Promise.all([refreshProjects(), refreshWork()]);
          if (projectId) await openProject(projectId);
          showMessage("项目安排已保存。");
        }} />}
      {activeSession?.id === focusRecoveryId && <div className="focus-recovery-backdrop"><section className="focus-recovery-dialog" role="dialog" aria-modal="true" aria-label="处理上次未结束的投入"><span>投入记录恢复</span><h2>上次投入没有正常结束</h2><p>“{activeSession.label}”开始于 {new Date(activeSession.startedAt).toLocaleString("zh-CN")}。请选择实际结束时间，或者继续本次投入。</p><label><span>实际结束时间</span><input type="datetime-local" min={toLocalDateTimeInput(new Date(activeSession.startedAt))} max={toLocalDateTimeInput(new Date())} value={focusRecoveryEnd} onChange={(event) => setFocusRecoveryEnd(event.target.value)} /></label><footer><Button variant="secondary" type="button" onClick={() => setFocusRecoveryId(null)}>继续投入</Button><Button variant="primary" onClick={() => void finishRecoveredFocus()}>按此时间暂停并记录</Button></footer></section></div>}

      {message && <div className="desktop-toast" role="status">{message}</div>}
      {undoOffer && <div className="desktop-toast undo-toast" role="status"><span>{undoOffer.message}</span><Button variant="ghost" size="small" type="button" onClick={() => void runUndo()}>撤销</Button></div>}
    </main>
  );
}

function WorkbenchSidebar({
  section,
  counts,
  collapsed,
  onSwitch,
  onToggle,
  accountDock,
  title,
  avatarDataUrl,
}: {
  section: DeskSection;
  counts: Record<DeskSection, number | null>;
  collapsed: boolean;
  onSwitch: (section: DeskSection) => void;
  onToggle: () => void;
  accountDock: ReactNode;
  title: string;
  avatarDataUrl: string;
}) {
  return (
    <aside className="workbench-sidebar">
      <button className="sidebar-collapse-toggle" onClick={onToggle} aria-label={collapsed ? "展开侧栏" : "收起侧栏"} title={collapsed ? "展开侧栏" : "收起侧栏"}>{collapsed ? "›" : "‹"}</button>
      <div className="sidebar-brand"><span className={`sidebar-brand-mark${avatarDataUrl ? " has-image" : ""}`}>{avatarDataUrl ? <img src={avatarDataUrl} alt="" width={42} height={42} /> : <WorkbenchIcon name="brand" />}</span><span><strong title={title}>{title}</strong></span></div>
      <nav className="sidebar-navigation" aria-label="工作台导航">
        {(["action", "knowledge", "tools"] as const).map((group) => (
          <div className="sidebar-group" key={group}>
            <span className="sidebar-caption">{group === "action" ? "行动" : group === "knowledge" ? "积累" : "工具"}</span>
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

function GlobalFocusBar({ session, task, onShow, onPause, onCorrect }: {
  session: FocusSession;
  task: WorkspaceTask | null;
  onShow: () => void;
  onPause: () => void;
  onCorrect: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [session.id]);
  const elapsed = Math.max(0, Math.floor((now - new Date(session.startedAt).getTime()) / 1_000));
  return <aside className="global-focus-bar" aria-live="polite"><button className="global-focus-main" onClick={onShow}><i /><span><small>正在投入{task?.projectTitle ? ` · ${task.projectTitle}` : ""}</small><strong>{task ? task.title : session.label}</strong></span><time>{formatFocusDuration(elapsed, true)}</time></button><Button variant="secondary" type="button" className="global-focus-pause" onClick={onPause}>Ⅱ 暂停</Button><Button variant="secondary" type="button" className="global-focus-pause" onClick={onCorrect}>刚才已结束</Button></aside>;
}

const avatarImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const avatarCropViewportSize = 300;
const avatarOutputByteLimit = 240 * 1024;

type AvatarCropSource = {
  url: string;
  width: number;
  height: number;
};

type AvatarCropSelection = {
  zoom: number;
  offsetX: number;
  offsetY: number;
};

function validateAvatarFile(file: File) {
  if (!avatarImageTypes.has(file.type)) throw new Error("请选择 JPG、PNG 或 WebP 图片。");
  if (file.size > 8 * 1024 * 1024) throw new Error("图片不能超过 8 MB。");
}

async function loadAvatarCropSource(file: File): Promise<AvatarCropSource> {
  validateAvatarFile(file);
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const candidate = new Image();
      candidate.onload = () => resolve(candidate);
      candidate.onerror = () => reject(new Error("无法读取这张图片，请换一张重试。"));
      candidate.src = objectUrl;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("这张图片没有可用的尺寸信息。");
    return { url: objectUrl, width: image.naturalWidth, height: image.naturalHeight };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

async function createAvatarDataUrl(source: AvatarCropSource, crop: AvatarCropSelection) {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const candidate = new Image();
    candidate.onload = () => resolve(candidate);
    candidate.onerror = () => reject(new Error("无法读取这张图片，请换一张重试。"));
    candidate.src = source.url;
  });
  const baseScale = Math.max(avatarCropViewportSize / source.width, avatarCropViewportSize / source.height);
  const sourceSize = avatarCropViewportSize / (baseScale * crop.zoom);
  const sourceX = Math.max(0, Math.min(source.width - sourceSize, (source.width - sourceSize) / 2 - crop.offsetX / (baseScale * crop.zoom)));
  const sourceY = Math.max(0, Math.min(source.height - sourceSize, (source.height - sourceSize) / 2 - crop.offsetY / (baseScale * crop.zoom)));

  for (const outputSize of [512, 448, 384, 320, 256]) {
    const canvas = document.createElement("canvas");
    canvas.width = outputSize;
    canvas.height = outputSize;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前设备暂时无法处理头像图片。");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.86, 0.78, 0.7, 0.62, 0.56, 0.48]) {
      const dataUrl = canvas.toDataURL("image/webp", quality);
      if (!dataUrl.startsWith("data:image/webp;base64,")) throw new Error("头像图片转换失败，请换一张重试。");
      const estimatedBytes = Math.ceil((dataUrl.length - dataUrl.indexOf(",") - 1) * 3 / 4);
      if (estimatedBytes <= avatarOutputByteLimit) return dataUrl;
    }
  }
  throw new Error("头像图片压缩失败，请换一张重试。");
}

function AvatarCropDialog({ source, busy, message, onCancel, onConfirm }: {
  source: AvatarCropSource;
  busy: boolean;
  message: string;
  onCancel: () => void;
  onConfirm: (selection: AvatarCropSelection) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const baseScale = Math.max(avatarCropViewportSize / source.width, avatarCropViewportSize / source.height);
  const renderedWidth = source.width * baseScale * zoom;
  const renderedHeight = source.height * baseScale * zoom;
  const limitX = Math.max(0, (renderedWidth - avatarCropViewportSize) / 2);
  const limitY = Math.max(0, (renderedHeight - avatarCropViewportSize) / 2);
  const clampOffset = (x: number, y: number) => ({
    x: Math.max(-limitX, Math.min(limitX, x)),
    y: Math.max(-limitY, Math.min(limitY, y)),
  });

  useEffect(() => {
    setOffset((current) => clampOffset(current.x, current.y));
  }, [limitX, limitY]);

  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onCancel]);

  function moveByKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 12 : 3;
    const movement = event.key === "ArrowLeft" ? [step, 0] : event.key === "ArrowRight" ? [-step, 0] : event.key === "ArrowUp" ? [0, step] : event.key === "ArrowDown" ? [0, -step] : null;
    if (!movement) return;
    event.preventDefault();
    setOffset((current) => clampOffset(current.x + movement[0], current.y + movement[1]));
  }

  function startDragging(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || busy) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offsetX: offset.x, offsetY: offset.y };
  }

  function continueDragging(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setOffset(clampOffset(drag.offsetX + event.clientX - drag.x, drag.offsetY + event.clientY - drag.y));
  }

  function stopDragging(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <div className="avatar-crop-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) onCancel(); }}>
      <section className="avatar-crop-dialog" role="dialog" aria-modal="true" aria-labelledby="avatar-crop-title">
        <header><div><span>调整头像</span><h2 id="avatar-crop-title">选择要保留的区域</h2><p>拖动图片改变位置，使用滑块放大；方框内就是最终头像。</p></div><Button variant="secondary" size="small" iconOnly type="button" disabled={busy} onClick={onCancel} aria-label="关闭裁剪器">×</Button></header>
        <div
          className="avatar-crop-viewport"
          tabIndex={0}
          aria-label="头像裁剪区域，可拖动图片，或使用方向键微调"
          onKeyDown={moveByKeyboard}
          onPointerDown={startDragging}
          onPointerMove={continueDragging}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
          onDoubleClick={() => setOffset({ x: 0, y: 0 })}
        >
          <img
            src={source.url}
            alt="待裁剪头像"
            draggable={false}
            style={{ width: renderedWidth, height: renderedHeight, transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)` }}
          />
        </div>
        <label className="avatar-crop-zoom"><span>缩放</span><input type="range" min="1" max="3" step="0.01" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /><output>{Math.round(zoom * 100)}%</output></label>
        {message && <p className="avatar-crop-message" role="status">{message}</p>}
        <footer><Button variant="secondary" type="button" disabled={busy} onClick={onCancel}>取消</Button><Button type="button" variant="primary" disabled={busy} onClick={() => onConfirm({ zoom, offsetX: offset.x, offsetY: offset.y })}>{busy ? "正在处理…" : "使用此裁剪"}</Button></footer>
      </section>
    </div>
  );
}

function SettingsPage({ displayName, avatarDataUrl, themeId, fontPresetId, backingUp, dashboardPreferences, healthReminder, onSaveDashboardPreferences, onSaveHealthReminder, onTestHealthReminder, onSaveDisplayName, onSaveAvatarDataUrl, onThemeChange, onFontPresetChange, onCreateBackup, onRestoreBackup }: {
  displayName: string;
  avatarDataUrl: string;
  themeId: ThemeId;
  fontPresetId: FontPresetId;
  backingUp: boolean;
  dashboardPreferences: DashboardPreferences;
  healthReminder: HealthReminderPreferences;
  onSaveDashboardPreferences: (preferences: DashboardPreferences) => Promise<void>;
  onSaveHealthReminder: (preferences: HealthReminderPreferences) => Promise<void>;
  onTestHealthReminder: () => Promise<void>;
  onThemeChange: (themeId: ThemeId) => void;
  onFontPresetChange: (fontPresetId: FontPresetId) => void;
  onCreateBackup: () => void;
  onRestoreBackup: () => void;
  onSaveDisplayName: (name: string) => Promise<void>;
  onSaveAvatarDataUrl: (dataUrl: string) => Promise<void>;
}) {
  const [nameDraft, setNameDraft] = useState(displayName);
  const { palette, onChange: onPaletteChange } = useDefaultThemePalette();
  const [nameMessage, setNameMessage] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarMessage, setAvatarMessage] = useState("");
  const [avatarCropSource, setAvatarCropSource] = useState<AvatarCropSource | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const avatarObjectUrlRef = useRef("");
  const [updateProxyPort, setUpdateProxyPort] = useState(loadUpdateProxyPort);
  const [proxyMessage, setProxyMessage] = useState("");
  const [autostartOn, setAutostartOn] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartMessage, setAutostartMessage] = useState("");
  const [reminderTime, setReminderTime] = useState(healthReminder.time);
  const [reminderBusy, setReminderBusy] = useState(false);
  const [reminderMessage, setReminderMessage] = useState("");

  useEffect(() => setNameDraft(displayName), [displayName]);
  useEffect(() => setReminderTime(healthReminder.time), [healthReminder.time]);

  async function saveName(event: FormEvent) {
    event.preventDefault();
    try {
      await onSaveDisplayName(nameDraft);
      setNameMessage("名称已保存。");
    } catch (error) {
      setNameMessage(error instanceof Error ? `名称保存失败：${error.message}` : "名称保存失败，请稍后重试。");
    }
  }

  const beginAvatarCrop = useCallback(async (file: File) => {
    setAvatarBusy(true);
    setAvatarMessage("");
    try {
      const source = await loadAvatarCropSource(file);
      if (avatarObjectUrlRef.current) URL.revokeObjectURL(avatarObjectUrlRef.current);
      avatarObjectUrlRef.current = source.url;
      setAvatarCropSource(source);
    } catch (error) {
      setAvatarMessage(error instanceof Error ? error.message : "无法读取剪贴板中的图片，请换一张重试。");
    } finally {
      setAvatarBusy(false);
    }
  }, []);

  function closeAvatarCrop() {
    if (avatarObjectUrlRef.current) URL.revokeObjectURL(avatarObjectUrlRef.current);
    avatarObjectUrlRef.current = "";
    setAvatarCropSource(null);
  }

  useEffect(() => () => {
    if (avatarObjectUrlRef.current) URL.revokeObjectURL(avatarObjectUrlRef.current);
  }, []);

  useEffect(() => {
    const pasteAvatar = (event: globalThis.ClipboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (avatarBusy || avatarCropSource || target?.closest("input, textarea, [contenteditable='true']")) return;
      const imageItem = Array.from(event.clipboardData?.items ?? []).find((item) => item.kind === "file" && avatarImageTypes.has(item.type));
      const file = imageItem?.getAsFile();
      if (!file) return;
      event.preventDefault();
      void beginAvatarCrop(file);
    };
    window.addEventListener("paste", pasteAvatar);
    return () => window.removeEventListener("paste", pasteAvatar);
  }, [avatarBusy, avatarCropSource, beginAvatarCrop]);

  async function chooseAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await beginAvatarCrop(file);
  }

  async function readAvatarFromClipboard() {
    if (!navigator.clipboard?.read) {
      setAvatarMessage("请复制图片后，在此页面直接按 Ctrl+V 粘贴。");
      return;
    }
    setAvatarBusy(true);
    setAvatarMessage("");
    try {
      const clipboardItems = await navigator.clipboard.read();
      const item = clipboardItems.find((candidate) => candidate.types.some((type) => avatarImageTypes.has(type)));
      const type = item?.types.find((candidate) => avatarImageTypes.has(candidate));
      if (!item || !type) throw new Error("剪贴板中没有 JPG、PNG 或 WebP 图片。");
      const blob = await item.getType(type);
      await beginAvatarCrop(new File([blob], "clipboard-avatar", { type }));
    } catch (error) {
      const fallback = "无法直接读取剪贴板，请复制图片后在此页面按 Ctrl+V。";
      setAvatarMessage(error instanceof Error && !error.name.includes("NotAllowed") ? error.message : fallback);
    } finally {
      setAvatarBusy(false);
    }
  }

  async function saveCroppedAvatar(selection: AvatarCropSelection) {
    if (!avatarCropSource) return;
    setAvatarBusy(true);
    setAvatarMessage("");
    try {
      const dataUrl = await createAvatarDataUrl(avatarCropSource, selection);
      await onSaveAvatarDataUrl(dataUrl);
      closeAvatarCrop();
      setAvatarMessage("头像已裁剪、压缩并更新。");
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

  async function saveHealthReminder(next: HealthReminderPreferences, successMessage: string) {
    if (reminderBusy) return;
    setReminderBusy(true);
    setReminderMessage("");
    try {
      await onSaveHealthReminder(next);
      setReminderMessage(successMessage);
    } catch (error) {
      setReminderMessage(error instanceof Error ? error.message : "提醒设置未保存，请稍后重试。");
    } finally {
      setReminderBusy(false);
    }
  }

  async function testHealthReminder() {
    if (reminderBusy) return;
    setReminderBusy(true);
    setReminderMessage("");
    try {
      await onTestHealthReminder();
      setReminderMessage("测试提醒已显示；若系统通知已授权，也会同步发送。");
    } catch (error) {
      setReminderMessage(error instanceof Error ? error.message : "测试提醒发送失败，请稍后重试。");
    } finally {
      setReminderBusy(false);
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
      <header className="workspace-page-heading"><div><h1>设置</h1><p>统一管理外观、数据与以后新增的工作台偏好。</p></div><ThemeSticker section="settings" /></header>
      <div className="settings-grid">
        <section className="workspace-card settings-section settings-identity-section">
          <header><span>身份</span><h2>名称与头像</h2></header>
          <div className="settings-identity-content">
            <div className="settings-avatar-row">
              <span className={`settings-avatar-preview${avatarDataUrl ? " has-image" : ""}`}>{avatarDataUrl ? <img src={avatarDataUrl} alt="当前头像" /> : <WorkbenchIcon name="brand" />}</span>
              <div className="settings-avatar-details">
                <strong>个人头像</strong>
                <small>支持 JPG、PNG、WebP；可上传或按 Ctrl+V 粘贴，保存前可拖动裁剪与缩放。</small>
                <div className="settings-avatar-actions">
                  <Button variant="secondary" type="button" disabled={avatarBusy} onClick={() => avatarInputRef.current?.click()}>{avatarBusy ? "处理中…" : avatarDataUrl ? "更换图片" : "上传图片"}</Button>
                  <Button type="button" variant="quiet" disabled={avatarBusy} onClick={() => void readAvatarFromClipboard()}>从剪贴板粘贴</Button>
                  {avatarDataUrl && <Button type="button" variant="quiet" disabled={avatarBusy} onClick={() => void removeAvatar()}>移除</Button>}
                </div>
                <input ref={avatarInputRef} className="settings-avatar-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void chooseAvatar(event)} />
                <p role="status">{avatarMessage}</p>
              </div>
            </div>
            <form className="settings-name-form" onSubmit={saveName}>
              <label htmlFor="workspace-display-name"><span>名称</span><small id="workspace-display-name-count">{[...nameDraft].length}/24</small></label>
              <div><input id="workspace-display-name" value={nameDraft} onChange={(event) => { setNameDraft([...event.target.value].slice(0, 24).join("")); setNameMessage(""); }} placeholder="例如：小洛" aria-describedby="workspace-display-name-count workspace-display-name-message" /><Button variant="primary" type="submit">保存名称</Button></div>
              <p id="workspace-display-name-message" role="status">{nameMessage}</p>
            </form>
          </div>
        </section>
        <section className="workspace-card settings-section">
          <header><span>外观</span><h2>工作台主题</h2><p>默认主题可选择配色；角色主题使用专属色彩，首页以小贴图陪伴。</p></header>
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
          {themeId === "default" && <div className="settings-palette-options" role="group" aria-label="默认主题配色">
            <span>默认配色</span>
            <div>{DEFAULT_THEME_PALETTES.map((item) => <button
              className="settings-palette-option"
              key={item.id}
              type="button"
              aria-pressed={palette === item.id}
              onClick={() => onPaletteChange(item.id)}
            ><i style={{ background: item.primary }} aria-hidden="true" /><span>{item.label}</span></button>)}</div>
            <small>配色会自动保存，切换角色主题后仍会保留。</small>
          </div>}
        </section>
        <section className="workspace-card settings-section settings-font-section">
          <header><span>外观</span><h2>文字风格</h2><p>标题与长正文跟随选择；按钮、表单和数字始终保持清晰。</p></header>
          <div className="settings-font-options">
            {DESKTOP_FONT_PRESETS.map((preset) => (
              <button
                className={fontPresetId === preset.id ? "active" : ""}
                key={preset.id}
                type="button"
                aria-pressed={fontPresetId === preset.id}
                onClick={() => onFontPresetChange(preset.id)}
              >
                <span className={`settings-font-preview preview-${preset.id}`}>
                  <strong>{preset.preview}</strong>
                  <small>行动 · 阅读 · Aa 123</small>
                </span>
                <span className="settings-font-copy">
                  <strong>{preset.label}</strong>
                  <small>{preset.description}</small>
                </span>
                <i>{fontPresetId === preset.id ? "✓" : ""}</i>
              </button>
            ))}
          </div>
          <p className="settings-font-note">字体文件随应用保存，离线使用时也会保持一致。</p>
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
        <section className="workspace-card settings-section settings-reminder-section">
          <header><span>提醒</span><h2>少漏记一点</h2><p>到点后先检查当天记录；睡眠和活动都已填写时不会打扰你。</p></header>
          <div className="settings-toggle-row">
            <button
              type="button"
              role="switch"
              aria-checked={healthReminder.enabled}
              disabled={reminderBusy}
              className={healthReminder.enabled ? "settings-switch on" : "settings-switch"}
              onClick={() => void saveHealthReminder(
                { enabled: !healthReminder.enabled, time: reminderTime },
                healthReminder.enabled ? "每日健康提醒已关闭。" : `每日 ${reminderTime} 提醒已开启。`,
              )}
              aria-describedby="settings-reminder-message"
            >
              <i />
            </button>
            <div>
              <strong>{reminderBusy ? "正在保存…" : healthReminder.enabled ? `每天 ${healthReminder.time}` : "已关闭"}</strong>
              <small>应用需在运行或系统托盘中；建议同时开启上方的开机自启动。</small>
            </div>
          </div>
          <div className="settings-reminder-actions">
            <label htmlFor="settings-health-reminder-time"><span>提醒时间</span><input id="settings-health-reminder-time" type="time" value={reminderTime} onChange={(event) => { setReminderTime(event.target.value); setReminderMessage(""); }} /></label>
            <Button variant="secondary" type="button" disabled={reminderBusy || !reminderTime} onClick={() => void saveHealthReminder({ ...healthReminder, time: reminderTime }, "提醒时间已保存。")}>保存时间</Button>
            <Button variant="quiet" type="button" disabled={reminderBusy} onClick={() => void testHealthReminder()}>发送测试提醒</Button>
          </div>
          <div className="settings-expense-capture-note">
            <strong>消费发生后，按 Ctrl + Shift + M</strong>
            <p>会直接打开“补记一笔消费”；托盘菜单也有同样入口。应用不会读取短信或支付通知，因此不会申请高敏感权限，也不会误判转账、退款。</p>
          </div>
          <p className="settings-toggle-message" id="settings-reminder-message" role="status">{reminderMessage}</p>
        </section>
        <AiModelSettingsSection />
        <DashboardSettingsSection preferences={dashboardPreferences} onSave={onSaveDashboardPreferences} />
        <section className="workspace-card settings-section settings-data-section">
          <header><span>数据</span><h2>备份与恢复</h2><p>项目、行动、笔记和回顾会一起保存在完整本地备份中。</p></header>
          <div className="settings-data-actions">
            <button disabled={backingUp} onClick={onCreateBackup}><i>⇩</i><span><strong>{backingUp ? "正在备份" : "创建本地备份"}</strong><small>导出当前资料库的完整副本</small></span></button>
            <button disabled={backingUp} onClick={onRestoreBackup}><i>↺</i><span><strong>恢复最近备份</strong><small>恢复前会自动保留当前资料库</small></span></button>
          </div>
          <aside><strong>数据边界</strong><p>新版服务器会同步核心工作台与附件；旧版服务器自动回退为仅同步不含附件的笔记。API 密钥、网站会话和设备外观设置始终只留在本机。</p></aside>
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
              <Button variant="primary" type="submit">保存</Button>
            </div>
            <small id="update-proxy-help">默认 {DEFAULT_UPDATE_PROXY_PORT}；留空后仅使用系统网络。代理连接失败时也会自动回退到系统网络。</small>
            <p id="update-proxy-message" role="status">{proxyMessage}</p>
          </form>
        </section>
      </div>
      {avatarCropSource && <AvatarCropDialog source={avatarCropSource} busy={avatarBusy} message={avatarMessage} onCancel={closeAvatarCrop} onConfirm={(selection) => void saveCroppedAvatar(selection)} />}
    </div>
  );
}

function AiModelSettingsSection() {
  const [settings, setSettings] = useState<DeepSeekModelSettings>(() => loadDeepSeekModelSettings());
  const [models, setModels] = useState<DeepSeekModel[]>(() => loadCachedDeepSeekModels()?.models ?? []);
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [keyValue, setKeyValue] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    desktopApi.secrets.status("deepseek_api_key").then((configured) => {
      if (cancelled) return;
      setKeyConfigured(configured);
      const cached = loadCachedDeepSeekModels();
      if (configured && !cached?.fresh) void refreshModels();
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  async function saveKey(event: FormEvent) {
    event.preventDefault();
    if (!keyValue.trim() || busy) return;
    setBusy("key"); setMessage("");
    try {
      await desktopApi.secrets.set("deepseek_api_key", keyValue.trim());
      setKeyValue(""); setKeyConfigured(true); setMessage("API Key 已安全保存到 Windows 凭据管理器。");
      await refreshModels();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(""); }
  }

  async function deleteKey() {
    if (busy) return;
    setBusy("key"); setMessage("");
    try {
      await desktopApi.secrets.delete("deepseek_api_key");
      setKeyConfigured(false); setMessage("API Key 已从本机删除。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(""); }
  }

  async function refreshModels() {
    if (!isTauri()) return;
    setBusy("models"); setMessage("");
    try {
      const next = await desktopApi.deepseek.apiModels();
      cacheDeepSeekModels(next);
      setModels(next);
      setMessage(`已从 DeepSeek 读取 ${next.length} 个可用模型。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(""); }
  }

  function saveModels() {
    const saved = saveDeepSeekModelSettings(settings);
    setSettings(saved);
    setMessage("模型偏好已保存在本机，不会同步到其他设备。");
  }

  const unavailable = new Set([
    settings.defaultModel,
    ...Object.values(settings.overrides).filter(Boolean),
  ].filter((model) => !models.some((candidate) => candidate.id === model)));
  const modelOptions = [
    ...Array.from(unavailable).map((model) => ({ value: model, label: `${model}（当前不可用）` })),
    ...models.map((model) => ({ value: model.id, label: model.id })),
  ];
  const featureRows: Array<{ key: keyof DeepSeekModelSettings["overrides"]; label: string; detail: string }> = [
    { key: "projectCreate", label: "项目创建判断", detail: "默认使用更强模型判断行动/项目与推进方式" },
    { key: "projectReplan", label: "重大计划重排", detail: "处理截止提前、实验失败和导师反馈" },
    { key: "nextAction", label: "下一行动建议", detail: "留空时跟随全局默认" },
    { key: "globalPlanning", label: "全局规划助手", detail: "留空时跟随全局默认" },
    { key: "financeReport", label: "财务月报", detail: "留空时跟随全局默认" },
    { key: "healthAdvice", label: "健康建议", detail: "解读手动记录并生成下一餐建议" },
  ];

  return <section className="workspace-card settings-section settings-ai-model-section" id="ai-model-settings">
    <header><span>AI 与模型</span><h2>DeepSeek API</h2><p>这是 API Key 与模型选择的唯一入口。网页 AI 助手仍保持独立，不受这里影响。</p></header>
    <form className="settings-ai-key" onSubmit={(event) => void saveKey(event)}>
      <label><span>API Key</span><small>{keyConfigured ? "已保存在 Windows 凭据管理器" : "尚未配置"}</small></label>
      <div><input type="password" autoComplete="off" value={keyValue} onChange={(event) => setKeyValue(event.target.value)} placeholder={keyConfigured ? "输入新 Key 以替换" : "sk-..."} /><Button variant="primary" type="submit" disabled={busy === "key" || !keyValue.trim()}>{busy === "key" ? "保存中…" : "保存 Key"}</Button>{keyConfigured && <Button type="button" variant="danger" disabled={Boolean(busy)} onClick={() => void deleteKey()}>删除</Button>}</div>
      <p>Key 会用于你主动发起的项目规划、财务月报与健康建议 API 调用，也用于余额和模型列表读取；不会用于网页 AI 会话。</p>
    </form>
    <div className="settings-model-heading"><div><strong>API 模型</strong><small>每次调用前会检查所选模型是否仍在官方列表中；不可用时不会静默切换。</small></div><Button variant="secondary" type="button" disabled={!keyConfigured || busy === "models"} onClick={() => void refreshModels()}>{busy === "models" ? "读取中…" : "刷新官方模型"}</Button></div>
    <div className="settings-model-fields">
      <label><span>全局默认</span><SelectMenu label="全局默认模型" value={settings.defaultModel} onChange={(defaultModel) => setSettings({ ...settings, defaultModel })} options={modelOptions.length ? modelOptions : [{ value: settings.defaultModel, label: `${settings.defaultModel}（等待读取）` }]} /></label>
      {featureRows.map((row) => <label key={row.key}><span>{row.label}</span><small>{row.detail}</small><SelectMenu label={`${row.label}模型`} value={settings.overrides[row.key]} onChange={(value) => setSettings({ ...settings, overrides: { ...settings.overrides, [row.key]: value } })} options={[{ value: "", label: `跟随全局（${settings.defaultModel}）` }, ...modelOptions]} /></label>)}
    </div>
    <footer><p role="status">{message || "AI 只会在你明确点击后调用；项目调整仍需预览确认才会写入。"}</p><Button type="button" variant="primary" onClick={saveModels}>保存模型偏好</Button></footer>
  </section>;
}

function NotesWorkspace({ articles, projects, counts, loading, query, view, batchMode, batchIds, organizeId, organizingArticle, onQuery, onView, onOpen, onNew, onOrganizeToggle, onToggleBatch, onToggleAll, onEnterBatch, onExitBatch, onOrganize, onBatchOrganize }: {
  articles: StoredArticle[];
  projects: ProjectSummary[];
  counts: Record<string, number>;
  loading: boolean;
  query: string;
  view: "recent" | NoteCategory;
  batchMode: boolean;
  batchIds: Set<string>;
  organizeId: string | null;
  organizingArticle: StoredArticle | null;
  onQuery: (value: string) => void;
  onView: (view: "recent" | NoteCategory) => void;
  onOpen: (article: StoredArticle) => void;
  onNew: () => void;
  onOrganizeToggle: (id: string | null) => void;
  onToggleBatch: (id: string) => void;
  onToggleAll: () => void;
  onEnterBatch: () => void;
  onExitBatch: () => void;
  onOrganize: (article: StoredArticle, patch: ArticleOrganizationPatch) => Promise<boolean>;
  onBatchOrganize: (patch: { category?: NoteCategory; addTag?: string; removeTag?: string }) => void;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const helpDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = helpDialog.current;
    if (helpOpen) dialog?.showModal();
    else dialog?.close();
  }, [helpOpen]);
  const [batchTag, setBatchTag] = useState("");
  const selectedVisibleCount = articles.filter((article) => batchIds.has(article.id)).length;
  return (
    <>
      <section className="notes-filter-pane">
        <header><div><span>个人笔记</span><Button variant="ghost" size="small" iconOnly type="button" className="notes-help-toggle" aria-label="查看笔记分类说明" aria-expanded={helpOpen} onClick={() => setHelpOpen((value) => !value)}>?</Button></div><h1>笔记</h1><p>按以后重读它的原因，选择一个主分类。</p></header>
        <nav>{noteCategoryViews.map((item) => <button className={view === item.id ? "active" : ""} key={item.id} onClick={() => onView(item.id)}><span>{item.label}</span><small>{counts[item.id] ?? 0}</small></button>)}</nav>
        <dialog ref={helpDialog} className="notes-help-popover" aria-label="笔记分类说明" onClose={() => setHelpOpen(false)} onClick={event => { if (event.target === event.currentTarget) setHelpOpen(false); }}><header><strong>怎样整理笔记</strong><Button variant="ghost" size="small" iconOnly type="button" aria-label="关闭说明" onClick={() => setHelpOpen(false)}>×</Button></header><p>每篇笔记选一个主分类，具体主题用标签补充。</p><dl><div><dt>主分类</dt><dd>按重读的目的选择：思考感悟、经历记录、学习整理、经验复盘或随手记。</dd></div><div><dt>自由标签</dt><dd>可选，添加以后可能搜索的关键词，如家庭、沟通、写作。</dd></div><div><dt>放在哪里</dt><dd>要做的事放进今日行动；待消化的外部资料放进探索库。</dd></div></dl></dialog>
      </section>
      <section className={`notes-list-stage${organizingArticle ? " has-organizer" : ""}`}>
        <div className="notes-list-content">
          <header className="notes-list-header">
            <div><strong>{query ? "搜索结果" : noteCategoryViews.find((item) => item.id === view)?.label}</strong><span>{articles.length} 条</span></div>
            <div className="notes-list-actions">
              {batchMode ? <Button variant="ghost" onClick={onExitBatch}>退出管理</Button> : <Button variant="ghost" onClick={onEnterBatch}>批量管理</Button>}
              <button className="notes-create-button" onClick={onNew}><span aria-hidden="true">＋</span>新建笔记</button>
            </div>
          </header>
          {batchMode && (
            <div className="notes-batch-bar" role="toolbar" aria-label="批量整理">
              <label className="batch-select-all"><input type="checkbox" checked={articles.length > 0 && selectedVisibleCount === articles.length} onChange={onToggleAll} aria-label="全选当前列表的笔记" />全选（{selectedVisibleCount}/{articles.length}）</label>
              <SelectMenu label="批量设置主分类" value="" onChange={(value) => value && onBatchOrganize({ category: value as NoteCategory })} options={[{ value: "", label: "设置主分类…" }, ...NOTE_CATEGORY_OPTIONS]} />
              <form className="notes-batch-tags" onSubmit={(event) => { event.preventDefault(); const tag = batchTag.trim(); if (!tag) return; onBatchOrganize({ addTag: tag }); setBatchTag(""); }}>
                <input value={batchTag} onChange={(event) => setBatchTag(event.target.value)} placeholder="自由标签" aria-label="批量标签" />
                <Button variant="ghost" size="small" type="submit" disabled={!batchTag.trim()}>添加</Button>
                <Button variant="ghost" size="small" type="button" disabled={!batchTag.trim()} onClick={() => { const tag = batchTag.trim(); if (!tag) return; onBatchOrganize({ removeTag: tag }); setBatchTag(""); }}>移除</Button>
              </form>
            </div>
          )}
          <SearchField value={query} onChange={onQuery} placeholder="搜索标题、正文、标签…" label="搜索笔记" />
          <div className="notes-card-list">
            {loading ? <div className="list-empty"><span>正在读取笔记…</span></div> : articles.length ? articles.map((article) => (
              <article key={article.id} className={`note-card${batchIds.has(article.id) ? " selected" : ""}${organizeId === article.id ? " organizing" : ""}`}>
                {batchMode && <label className="note-card-check"><input type="checkbox" checked={batchIds.has(article.id)} onChange={() => onToggleBatch(article.id)} aria-label={`选择 ${article.title}`} /></label>}
                <button className="note-card-open" onClick={() => onOpen(article)}>
                  <span className="note-card-labels"><i className="note-category-badge">{NOTE_CATEGORY_LABELS[articleNoteCategory(article)]}</i>{article.tags.slice(0, 2).map((tag) => <i className="note-free-tag" key={tag}>#{tag}</i>)}</span>
                  <strong>{article.title}</strong>
                  <p>{article.summary || plainExcerpt(article.body)}</p>
                  <footer>{article.project ? <span className="note-card-project"><b aria-hidden="true">↗</b>关联项目 · {article.project}</span> : <span />}<time>{formatRelativeDate(article.updated || article.created)}</time></footer>
                </button>
                {!batchMode && <div className="note-card-organize"><button className={organizeId === article.id ? "active" : ""} aria-expanded={organizeId === article.id} onClick={() => onOrganizeToggle(organizeId === article.id ? null : article.id)}>{organizeId === article.id ? "整理中" : "整理"}</button></div>}
              </article>
            )) : <div className="list-empty"><span>{query ? "没有找到相关笔记" : "这个分类还没有内容"}</span><Button variant="secondary" type="button" onClick={onNew}>写下第一条</Button></div>}
          </div>
        </div>
        {organizingArticle && <NoteOrganizePanel article={organizingArticle} projects={projects} onOrganize={onOrganize} onClose={() => onOrganizeToggle(null)} />}
      </section>
    </>
  );
}

/** 宽屏使用独立侧栏、窄屏落到列表下方，整理过程不会再遮住笔记卡片。 */
function NoteOrganizePanel({ article, projects, onOrganize, onClose }: {
  article: StoredArticle;
  projects: ProjectSummary[];
  onOrganize: (article: StoredArticle, patch: ArticleOrganizationPatch) => Promise<boolean>;
  onClose: () => void;
}) {
  const [tagText, setTagText] = useState(article.tags.join("，"));
  const [sourceKind, setSourceKind] = useState(article.source.find((item) => !/^https?:\/\//i.test(item)) || "自写");
  const [sourceUrl, setSourceUrl] = useState(article.source.find((item) => /^https?:\/\//i.test(item)) || "");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    setTagText(article.tags.join("，"));
    setSourceKind(article.source.find((item) => !/^https?:\/\//i.test(item)) || "自写");
    setSourceUrl(article.source.find((item) => /^https?:\/\//i.test(item)) || "");
  }, [article.id, article.source, article.tags]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  async function save(patch: ArticleOrganizationPatch) {
    if (saveState === "saving") return;
    setSaveState("saving");
    const saved = await onOrganize(article, patch);
    setSaveState(saved ? "saved" : "error");
  }

  function saveSource() {
    return save({ source: preserveCaptureSourceMetadata(article.source, sourceKind, sourceUrl) });
  }

  return (
    <aside className={`note-organize-panel${saveState === "saving" ? " saving" : ""}`} aria-label="快速整理笔记" aria-busy={saveState === "saving"}>
      <header><div><span>快速整理</span><strong>{article.title}</strong></div><Button variant="secondary" size="small" iconOnly type="button" aria-label="关闭快速整理" onClick={onClose}>×</Button></header>
      <div className={`note-organize-status ${saveState}`} role="status"><span>{saveState === "saving" ? "正在保存…" : saveState === "saved" ? "已保存" : saveState === "error" ? "保存失败，请重试" : "选择后自动保存"}</span></div>
      <section>
        <div className="organize-section-heading"><strong>主分类</strong><span>只选一个</span></div>
        <div className="organize-category-list">
          {NOTE_CATEGORY_OPTIONS.map((option) => (
            <button key={option.value} className={articleNoteCategory(article) === option.value ? "active" : ""} onClick={() => void save({ category: option.value })}><strong>{option.label}</strong><span>{option.description}</span></button>
          ))}
        </div>
      </section>
      <form className="organize-tags-form" onSubmit={(event) => { event.preventDefault(); void save({ tags: splitTags(tagText) }); }}>
        <label htmlFor={`organize-tags-${article.id}`}><strong>自由标签</strong><span>可不填，用逗号分隔</span></label>
        <input id={`organize-tags-${article.id}`} value={tagText} onChange={(event) => setTagText(event.target.value)} placeholder="例如：沟通，边界，写作" />
        <Button variant="primary" type="submit">保存标签</Button>
      </form>
      <details className="organize-more-relations">
        <summary><span><strong>更多关联</strong><small>项目与来源都是可选项</small></span><i>展开</i></summary>
        <div>
          <label><span>关联项目</span><SelectMenu label="关联项目" value={article.projectId || projects.find((project) => project.title === article.project)?.id || ""} onChange={(value) => { const project = projects.find((item) => item.id === value); void save({ projectId: project?.id || "", project: project?.title || "" }); }} options={[{ value: "", label: "不关联项目" }, ...projects.map((project) => ({ value: project.id, label: project.title }))]} /></label>
          <label><span>来源</span><SelectMenu label="来源" value={sourceKind} onChange={setSourceKind} options={sourceOptions.map((source) => ({ value: source, label: source }))} /></label>
          <label><span>来源链接</span><input type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="可选" /></label>
          <Button variant="primary" type="button" onClick={() => void saveSource()}>保存来源</Button>
        </div>
      </details>
      <footer><span>项目只适合确实属于某项工作的笔记。</span><Button variant="secondary" type="button" onClick={onClose}>完成</Button></footer>
    </aside>
  );
}

function ArticleReader({ article, attachmentRepository, saving, onBack, onEdit, onAppend, onRemove, onDelegate }: {
  article: StoredArticle;
  attachmentRepository: AttachmentRepository;
  saving: boolean;
  onBack: () => void;
  onEdit: () => void;
  onAppend: () => void;
  onRemove: () => void;
  onDelegate?: () => void;
}) {
  const sourceUrl = article.source.find((item) => /^https?:\/\//i.test(item));
  const shotId = article.source.find(source => source.startsWith("浅羽画面 · "))?.split(" · ")[1];
  return (
    <article className="desktop-reader immersive-reader">
      <header className="reader-toolbar">
        <Button variant="ghost" type="button" className="reader-back" onClick={onBack}>← 返回笔记</Button>
        <div><span>最后修改于 {formatDate(article.updated || article.created)}</span>{onDelegate && <Button onClick={onDelegate}>创建委托</Button>}<Button variant="danger" disabled={saving} onClick={onRemove}>删除</Button><Button variant="primary" onClick={onEdit}>编辑</Button></div>
      </header>
      <div className="reader-scroll">
        <div className="reader-document">
          <div className="reader-kicker"><span>{article.collection === "sources" ? "探索资料" : NOTE_CATEGORY_LABELS[articleNoteCategory(article)]}</span><small>{formatDate(article.created)}</small></div>
          <h1>{article.title}</h1>
          <div className="reader-tags">
            {article.tags.map((tag) => <span key={tag}>#{tag}</span>)}
            {article.project && <span className="reader-project-link">↗ 关联项目 · {article.project}</span>}
          </div>
          <MarkdownDocument body={article.body} title={article.title} attachmentRepository={attachmentRepository} />
          {shotId && <AsabaShotPreview key={shotId} id={shotId} />}
          <footer className="reader-history"><div><strong>读到这里，有新的想法吗？</strong><span>追加会在原文末尾新建一个带日期的段落，保留前文的连贯性。</span></div><div className="reader-history-actions">{sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer">打开原始来源 ↗</a>}<Button variant="secondary" type="button" onClick={onAppend}>＋ 在文末追加想法</Button></div></footer>
        </div>
      </div>
    </article>
  );
}

function ArticleEditor({ draft, attachmentRepository, projects, saving, appendMode, onChange, onCancel, onSave }: {
  draft: Article;
  attachmentRepository: AttachmentRepository;
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
  const sourceUrl = draft.source.find((item) => /^https?:\/\//i.test(item)) || "";
  const sourceKind = draft.source.find((item) => !/^https?:\/\//i.test(item)) || "自写";

  const syncLoadedAttachments = useCallback(() => {
    window.requestAnimationFrame(() => {
      const seed = richSeedRef.current;
      const editor = richEditorRef.current;
      if (!seed || !editor) return;
      for (const loaded of seed.querySelectorAll<HTMLImageElement>("img[data-attachment-id]")) {
        const id = loaded.dataset.attachmentId;
        if (!id || !loaded.src || loaded.src === transparentEditorPixel) continue;
        for (const target of editor.querySelectorAll<HTMLImageElement>("img[data-attachment-id]")) {
          if (target.dataset.attachmentId === id && target.src !== loaded.src) target.src = loaded.src;
        }
      }
    });
  }, []);

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

  function toggleHeading(level: 1 | 2) {
    if (editorMode === "markdown") {
      const input = bodyRef.current;
      if (!input) return;
      const previousSelection = captureSelection("body", input);
      const result = toggleMarkdownHeading(draft.body, previousSelection, level);
      commit({ ...draft, body: result.body }, previousSelection);
      restoreInputSelection({ ...previousSelection, ...result.selection });
      return;
    }

    const editor = richEditorRef.current;
    if (!editor) return;
    const selection = window.getSelection();
    let currentElement = selection?.anchorNode instanceof Element
      ? selection.anchorNode
      : selection?.anchorNode?.parentElement ?? null;
    while (currentElement && currentElement !== editor && !currentElement.matches("h1, h2, h3, h4, h5, h6, p, blockquote, li, div")) {
      currentElement = currentElement.parentElement;
    }
    const targetTag = `h${level}`;
    const isTargetHeading = currentElement !== editor && currentElement?.tagName.toLowerCase() === targetTag;
    editor.focus({ preventScroll: true });
    document.execCommand("formatBlock", false, isTargetHeading ? "p" : targetTag);
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
    if (supportedFiles.some((file) => file.size > 25 * 1024 * 1024)) {
      showPasteStatus("单张原图不能超过 25 MiB。");
      return;
    }

    const input = event.currentTarget;
    const previousSelection = captureSelection("body", input);
    const bodyBeforePaste = draft.body;
    showPasteStatus("正在插入图片…");

    try {
      const attachments = await Promise.all(supportedFiles.map((file) => attachmentRepository.importImage(file, file.name)));
      const imageMarkdown = attachments
        .map((attachment, index) => `![粘贴图片${attachments.length > 1 ? index + 1 : ""}](${attachmentUri(attachment.id)})`)
        .join("\n\n");
      const insertedBody = `${bodyBeforePaste.slice(0, previousSelection.start)}${imageMarkdown}${bodyBeforePaste.slice(previousSelection.end)}`;
      commit({ ...draft, body: insertedBody }, previousSelection);
      restoreInputSelection({
        ...previousSelection,
        start: previousSelection.start + imageMarkdown.length,
        end: previousSelection.start + imageMarkdown.length,
      });
      showPasteStatus(attachments.length > 1 ? `已插入 ${attachments.length} 张图片。` : "图片已插入，可在右侧预览。");
    } catch (error) {
      showPasteStatus(error instanceof Error ? error.message : "图片读取失败，请重新复制后再试。");
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
    if (supportedFiles.some((file) => file.size > 25 * 1024 * 1024)) {
      showPasteStatus("单张原图不能超过 25 MiB。");
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
      const attachments = await Promise.all(supportedFiles.map((file) => attachmentRepository.importImage(file, file.name)));
      if (!editor) return;
      editor.focus({ preventScroll: true });
      if (savedRange && selection) {
        selection.removeAllRanges();
        selection.addRange(savedRange);
      } else {
        placeCaretAtEnd(editor);
      }
      attachments.forEach((attachment, index) => {
        const suffix = attachments.length > 1 ? index + 1 : "";
        const source = attachmentUri(attachment.id);
        document.execCommand("insertHTML", false, `<img src="${transparentEditorPixel}" data-attachment-id="${attachment.id}" data-attachment-source="${source}" alt="粘贴图片${suffix}"><br>`);
      });
      syncRichBody();
      showPasteStatus(attachments.length > 1 ? `已插入 ${attachments.length} 张图片。` : "图片已插入正文。");
    } catch (error) {
      showPasteStatus(error instanceof Error ? error.message : "图片读取失败，请重新复制后再试。");
    }
  }

  return (
    <div className="workbench-editor immersive-editor" onKeyDown={handleEditorKeyDown}>
      <header className="editor-toolbar"><div><Button variant="ghost" size="small" type="button" onClick={onCancel}>← 取消</Button><span>{draft.id ? "编辑笔记" : "新建笔记"}</span></div><div className="editor-toolbar-actions"><div className="editor-history-actions" aria-label="编辑历史"><Button variant="ghost" size="small" type="button" disabled={editorMode === "markdown" && !historyAvailability.canUndo} onMouseDown={(event) => event.preventDefault()} onClick={() => runEditorHistory("undo")} title="撤回（Ctrl+Z）">↶ 撤回</Button><Button variant="ghost" size="small" type="button" disabled={editorMode === "markdown" && !historyAvailability.canRedo} onMouseDown={(event) => event.preventDefault()} onClick={() => runEditorHistory("redo")} title="重做（Ctrl+Shift+Z / Ctrl+Y）">↷ 重做</Button></div><small><kbd>Ctrl</kbd> + <kbd>S</kbd></small><Button variant="primary" disabled={saving} onClick={onSave}>{saving ? "保存中…" : "保存"}</Button></div></header>
      <div className="editor-scroll" ref={editorScrollRef}><div className="editor-paper">
        <section className="editor-writing-pane">
          <input ref={titleRef} className="editor-title" autoFocus={!appendMode} value={draft.title} onBeforeInput={(event) => rememberSelection("title", event.currentTarget)} onChange={(event) => update("title", event.target.value)} placeholder="这篇笔记的标题" />
          <div className="markdown-toolbar" aria-label="正文格式工具">
            <div className="markdown-format-actions">
              <Button variant="ghost" size="small" type="button" title="一级标题（再次点击恢复正文）" onMouseDown={(event) => event.preventDefault()} onClick={() => toggleHeading(1)}>一级标题</Button>
              <Button variant="ghost" size="small" type="button" title="二级标题（再次点击恢复正文）" onMouseDown={(event) => event.preventDefault()} onClick={() => toggleHeading(2)}>二级标题</Button>
              <Button variant="ghost" size="small" type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat("**", "**", "bold")}>加粗</Button>
              <Button variant="ghost" size="small" type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat("> ", "", "formatBlock", "blockquote")}>引用</Button>
              <Button variant="ghost" size="small" type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat("- ", "", "insertUnorderedList")}>列表</Button>
              <Button variant="ghost" size="small" type="button" onMouseDown={(event) => event.preventDefault()} onClick={applyLink}>链接</Button>
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
            <section className={`editor-live-preview ${editorMode === "markdown" ? "" : "editor-pane-hidden"}`} aria-label="实时预览"><div className="editor-pane-label"><strong>实时预览</strong><span>与阅读页同步</span></div><div className="editor-preview-document"><h1>{draft.title || "未命名笔记"}</h1>{draft.body.trim() ? <MarkdownDocument body={draft.body} title={draft.title} attachmentRepository={attachmentRepository} /> : <p className="editor-preview-empty">开始输入后，这里会显示最终排版。</p>}</div></section>
            <div ref={richSeedRef} className="editor-rich-seed" aria-hidden="true"><MarkdownDocument body={draft.body} attachmentRepository={attachmentRepository} onAttachmentReady={syncLoadedAttachments} /></div>
          </div>
        </section>
        <aside className="editor-metadata new-note-metadata" aria-label="笔记信息">
          <header className="note-metadata-header"><div><span>笔记信息</span><strong>整理与关联</strong></div><p>写作时随手补充，留空也可以保存。</p></header>
          <fieldset><legend><strong>主分类</strong><span>选择一个</span></legend><div className="note-category-picker">{NOTE_CATEGORY_OPTIONS.map((option) => <button aria-pressed={articleNoteCategory(draft) === option.value} className={articleNoteCategory(draft) === option.value ? "active" : ""} type="button" key={option.value} onClick={() => update("category", option.value)}><strong>{option.label}</strong><span>{option.description}</span><i className="note-category-status" aria-hidden="true">✓</i></button>)}</div></fieldset>
          <label className="metadata-topic"><span><strong>自由标签</strong><small>可选，用逗号分隔</small></span><input ref={tagsRef} value={draft.tags.join("，")} onBeforeInput={(event) => rememberSelection("tags", event.currentTarget)} onChange={(event) => update("tags", splitTags(event.target.value))} placeholder="沟通，边界，写作" /></label>
          <details className="metadata-more-relations">
            <summary><span><strong>项目与来源</strong><small>需要时再补充</small></span><i><span className="metadata-expand-label">展开</span><span className="metadata-collapse-label">收起</span></i></summary>
            <div className="metadata-grid">
              <label className="metadata-project"><span>关联项目</span><SelectMenu label="关联项目" value={draft.projectId || projects.find((project) => project.title === draft.project)?.id || ""} onChange={(value) => { const project = projects.find((item) => item.id === value); commit({ ...draft, projectId: project?.id || "", project: project?.title || "" }); }} options={[{ value: "", label: "不关联项目" }, ...projects.map((project) => ({ value: project.id, label: project.title }))]} /></label>
              <label className="metadata-source"><span>来源</span><SelectMenu label="来源" value={sourceKind} onChange={updateSource} options={sourceOptions.map((source) => ({ value: source, label: source }))} /></label>
              <label className="metadata-source-link"><span>来源链接</span><input ref={sourceUrlRef} type="url" value={sourceUrl} onBeforeInput={(event) => rememberSelection("sourceUrl", event.currentTarget)} onChange={(event) => updateSource(sourceKind, event.target.value)} placeholder="可选" /></label>
            </div>
          </details>
          <small className="metadata-auto-note">摘要与时间等信息由系统自动维护。</small>
        </aside>
      </div></div>
    </div>
  );
}

type RichMarkdownState = {
  images: Array<{ id: string; source: string }>;
  imageIds: Map<string, string>;
};

const transparentEditorPixel = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

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
    const attachmentSource = node.dataset.attachmentSource
      || (node.dataset.attachmentId ? attachmentUri(node.dataset.attachmentId) : "");
    if (!source && !attachmentSource) return "";
    const alt = (node.getAttribute("alt") || "图片").replace(/[\[\]]/g, "");
    if (attachmentSource) return `![${alt}](${attachmentSource})`;
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

function articleNoteCategory(article: Partial<Pick<Article, "category" | "type" | "tags" | "title" | "summary">>) {
  return inferNoteCategory(article);
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

function shiftLocalDate(value: string, days: number) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
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

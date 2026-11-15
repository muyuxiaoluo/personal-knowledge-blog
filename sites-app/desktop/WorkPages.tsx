import { actionDeadline, projectDateLabel, scheduledProjectDate } from "../app/project-dates";
import { ProjectDateField } from "./ProjectDateField";
import "./styles/global-planning.css";
import "./styles/capture.css";
import "./styles/health.css";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { buildActivityDays, buildActivityWeeks, type ActivityDay } from "../app/activity-helpers";
import { isSourceArticle, isThoughtInboxArticle, pickRediscoverySource } from "../app/article-helpers";
import type { ArticleRepository } from "../app/data/article-repository";
import { calendarDayDifference, localDate } from "../app/date-helpers";
import { projectCalendarEvents, projectJobGroups } from "../app/project-selectors";
import type { AsabaJob } from "../app/companion-types";
import type { WorkerArchive } from "../app/asaba-worker";
import { AsabaJobCard } from "./AsabaDetails";
import { companionApi } from "./companionApi";
import { LIFE_DOMAIN_LABELS, LIFE_DOMAIN_OPTIONS } from "../app/domain-taxonomy";
import {
  buildQuickCloseout,
  contextualEchoTerms,
  findContextualEcho,
  selectContextualEcho,
  selectHomeTaskCandidates,
  type ContextualEcho,
  type QuickCloseoutOutcome,
  decodeTaskProgressLog,
} from "../app/home-workflow";
import type {
  MilestoneStatus,
  ProjectDetail,
  ProjectStatus,
  ProjectSummary,
  ProjectTask,
} from "../app/project-types";
import type { StoredArticle } from "../app/types";
import type {
  FocusSession,
  TaskPlan,
  WeeklyFocus,
  WeeklyReview,
  WeeklyReviewOutcomeStatus,
  WeeklyReviewStrategy,
} from "../app/work-types";
import type { IntegrationRepository } from "../app/data/integration-repository";
import type { DashboardRepository } from "../app/data/dashboard-repository";
import type { CalendarEvent, DashboardPreferences, ExternalSourceInput, RestDay } from "../app/dashboard-types";
import { analyzeHealthDay, formatSleepDuration } from "../app/health-helpers";
import type { HealthDailyLog, HealthMeal, HealthProfile } from "../app/health-types";
import {
  captureMetadata,
  captureRelations,
  formatPlaybackTime,
  type CaptureRelation,
} from "../app/entertainment-capture";
import { Button, SearchField, SelectMenu } from "./DesktopControls";
import { isConfirmedTodayPlan, type actionCenterLanes } from "../app/action-planning";
import type { DailySituation } from "../app/work-types";
import { ActionPlanningAssistant } from "./ActionPlanningAssistant";
import { GlobalPlanningAssistant } from "./GlobalPlanningAssistant";
import type { PlanningHistoryRepository } from "../app/data/sqlite-ai-repository";
import { HomeNextActions } from "./HomeNextActions";
import { ActionOptionalFields } from "./ActionOptionalFields";
import { BrandLogo } from "./BrandLogo";
import { ThemeSticker } from "./DesktopThemes";
import { HomeIntegrationCards } from "./ToolCenter";
import { HomeAccountBalances } from "./HomeAccountBalances";
import { HomeAdaptiveGrid } from "./HomeAdaptiveGrid";
import { MorningInformation, MorningOverview } from "./MorningDashboard";
import { ActionChecklist, ActionStepEditor } from "./ActionStructure";
import { ActionEstimateField } from "./ActionEstimateField";
import { formatFocusDuration } from "./focus-format";

export type WorkspaceTask = ProjectTask & {
  projectTitle: string;
  projectStatus: ProjectStatus | null;
  projectDraft?: boolean;
  milestoneStatus?: MilestoneStatus;
  stageTitle: string;
  stageDueDate: string;
  stageDueDateKind?: ProjectTask["dueDateKind"];
  projectTargetDate?: string;
  projectTargetDateKind?: ProjectTask["dueDateKind"];
  stageIndex: number;
  stageCount: number;
  stageCompletedTasks: number;
  stageTaskCount: number;
  plan: TaskPlan | null;
  planCarriedFrom: string;
  weekBlocked?: boolean;
};

export type NewActionInput = {
  projectId: string | null;
  milestoneId: string | null;
  direction: ProjectTask["direction"];
  title: string;
  definitionOfDone: string;
  steps: ProjectTask["steps"];
  currentFocus: string;
  details: string;
  dueDate: string;
  dueDateKind?: ProjectTask["dueDateKind"];
  estimatedDays?: number;
  status?: ProjectTask["status"];
  plannedToday: boolean;
  keepAvailable?: boolean;
};

export type SourceOrganizationInput =
  | { kind: "note"; title: string; body: string; tags: string[] }
  | { kind: "action"; projectId: string | null; milestoneId: string | null; direction: ProjectTask["direction"]; title: string; definitionOfDone: string; steps: ProjectTask["steps"]; currentFocus: string; details: string; dueDate: string; dueDateKind?: ProjectTask["dueDateKind"] }
  | { kind: "proposal"; projectId: string; title: string; problem: string; expectedValue: string; cost: string };

type TaskActions = {
  onChangeWeek: () => void;
  onCompleteTask: (task: WorkspaceTask) => void;
  onUpdateTask: (task: WorkspaceTask) => Promise<boolean>;
  onCloseToday: (task: WorkspaceTask, result: string, nextFocus: string) => Promise<boolean>;
  onPlanToday: (task: WorkspaceTask) => void;
  onRemoveFromToday: (task: WorkspaceTask) => void;
  onStartFocus: (task: WorkspaceTask) => void;
  onQuickStart: (title: string) => Promise<boolean>;
  onStopFocus: () => void;
  activeSession: FocusSession | null;
  focusSessions: FocusSession[];
};

export function HomeDashboard({
  planningHistoryRepository,
  projectDetails,
  dailySituations,
  onSupplementDay,
  today,
  tasks,
  articles,
  articleRepository,
  weeklyFocus,
  integrationRepository,
  dashboardRepository,
  dashboardPreferences,
  calendarEvents,
  restDays,
  healthProfile,
  healthToday,
  healthMeals,
  onOpenTools,
  onOpenHealth,
  onSaveWeeklyFocus,
  onOpenArticle,
  onOpenProject,
  onOpenTask,
  onOpenTasks,
  onSaveDashboardPreferences,
  onSaveCalendarEvent,
  onDeleteCalendarEvent,
  onSetRestDay,
  onSaveSource,
  onNotice,
  ...taskActions
}: {
  planningHistoryRepository: PlanningHistoryRepository;
  projectDetails: ProjectDetail[];
  dailySituations: DailySituation[];
  onSupplementDay: (date: string) => void;
  today: string;
  tasks: WorkspaceTask[];
  articles: StoredArticle[];
  articleRepository: Pick<ArticleRepository, "listSummaries">;
  weeklyFocus: WeeklyFocus | null;
  integrationRepository: IntegrationRepository;
  dashboardRepository: DashboardRepository;
  dashboardPreferences: DashboardPreferences;
  calendarEvents: CalendarEvent[];
  restDays: RestDay[];
  healthProfile: HealthProfile;
  healthToday: HealthDailyLog;
  healthMeals: HealthMeal[];
  onOpenTools: () => void;
  onOpenHealth: () => void;
  onSaveWeeklyFocus: (primaryOutcome: string, secondaryOutcome: string) => Promise<void>;
  onOpenArticle: (article: StoredArticle) => void;
  onOpenProject: (projectId: string) => void;
  onOpenTask: (taskId: string) => void;
  onOpenTasks: () => void;
  onSaveDashboardPreferences: (preferences: DashboardPreferences) => Promise<void>;
  onSaveCalendarEvent: (event: CalendarEvent) => Promise<CalendarEvent>;
  onDeleteCalendarEvent: (id: string) => Promise<void>;
  onSetRestDay: (date: string, rested: boolean) => Promise<void>;
  onSaveSource: (input: ExternalSourceInput) => Promise<boolean>;
  onNotice: (message: string) => void;
} & TaskActions) {
  const [focusOpen, setFocusOpen] = useState(false);
  const [closeoutTask, setCloseoutTask] = useState<WorkspaceTask | null>(null);
  const [quickStartText, setQuickStartText] = useState("");
  const [quickStarting, setQuickStarting] = useState(false);
  const [repositoryEcho, setRepositoryEcho] = useState<ContextualEcho | null>(null);
  const [primaryOutcome, setPrimaryOutcome] = useState(weeklyFocus?.primaryOutcome ?? "");
  const [secondaryOutcome, setSecondaryOutcome] = useState(weeklyFocus?.secondaryOutcome ?? "");
  const [selectedActivityDate, setSelectedActivityDate] = useState(today);
  const [restBusy, setRestBusy] = useState(false);
  const planningInput = useMemo(() => ({ today, projects: projectDetails, tasks, focusSessions: taskActions.focusSessions, weeklyFocus, dailySituations }), [today, projectDetails, tasks, taskActions.focusSessions, weeklyFocus, dailySituations]);
  const displayCalendarEvents = useMemo(() => [...calendarEvents, ...projectCalendarEvents(projectDetails)], [calendarEvents, projectDetails]);
  useEffect(() => {
    setPrimaryOutcome(weeklyFocus?.primaryOutcome ?? "");
    setSecondaryOutcome(weeklyFocus?.secondaryOutcome ?? "");
  }, [weeklyFocus]);
  useEffect(() => setSelectedActivityDate(today), [today]);
  const available = tasks
    .filter((task) => !task.projectDraft && task.status !== "done" && task.status !== "cancelled" && task.status !== "waiting" && (task.projectStatus === null || task.projectStatus === "active"))
    .sort((left, right) => taskRank(left, today) - taskRank(right, today));
  const planned = available.filter((task) => isConfirmedTodayPlan(task.plan, today));
  const homeChoices = selectHomeTaskCandidates(tasks, today, taskActions.activeSession?.taskId ?? null);
  const primaryTask = homeChoices[0] ?? null;
  const alternatives = homeChoices.slice(1);
  const missed = available.find((task) => task.plan?.source !== "auto" && task.planCarriedFrom && !task.weekBlocked);
  const restingToday = restDays.some((day) => day.date === today);
  const echoTerms = useMemo(
    () => contextualEchoTerms(primaryTask, weeklyFocus),
    [primaryTask?.benefit, primaryTask?.currentFocus, primaryTask?.id, primaryTask?.projectTitle, primaryTask?.stageTitle, primaryTask?.title, weeklyFocus?.primaryOutcome, weeklyFocus?.secondaryOutcome],
  );
  const fallbackEcho = selectContextualEcho(articles, echoTerms, today);
  useEffect(() => {
    let active = true;
    setRepositoryEcho(null);
    if (!echoTerms.length) return () => { active = false; };
    void findContextualEcho(articleRepository, echoTerms, today).then((match) => {
      if (active) setRepositoryEcho(match);
    });
    return () => { active = false; };
  }, [articleRepository, echoTerms, today]);
  const echo = repositoryEcho ?? fallbackEcho;
  const rediscovery = pickRediscoverySource(
    articles,
    primaryTask ? `${primaryTask.projectTitle} ${primaryTask.stageTitle} ${primaryTask.title} ${primaryTask.details}` : weeklyFocus?.primaryOutcome || "",
    today,
  );
  const weekStartDate = startOfLocalWeek().slice(0, 10);
  const completedThisWeek = tasks.filter((task) => task.completedAt && task.completedAt.slice(0, 10) >= weekStartDate).length;
  const notesThisWeek = articles.filter((article) => !isSourceArticle(article) && !isThoughtInboxArticle(article) && (article.updated || article.created).slice(0, 10) >= weekStartDate).length;
  const focusNow = useLiveNow(Boolean(taskActions.activeSession));
  const primaryFocusSeconds = primaryTask
    ? taskFocusSeconds(primaryTask.id, taskActions.focusSessions, today, taskActions.activeSession, focusNow)
    : 0;
  const healthAnalysis = analyzeHealthDay(healthProfile, healthToday, healthMeals);
  const healthRecorded = Boolean(
    healthToday.createdAt
    || healthMeals.some((meal) => meal.description.trim())
    || healthToday.steps !== null
    || healthToday.sleepStart,
  );

  async function toggleRestDay(date: string) {
    if (restBusy || date > today) return;
    setRestBusy(true);
    try {
      await onSetRestDay(date, !restDays.some((day) => day.date === date));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "休息日记录失败");
    } finally {
      setRestBusy(false);
    }
  }

  async function quickStart(event: FormEvent) {
    event.preventDefault();
    const title = quickStartText.trim();
    if (!title || quickStarting || taskActions.activeSession) return;
    setQuickStarting(true);
    const started = await taskActions.onQuickStart(title);
    setQuickStarting(false);
    if (started) setQuickStartText("");
  }

  return (
    <div className="home-dashboard home-launchpad home-overview workspace-scroll">
      <header className="home-context-line">
        <div><span>{formatLongDate(today)}</span><strong>{greeting()}，{weeklyFocus?.primaryOutcome || "先选出本周最重要的结果"}</strong></div>
        <ThemeSticker section="home" placement="home-heading" />
        <div className="home-context-actions">
          <HomeAccountBalances repository={integrationRepository} onOpenTools={onOpenTools} />
          <button className={`home-rest-toggle ${restingToday ? "active" : ""}`} disabled={restBusy} onClick={() => void toggleRestDay(today)}>{restingToday ? "取消今日休息" : "☕ 休息一天"}</button>
          <Button variant="secondary" type="button" onClick={() => setFocusOpen((value) => !value)}>本周聚焦</Button>
          <Button variant="secondary" type="button" onClick={taskActions.onChangeWeek}>计划有变</Button>
          <Button variant="secondary" type="button" onClick={onOpenTasks}>查看全部行动 →</Button>
        </div>
      </header>

      {focusOpen && <form className="weekly-focus-card workspace-card" onSubmit={async (event) => {
        event.preventDefault();
        await onSaveWeeklyFocus(primaryOutcome, secondaryOutcome);
        setFocusOpen(false);
      }}>
        <div><span>主结果</span><input autoFocus value={primaryOutcome} onChange={(event) => setPrimaryOutcome(event.target.value)} placeholder="这一周最值得完成的结果" /></div>
        <div><span>副结果</span><input value={secondaryOutcome} onChange={(event) => setSecondaryOutcome(event.target.value)} placeholder="有余力时推进的第二结果" /></div>
        <Button variant="primary" type="submit">保存本周聚焦</Button>
      </form>}

      {missed && primaryTask?.id !== missed.id && !restingToday && <div className="project-week-summary workspace-card">
        <p>上次没做完 · {missed.currentFocus || missed.title}</p>
        <div className="project-week-heading"><Button size="small" disabled={Boolean(taskActions.activeSession)} onClick={() => taskActions.onStartFocus(missed)}>继续这一步</Button>
          <Button size="small" variant="secondary" onClick={taskActions.onChangeWeek}>调整接下来的安排</Button></div>
      </div>}

      <HomeAdaptiveGrid>
      <div className="home-primary-grid with-alternatives">
        <section className={`home-strategy-card workspace-card ${restingToday ? "resting" : ""}`} data-home-tile>
          <header>
            <div><span>{restingToday ? "今日节奏" : "今日行动"}</span><strong>{restingToday ? "主动休息" : primaryTask?.projectTitle || "尚未安排"}</strong></div>
            <div className="home-strategy-header-side">
              <div className="home-result-summary" aria-label={`本周完成 ${completedThisWeek} 项行动，更新 ${notesThisWeek} 条笔记`}>
                <p>本周留下</p>
                <span><i>{completedThisWeek}</i> 项行动</span>
                <span><i>{notesThisWeek}</i> 条笔记</span>
              </div>
              {!restingToday && primaryTask && <Button variant="secondary" type="button" onClick={() => primaryTask.projectId ? onOpenProject(primaryTask.projectId) : onOpenTask(primaryTask.id)}>{primaryTask.projectId ? "进入项目" : "查看行动"}</Button>}
            </div>
          </header>
          {restingToday ? (
            <div className="home-rest-body">
              <i aria-hidden="true">☕</i>
              <div><span>今天不必用产出来证明什么</span><h1>好好休息，也是长期推进的一部分。</h1><p>{planned.length ? `原有的 ${planned.length} 项今日安排仍然保留，取消休息后可以继续。` : "没有安排会被删除，明天再从最重要的一步开始。"}</p><Button variant="secondary" type="button" disabled={restBusy} onClick={() => void toggleRestDay(today)}>恢复今天的安排</Button></div>
            </div>
          ) : primaryTask ? (
            <div className="home-strategy-body">
              <div className="home-action-core">
                <p className="home-action-meta"><span title={primaryTask.stageTitle}>{primaryTask.projectId ? primaryTask.stageTitle || "未关联阶段" : LIFE_DOMAIN_LABELS[primaryTask.direction]}</span>{actionDate(primaryTask, today).text && <time className={actionDate(primaryTask, today).tone}>{deadlineLabel(primaryTask, today)}</time>}</p>
                <h1 title={primaryTask.currentFocus || actionDisplayTitle(primaryTask)}>{primaryTask.currentFocus || actionDisplayTitle(primaryTask)}</h1>
                {primaryFocusSeconds > 0 && <div className={`home-focus-status ${taskActions.activeSession?.taskId === primaryTask.id ? "active" : ""}`}><span>{taskActions.activeSession?.taskId === primaryTask.id ? "正在投入" : "今天已投入"}</span><strong>{formatFocusDuration(primaryFocusSeconds, true)}</strong></div>}
                <div className="home-strategy-actions">
                  {taskActions.activeSession?.taskId === primaryTask.id
                    ? <Button variant="secondary" type="button" onClick={taskActions.onStopFocus}>Ⅱ 暂停投入</Button>
                    : !taskActions.activeSession && <Button variant="primary" type="button" onClick={() => taskActions.onStartFocus(primaryTask)}>{primaryTask.planCarriedFrom ? "继续这一步" : "▷ 开始投入"}</Button>}
                  {primaryTask.planCarriedFrom && <Button variant="secondary" onClick={taskActions.onChangeWeek}>调整接下来的安排</Button>}
                  <Button variant="secondary" onClick={() => setCloseoutTask(primaryTask)}>今日收工</Button>
                </div>
                <details className="home-action-details" key={primaryTask.id}>
                  <summary>行动详情与更多操作</summary>
                  <div>
                    <p>{primaryTask.currentFocus || actionDisplayTitle(primaryTask)}</p>
                    {primaryTask.currentFocus && <p>所属行动 · {actionDisplayTitle(primaryTask)}</p>}
                    {primaryTask.planCarriedFrom && <small>上次起点 · 有空继续</small>}
                    <StageProgress task={primaryTask} />
                    <ActionStructureDisclosure task={primaryTask} onUpdate={taskActions.onUpdateTask} />
                    <div className="home-strategy-actions">
                      <Button variant="secondary" type="button" onClick={() => taskActions.onCompleteTask(primaryTask)}>完成行动</Button>
                      {primaryTask.plan && primaryTask.plan.source !== "auto" && <Button variant="secondary" type="button" onClick={() => taskActions.onRemoveFromToday(primaryTask)}>{primaryTask.plan.plannedDate === today ? "移入待继续" : "暂时收起"}</Button>}
                      <Button variant="ghost" type="button" onClick={() => onOpenTask(primaryTask.id)}>编辑行动</Button>
                    </div>
                  </div>
                </details>
              </div>
            </div>
          ) : (
            <div className="home-empty-today"><EmptyState title="现在想做什么？" body="不用先规划。写下一件正在面对的事，系统会建立独立行动并立即开始记录投入。" /><form className="home-quick-start" onSubmit={(event) => void quickStart(event)}><input value={quickStartText} onChange={(event) => setQuickStartText(event.target.value)} placeholder="我现在要做……" aria-label="立即开始的行动" disabled={quickStarting || Boolean(taskActions.activeSession)} /><Button variant="primary" type="submit" disabled={quickStarting || !quickStartText.trim() || Boolean(taskActions.activeSession)}>{quickStarting ? "正在开始…" : "▷ 立即开始"}</Button></form><Button variant="ghost" type="button" onClick={onOpenTasks}>或者查看已有行动 →</Button></div>
          )}
        </section>

        <aside className="home-primary-side">
          <GlobalPlanningAssistant input={planningInput} historyRepository={planningHistoryRepository} onOpenProject={onOpenProject} onOpenTask={onOpenTask} onPlanToday={taskActions.onPlanToday} />
          {!restingToday && alternatives.length > 0 && <HomeNextActions tasks={alternatives} onOpenTask={onOpenTask} />}
        </aside>
      </div>

        {(dashboardPreferences.modules.aiHot || dashboardPreferences.modules.morningBrief) && <MorningInformation
          today={today}
          repository={dashboardRepository}
          preferences={dashboardPreferences}
          onSavePreferences={onSaveDashboardPreferences}
          onSaveSource={onSaveSource}
          onNotice={onNotice}
        />}
        <MorningOverview
          today={today}
          repository={dashboardRepository}
          preferences={dashboardPreferences}
          events={displayCalendarEvents}
          onOpenProject={onOpenProject}
          onSavePreferences={onSaveDashboardPreferences}
          onSaveEvent={onSaveCalendarEvent}
          onDeleteEvent={onDeleteCalendarEvent}
          onNotice={onNotice}
        />
      <section className="workspace-card health-home-strip" data-home-tile>
        <header><div><span>今日健康</span><strong>{healthRecorded ? "生活节奏已记录" : "补全今天的健康记录"}</strong></div><Button variant="secondary" size="small" type="button" onClick={onOpenHealth}>{healthRecorded ? "查看与分析 →" : "开始记录 →"}</Button></header>
        {healthRecorded ? <div className="health-home-metrics">
          <div><span>睡眠</span><strong>{formatSleepDuration(healthAnalysis.sleepMinutes)}</strong></div>
          <div><span>步数</span><strong>{healthToday.steps === null ? "未记录" : healthToday.steps.toLocaleString("zh-CN")}</strong></div>
          <div><span>餐食</span><strong>{healthAnalysis.recordedMealCount} 项</strong></div>
          <p>{healthAnalysis.observations[0]}</p>
        </div> : <p className="health-home-empty">睡眠、步数与三餐，记录今天的生活节奏。</p>}
      </section>

        <section className="workspace-card home-context-card" data-home-tile>
          <CardHeader title="一条相关旧经验" subtitle={primaryTask ? `围绕「${primaryTask.projectTitle}」寻找旧记录` : weeklyFocus?.primaryOutcome ? "从本周聚焦中寻找" : "开始行动后自动寻找"} />
          {echo ? (
            <details className="home-context-echo">
              <summary><span>{echo.reason}</span><strong>{echo.article.title}</strong><small>展开看看</small></summary>
              <p>{echo.article.summary || plainExcerpt(echo.article.body)}</p>
              <Button variant="secondary" type="button" onClick={() => onOpenArticle(echo.article)}>打开完整笔记 →</Button>
            </details>
          ) : <p className="compact-empty">还没有找到和当前阶段足够相关的旧记录。</p>}
        </section>
        {rediscovery && <section className="workspace-card home-rediscovery-card" data-home-tile>
          <CardHeader title="收藏回响" subtitle="让收藏在需要时重新出现" />
          <div>
            <span>{rediscovery.reason}</span>
            <strong>{rediscovery.article.title}</strong>
            <p>{rediscovery.article.summary || plainExcerpt(rediscovery.article.body)}</p>
          </div>
          {sourceUrl(rediscovery.article) && <Button variant="secondary" type="button" onClick={() => void openSourceUrl(sourceUrl(rediscovery.article))}>重新打开 ↗</Button>}
        </section>}
      </HomeAdaptiveGrid>
      <HomeIntegrationCards repository={integrationRepository} onOpenTools={onOpenTools} />
      <ActivityCalendar
        dailySituations={dailySituations}
        onSupplementDay={onSupplementDay}
        today={today}
        tasks={tasks}
        articles={articles}
        focusSessions={taskActions.focusSessions}
        restDays={restDays}
        selectedDate={selectedActivityDate}
        busy={restBusy}
        onSelectDate={setSelectedActivityDate}
        onToggleRest={(date) => void toggleRestDay(date)}
        onOpenArticle={onOpenArticle}
        onOpenProject={onOpenProject}
        onOpenTask={onOpenTask}
      />
      {closeoutTask && <TaskCloseoutDialog task={closeoutTask} onCancel={() => setCloseoutTask(null)} onSave={taskActions.onCloseToday} />}
    </div>
  );
}

function ActivityCalendar({
  dailySituations,
  onSupplementDay,
  today,
  tasks,
  articles,
  focusSessions,
  restDays,
  selectedDate,
  busy,
  onSelectDate,
  onToggleRest,
  onOpenArticle,
  onOpenProject,
  onOpenTask,
}: {
  dailySituations: DailySituation[];
  onSupplementDay: (date: string) => void;
  today: string;
  tasks: WorkspaceTask[];
  articles: StoredArticle[];
  focusSessions: FocusSession[];
  restDays: RestDay[];
  selectedDate: string;
  busy: boolean;
  onSelectDate: (date: string) => void;
  onToggleRest: (date: string) => void;
  onOpenArticle: (article: StoredArticle) => void;
  onOpenProject: (projectId: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const noteArticles = useMemo(() => articles.filter((article) => !isSourceArticle(article) && !isThoughtInboxArticle(article)), [articles]);
  const activityDays = useMemo(() => buildActivityDays({ tasks, notes: noteArticles, focusSessions, restDays, situations: dailySituations }), [focusSessions, noteArticles, restDays, tasks, dailySituations]);
  const weeks = useMemo(() => buildActivityWeeks(today), [today]);
  const visibleDates = useMemo(() => weeks.flatMap((week) => week.filter((date): date is string => Boolean(date))), [weeks]);
  const visibleSet = useMemo(() => new Set(visibleDates), [visibleDates]);
  const activeDayCount = useMemo(() => [...activityDays.values()].filter((day) => visibleSet.has(day.date) && day.intensity > 0).length, [activityDays, visibleSet]);
  const restDayCount = useMemo(() => restDays.filter((day) => visibleSet.has(day.date)).length, [restDays, visibleSet]);
  const selected = activityDays.get(selectedDate) ?? emptyActivityDay(selectedDate);
  let previousMonth = "";
  const monthLabels = weeks.map((week) => {
    const date = week.find((item): item is string => Boolean(item)) ?? "";
    const month = date.slice(0, 7);
    if (!month || month === previousMonth) return "";
    previousMonth = month;
    return `${Number(month.slice(5, 7))}月`;
  });

  return <section className="workspace-card activity-calendar-card">
    <header>
      <div><span>生活节奏</span><strong>过去一年，{activeDayCount} 天留下推进记录</strong><small>{restDayCount ? `${restDayCount} 天主动休息` : "休息日会以暖色单独记录"}</small></div>
      <div className="activity-legend"><span>少</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`level-${level}`} />)}<span>多</span><i className="rest" /><span>休息</span></div>
    </header>
    <div className="activity-calendar-scroll">
      <div className="activity-calendar-plot">
        <div className="activity-month-spacer" />
        <div className="activity-months">{monthLabels.map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}</div>
        <div className="activity-weekdays"><span /><span>一</span><span /><span>三</span><span /><span>五</span><span /></div>
        <div className="activity-weeks">{weeks.map((week, weekIndex) => <div className="activity-week" key={weekIndex}>{week.map((date, dayIndex) => {
          if (!date) return <i className="activity-cell placeholder" key={dayIndex} />;
          const day = activityDays.get(date) ?? emptyActivityDay(date);
          const classes = ["activity-cell", `level-${day.intensity}`, day.situation ? "has-situation" : "", day.rest ? "rest" : "", day.rest && day.intensity > 0 ? "mixed" : "", date === selectedDate ? "selected" : ""].filter(Boolean).join(" ");
          const label = `${formatActivityDate(date)}，${activityDaySummary(day)}`;
          return <button type="button" className={classes} key={date} title={label} aria-label={label} aria-pressed={date === selectedDate} onClick={() => onSelectDate(date)} />;
        })}</div>)}</div>
      </div>
    </div>
    <div className="activity-day-detail">
      <header><div><span>{selectedDate === today ? "今天" : formatActivityDate(selectedDate)}</span><strong>{activityDaySummary(selected)}</strong></div><div className="activity-day-actions"><Button variant={selected.rest ? "quiet" : "secondary"} size="small" aria-pressed={selected.rest} disabled={busy || selectedDate > today} onClick={() => onToggleRest(selectedDate)}>{selected.rest ? "取消休息标记" : "标记为休息日"}</Button><Button size="small" disabled={selectedDate > today} onClick={() => onSupplementDay(selectedDate)}>{selected.situation ? "查看或修改当天情况" : "补记当天情况"}</Button></div></header>
      {selected.situation && <div className="situation-summary"><strong>当天情况 · {selected.situation.reason}</strong>{selected.situation.actualWork && <p>实际做了：{selected.situation.actualWork}</p>}{selected.situation.tasks.map((task) => <p key={task.taskId}>{task.title}：{task.outcome === "partial" ? `部分推进 · ${task.progress}` : "未开始"}</p>)}</div>}
      {selected.intensity === 0 && !selected.rest ? (!selected.situation && <p className="activity-empty-day">这一天还没有推进、休息或情况记录。</p>) : <div className="activity-detail-groups">
        {selected.rest && <div className="activity-rest-note"><i>☕</i><span><strong>这一天选择了休息</strong><small>{selected.intensity > 0 ? "也保留了当天实际发生的活动记录。" : "留白不是中断，而是在为下一段节奏恢复精力。"}</small></span></div>}
        {selected.tasks.length > 0 && <section><span>完成的行动</span>{selected.tasks.slice(0, 5).map((task) => <button key={task.id} onClick={() => task.projectId ? onOpenProject(task.projectId) : onOpenTask(task.id)}><strong>{task.currentFocus || task.title}</strong><small>{task.projectId ? task.projectTitle : `独立行动 · ${LIFE_DOMAIN_LABELS[task.direction ?? "uncategorized"]}`}</small></button>)}{selected.tasks.length > 5 && <em>还有 {selected.tasks.length - 5} 项行动</em>}</section>}
        {selected.notes.length > 0 && <section><span>更新的笔记</span>{selected.notes.slice(0, 5).map((note) => <button key={note.id} onClick={() => onOpenArticle(note as StoredArticle)}><strong>{note.title}</strong><small>打开笔记</small></button>)}{selected.notes.length > 5 && <em>还有 {selected.notes.length - 5} 条笔记</em>}</section>}
        {selected.focusSeconds > 0 && <section><span>投入时间</span><div className="activity-focus-total"><strong>{formatFocusDuration(selected.focusSeconds, true)}</strong><small>{selected.focusSessions.length} 段投入记录</small></div></section>}
      </div>}
    </div>
  </section>;
}

function emptyActivityDay(date: string): ActivityDay {
  return { date, tasks: [], notes: [], focusSessions: [], focusSeconds: 0, rest: false, intensity: 0 };
}

function activityDaySummary(day: ActivityDay) {
  const parts = [
    day.tasks.length ? `${day.tasks.length} 项行动` : "",
    day.notes.length ? `${day.notes.length} 条笔记` : "",
    day.focusSeconds > 0 ? `${formatFocusDuration(day.focusSeconds, true)}投入` : "",
    day.rest ? "休息日" : "",
    day.situation ? "有当天情况记录" : "",
  ].filter(Boolean);
  return parts.join(" · ") || "没有记录";
}

function formatActivityDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short", timeZone: "UTC" }).format(date);
}

export function TasksPage({
  onOpenFocusHistory,
  onSupplementDay,
  dailySituations,
  today,
  tasks,
  lanes,
  projects,
  projectDetails,
  loadProject,
  initialTaskId,
  onTaskOpened,
  onAddTask,
  onRemoveTask,
  onOpenProject,
  onArchiveWorker,
  ...taskActions
}: {
  onOpenFocusHistory: () => void;
  onSupplementDay: (date: string) => void;
  dailySituations: DailySituation[];
  today: string;
  tasks: WorkspaceTask[];
  lanes: ReturnType<typeof actionCenterLanes<WorkspaceTask>>;
  projects: ProjectSummary[];
  projectDetails: ProjectDetail[];
  loadProject: (id: string) => Promise<ProjectDetail | null>;
  initialTaskId?: string | null;
  onTaskOpened?: () => void;
  onAddTask: (input: NewActionInput) => Promise<boolean>;
  onRemoveTask: (task: WorkspaceTask) => void;
  onOpenProject: (projectId: string) => void;
  onArchiveWorker: (request: WorkerArchive) => Promise<void>;
} & TaskActions) {
  const [showComposer, setShowComposer] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const [showAi, setShowAi] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [milestoneId, setMilestoneId] = useState("");
  const [direction, setDirection] = useState<ProjectTask["direction"]>("uncategorized");
  const [title, setTitle] = useState("");
  const [definitionOfDone, setDefinitionOfDone] = useState("");
  const [steps, setSteps] = useState<ProjectTask["steps"]>([]);
  const [currentFocus, setCurrentFocus] = useState("");
  const [details, setDetails] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [dueDateKind, setDueDateKind] = useState<ProjectTask["dueDateKind"]>(null);
  const [estimatedDays, setEstimatedDays] = useState(0);
  const [newTaskStatus, setNewTaskStatus] = useState<ProjectTask["status"]>("later");
  const [planOnSave, setPlanOnSave] = useState(false);
  const [closeoutTask, setCloseoutTask] = useState<WorkspaceTask | null>(null);
  const [editingTask, setEditingTask] = useState<WorkspaceTask | null>(null);
  useEffect(() => {
    if (!initialTaskId || !tasks.some((task) => task.id === initialTaskId)) return;
    setRequestedId(initialTaskId);
    setExpandedId(initialTaskId);
    setShowAll(!lanes.schedule.some((task) => task.id === initialTaskId) && !lanes.ready.slice(0, 6).some((task) => task.id === initialTaskId));
    setQuery("");
    onTaskOpened?.();
  }, [initialTaskId, onTaskOpened, tasks, lanes]);
  useEffect(() => {
    if (requestedId) document.getElementById("action-row-" + requestedId)?.scrollIntoView({ block: "nearest" });
  }, [requestedId]);
  useEffect(() => {
    if (!showComposer) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setShowComposer(false); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [showComposer]);
  const { schedule, ready, pending, dateSuggestions } = lanes;
  const needle = query.trim().toLocaleLowerCase("zh-CN");
  const allTasks = tasks.filter((task) => (pending.includes(task) || task.id === requestedId) &&
    [task.title, task.currentFocus, task.projectTitle, task.stageTitle].join(" ").toLocaleLowerCase("zh-CN").includes(needle));
  const selectedProject = projectDetails.find((detail) => detail.project.id === projectId);

  function chooseProject(value: string) {
    setProjectId(value);
    const detail = projectDetails.find((item) => item.project.id === value);
    setMilestoneId(detail?.milestones.find((item) => item.status === "current")?.id || "");
    if (detail) setDirection(detail.project.category);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    if (!await onAddTask({ projectId: projectId || null, milestoneId: projectId ? milestoneId || null : null, direction, title: title.trim(), definitionOfDone: definitionOfDone.trim(), steps, currentFocus: currentFocus.trim(), details: details.trim(), dueDate, dueDateKind, estimatedDays, status: newTaskStatus, plannedToday: planOnSave })) return;
    setTitle(""); setDefinitionOfDone(""); setSteps([]); setCurrentFocus(""); setDetails(""); setDueDate(""); setDueDateKind(null); setEstimatedDays(0); setNewTaskStatus("later"); setPlanOnSave(false); setShowComposer(false);
  }

  function row(task: WorkspaceTask) {
    return <ActionRow key={task.id} task={task} today={today} suggested={dateSuggestions.has(task.id)}
      expanded={expandedId === task.id} onToggle={() => setExpandedId((current) => current === task.id ? null : task.id)}
      onOpenProject={onOpenProject} onRemoveTask={onRemoveTask} onRequestCloseout={setCloseoutTask} onEditTask={setEditingTask} {...taskActions} />;
  }

  return (
    <div className="tasks-page action-center workspace-scroll">
      <header className="workspace-page-heading action-center-heading">
        <h1>行动</h1>
        <div className="action-center-controls">
          <Button variant="primary" type="button" onClick={() => setShowComposer(true)}>＋ 新建行动</Button>
          <details className="action-center-tools">
            <summary>更多</summary>
            <div>
              <Button variant="ghost" type="button" onClick={() => setShowAi(true)}>AI 帮我起步</Button>
              <Button variant="ghost" type="button" onClick={taskActions.onChangeWeek}>计划有变</Button>
              <Button variant="ghost" type="button" onClick={onOpenFocusHistory}>投入记录</Button>
              <Button variant="ghost" type="button" onClick={() => onSupplementDay(today)}>补记当天情况</Button>
              {dailySituations[0] && dailySituations[0].date !== today && <Button variant="ghost" type="button" onClick={() => onSupplementDay(dailySituations[0].date)}>查看最近补记</Button>}
            </div>
          </details>
        </div>
      </header>
      <nav className="action-center-views" aria-label="行动视图">
        <Button variant={!showAll ? "secondary" : "ghost"} type="button" aria-pressed={!showAll} onClick={() => setShowAll(false)}>概览</Button>
        <Button variant={showAll ? "secondary" : "ghost"} type="button" aria-pressed={showAll} onClick={() => setShowAll(true)}>全部行动</Button>
        {showAll && <SearchField label="搜索行动" value={query} onChange={setQuery} placeholder="搜索行动或项目" />}
      </nav>
      {showAi && <ActionPlanningAssistant projects={projectDetails} loadProject={loadProject} onClose={() => setShowAi(false)} onAddTask={onAddTask} />}
      <div className="action-center-grid">
        <div className="action-center-list">
          {showAll ? <section className="workspace-card action-center-panel"><h2>全部行动</h2>
            {allTasks.map(row)}{!allTasks.length && <p>{needle ? "没有匹配的行动" : "暂无行动"}</p>}
          </section> : <>
            <section className="workspace-card action-center-panel"><h2>今天</h2>
              {schedule.length ? schedule.map(row) : <p>今天没有确认的安排</p>}
            </section>
            <section className="workspace-card action-center-panel"><h2>可继续</h2>
              {ready.length ? ready.slice(0, 6).map(row) : <p>暂无可继续的行动</p>}
              {ready.length > 6 && <Button variant="ghost" size="small" onClick={() => setShowAll(true)}>查看全部行动</Button>}
            </section>
          </>}
        </div>
        <ActionCenterJobs projects={projects} onOpenProject={onOpenProject} onArchive={onArchiveWorker} showAll={showAll} />
      </div>

      {showComposer && (
        <div className="task-drawer-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setShowComposer(false); }}>
          <aside className="task-drawer action-drawer" role="dialog" aria-modal="true" aria-label="添加行动">
            <header><div><span>新的行动</span><h2>{projectId ? "添加项目行动" : "添加独立行动"}</h2></div><Button variant="secondary" size="small" iconOnly type="button" onClick={() => setShowComposer(false)} aria-label="关闭">×</Button></header>
            <form onSubmit={submit}>
              <label><span>所属项目 · 可选</span><SelectMenu label="所属项目" value={projectId} onChange={chooseProject} options={[{ value: "", label: "不关联项目" }, ...projects.filter((project) => project.status === "active" && !project.isDraft).map((project) => ({ value: project.id, label: project.title }))]} /></label>
              {!projectId && <label><span>关注方向 · 可选</span><SelectMenu label="关注方向" value={direction} onChange={(value) => setDirection(value as ProjectTask["direction"])} options={LIFE_DOMAIN_OPTIONS} /></label>}
              {projectId && <label><span>所属阶段</span><SelectMenu label="所属阶段" value={milestoneId} onChange={setMilestoneId} options={[{ value: "", label: "暂不关联" }, ...(selectedProject?.milestones ?? []).filter((milestone) => milestone.status !== "superseded").map((milestone) => ({ value: milestone.id, label: `${milestone.status === "current" ? "当前 · " : ""}${milestone.title}` }))]} /></label>}
              <label><span>行动状态</span><SelectMenu label="行动状态" value={newTaskStatus} onChange={(value) => setNewTaskStatus(value as ProjectTask["status"])} options={[{ value: "later", label: "稍后" }, { value: "next", label: "下一步" }]} /></label>
              <label><span>行动名称</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：精读论文并形成一页方法笔记" /></label>
              <ActionOptionalFields hasContent={Boolean(currentFocus || definitionOfDone || steps.length || details)}>
              <label><span>本次推进 · 可选</span><textarea value={currentFocus} onChange={(event) => setCurrentFocus(event.target.value)} placeholder="这一次先推进到哪里？例如：读完方法部分并画出流程" /></label>
              <label><span>完成标志 · 可选</span><textarea value={definitionOfDone} onChange={(event) => setDefinitionOfDone(event.target.value)} placeholder="看到什么结果时，这条行动才算完成？" /></label>
              <ActionStepEditor steps={steps} onChange={setSteps} />
              <label><span>补充说明 · 可选</span><textarea value={details} onChange={(event) => setDetails(event.target.value)} placeholder="记录资料位置、注意事项，或其他上下文。" /></label>
              </ActionOptionalFields>
              <ProjectDateField label="行动日期" value={dueDate} kind={dueDateKind} onChange={(date, kind) => { setDueDate(date); setDueDateKind(kind); }} />
              <ActionEstimateField dateKind={dueDateKind} dueDate={scheduledProjectDate(dueDate, dueDateKind)} estimatedDays={estimatedDays} title={title} currentFocus={currentFocus} definitionOfDone={definitionOfDone} steps={steps} details={details} projectTitle={selectedProject?.project.title || ""} stageTitle={selectedProject?.milestones.find((item) => item.id === milestoneId)?.title || ""} onChange={setEstimatedDays} />
              <label className="task-today-toggle"><input type="checkbox" checked={planOnSave} onChange={(event) => setPlanOnSave(event.target.checked)} /><span><strong>安排到今天</strong><small>不会启动计时，也可以随时撤销</small></span></label>
              <footer><Button variant="secondary" type="button" onClick={() => setShowComposer(false)}>取消</Button><Button variant="primary" type="submit" disabled={!title.trim()}>保存行动</Button></footer>
            </form>
          </aside>
        </div>
      )}
      {closeoutTask && <TaskCloseoutDialog task={closeoutTask} onCancel={() => setCloseoutTask(null)} onSave={taskActions.onCloseToday} />}
      {editingTask && <ActionEditDialog task={editingTask} projects={projects} projectDetails={projectDetails} onCancel={() => setEditingTask(null)} onSave={async (task) => { const saved = await taskActions.onUpdateTask(task); if (saved) setEditingTask(null); return saved; }} />}
    </div>
  );
}

export function ArchivePage({ projects, tasks, focusSessions, onOpenProject, onOpenTask, onRestoreTask }: {
  projects: ProjectSummary[];
  tasks: WorkspaceTask[];
  focusSessions: FocusSession[];
  onOpenProject: (projectId: string) => void;
  onOpenTask: (taskId: string) => void;
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
    .filter((task) => task.status === "done" || task.status === "cancelled")
    .filter((task) => !needle || `${task.title} ${task.projectTitle} ${task.stageTitle} ${task.details}`.toLocaleLowerCase("zh-CN").includes(needle))
    .sort((left, right) => (right.completedAt || right.updatedAt).localeCompare(left.completedAt || left.updatedAt));

  return <div className="archive-page workspace-scroll">
    <header className="workspace-page-heading"><div><h1>归档</h1><p>已经完成的项目与行动从日常工作区退场，在这里保留结果和投入记录。</p></div><ThemeSticker section="archive" /><SearchField label="搜索归档" value={query} onChange={setQuery} placeholder="搜索项目或行动" /></header>
    <nav className="archive-tabs" aria-label="归档类型"><button className={view === "projects" ? "active" : ""} onClick={() => setView("projects")}>已完成项目 <span>{projects.filter((item) => item.status === "completed").length}</span></button><button className={view === "actions" ? "active" : ""} onClick={() => setView("actions")}>归档行动 <span>{tasks.filter((item) => item.status === "done" || item.status === "cancelled").length}</span></button></nav>
    {view === "projects" ? <section className="archive-project-grid">{completedProjects.map((project) => <article key={project.id}><header><span>{project.parentProjectId ? "已完成支线" : "已完成项目"}</span><time>{formatArchiveDate(project.completedAt || project.updatedAt)}</time></header><h2>{project.title}</h2><p>{project.outcome}</p><div><span><strong>{project.completedMilestoneCount}</strong>/{project.milestoneCount || 0} 阶段</span><span><strong>{project.completedTaskCount}</strong> 项行动</span></div><Button variant="ghost" size="small" type="button" onClick={() => onOpenProject(project.id)}>查看档案或重新开启 →</Button></article>)}{!completedProjects.length && <EmptyState title={query ? "没有找到匹配项目" : "还没有已完成项目"} body="项目完结后会自动出现在这里，并保留全部阶段、行动和记录。" />}</section>
      : <section className="archive-action-list">{completedTasks.map((task) => { const focusSeconds = focusSessions.filter((session) => session.taskId === task.id && session.endedAt).reduce((sum, session) => sum + session.durationSeconds, 0); return <article key={task.id}><div><span>{task.projectId ? task.projectTitle : `独立行动 · ${LIFE_DOMAIN_LABELS[task.direction]}`}{task.stageTitle ? ` · ${task.stageTitle}` : ""}{task.status === "cancelled" ? " · 已取消" : ""}</span><h2>{actionDisplayTitle(task)}</h2><p>{task.details || "没有补充具体做法。"}</p></div><aside><time>{formatArchiveDate(task.completedAt || task.updatedAt)}</time>{focusSeconds > 0 && <small>累计投入 {formatFocusDuration(focusSeconds)}</small>}<Button variant="secondary" type="button" onClick={() => onOpenTask(task.id)}>查看详情</Button><Button variant="secondary" type="button" onClick={() => onRestoreTask(task)}>恢复行动</Button></aside></article>; })}{!completedTasks.length && <EmptyState title={query ? "没有找到匹配行动" : "还没有归档行动"} body="完成或取消行动后，它会离开今日行动并保留在这里。" />}</section>}
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
      <header className="workspace-page-heading"><div><h1>探索库</h1><p>保存感兴趣的内容；当它与当前行动相关或沉寂较久时，首页会重新提醒你。</p></div><ThemeSticker section="explore" /></header>
      <form className="link-capture-card" onSubmit={submit}>
        <div><span>添加收藏</span><strong>支持直接粘贴分享文案或链接</strong></div>
        <input value={capture} onChange={(event) => { setCapture(event.target.value); setError(""); }} placeholder="粘贴 B站、抖音、文章链接或整段分享文案" />
        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="为什么收藏它？可选，能帮助以后重新发现" />
        <Button variant="ghost" size="small" type="submit" disabled={!capture.trim()}>收藏</Button>
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
      {url && <Button variant="primary" onClick={() => void openSourceUrl(url)}>打开原内容 ↗</Button>}
      {!archived && <Button variant="secondary" type="button" onClick={() => onOrganize(article)}>整理</Button>}
      <Button variant="secondary" type="button" onClick={() => void onArchive(article, !archived)}>{archived ? "恢复" : "归档"}</Button>
      <Button variant="danger" onClick={() => void onDelete(article)}>删除</Button>
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
  const [direction, setDirection] = useState<ProjectTask["direction"]>("uncategorized");
  const [milestoneId, setMilestoneId] = useState(projectDetails.find((detail) => detail.project.id === initialProject)?.milestones.find((milestone) => milestone.status === "current")?.id || "");
  const [dueDate, setDueDate] = useState("");
  const [dueDateKind, setDueDateKind] = useState<ProjectTask["dueDateKind"]>(null);
  const [definitionOfDone, setDefinitionOfDone] = useState("");
  const [currentFocus, setCurrentFocus] = useState(article.title);
  const [steps, setSteps] = useState<ProjectTask["steps"]>([]);
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
    if (!title.trim() || !body.trim() || (kind === "proposal" && !projectId) || saving) return;
    setSaving(true);
    try {
      if (kind === "note") await onSubmit({ kind, title: title.trim(), body: body.trim(), tags: tags.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) });
      else if (kind === "action") await onSubmit({ kind, projectId: projectId || null, milestoneId: projectId ? milestoneId || null : null, direction: projectId ? selectedProject?.project.category ?? direction : direction, title: title.trim(), definitionOfDone: definitionOfDone.trim(), steps, currentFocus: currentFocus.trim(), details: body.trim(), dueDate, dueDateKind });
      else await onSubmit({ kind, projectId, title: title.trim(), problem: body.trim(), expectedValue: expectedValue.trim(), cost: cost.trim() });
    } finally {
      setSaving(false);
    }
  }

  return <div className="task-drawer-backdrop source-organizer-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><aside className="task-drawer source-organizer-drawer" role="dialog" aria-modal="true" aria-label="整理探索资料"><header><div><span>整理探索资料</span><h2>{article.title}</h2><p>原内容会继续留在探索库，并与整理结果保持关联。</p></div><Button variant="secondary" size="small" iconOnly type="button" onClick={onClose} aria-label="关闭">×</Button></header><nav><button type="button" className={kind === "note" ? "active" : ""} onClick={() => setKind("note")}>转为笔记</button><button type="button" className={kind === "action" ? "active" : ""} onClick={() => setKind("action")}>转为行动</button><button type="button" className={kind === "proposal" ? "active" : ""} onClick={() => setKind("proposal")}>转为提案</button></nav><form onSubmit={submit}><label><span>标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label><span>{kind === "note" ? "笔记内容" : kind === "action" ? "补充说明" : "需要判断的问题"}</span><textarea value={body} onChange={(event) => setBody(event.target.value)} /></label>{kind === "note" ? <label><span>标签</span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="多个标签用顿号隔开" /></label> : <><label><span>{kind === "action" ? "所属项目（可选）" : "所属项目"}</span><SelectMenu label="所属项目" value={projectId} onChange={chooseProject} options={[{ value: "", label: kind === "action" ? "独立行动" : "选择项目" }, ...projects.filter((project) => project.status !== "completed").map((project) => ({ value: project.id, label: project.title }))]} /></label>{kind === "action" ? <>{!projectId && <label><span>关注方向（可选）</span><SelectMenu label="关注方向" value={direction} onChange={(value) => setDirection(value as ProjectTask["direction"])} options={LIFE_DOMAIN_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} /></label>}{projectId && <label><span>所属阶段</span><SelectMenu label="所属阶段" value={milestoneId} onChange={setMilestoneId} options={[{ value: "", label: "暂不关联" }, ...(selectedProject?.milestones ?? []).map((milestone) => ({ value: milestone.id, label: milestone.title }))]} /></label>}<label><span>本次推进 · 可选</span><textarea value={currentFocus} onChange={(event) => setCurrentFocus(event.target.value)} placeholder="这一次先推进到哪里？" /></label><label><span>完成标志 · 可选</span><textarea value={definitionOfDone} onChange={(event) => setDefinitionOfDone(event.target.value)} placeholder="看到什么结果时，这条行动才算完成？" /></label><ActionStepEditor steps={steps} onChange={setSteps} /><ProjectDateField label="行动日期" value={dueDate} kind={dueDateKind} onChange={(date, kind) => { setDueDate(date); setDueDateKind(kind); }} /></> : <><label><span>预期价值</span><textarea value={expectedValue} onChange={(event) => setExpectedValue(event.target.value)} placeholder="如果值得做，可能带来什么？" /></label><label><span>成本与顾虑</span><textarea value={cost} onChange={(event) => setCost(event.target.value)} placeholder="需要投入什么，可能遇到什么问题？" /></label></>}</>}<footer><Button variant="secondary" type="button" onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={saving || !title.trim() || !body.trim() || (kind === "proposal" && !projectId)}>{saving ? "正在保存…" : kind === "note" ? "生成笔记" : kind === "action" ? "创建行动" : "创建提案"}</Button></footer></form></aside></div>;
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
        <ThemeSticker section="inbox" />
        <Button variant="secondary" type="button" onClick={onNewCapture}>＋ 随手记一条</Button>
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
    <div className="inbox-item-actions"><Button variant="secondary" type="button" onClick={() => void onMoveArticle(article, "note")}>整理为笔记</Button><Button variant="secondary" type="button" onClick={() => void onMoveArticle(article, "explore")}>放入探索库</Button><button className={organizingProject ? "active" : ""} onClick={() => setOrganizingProject((value) => !value)}>纳入项目{organizingProject ? " ↑" : "…"}</button><Button variant="danger" aria-label={`删除 ${article.title}`} onClick={() => void onDelete(article)}>删除</Button></div>
    {organizingProject && <section className="inbox-project-panel"><div><strong>把它放进哪个项目？</strong><p>转为行动适合已经明确要做的事；转为提案适合还需要判断价值和成本的想法。</p></div><SelectMenu label="选择项目" value={projectId} onChange={setProjectId} options={[{ value: "", label: "选择项目" }, ...projects.filter((project) => project.status !== "completed").map((project) => ({ value: project.id, label: project.title }))]} /><footer><Button variant="secondary" type="button" disabled={!projectId} onClick={() => void onConvertToAction(article, projectId)}>转为行动</Button><Button variant="secondary" type="button" disabled={!projectId} onClick={() => void onConvertToProposal(article, projectId)}>转为提案</Button></footer></section>}
  </article>;
}

const weeklyReviewOutcomeOptions: Array<{ value: WeeklyReviewOutcomeStatus; label: string; detail: string }> = [
  { value: "achieved", label: "已达成", detail: "预期结果已经出现" },
  { value: "partial", label: "部分达成", detail: "方向有效，但结果尚未完整" },
  { value: "missed", label: "未达成", detail: "结果没有如期出现" },
  { value: "redirected", label: "中途改向", detail: "原目标已不再适用" },
];

const weeklyReviewStrategyOptions: Array<{ value: WeeklyReviewStrategy; label: string; detail: string }> = [
  { value: "continue", label: "继续主线", detail: "方向不变，继续兑现结果" },
  { value: "narrow", label: "缩小范围", detail: "保留方向，减少承诺" },
  { value: "switch", label: "更换主线", detail: "把资源转向更重要的结果" },
  { value: "pause", label: "暂停或停止", detail: "主动结束低价值投入" },
];

const weeklyReviewFactorOptions = [
  { value: "", label: "暂不归类" },
  { value: "scope", label: "范围判断" },
  { value: "external", label: "外部阻塞" },
  { value: "priority", label: "优先级变化" },
  { value: "capacity", label: "时间与精力" },
  { value: "approach", label: "执行方式" },
  { value: "other", label: "其他因素" },
];

export function ReviewPage({ dailySituations, onSupplementDay, projects, projectDetails, articles, tasks, weeklyFocus, weeklyReview, previousWeeklyReview, onSaveWeeklyReview, onOpenTask }: {
  dailySituations: DailySituation[];
  onSupplementDay: (date: string) => void;
  projects: ProjectSummary[];
  projectDetails: ProjectDetail[];
  articles: StoredArticle[];
  tasks: WorkspaceTask[];
  weeklyFocus: WeeklyFocus | null;
  weeklyReview: WeeklyReview | null;
  previousWeeklyReview: WeeklyReview | null;
  onSaveWeeklyReview: (review: Omit<WeeklyReview, "weekStart" | "updatedAt">) => Promise<void>;
  onOpenTask: (taskId: string) => void;
}) {
  const [outcomeStatus, setOutcomeStatus] = useState<WeeklyReviewOutcomeStatus | "">(weeklyReview?.outcomeStatus ?? "");
  const [factor, setFactor] = useState<WeeklyReview["factor"]>(weeklyReview?.factor ?? "");
  const [factorNote, setFactorNote] = useState(weeklyReview?.factorNote ?? "");
  const [nextStrategy, setNextStrategy] = useState<WeeklyReviewStrategy | "">(weeklyReview?.nextStrategy ?? "");
  const [adjustment, setAdjustment] = useState(weeklyReview?.adjustment ?? "");
  const [savingReview, setSavingReview] = useState(false);
  useEffect(() => {
    setOutcomeStatus(weeklyReview?.outcomeStatus ?? "");
    setFactor(weeklyReview?.factor ?? "");
    setFactorNote(weeklyReview?.factorNote ?? "");
    setNextStrategy(weeklyReview?.nextStrategy ?? "");
    setAdjustment(weeklyReview?.adjustment ?? "");
  }, [weeklyReview]);
  const weekStart = startOfLocalWeek();
  const weekArticles = articles.filter((article) => !isSourceArticle(article) && !isThoughtInboxArticle(article) && (article.updated || article.created) >= weekStart.slice(0, 10));
  const weekCompleted = tasks.filter((task) => task.completedAt && task.completedAt >= weekStart);
  const continuationRecords = projectDetails.flatMap((detail) => detail.logs.flatMap((log) => {
    const continuation = decodeContinuationLog(log.body);
    if (!continuation || log.createdAt < weekStart) return [];
    return [{ id: log.id, taskId: null, projectId: detail.project.id, projectTitle: detail.project.title, title: continuation.text, detail: continuation.label, kind: "接续记录" }];
  }));
  const taskProgressRecords = projectDetails.flatMap((detail) => detail.logs.flatMap((log) => {
    const progress = decodeTaskProgressLog(log.body);
    if (!progress || log.createdAt < weekStart) return [];
    const blocked = progress.result.startsWith("遇到阻塞") && detail.tasks.some((task) => task.id === progress.taskId && !["done", "cancelled"].includes(task.status));
    return [{ id: log.id, taskId: progress.taskId, projectId: detail.project.id, projectTitle: detail.project.title, title: progress.result, detail: `下一次：${progress.nextFocus}`, kind: blocked ? "未解决卡点" : "今日推进" }];
  }));
  const weekProgress = [
    ...weekCompleted.map((task) => ({ id: task.id, taskId: task.id, projectId: task.projectId, projectTitle: task.projectTitle, title: actionDisplayTitle(task), detail: task.projectId ? task.stageTitle || "未关联阶段" : `独立行动 · ${LIFE_DOMAIN_LABELS[task.direction]}`, kind: "完成" })),
    ...continuationRecords,
    ...taskProgressRecords,
  ];
  const progressGroups = [...weekProgress.reduce((groups, item) => {
    const groupKey = item.projectId ?? "standalone";
    const group = groups.get(groupKey) ?? { projectId: item.projectId, projectTitle: item.projectTitle, items: [] as typeof weekProgress };
    group.items.push(item);
    groups.set(groupKey, group);
    return groups;
  }, new Map<string, { projectId: string | null; projectTitle: string; items: typeof weekProgress }>()).values()];
  const completedStages = projects.reduce((sum, project) => sum + project.completedMilestoneCount, 0);
  const previousStrategy = previousWeeklyReview
    ? weeklyReviewStrategyOptions.find((option) => option.value === previousWeeklyReview.nextStrategy)?.label
    : "";
  return (
    <div className="review-page workspace-scroll">
      <header className="workspace-page-heading"><div><h1>本周回顾</h1><p>{weeklyFocus?.primaryOutcome ? `本周主结果：${weeklyFocus.primaryOutcome}` : "查看留下了什么结果、判断与经验，而不是用计时证明自己很忙。"}</p></div><ThemeSticker section="review" /></header>
      <div className="review-metrics"><article><span>本周完成行动</span><strong>{weekCompleted.length}</strong><small>项行动在本周完成</small></article><article><span>全部累计阶段</span><strong>{completedStages}</strong><small>个项目阶段已经走过</small></article><article><span>本周更新笔记</span><strong>{weekArticles.length}</strong><small>条笔记或资料有更新</small></article></div>
      <div className="review-grid">
        <section className="workspace-card review-project-time"><CardHeader title="项目与行动进展" subtitle={weekProgress.length ? `${progressGroups.length} 个分组 · ${weekProgress.length} 条记录` : "完成与接续记录"} />{progressGroups.length ? <div className="review-project-groups">{progressGroups.map((group) => <article className="review-project-group" key={group.projectId ?? "standalone"}><header><strong>{group.projectId ? group.projectTitle : "独立行动"}</strong><span>{group.items.length} 条</span></header><div>{group.items.map((item) => <button className="review-progress-row" disabled={!item.taskId} onClick={() => item.taskId && onOpenTask(item.taskId)} key={item.id}><i>{item.kind}</i><span><strong>{item.title}</strong><small>{item.detail}</small></span></button>)}</div></article>)}</div> : <div className="review-compact-empty"><strong>本周还没有进展</strong><p>完成行动或写下“今天做到哪里”，这里就会按项目或独立行动归拢。</p></div>}</section>
        <section className="workspace-card review-growth"><CardHeader title="本周留下了什么" subtitle="最近更新的经验、思考和资料" />{weekArticles.slice(0, 6).map((article) => <p key={article.id}><span>{natureLabel(article)}</span><strong>{article.title}</strong><small>{formatRelativeDate(article.updated || article.created)}</small></p>)}{!weekArticles.length && <EmptyState title="还没有新的沉淀" body="完成工作后留一句发现，也是一种可见的成长。" />}</section>
      </div>
      <section className="workspace-card situation-week"><CardHeader title="本周的实际变化" subtitle="按发生日期回看，不计入行动完成数" />{dailySituations.filter((item) => item.date >= weekStart.slice(0, 10) && item.date <= localDate()).map((item) => <button key={item.date} onClick={() => onSupplementDay(item.date)}><span>{item.date}</span><strong>{item.reason}</strong>{item.actualWork && <p>实际做了：{item.actualWork}</p>}<small>{item.tasks.filter((task) => task.outcome === "not_started").length} 项未开始 · {item.tasks.filter((task) => task.outcome === "partial").length} 项部分推进</small></button>)}{!dailySituations.some((item) => item.date >= weekStart.slice(0, 10) && item.date <= localDate()) && <p>忙完后补记的情况会出现在这里，帮助判断时间和精力去了哪里。</p>}</section>
      <form className="workspace-card weekly-calibration-card" onSubmit={async (event) => {
        event.preventDefault();
        if (!outcomeStatus || !nextStrategy || savingReview) return;
        setSavingReview(true);
        await onSaveWeeklyReview({ outcomeStatus, factor, factorNote, nextStrategy, adjustment });
        setSavingReview(false);
      }}>
        <CardHeader title="本周校准" subtitle={weeklyReview ? "本周结论已保存，可以继续修正" : "不重复记录做了什么，只决定接下来怎么走"} />
        <div className="weekly-calibration-intent">
          <span>本周原定结果</span>
          <strong>{weeklyFocus?.primaryOutcome || "本周没有设置主结果"}</strong>
          {weeklyFocus?.secondaryOutcome && <small>副结果 · {weeklyFocus.secondaryOutcome}</small>}
        </div>
        {previousWeeklyReview && <aside className="weekly-calibration-carry"><div><span>上周留下的校准</span><strong>{previousStrategy}</strong></div><p>{previousWeeklyReview.adjustment || "上周没有额外写下调整原则。"}</p></aside>}
        <section className="weekly-calibration-section">
          <header><i>01</i><div><strong>本周主结果的结论</strong><small>判断结果，而不是用完成数量评价这一周。</small></div></header>
          <div className="weekly-calibration-options">{weeklyReviewOutcomeOptions.map((option) => <button type="button" className={outcomeStatus === option.value ? "selected" : ""} aria-pressed={outcomeStatus === option.value} key={option.value} onClick={() => setOutcomeStatus(option.value)}><strong>{option.label}</strong><small>{option.detail}</small></button>)}</div>
        </section>
        <section className="weekly-calibration-section weekly-calibration-factor">
          <header><i>02</i><div><strong>影响结果的关键因素</strong><small>只保留最关键的一项，不重述项目日志。</small></div></header>
          <div><SelectMenu label="关键因素分类" value={factor} onChange={(value) => setFactor(value as WeeklyReview["factor"])} options={weeklyReviewFactorOptions} /><textarea value={factorNote} onChange={(event) => setFactorNote(event.target.value)} placeholder="可选：为什么它真正影响了结果？" /></div>
        </section>
        <section className="weekly-calibration-section">
          <header><i>03</i><div><strong>下周采取什么策略</strong><small>这里做方向取舍；具体行动仍然回到项目与今日行动中安排。</small></div></header>
          <div className="weekly-calibration-options">{weeklyReviewStrategyOptions.map((option) => <button type="button" className={nextStrategy === option.value ? "selected" : ""} aria-pressed={nextStrategy === option.value} key={option.value} onClick={() => setNextStrategy(option.value)}><strong>{option.label}</strong><small>{option.detail}</small></button>)}</div>
          <label><span>下周只改变什么？</span><textarea value={adjustment} onChange={(event) => setAdjustment(event.target.value)} placeholder="可选：写下一条约束或试验，例如“上午只推进主结果，不安排整理类任务”" /></label>
        </section>
        <footer><p>{weeklyReview ? `上次保存于 ${formatRelativeDate(weeklyReview.updatedAt)}` : "每周记录一次即可，周中也可以提前校准。"}</p><Button variant="primary" type="submit" disabled={savingReview || !outcomeStatus || !nextStrategy}>{savingReview ? "正在保存…" : weeklyReview ? "更新本周结论" : "保存本周结论"}</Button></footer>
      </form>
    </div>
  );
}

function ActionCenterJobs({ projects, onOpenProject, onArchive, showAll }: {
  projects: ProjectSummary[];
  onOpenProject: (id: string) => void;
  onArchive: (request: WorkerArchive) => Promise<void>;
  showAll: boolean;
}) {
  const [jobs, setJobs] = useState<AsabaJob[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    const refresh = () => void companionApi.jobs().then((value) => { if (active) { setJobs(value); setError(""); } }, (cause) => { if (active) setError(String(cause)); });
    const subscription = listen("asaba-jobs-changed", refresh);
    void subscription.then(refresh, () => refresh());
    return () => { active = false; void subscription.then((stop) => stop(), () => undefined); };
  }, []);
  const groups = projectJobGroups(jobs);
  const needsReview = groups.filter(({ latest }) => latest.state === "review");
  const running = groups.filter(({ latest }) => ["queued", "running", "recovering"].includes(latest.state));
  const other = groups.filter(({ latest }) => !["review", "queued", "running", "recovering"].includes(latest.state));
  const eligibleProjects = projects.filter((project) => !project.isDraft && project.status !== "completed");
  function renderJob({ latest, previous }: ReturnType<typeof projectJobGroups>[number]) {
    const project = projects.find(({ id }) => id === latest.projectId);
    return <div key={latest.id} className="action-center-job">
      <AsabaJobCard job={latest} projects={eligibleProjects} onArchive={onArchive} onReviewed={latest.agent === "codex" && latest.state === "review"
        ? () => void companionApi.jobAction(latest.id, "reviewed").catch((cause) => setError(String(cause))) : undefined} />
      {project && <Button variant="ghost" size="small" onClick={() => onOpenProject(project.id)}>{project.title} ↗</Button>}
      {showAll && previous.length > 0 && <details><summary>之前的尝试（{previous.length}）</summary>{previous.map((job) => <AsabaJobCard key={job.id} job={job} />)}</details>}
    </div>;
  }
  return <aside className="action-center-list" aria-label="委托">
    <section className="workspace-card action-center-panel"><h2>待确认</h2>{needsReview.length ? needsReview.map(renderJob) : <p>暂无待确认的委托</p>}</section>
    {running.length > 0 && <section className="workspace-card action-center-panel"><h2>正在委托</h2>{running.map(renderJob)}</section>}
    {showAll && other.length > 0 && <section className="workspace-card action-center-panel"><h2>委托记录</h2>{other.map(renderJob)}</section>}
    {error && <p role="status">{error}</p>}
  </aside>;
}

function ActionRow({ task, today, suggested, expanded, onToggle, onOpenProject, onRemoveTask, onRequestCloseout, onEditTask,
  onCompleteTask, onUpdateTask, onPlanToday, onRemoveFromToday, onStartFocus, onStopFocus, activeSession }: {
  task: WorkspaceTask; today: string; suggested: boolean; expanded: boolean; onToggle: () => void;
  onOpenProject: (projectId: string) => void; onRemoveTask: (task: WorkspaceTask) => void;
  onRequestCloseout: (task: WorkspaceTask) => void; onEditTask: (task: WorkspaceTask) => void;
} & TaskActions) {
  const confirmed = isConfirmedTodayPlan(task.plan, today);
  const active = activeSession?.taskId === task.id;
  const closed = task.status === "done" || task.status === "cancelled";
  const blocked = Boolean(task.weekBlocked || task.status === "waiting" || task.projectDraft || (task.projectStatus && task.projectStatus !== "active"));
  const date = actionDate(task, today);
  const title = actionDisplayTitle(task);
  const [completing, setCompleting] = useState(false);
  return <article id={"action-row-" + task.id} className="action-center-row">
    <div className="action-center-row-main">
      <div>
        <div className="action-center-context">
          {task.projectId ? <Button variant="ghost" size="small" wrap onClick={() => onOpenProject(task.projectId!)}>{task.projectTitle} ↗</Button> : <span>独立行动</span>}
          {task.stageTitle && <span>{task.stageTitle}</span>}
        </div>
        <h3><Button variant="ghost" wrap aria-expanded={expanded} onClick={onToggle}>{task.currentFocus || title}</Button></h3>
        {(closed || blocked || active || suggested) && <small>{closed ? task.status === "done" ? "已完成" : "已取消" : active ? "正在计时" : task.status === "waiting" ? "等待中" : task.weekBlocked ? "等待前置行动" : blocked ? "所属项目未在推进" : "建议近期开始"}</small>}
        {date.text && (date.tone || expanded) && <small className={date.tone}>{date.text}</small>}
      </div>
      <div className="action-center-row-buttons">
        {!closed && !blocked && <Button variant="secondary" size="small" disabled={completing} onClick={async () => { setCompleting(true); try { await onCompleteTask(task); } finally { setCompleting(false); } }}>完成</Button>}
        <Button variant="ghost" size="small" aria-expanded={expanded} onClick={onToggle}>{expanded ? "收起" : "详情"}</Button>
      </div>
    </div>
    {expanded && <div className="action-center-row-details">
      {task.currentFocus && task.currentFocus !== title && <p>{title}</p>}
      <ActionStructureDisclosure task={task} onUpdate={onUpdateTask} initiallyOpen />
      {task.resumeAction && <p>恢复后 · {task.resumeAction}</p>}
      <footer>
        {!closed && !blocked && <Button variant="secondary" size="small" onClick={() => confirmed ? onRemoveFromToday(task) : onPlanToday(task)}>{confirmed ? "移出今天" : "安排到今天"}</Button>}
        {!closed && <Button variant="ghost" size="small" onClick={() => onEditTask(task)}>编辑行动</Button>}
        {active ? <Button variant="ghost" size="small" onClick={onStopFocus}>停止计时</Button> : !closed && !blocked && !activeSession && <Button variant="ghost" size="small" onClick={() => onStartFocus(task)}>记录投入</Button>}
        {!closed && !blocked && <Button variant="ghost" size="small" onClick={() => onRequestCloseout(task)}>今日收工</Button>}
        {!closed && <Button variant="danger" size="small" onClick={() => onRemoveTask(task)}>删除</Button>}
      </footer>
    </div>}
  </article>;
}

function ActionStructureDisclosure({ task, onUpdate, initiallyOpen }: { task: WorkspaceTask; onUpdate: (task: WorkspaceTask) => Promise<boolean>; initiallyOpen?: boolean }) {
  async function toggleStep(stepId: string) {
    await onUpdate({
      ...task,
      steps: task.steps.map((step) => step.id === stepId ? { ...step, completed: !step.completed } : step),
    });
  }
  if (!task.definitionOfDone && !task.steps.length && !task.details && !task.waitingFor) return null;
  return <details className="action-disclosure action-structure-disclosure" open={initiallyOpen}>
    <summary>查看行动说明与步骤</summary>
    <div>
      {task.definitionOfDone && <section><strong>完成标志</strong><p>{task.definitionOfDone}</p></section>}
      <ActionChecklist steps={task.steps} onToggle={(stepId) => void toggleStep(stepId)} />
      {task.details && <section><strong>补充说明</strong><p>{task.details}</p></section>}
      {task.waitingFor && <section><strong>正在等待</strong><p>{task.waitingFor}</p></section>}
    </div>
  </details>;
}

function ActionEditDialog({ task, projects, projectDetails, onCancel, onSave }: {
  task: WorkspaceTask;
  projects: ProjectSummary[];
  projectDetails: ProjectDetail[];
  onCancel: () => void;
  onSave: (task: WorkspaceTask) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<WorkspaceTask>(() => ({ ...task, steps: task.steps.map((step) => ({ ...step })) }));
  const [saving, setSaving] = useState(false);
  const selectedProject = draft.projectId ? projectDetails.find((detail) => detail.project.id === draft.projectId) ?? null : null;
  function chooseProject(value: string) {
    const project = projectDetails.find((detail) => detail.project.id === value) ?? null;
    setDraft({
      ...draft,
      projectId: project?.project.id ?? null,
      milestoneId: project?.milestones.find((milestone) => milestone.status === "current")?.id ?? null,
      direction: project?.project.category ?? draft.direction,
    });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.title.trim() || saving) return;
    setSaving(true);
    const saved = await onSave({
      ...draft,
      projectId: draft.projectId || null,
      milestoneId: draft.projectId ? draft.milestoneId : null,
      title: draft.title.trim(),
      currentFocus: draft.currentFocus.trim(),
      definitionOfDone: draft.definitionOfDone.trim(),
      details: draft.details.trim(),
    });
    if (!saved) setSaving(false);
  }
  return <div className="task-drawer-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && !saving) onCancel(); }}>
    <aside className="task-drawer action-drawer" role="dialog" aria-modal="true" aria-label="行动详情">
      <header><div><span>{draft.projectId ? "项目行动" : "独立行动"}</span><h2>行动详情</h2><p>可以归入项目，或从项目移出成为独立行动；历史投入不会丢失。</p></div><Button variant="secondary" size="small" iconOnly type="button" disabled={saving} onClick={onCancel} aria-label="关闭">×</Button></header>
      <form onSubmit={(event) => void submit(event)}>
        <label><span>所属项目 · 可选</span><SelectMenu label="所属项目" value={draft.projectId || ""} onChange={chooseProject} options={[{ value: "", label: "独立行动" }, ...projects.filter((project) => project.status === "active").map((project) => ({ value: project.id, label: project.title }))]} /></label>
        {!draft.projectId && <label><span>关注方向 · 可选</span><SelectMenu label="关注方向" value={draft.direction} onChange={(value) => setDraft({ ...draft, direction: value as ProjectTask["direction"] })} options={LIFE_DOMAIN_OPTIONS} /></label>}
        {draft.projectId && <label><span>所属阶段 · 可选</span><SelectMenu label="所属阶段" value={draft.milestoneId || ""} onChange={(value) => setDraft({ ...draft, milestoneId: value || null })} options={[{ value: "", label: "暂不关联" }, ...(selectedProject?.milestones ?? []).filter((milestone) => milestone.status !== "superseded").map((milestone) => ({ value: milestone.id, label: `${milestone.status === "current" ? "当前 · " : ""}${milestone.title}` }))]} /></label>}
        <label><span>行动状态</span><SelectMenu label="行动状态" value={draft.status} onChange={(value) => setDraft({ ...draft, status: value as ProjectTask["status"] })} options={[{ value: "next", label: "下一步" }, { value: "later", label: "稍后" }, { value: "waiting", label: "等待中" }, { value: "cancelled", label: "已取消" }]} /></label>
        {draft.status === "waiting" && <>
          <label><span>等待条件</span><input value={draft.waitingFor} onChange={(event) => setDraft({ ...draft, waitingFor: event.target.value })} /></label>
          <label><span>恢复后行动</span><input value={draft.resumeAction} onChange={(event) => setDraft({ ...draft, resumeAction: event.target.value })} /></label>
        </>}
        <label><span>行动名称</span><input autoFocus value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
        <ActionOptionalFields hasContent={Boolean(draft.currentFocus || draft.definitionOfDone || draft.steps.length || draft.details)}>
        <label><span>本次推进</span><textarea value={draft.currentFocus} onChange={(event) => setDraft({ ...draft, currentFocus: event.target.value })} /></label>
        <label><span>完成标志</span><textarea value={draft.definitionOfDone} onChange={(event) => setDraft({ ...draft, definitionOfDone: event.target.value })} /></label>
        <ActionStepEditor steps={draft.steps} onChange={(steps) => setDraft({ ...draft, steps })} />
        <label><span>补充说明 · 可选</span><textarea value={draft.details} onChange={(event) => setDraft({ ...draft, details: event.target.value })} /></label>
        </ActionOptionalFields>
        <ProjectDateField label="行动日期" value={draft.dueDate} kind={draft.dueDateKind} onChange={(dueDate, dueDateKind) => setDraft({ ...draft, dueDate, dueDateKind })} />
        <ActionEstimateField dateKind={draft.dueDateKind} dueDate={scheduledProjectDate(draft.dueDate, draft.dueDateKind)} estimatedDays={draft.estimatedDays || 0} title={draft.title} currentFocus={draft.currentFocus} definitionOfDone={draft.definitionOfDone} steps={draft.steps} details={draft.details} projectTitle={selectedProject?.project.title || ""} stageTitle={selectedProject?.milestones.find((item) => item.id === draft.milestoneId)?.title || ""} onChange={(days) => setDraft({ ...draft, estimatedDays: days })} />
        <footer><Button variant="secondary" type="button" disabled={saving} onClick={onCancel}>取消</Button><Button variant="primary" type="submit" disabled={saving || !draft.title.trim()}>{saving ? "正在保存…" : "保存行动"}</Button></footer>
      </form>
    </aside>
  </div>;
}

function TaskCloseoutDialog({ task, onCancel, onSave }: {
  task: WorkspaceTask;
  onCancel: () => void;
  onSave: (task: WorkspaceTask, result: string, nextFocus: string) => Promise<boolean>;
}) {
  const [outcome, setOutcome] = useState<QuickCloseoutOutcome>("progressed");
  const [note, setNote] = useState("");
  const [nextFocus, setNextFocus] = useState(task.currentFocus || "");
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const closeout = buildQuickCloseout(outcome, note, nextFocus, task.currentFocus || actionDisplayTitle(task));
    setSaving(true);
    const saved = await onSave(task, closeout.result, closeout.nextFocus);
    setSaving(false);
    if (saved) onCancel();
  }
  return <div className="task-closeout-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && !saving) onCancel(); }}>
    <form className="task-closeout-dialog" role="dialog" aria-modal="true" aria-label="记录今日进展" onSubmit={(event) => void submit(event)}>
      <header><div><span>今日收工</span><h2>点一下，留下今天的进展</h2></div><Button variant="secondary" size="small" iconOnly type="button" disabled={saving} onClick={onCancel} aria-label="关闭">×</Button></header>
      <p>投入时间已经自动保存。选择最接近的结果即可；补充说明和调整下次起点都不是必填项。</p>
      <aside><small>所属行动</small><strong>{actionDisplayTitle(task)}</strong></aside>
      <div className="task-closeout-outcomes" aria-label="选择今天的进展">{([
        ["progressed", "推进了一些", "保留当前起点"],
        ["small_step", "完成当前小步", "下次继续下一步"],
        ["blocked", "遇到阻塞", "记住停在哪里"],
      ] as const).map(([value, label, detail]) => <button type="button" key={value} className={outcome === value ? "active" : ""} aria-pressed={outcome === value} onClick={() => setOutcome(value)}><strong>{label}</strong><small>{detail}</small></button>)}</div>
      <label><span>补充一句 · 可选</span><textarea autoFocus value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：已看完实验设置，输入输出流程也画好了" /></label>
      <details className="task-closeout-next"><summary>调整下次从哪里继续 · 可选</summary><label><span>默认沿用当前起点</span><textarea value={nextFocus} onChange={(event) => setNextFocus(event.target.value)} placeholder={task.currentFocus || actionDisplayTitle(task)} /></label></details>
      <footer><Button variant="secondary" type="button" disabled={saving} onClick={onCancel}>继续做</Button><Button variant="primary" type="submit" disabled={saving}>{saving ? "正在保存…" : "保存并收工"}</Button></footer>
    </form>
  </div>;
}

function StageProgress({ task, compact = false }: { task: WorkspaceTask; compact?: boolean }) {
  if (!task.projectId || !task.stageTitle || task.stageCount === 0) return null;
  const total = Math.max(task.stageTaskCount, 1);
  const ratio = Math.min(100, Math.round(task.stageCompletedTasks / total * 100));
  return <div className={`stage-progress ${compact ? "compact" : ""}`}><i><b style={{ width: `${ratio}%` }} /></i><span>{task.stageCompletedTasks}/{task.stageTaskCount || 0} 个阶段行动完成</span></div>;
}

function CardHeader({ title, subtitle, action, onAction }: { title: string; subtitle: string; action?: string; onAction?: () => void }) { return <header className="card-header"><div><strong>{title}</strong><span>{subtitle}</span></div>{action && <Button variant="secondary" type="button" onClick={onAction}>{action} →</Button>}</header>; }
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
function taskRank(task: WorkspaceTask, today: string) { const todayRank = isConfirmedTodayPlan(task.plan, today) ? 0 : task.status === "next" ? 4 : 10; const dueDifference = actionDeadline(task) ? calendarDayDifference(actionDeadline(task), today) : null; const dueRank = dueDifference === null ? 30 : Math.max(0, dueDifference); return todayRank + dueRank / 100 + task.sortOrder / 1000; }
function actionDate(task: WorkspaceTask, today: string) {
  const due = actionDeadline(task);
  return due ? projectDateLabel(due, "deadline", today) : task.dueDate ? projectDateLabel(task.dueDate, task.dueDateKind, today) : task.stageDueDate ? projectDateLabel(task.stageDueDate, task.stageDueDateKind, today) : projectDateLabel(task.projectTargetDate ?? "", task.projectTargetDateKind, today);
}
function deadlineLabel(task: WorkspaceTask, today: string) { return actionDate(task, today).text; }
function greeting() { const hour = new Date().getHours(); if (hour < 6) return "夜深了"; if (hour < 11) return "早上好"; if (hour < 14) return "中午好"; if (hour < 18) return "下午好"; return "晚上好"; }
function formatLongDate(value: string) { return new Date(`${value}T12:00:00`).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" }); }
function formatDate(value: string) { return value ? value.slice(0, 10).replaceAll("-", ".") : "未记录日期"; }
function formatRelativeDate(value: string) { if (!value) return "未记录"; const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value); const diff = Math.floor((Date.now() - date.getTime()) / 86_400_000); if (diff <= 0) return "今天"; if (diff === 1) return "昨天"; if (diff < 7) return `${diff} 天前`; return formatDate(value); }
function formatArchiveDate(value: string) { return new Date(value).toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" }); }
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

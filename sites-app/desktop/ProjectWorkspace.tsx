import { openUrl } from "@tauri-apps/plugin-opener";
import type { WorkerArchive } from "../app/asaba-worker";
import type { AsabaAdjustmentRequest, AskProjectDecision } from "../app/asaba-planning";
import { ProjectDateField } from "./ProjectDateField";
import { projectDateLabel, scheduledProjectDate } from "../app/project-dates";
import { decodeContinuationLog, filterProjects, normalizeProjectTags, projectProgress, projectStatusCounts, suggestedProjectTags } from "../app/project-selectors";
import { ProjectRouteGraph } from "./ProjectRouteGraph";
import { ProjectTargetDate, StageDeadlineControls } from "./ProjectDeadlineControls";
import "./styles/project-refinements.css";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { ProjectRepository } from "../app/data/project-repository";
import { localDate } from "../app/date-helpers";
import type {
  Milestone,
  Project,
  ProjectAccumulation,
  ProjectDetail,
  ProjectProposal,
  ProjectPlanningMode,
  ProjectStatus,
  ProjectSummary,
  ProjectTask,
  ProjectTaskStatus,
  ProposalStatus,
} from "../app/project-types";
import { Button, DateField, IconButton, SearchField, SelectMenu, useConfirmDialog } from "./DesktopControls";
import { ActionChecklist, ActionStepEditor } from "./ActionStructure";
import { ActionEstimateField } from "./ActionEstimateField";
import { ActionOptionalFields } from "./ActionOptionalFields";
import { ThemeSticker } from "./DesktopThemes";
import { desktopApi } from "./integrationApi";
import type {
  DeepSeekStructuredResponse,
  ProjectAdjustmentDraft,
  ProjectCreationProposal,
  ProjectReplanProposal,
  ProjectRouteDraft,
  ProjectRouteProposal,
  ProjectRouteProposalNode,
} from "../app/ai-api-types";
import {
  resolveAvailableDeepSeekModel,
} from "../app/ai-model-settings";
import { buildRouteAiContext } from "../app/project-ai-context";
import { prepareProjectRoute } from "../app/project-route-proposal";
import type { StoredArticle } from "../app/types";
import { ProjectRecent } from "./ProjectRecent";

type ProjectTab = "overview" | "planning" | "stages" | "dependencies" | "records";

type ProjectWorkspaceProps = {
  onCreateWeek: (manual: () => void) => void;
  onContinueWeek: (projectId: string) => void;
  onChangeWeek: () => void;
  weekRevision: number;
  plannedDates: Record<string, string>;
  today: string;
  repository: ProjectRepository;
  projects: ProjectSummary[];
  loadArticles: (projectId: string) => Promise<StoredArticle[]>;
  articlesRevision: StoredArticle[];
  onOpenArticle: (article: StoredArticle) => Promise<void>;
  initialProjectId?: string | null;
  asabaAdjustment?: AsabaAdjustmentRequest | null;
  onConsumeAsabaAdjustment: (id: string) => void;
  onArchiveWorker: (request: WorkerArchive) => Promise<void>;
  onAskAsaba: (id: string, milestoneId?: string | null) => void;
  askProjectDecision: AskProjectDecision;
  onProjectsChange: () => Promise<ProjectSummary[]>;
  /** 用户从项目详情返回项目大厅时通知父组件，用于清除外部传入的 initialProjectId。 */
  onBackToHall?: () => void;
  onRemoveTask?: (task: ProjectTask) => Promise<void>;
  onOpenTask: (taskId: string) => void;
  onCompleteTask: (task: ProjectTask) => Promise<boolean>;
  onEditingStateChange?: (editing: boolean) => void;
};

type WorkspaceDraft = {
  project: Project;
  milestones: Milestone[];
  task: ProjectTask;
  recordGoalChange: boolean;
};

const statusLabels: Record<ProjectStatus, string> = {
  active: "正在推进",
  paused: "已暂停",
  completed: "已完成",
};

const taskStatusLabels: Record<ProjectTaskStatus, string> = {
  next: "下一步",
  waiting: "等待中",
  later: "稍后",
  done: "已完成",
  cancelled: "已取消",
};

const proposalStatusLabels: Record<ProposalStatus, string> = {
  pending: "待评审",
  experiment: "先小范围尝试",
  accepted: "决定采纳",
  deferred: "暂缓",
  rejected: "不采纳",
};

const planningModeLabels: Record<ProjectPlanningMode, string> = {
  direct: "直接推进",
  staged: "按阶段推进",
  adaptive: "滚动推进",
};

export function ProjectWorkspace({
  onCreateWeek,
  onContinueWeek,
  onChangeWeek,
  weekRevision,
  plannedDates,
  today,
  repository,
  projects,
  loadArticles,
  articlesRevision,
  onOpenArticle,
  initialProjectId,
  asabaAdjustment,
  onConsumeAsabaAdjustment,
  onProjectsChange,
  onArchiveWorker,
  onAskAsaba,
  askProjectDecision,
  onBackToHall,
  onRemoveTask,
  onOpenTask,
  onCompleteTask,
  onEditingStateChange,
}: ProjectWorkspaceProps) {
  const confirm = useConfirmDialog();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const lastInitialProjectId = useRef<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ProjectStatus>("active");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [draft, setDraft] = useState<WorkspaceDraft | null>(null);
  const [logText, setLogText] = useState("");
  const [tab, setTab] = useState<ProjectTab>("overview");
  const [message, setMessage] = useState("");

  const visibleProjects = useMemo(() => filterProjects(projects, statusFilter, query, tagFilter), [projects, statusFilter, query, tagFilter]);
  const allTags = useMemo(() => normalizeProjectTags(projects.flatMap((project) => project.tags ?? [])), [projects]);
  const projectCounts = projectStatusCounts(projects);

  useEffect(() => {
    onEditingStateChange?.(editing);
  }, [editing, onEditingStateChange]);

  useEffect(() => () => onEditingStateChange?.(false), [onEditingStateChange]);

  useEffect(() => {
    if (!editing || !draftDirty) return;
    const preventClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventClose);
    return () => window.removeEventListener("beforeunload", preventClose);
  }, [draftDirty, editing]);

  useEffect(() => {
    if (!projects.length) {
      setSelectedId(null);
      setDetail(null);
      return;
    }
    if (asabaAdjustment && projects.some(project => project.id === asabaAdjustment.projectId)) {
      lastInitialProjectId.current = asabaAdjustment.projectId;
      setSelectedId(asabaAdjustment.projectId);
      setTab("planning");
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
  }, [asabaAdjustment, initialProjectId, projects, selectedId]);

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
  }, [repository, selectedId, weekRevision]);

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
        planningMode: "direct",
        category: "uncategorized",
        sortOrder: (projects.length + 1) * 10,
        isDraft: false,
        sourceNote: "本人创建",
        targetDate: "",
        reviewDate: "",
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      milestones: [],
      task: emptyTask("", "", now),
      recordGoalChange: false,
    });
    setDraftDirty(false);
    setEditing(true);
  }

  function startEditing() {
    if (!detail) return;
    setDraft({
      project: { ...detail.project },
      milestones: [],
      task: emptyTask(detail.project.id, "", new Date().toISOString()),
      recordGoalChange: false,
    });
    setDraftDirty(false);
    setEditing(true);
  }

  async function cancelEditing() {
    if (draftDirty && !await confirm({
      title: "放弃未保存的项目修改？",
      description: "当前编辑内容尚未保存，放弃后无法恢复。",
      confirmLabel: "放弃修改",
      tone: "danger",
    })) return;
    setDraftDirty(false);
    setEditing(false);
    setDraft(null);
  }

  async function saveDraft() {
    if (!draft || !draft.project.title.trim() || !draft.project.outcome.trim()) {
      showMessage("请先填写项目名称和期望结果。");
      return;
    }
    setSaving(true);
    try {
      const project = draft.project.id
        ? await repository.saveProject(draft.project, draft.recordGoalChange)
        : await repository.saveWorkspace(draft.project, draft.milestones, draft.task.title.trim() ? draft.task : null);
      setDraftDirty(false);
      setEditing(false);
      setDraft(null);
      await reload(project.id);
      showMessage("项目内容已经保存。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "项目保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function createStandaloneFromAi(proposal: ProjectCreationProposal) {
    const action = proposal.firstAction;
    if (!action.title.trim()) {
      showMessage("AI 草案中的行动信息不完整，请先编辑后再确认。");
      return false;
    }
    setSaving(true);
    try {
      const now = new Date().toISOString();
      await repository.saveTask({
        id: "",
        projectId: null,
        milestoneId: null,
        direction: action.direction,
        title: action.title,
        actionType: "organize",
        definitionOfDone: action.definitionOfDone,
        steps: [],
        currentFocus: action.currentFocus,
        details: action.details,
        benefit: "",
        dueDate: action.dueDate,
        dueDateKind: "target",
        status: "next",
        waitingFor: "",
        resumeAction: "",
        context: "anywhere",
        sortOrder: 10,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      });
      setEditing(false);
      setDraftDirty(false);
      setDraft(null);
      await onProjectsChange();
      showMessage("已按确认的 AI 草案创建为独立行动。");
      return true;
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "独立行动创建失败");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function applyAiAdjustment(adjustment: ProjectAdjustmentDraft) {
    setSaving(true);
    try {
      await repository.applyProjectAdjustment(adjustment);
      await reload(adjustment.projectId);
      showMessage("已应用勾选的计划调整，旧路线保留在调整记录中。");
      return true;
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "计划调整应用失败");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function applyAiRoute(route: ProjectRouteDraft) {
    setSaving(true);
    try {
      await repository.applyProjectRoute(route);
      await reload(route.projectId);
      showMessage("主线草案已经应用，完成历史与被替代路线均已保留。");
      return true;
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "主线草案应用失败");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function deleteCurrentProject() {
    if (!detail) return;
    const branchCount = projects.filter((project) => project.parentProjectId === detail.project.id).length;
    const consequence = branchCount ? `${branchCount} 个子项目将转为独立项目，保留其内容和关联。` : "";
    if (!await confirm({ title: `永久删除“${detail.project.title}”？`, description: `将删除本项目及其阶段、行动和记录。关联文章会解除关联。${consequence}`, confirmLabel: "永久删除项目", tone: "danger" })) return;
    setSaving(true);
    try {
      const parentProjectId = detail.project.parentProjectId;
      await repository.removeProject(detail.project.id);
      const nextProjects = await onProjectsChange();
      setEditing(false);
      setDraftDirty(false);
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

  async function changeProjectCompletion() {
    if (!detail) return;
    const { project, milestones, tasks } = detail;
    const completing = project.status !== "completed";
    const activeMilestones = milestones.filter((item) => item.status !== "superseded");
    const incompleteMilestones = activeMilestones.filter((item) => item.status !== "completed").length;
    const activeTasks = tasks.filter((item) => item.status !== "cancelled");
    const unfinishedTasks = activeTasks.filter((item) => item.status !== "done").length;
    const subject = project.parentProjectId ? "支线" : "项目";
    const accepted = await confirm({
      title: completing ? `完结${subject}“${project.title}”？` : `重新开启${subject}“${project.title}”？`,
      description: completing ? <div className="project-completion-confirm">
        <p>这会把它移入“已完成”，并保留全部阶段、行动、提案和记录。</p>
        <div><span><b>{activeMilestones.length - incompleteMilestones}</b>/{activeMilestones.length || 0} 个节点完成</span><span><b>{activeTasks.length - unfinishedTasks}</b>/{activeTasks.length || 0} 项行动完成</span></div>
        {(incompleteMilestones > 0 || unfinishedTasks > 0) && <small>仍有 {incompleteMilestones} 个阶段、{unfinishedTasks} 项行动未完成；它们会保留原状态，方便以后回看。</small>}
      </div> : <p>项目会回到“正在推进”，原有路线和行动保持不变。</p>,
      confirmLabel: completing ? `完结${subject}` : `重新开启${subject}`,
      cancelLabel: completing ? "继续推进" : "取消",
      tone: "warning",
    });
    if (!accepted) return;
    setSaving(true);
    try {
      await repository.updateProjectStatus(
        project.id,
        completing ? "completed" : "active",
        `${completing ? "完结" : "重新开启"}${subject}：${project.title}`,
      );
      await reload(project.id);
      showMessage(completing ? `${subject}已经完结，成果与轨迹都已保留。` : `${subject}已经重新开始推进。`);
    } catch (error) {
      showMessage(error instanceof Error ? error.message : `${subject}状态更新失败`);
    } finally {
      setSaving(false);
    }
  }

  async function changeTaskStatus(task: ProjectTask, status: ProjectTaskStatus) {
    setSaving(true);
    try {
      if (status === "done") {
        if (!await onCompleteTask(task)) return;
      } else {
        await repository.updateTaskStatus(task.id, status);
        showMessage("下一步已经更新。");
      }
      await reload(task.projectId);
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "行动更新失败");
    } finally {
      setSaving(false);
    }
  }

  async function saveCurrentAction(task: ProjectTask) {
    if (!detail || !task.title.trim()) return false;
    setSaving(true);
    try {
      await repository.saveTask({ ...task, projectId: detail.project.id, status: "next" });
      await reload(detail.project.id);
      showMessage("当前行动已经安排。");
      return true;
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "行动保存失败");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function removeCurrentTask(task: ProjectTask) {
    if (!onRemoveTask) return;
    await onRemoveTask(task);
    await reload(task.projectId);
  }

  async function addProgress(event: FormEvent, kind: "continuation" | "general" = "general", target?: { id: string; title: string }) {
    event.preventDefault();
    if (!detail || !logText.trim()) return;
    setSaving(true);
    try {
      const currentMilestone = detail.milestones.find((item) => item.status === "current") ?? null;
      const currentTask = detail.tasks.find((item) => item.status === "next" && (!currentMilestone || item.milestoneId === currentMilestone.id))
        ?? detail.tasks.find((item) => item.status === "waiting" && (!currentMilestone || item.milestoneId === currentMilestone.id))
        ?? null;
      const body = kind === "continuation"
        ? encodeContinuationLog(target?.id || currentTask?.id || currentMilestone?.id || detail.project.id, target?.title || currentTask?.title || currentMilestone?.title || detail.project.title, logText)
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

  async function saveMilestone(milestone: Milestone, useDependencies = false) {
    if (!detail) return false;
    setSaving(true);
    try {
      await repository.saveMilestone({ ...milestone, projectId: detail.project.id }, useDependencies);
      await reload(detail.project.id);
      showMessage("里程碑已保存。");
      return true;
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "阶段保存失败");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function completeMilestone(milestone: Milestone) {
    if (!detail || milestone.status === "completed") return;
    const linkedTasks = detail.tasks.filter((task) => task.milestoneId === milestone.id);
    const unfinishedTasks = linkedTasks.filter((task) => task.status !== "done" && task.status !== "cancelled");
    const ordered = detail.milestones.filter((item) => item.status !== "superseded").sort((left, right) => left.sortOrder - right.sortOrder);
    const currentIndex = ordered.findIndex((item) => item.id === milestone.id);
    const nextMilestone = ordered.slice(currentIndex + 1).find((item) => item.status === "planned") ?? null;
    const accepted = await confirm({
      title: `完成阶段“${milestone.title}”？`,
      description: <div className="milestone-completion-confirm">
        <p><b>完成标准</b>{milestone.definitionOfDone || "这个阶段尚未填写完成标准，请根据实际结果确认。"}</p>
        {unfinishedTasks.length > 0 && <small>仍有 {unfinishedTasks.length} 项行动未完成，它们会保留在本阶段，不会被自动标记完成。</small>}
        <span>{detail.project.planningMode === "adaptive"
          ? "完成后其他并行检查点继续推进，候选节点仍由你决定何时开展。"
          : nextMilestone ? `完成后将自动进入下一阶段“${nextMilestone.title}”。` : "这是路线中的最后一个待推进阶段，完成后可以选择完结项目或继续添加阶段。"}</span>
      </div>,
      confirmLabel: "确认完成阶段",
      cancelLabel: "继续推进",
      tone: "warning",
    });
    if (!accepted) return;
    setSaving(true);
    try {
      const next = await repository.completeMilestone(milestone.id, `完成阶段：${milestone.title}`);
      await reload(detail.project.id);
      showMessage(next ? `阶段已完成，当前进入“${next.title}”。` : "阶段已完成，路线暂时没有下一阶段。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "阶段完成失败");
    } finally {
      setSaving(false);
    }
  }

  async function removeMilestone(milestone: Milestone) {
    if (!detail || !await confirm({ title: `删除阶段“${milestone.title}”？`, description: "关联行动会保留，但不再归属该阶段。", confirmLabel: "删除阶段", tone: "danger" })) return;
    setSaving(true);
    try {
      const replacement = detail.project.planningMode !== "adaptive" && milestone.status === "current"
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

  async function moveMilestone(milestone: Milestone, direction: -1 | 1) {
    if (!detail) return;
    const ordered = [...detail.milestones].sort((left, right) => left.sortOrder - right.sortOrder);
    const index = ordered.findIndex((item) => item.id === milestone.id);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= ordered.length) return;
    const target = ordered[targetIndex];
    setSaving(true);
    try {
      await repository.saveMilestone({ ...milestone, sortOrder: target.sortOrder });
      await repository.saveMilestone({ ...target, sortOrder: milestone.sortOrder });
      await reload(detail.project.id);
      showMessage("阶段顺序已经调整。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "阶段排序失败");
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

  async function removeProposal(proposal: ProjectProposal) {
    if (!await confirm({ title: `删除提案“${proposal.title}”？`, description: "这条提案及其评审结论将被永久删除。", confirmLabel: "删除提案", tone: "danger" })) return;
    setSaving(true);
    try {
      await repository.removeProposal(proposal.id);
      await reload(proposal.projectId);
      showMessage("提案已经删除。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "提案删除失败");
    } finally {
      setSaving(false);
    }
  }

  async function saveAccumulation(accumulation: ProjectAccumulation) {
    if (!detail) return false;
    setSaving(true);
    try {
      await repository.saveAccumulation({ ...accumulation, projectId: detail.project.id });
      await reload(detail.project.id);
      showMessage(accumulation.id ? "积累已经更新。" : "新的积累已经记下。");
      return true;
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "积累保存失败");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function removeAccumulation(accumulation: ProjectAccumulation) {
    if (!await confirm({ title: `删除积累“${accumulation.title}”？`, description: "这条已确认的项目事实将被永久删除，也不会再提供给 AI。", confirmLabel: "删除积累", tone: "danger" })) return;
    setSaving(true);
    try {
      await repository.removeAccumulation(accumulation.id);
      await reload(accumulation.projectId);
      showMessage("积累已经删除。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "积累删除失败");
    } finally {
      setSaving(false);
    }
  }

  return (
      <section className="project-workspace">
        {editing && draft ? (
          <ProjectEditor
            draft={draft}
            projects={projects}
            suggestedTags={normalizeProjectTags([...suggestedProjectTags, ...allTags])}
            saving={saving}
            onChange={(nextDraft) => { setDraft(nextDraft); setDraftDirty(true); }}
            onCancel={() => void cancelEditing()}
            onDelete={() => void deleteCurrentProject()}
            onSave={() => void saveDraft()}
            onCreateStandalone={(proposal) => createStandaloneFromAi(proposal)}
            onCreateWeek={() => onCreateWeek(startNewProject)}
          />
        ) : loading ? (
          <div className="project-loading">正在恢复项目上下文…</div>
        ) : detail ? (
          <ProjectPage
            key={detail.project.id}
            detail={detail}
            asabaAdjustment={asabaAdjustment?.projectId === detail.project.id ? asabaAdjustment : null}
            onConsumeAsabaAdjustment={onConsumeAsabaAdjustment}
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
            onArchiveWorker={onArchiveWorker}
            onAskAsaba={(milestoneId) => onAskAsaba(detail.project.id, milestoneId)}
            askProjectDecision={askProjectDecision}
            onComplete={() => void changeProjectCompletion()}
            loadArticles={loadArticles}
            articlesRevision={articlesRevision}
            onOpenArticle={onOpenArticle}
            onOpenProject={(projectId) => { setSelectedId(projectId); setEditing(false); setTab("overview"); }}
            onBack={() => {
              // 通知父组件清除 initialProjectId：否则 effect 会立刻用它重新选中该项目，
              // 造成“返回项目大厅”后又被拉回详情页（返回卡住）；
              // 清除后再次从外部打开同一项目也能正常触发。
              lastInitialProjectId.current = null;
              setSelectedId(null);
              setDetail(null);
              onBackToHall?.();
            }}
            onTaskStatus={(task, status) => void changeTaskStatus(task, status)}
            onOpenTask={onOpenTask}
            onSaveTask={saveCurrentAction}
            onSaveMilestone={saveMilestone}
            onCompleteMilestone={(milestone) => void completeMilestone(milestone)}
            onRemoveMilestone={(milestone) => void removeMilestone(milestone)}
            onMoveMilestone={(milestone, direction) => void moveMilestone(milestone, direction)}
            onSaveProposal={(proposal) => void saveProposal(proposal)}
            onReviewProposal={(proposal, status, note) => void reviewProposal(proposal, status, note)}
            onRemoveProposal={(proposal) => void removeProposal(proposal)}
            onSaveAccumulation={saveAccumulation}
            onRemoveAccumulation={(accumulation) => void removeAccumulation(accumulation)}
            onRemoveTask={(task) => void removeCurrentTask(task)}
            onApplyAiAdjustment={applyAiAdjustment}
            onRefreshForAdjustment={async () => {
              await repository.list();
              const refreshed = await repository.get(detail.project.id);
              if (!refreshed || refreshed.project.isDraft || refreshed.project.status !== "active") throw new Error("项目已不可调整。");
              setDetail(refreshed);
              return refreshed;
            }}
            onApplyAiRoute={applyAiRoute}
            onContinueWeek={() => onContinueWeek(detail.project.id)}
            onChangeWeek={onChangeWeek}
            plannedDates={plannedDates}
            today={today}
          />
        ) : (
          <div className="project-gallery workspace-scroll">
            <header className="workspace-page-heading project-gallery-heading">
              <h1>项目大厅</h1>
              <ThemeSticker section="projects" />
              <Button variant="secondary" type="button" onClick={startNewProject}>＋ 新建项目</Button>
            </header>
            <div className="project-gallery-controls">
              <nav aria-label="项目状态">
                {([ ["active", "进行中"], ["paused", "已暂停"], ["completed", "已完成"] ] as const).map(([value, label]) => <button className={statusFilter === value ? "active" : ""} key={value} onClick={() => setStatusFilter(value)}>{label} <span>{projectCounts[value]}</span></button>)}
              </nav>
              <div className="project-gallery-filters">
                {(allTags.length > 0 || tagFilter.length > 0) && <details className="project-tag-filter">
                  <summary>{tagFilter.length ? `标签 · ${tagFilter.length}` : "筛选标签"}</summary>
                  <div className="project-tag-options">{normalizeProjectTags([...allTags, ...tagFilter]).map((tag) =>
                    <label key={tag}><input type="checkbox" checked={tagFilter.includes(tag)} onChange={() => setTagFilter((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag])} />{tag}</label>
                  )}{tagFilter.length > 0 && <Button size="small" variant="ghost" onClick={() => setTagFilter([])}>清除</Button>}</div>
                </details>}
                <SearchField label="搜索项目" value={query} onChange={setQuery} placeholder="搜索项目" />
              </div>
            </div>
            <div className="project-gallery-grid" aria-live="polite">
              {visibleProjects.map((project) => {
                const parent = projects.find((candidate) => candidate.id === project.parentProjectId);
                const node = project.currentMilestone;
                const action = project.nextTask;
                const focus = node?.title || action?.title;
                return <button className="project-gallery-card" key={project.id} onClick={() => { setSelectedId(project.id); setEditing(false); setTab("overview"); }}>
                  <header><span className={`project-status ${project.status}`}>{project.isDraft ? "待确认" : statusLabels[project.status]}</span></header>
                  <div><h2>{project.title}</h2>{parent && <small>上级 · {parent.title}</small>}<p>{project.outcome}</p></div>
                  {(focus || project.status === "active") && <section><span>{node ? "当前里程碑" : action?.status === "waiting" ? "等待中" : "下一步"}</span><strong>{focus || "尚未安排"}</strong></section>}
                  {!!project.tags?.length && <footer className="project-tag-list">{project.tags.map((tag) => <span key={tag}>#{tag}</span>)}</footer>}
                </button>;
              })}
              {!visibleProjects.length && <div className="project-gallery-empty"><strong>{query ? "没有找到相关项目" : "这个分组还没有项目"}</strong><Button variant="primary" type="button" onClick={startNewProject}>创建项目</Button></div>}
            </div>
          </div>
        )}
        {message && <div className="desktop-toast" role="status">{message}</div>}
      </section>
  );
}

function ProjectPage({
  detail,
  asabaAdjustment,
  onConsumeAsabaAdjustment,
  loadArticles,
  articlesRevision,
  onOpenArticle,
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
  onArchiveWorker,
  onAskAsaba,
  askProjectDecision,
  onComplete,
  onOpenProject,
  onBack,
  onTaskStatus,
  onOpenTask,
  onSaveTask,
  onSaveMilestone,
  onCompleteMilestone,
  onRemoveMilestone,
  onMoveMilestone,
  onSaveProposal,
  onReviewProposal,
  onRemoveProposal,
  onSaveAccumulation,
  onRemoveAccumulation,
  onRemoveTask,
  onApplyAiAdjustment,
  onRefreshForAdjustment,
  onApplyAiRoute,
  onContinueWeek,
  onChangeWeek,
  plannedDates,
  today,
}: {
  detail: ProjectDetail;
  asabaAdjustment: AsabaAdjustmentRequest | null;
  onConsumeAsabaAdjustment: (id: string) => void;
  loadArticles: (projectId: string) => Promise<StoredArticle[]>;
  articlesRevision: StoredArticle[];
  onOpenArticle: (article: StoredArticle) => Promise<void>;
  branches: ProjectSummary[];
  parentProject: ProjectSummary | null;
  saving: boolean;
  tab: ProjectTab;
  onTabChange: (tab: ProjectTab) => void;
  logText: string;
  onLogTextChange: (value: string) => void;
  onAddProgress: (event: FormEvent, kind?: "continuation" | "general", target?: { id: string; title: string }) => void;
  onConfirm: () => void;
  onEdit: () => void;
  onArchiveWorker: (request: WorkerArchive) => Promise<void>;
  onAskAsaba: (milestoneId?: string | null) => void;
  askProjectDecision: AskProjectDecision;
  onComplete: () => void;
  onOpenProject: (projectId: string) => void;
  onBack: () => void;
  onTaskStatus: (task: ProjectTask, status: ProjectTaskStatus) => void;
  onOpenTask: (taskId: string) => void;
  onSaveTask: (task: ProjectTask) => Promise<boolean>;
  onSaveMilestone: (milestone: Milestone, useDependencies?: boolean) => Promise<boolean>;
  onCompleteMilestone: (milestone: Milestone) => void;
  onRemoveMilestone: (milestone: Milestone) => void;
  onMoveMilestone: (milestone: Milestone, direction: -1 | 1) => void;
  onSaveProposal: (proposal: ProjectProposal) => void;
  onReviewProposal: (proposal: ProjectProposal, status: ProposalStatus, reviewNote: string) => void;
  onRemoveProposal: (proposal: ProjectProposal) => void;
  onSaveAccumulation: (accumulation: ProjectAccumulation) => Promise<boolean>;
  onRemoveAccumulation: (accumulation: ProjectAccumulation) => void;
  onRemoveTask: (task: ProjectTask) => void;
  onApplyAiAdjustment: (adjustment: ProjectAdjustmentDraft) => Promise<boolean>;
  onRefreshForAdjustment: () => Promise<ProjectDetail>;
  onApplyAiRoute: (draft: ProjectRouteDraft) => Promise<boolean>;
  onContinueWeek: () => void;
  onChangeWeek: () => void;
  plannedDates: Record<string, string>;
  today: string;
}) {
  const { project, milestones, tasks, logs, proposals, accumulations } = detail;
  const [selectedMilestoneId, setSelectedMilestoneId] = useState<string | null>();
  const currentMilestones = milestones.filter((item) => item.status === "current");
  const currentMilestone = selectedMilestoneId === null ? null : milestones.find((item) => item.id === selectedMilestoneId && item.status !== "superseded") ?? currentMilestones[0] ?? null;
  const activeMilestones = milestones.filter((item) => item.status !== "superseded").sort((a, b) => a.sortOrder - b.sortOrder);
  const showGraph = tab === "dependencies" || (tab === "stages" && project.planningMode === "adaptive");
  const openTasks = tasks.filter((item) => item.status !== "done" && item.status !== "cancelled" && (item.milestoneId === (currentMilestone?.id ?? null) || !activeMilestones.length)).sort((left, right) => left.sortOrder - right.sortOrder);
  const nextTask = openTasks.find((item) => item.status === "next") ?? openTasks.find((item) => item.status === "later") ?? openTasks[0] ?? null;
  const continuationTargetId = nextTask?.id || currentMilestone?.id || project.id;
  const latestContinuation = logs.map((log) => ({ log, continuation: decodeContinuationLog(log.body) }))
    .find((entry) => entry.continuation?.targetId === continuationTargetId) ?? null;
  const upcoming = tasks.filter((task) => !["done", "cancelled", "waiting"].includes(task.status) && (plannedDates[task.id] || "") >= today)
    .sort((left, right) => plannedDates[left.id].localeCompare(plannedDates[right.id]) || left.sortOrder - right.sortOrder);
  const showActions = (milestoneId?: string | null) => { setSelectedMilestoneId(milestoneId); onLogTextChange(""); onTabChange("planning"); };

  return (
    <article className="project-page">
      <header className="project-toolbar">
        <div>
          <Button variant="ghost" type="button" className="project-back" onClick={onBack}>← 项目大厅</Button>
          <span className={"project-status " + project.status}>{project.isDraft ? "待确认" : statusLabels[project.status]}</span>
          {parentProject && <Button variant="ghost" size="small" onClick={() => onOpenProject(parentProject.id)}>上级 · {parentProject.title}</Button>}
        </div>
        <div>
          {project.status !== "completed" && !project.isDraft && <Button variant="ghost" size="small" onClick={() => onAskAsaba()}>问浅羽</Button>}
          {project.isDraft && <Button variant="primary" size="small" type="button" disabled={saving} onClick={onConfirm}>确认项目</Button>}
          <Button variant="ghost" size="small" type="button" onClick={onEdit}>编辑信息</Button>
          {!project.isDraft && <Button variant="secondary" size="small" disabled={saving} onClick={onComplete}>{project.status === "completed" ? "重新开启" : "完结项目"}</Button>}
        </div>
      </header>

      <div className={"project-page-scroll" + (showGraph ? " is-route-view" : "")}>
        <header className="project-hero project-hero-compact">
          <h1>{project.title}</h1>
          <p>{project.outcome}</p>
          <div className="project-hero-meta">
            {project.targetDate && project.targetDateKind && <time>{projectDateLabel(project.targetDate, project.targetDateKind).text}</time>}
            <div className="project-tag-list">{project.tags?.map((tag) => <span key={tag}>#{tag}</span>)}</div>
          </div>
        </header>
        <nav className="project-tabs" aria-label="项目视图">
          {([["overview", "概览"], ["planning", "路线与行动"], ["records", "资料与记录"]] as const).map(([value, label]) => {
            const active = tab === value || (value === "planning" && (tab === "stages" || tab === "dependencies"));
            return <button className={active ? "active" : ""} aria-current={active ? "page" : undefined} key={value} onClick={() => onTabChange(value)}>{label}</button>;
          })}
        </nav>
        {tab === "overview" && activeMilestones.length > 0 && <section className="project-overview-route workspace-card">
          <header><h2>里程碑路线</h2><Button variant="ghost" size="small" onClick={() => onTabChange("stages")}>完整路线</Button></header>
          <ol>{activeMilestones.map((node) => <li key={node.id} className={node.status}>
            <details><summary><small>{node.status === "completed" ? "已达成" : node.status === "current" ? "当前" : "后续"}</small><strong>{node.title}</strong></summary>
              <div className="project-node-preview">
                {node.dueDateKind && node.dueDate && <p>{projectDateLabel(node.dueDate, node.dueDateKind).text}</p>}
                {node.definitionOfDone && <p>{node.definitionOfDone}</p>}
                {tasks.filter((task) => task.milestoneId === node.id && task.status !== "cancelled").map((task) => <p key={task.id}>{task.title} · {taskStatusLabels[task.status]}</p>)}
                <Button variant="ghost" size="small" onClick={() => showActions(node.id)}>查看行动</Button>
              </div>
            </details>
          </li>)}</ol>
        </section>}
        {tab === "overview" && !!branches.length && <section className="project-children workspace-card">
          <h2>子项目</h2>
          {branches.map((child) => <Button variant="ghost" size="small" key={child.id} onClick={() => onOpenProject(child.id)}>{child.title} · {statusLabels[child.status]}</Button>)}
        </section>}

        {tab === "planning" && <section className="project-week-summary workspace-card">
          <div className="project-week-heading"><h2>行动安排</h2>
            <div><Button size="small" variant="secondary" onClick={() => onTabChange("stages")}>管理里程碑</Button>
              {project.status === "active" && !project.isDraft && <>
                <Button size="small" onClick={onContinueWeek}>安排未来 7 天</Button>
                <Button size="small" variant="secondary" onClick={onChangeWeek}>计划有变</Button>
              </>}
            </div>
          </div>
          {upcoming.length > 0 && <ul>{upcoming.map((task) => <li key={task.id}>{plannedDates[task.id]} · {task.title}</li>)}</ul>}
        </section>}

        {(tab === "planning" || (tab === "stages" && project.planningMode === "adaptive")) && (project.planningMode === "adaptive" || (project.status !== "completed" && !project.isDraft)) && <div className={tab === "stages" ? "project-route-assist-tools" : "project-planning-tools"}>{project.status === "active" && !project.isDraft && <ProjectAiPlanningPanel detail={detail} saving={saving} askProjectDecision={askProjectDecision} onApplyAdjustment={onApplyAiAdjustment} onRefreshDetail={onRefreshForAdjustment} asabaAdjustment={asabaAdjustment} onConsumeAsabaAdjustment={onConsumeAsabaAdjustment} />}{tab === "stages" && <ProjectRoutePlanningAssistant detail={detail} saving={saving} onApply={onApplyAiRoute} />}</div>}

        <ProjectRecent detail={detail} view={tab === "overview" ? "summary" : tab === "records" ? "records" : null} onArchive={onArchiveWorker}
          loadArticles={loadArticles} articlesRevision={articlesRevision} onOpenArticle={onOpenArticle} onOpenTask={onOpenTask} onPlan={showActions} onOpenRecords={() => onTabChange("records")} />

        {tab === "planning" && <>
          <ProjectBackground detail={detail} />
          {activeMilestones.length > 0 && <nav className="project-parallel-switcher" aria-label="行动范围">
            <Button variant={!currentMilestone ? "primary" : "secondary"} aria-pressed={!currentMilestone} onClick={() => showActions(null)}>项目行动</Button>
            {activeMilestones.map((item) => <Button key={item.id} variant={item.id === currentMilestone?.id ? "primary" : "secondary"} type="button" aria-pressed={item.id === currentMilestone?.id} onClick={() => showActions(item.id)}>{item.title}</Button>)}
          </nav>}
          <ProjectCurrentProgress key={currentMilestone?.id || project.id}
            detail={detail}
            project={project}
            milestones={milestones}
            currentMilestone={currentMilestone}
            nextTask={nextTask}
            recentTaskCompleted={logs.some((log) => log.kind === "task_completed" && Date.now() - new Date(log.createdAt).getTime() <= 24 * 60 * 60 * 1000)}
            otherTasks={openTasks.filter((task) => task.id !== nextTask?.id)}
            latestContinuation={latestContinuation}
            saving={saving}
            logText={logText}
            onLogTextChange={onLogTextChange}
            onAddContinuation={(event) => onAddProgress(event, "continuation", { id: continuationTargetId, title: nextTask?.title || currentMilestone?.title || project.title })}
            onTaskStatus={onTaskStatus}
            onAskAsaba={() => onAskAsaba(currentMilestone?.id ?? null)}
            onOpenTask={onOpenTask}
            onSaveTask={onSaveTask}
            onSaveMilestone={onSaveMilestone}
            onRemoveTask={onRemoveTask}
            onCompleteMilestone={onCompleteMilestone}
            onEditProject={onEdit}
            onOpenRoute={() => onTabChange("stages")}
          />
        </>}

        {(tab === "stages" || tab === "dependencies") && <>
          <div className="project-route-nav"><Button variant="ghost" size="small" onClick={() => onTabChange("planning")}>← 行动</Button>
            {!showGraph && activeMilestones.length > 0 && <Button variant="secondary" size="small" onClick={() => onTabChange("dependencies")}>编辑依赖与并行节点</Button>}
            {tab === "dependencies" && project.planningMode !== "adaptive" && <Button variant="secondary" size="small" onClick={() => onTabChange("stages")}>返回线性路线</Button>}
          </div>
          {showGraph ? <ProjectRouteGraph projectId={project.id} milestones={milestones} tasks={tasks} saving={saving}
            onSave={(node) => onSaveMilestone(node, true)} onComplete={onCompleteMilestone} onRemove={onRemoveMilestone}
            onFocus={(node) => showActions(node.id)} />
            : <StageRouteEditor projectId={project.id} planningMode={project.planningMode} milestones={milestones} tasks={tasks}
              saving={saving} onSave={onSaveMilestone} onComplete={onCompleteMilestone} onRemove={onRemoveMilestone} onMove={onMoveMilestone} />}
          {showGraph && <RetiredMilestones milestones={milestones} />}
        </>}
        {tab === "records" && <>
          <ProjectAccumulationBoard projectId={project.id} milestones={milestones} accumulations={accumulations} saving={saving} onSave={onSaveAccumulation} onRemove={onRemoveAccumulation} />
          <ProposalBoard projectId={project.id} proposals={proposals} saving={saving} onSave={onSaveProposal} onReview={onReviewProposal} onRemove={onRemoveProposal} />
        </>}
      </div>
    </article>
  );
}

function ProjectCurrentProgress({ detail, project, milestones, currentMilestone, nextTask, recentTaskCompleted, otherTasks, latestContinuation, saving, logText, onLogTextChange, onAddContinuation, onTaskStatus, onAskAsaba, onOpenTask, onSaveTask, onSaveMilestone, onRemoveTask, onCompleteMilestone, onEditProject, onOpenRoute }: {
  detail: ProjectDetail;
  project: Project;
  milestones: Milestone[];
  currentMilestone: Milestone | null;
  nextTask: ProjectTask | null;
  recentTaskCompleted: boolean;
  otherTasks: ProjectTask[];
  latestContinuation: { log: ProjectDetail["logs"][number]; continuation: ReturnType<typeof decodeContinuationLog> } | null;
  saving: boolean;
  logText: string;
  onLogTextChange: (value: string) => void;
  onAddContinuation: (event: FormEvent) => void;
  onAskAsaba: () => void;
  onTaskStatus: (task: ProjectTask, status: ProjectTaskStatus) => void;
  onOpenTask: (taskId: string) => void;
  onSaveTask: (task: ProjectTask) => Promise<boolean>;
  onSaveMilestone: (milestone: Milestone) => Promise<boolean>;
  onRemoveTask: (task: ProjectTask) => void;
  onCompleteMilestone: (milestone: Milestone) => void;
  onEditProject: () => void;
  onOpenRoute: () => void;
}) {
  const [editingAction, setEditingAction] = useState<ProjectTask | "new" | null>(null);
  const orderedMilestones = milestones.filter((milestone) => milestone.status !== "superseded").sort((left, right) => left.sortOrder - right.sortOrder);
  const currentIndex = currentMilestone ? orderedMilestones.findIndex((item) => item.id === currentMilestone.id) : -1;
  const routeComplete = orderedMilestones.length > 0 && !currentMilestone && orderedMilestones.every((milestone) => milestone.status === "completed");
  const routeWaiting = orderedMilestones.length > 0 && !orderedMilestones.some((item) => item.status === "current") && !currentMilestone && !routeComplete;
  const adaptive = project.planningMode === "adaptive";
  const today = localDate();
  const calibrationReasons = [
    currentMilestone?.dueDateKind === "deadline" && currentMilestone.dueDate && currentMilestone.dueDate < today ? "当前检查点已经逾期" : "",
    project.targetDateKind === "deadline" && project.targetDate && project.targetDate < today ? "项目硬截止日期已经逾期" : "",
    project.reviewDate && project.reviewDate <= today ? "已到下次校准日期" : "",
    adaptive && recentTaskCompleted ? "刚完成了一项当前行动" : "",
  ].filter(Boolean);
  return <section className="project-current-progress">
    {calibrationReasons.length > 0 && <aside className="adaptive-calibration-notice"><div><span>计划提醒</span><strong>{calibrationReasons.join("；")}</strong></div><Button variant="ghost" size="small" onClick={() => document.getElementById("project-ai-planning")?.scrollIntoView({ behavior: "smooth", block: "center" })}>报告变化 ↗</Button></aside>}
    <header className={`project-current-stage ${currentMilestone ? "has-stage" : routeComplete ? "route-complete" : routeWaiting ? "route-waiting" : "lightweight"}`}>
      <div><span>{currentMilestone ? milestoneStatusLabel(currentMilestone) : routeComplete ? "路线已完成" : routeWaiting ? "尚未选定当前里程碑" : "项目行动"}</span><h2>{currentMilestone?.title || project.title}</h2>{currentMilestone?.definitionOfDone && <p>{currentMilestone.definitionOfDone}</p>}</div>
      <nav className="project-stage-primary-actions" aria-label={adaptive ? "检查点操作" : "阶段操作"}>
        {project.status === "active" && <Button variant="ghost" size="small" onClick={onAskAsaba}>问浅羽</Button>}
        <Button variant="ghost" size="small" onClick={onOpenRoute}>{adaptive ? "查看任务分支 ↗" : currentIndex >= 0 ? `阶段路线 · ${currentIndex + 1}/${orderedMilestones.length} ↗` : routeComplete ? "查看已完成路线 ↗" : "添加阶段路线"}</Button>
        {currentMilestone?.status === "current" && <Button variant="secondary" size="small" disabled={saving} onClick={() => onCompleteMilestone(currentMilestone)}>完成里程碑</Button>}
      </nav>
      {currentMilestone && <StageDeadlineControls key={currentMilestone.id} milestone={currentMilestone} adaptive={adaptive} hasCurrentAction={Boolean(nextTask)} saving={saving} onSave={onSaveMilestone} />}
      {!currentMilestone && project.targetDate && project.status !== "completed" && <ProjectTargetDate dueDate={project.targetDate} kind={project.targetDateKind} saving={saving} onAdjust={onEditProject} />}
    </header>
    <div className="project-focus-grid">
      <article className={`project-current-action ${nextTask ? "has-action" : "empty"}`}>
        <header><div><span>当前行动</span><small>{projectProgress({ ...project, nextTask })}</small></div>{!nextTask && !editingAction && <Button variant="primary" size="small" disabled={saving} onClick={() => setEditingAction("new")}>＋ 安排行动</Button>}{nextTask && (nextTask.status !== "next" || nextTask.dueDate) && <em>{nextTask.status !== "next" ? taskStatusLabels[nextTask.status] : ""}{nextTask.status !== "next" && nextTask.dueDate ? " · " : ""}{projectDateLabel(nextTask.dueDate, nextTask.dueDateKind).text}</em>}</header>
        {nextTask && editingAction !== nextTask ? <div className="project-current-action-row">
          <ProjectActionStructure task={nextTask} saving={saving} onSave={onSaveTask} />
          <div className="project-action-buttons"><Button variant="primary" size="small" onClick={() => onOpenTask(nextTask.id)}>在行动中打开</Button><Button variant="secondary" size="small" disabled={saving} onClick={() => onTaskStatus(nextTask, "done")}>完成行动</Button><Button variant="secondary" size="small" disabled={saving} onClick={() => setEditingAction(nextTask)}>编辑行动</Button>{nextTask.status !== "next" && <Button variant="secondary" size="small" disabled={saving} onClick={() => onTaskStatus(nextTask, "next")}>设为当前</Button>}<details className="project-action-more"><summary>更多操作</summary><Button variant="danger" size="small" disabled={saving} onClick={() => onRemoveTask(nextTask)}>删除行动</Button></details></div>
        </div> : editingAction ? <InlineActionComposer key={editingAction === "new" ? "new" : editingAction.id} detail={detail} projectId={project.id} milestone={currentMilestone} initialTask={editingAction === "new" ? undefined : editingAction} saving={saving} onCancel={() => setEditingAction(null)} onSave={onSaveTask} /> : <p className="project-current-action-empty">还没有当前行动，可添加一个具体的下一步。</p>}
      </article>
      <section className="project-continuation-card">
        <header><div><span>接续记录</span><h3>为下一次打开留下起点</h3></div>{latestContinuation?.continuation && <time>{formatProjectDate(latestContinuation.log.createdAt)}</time>}</header>
        {latestContinuation?.continuation ? <div className="continuation-latest"><small>上次做到</small><p>{latestContinuation.continuation.text}</p></div> : <p className="project-continuation-empty">离开项目前记下一句话，下次无需重新回忆上下文。</p>}
        <form onSubmit={onAddContinuation}><textarea rows={3} aria-label="项目接续记录" value={logText} onChange={(event) => onLogTextChange(event.target.value)} placeholder="今天做到哪里了？下一次从哪里继续？" /><div className="project-continuation-actions"><Button variant="primary" size="small" disabled={saving || !logText.trim()} type="submit">保存接续点</Button></div></form>
      </section>
    </div>
    {otherTasks.length > 0 && <details className="project-other-actions"><summary>本阶段还有 {otherTasks.length} 项行动</summary>{otherTasks.map((task) => <div key={task.id}><span>{taskStatusLabels[task.status]}</span><Button variant="ghost" wrap onClick={() => onOpenTask(task.id)}>{projectTaskDisplayTitle(task)}</Button><Button variant="danger" disabled={saving} onClick={() => onRemoveTask(task)}>删除</Button>{task.status !== "next" && <Button variant="secondary" type="button" disabled={saving} onClick={() => onTaskStatus(task, "next")}>设为下一步</Button>}</div>)}</details>}
  </section>;
}


function ProjectActionStructure({ task, saving, onSave }: {
  task: ProjectTask;
  saving: boolean;
  onSave: (task: ProjectTask) => Promise<boolean>;
}) {
  async function toggleStep(stepId: string) {
    if (saving) return;
    await onSave({
      ...task,
      steps: task.steps.map((step) => step.id === stepId ? { ...step, completed: !step.completed } : step),
    });
  }
  return <div className="project-action-structure">
    <h3>{projectTaskDisplayTitle(task)}</h3>
    {task.currentFocus && <section className="project-action-focus"><span>本次推进</span><strong>{task.currentFocus}</strong></section>}
    {task.definitionOfDone && <section className="project-action-done"><span>完成标志</span><p>{task.definitionOfDone}</p></section>}
    <ActionChecklist steps={task.steps} onToggle={(stepId) => void toggleStep(stepId)} />
    {(task.details || task.waitingFor || task.resumeAction) && <details className="project-action-details"><summary>补充说明</summary>{task.details && <p>{task.details}</p>}{task.waitingFor && <small>正在等待 · {task.waitingFor}</small>}{task.resumeAction && <small>恢复条件 · {task.resumeAction}</small>}</details>}
  </div>;
}

function InlineActionComposer({ detail, projectId, milestone, initialTask, saving, tone = "main", onCancel, onSave }: {
  detail: ProjectDetail;
  projectId: string;
  milestone: Milestone | null;
  initialTask?: ProjectTask;
  saving: boolean;
  tone?: "main" | "branch";
  onCancel: () => void;
  onSave: (task: ProjectTask) => Promise<boolean>;
}) {
  const [task, setTask] = useState(() => initialTask ? { ...initialTask, steps: initialTask.steps.map((step) => ({ ...step })) } : emptyTask(projectId, milestone?.id || "", new Date().toISOString()));
  const update = <Key extends keyof ProjectTask>(key: Key, value: ProjectTask[Key]) => setTask((current) => ({ ...current, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!task.title.trim()) return;
    if (await onSave({ ...task, projectId, milestoneId: milestone?.id || null })) onCancel();
  }
  return <form className={`inline-action-composer ${tone}`} onSubmit={(event) => void submit(event)}>
    <header><div><strong>{initialTask ? "编辑当前行动" : "安排当前行动"}</strong><small>{milestone ? `关联至「${milestone.title}」` : "归入当前项目"}</small></div><Button variant="secondary" size="small" iconOnly type="button" aria-label="收起行动编辑器" onClick={onCancel}>×</Button></header>
    <div className="inline-action-fields">
      <label className="inline-action-title"><span>行动名称 <b>必填</b></span><input autoFocus value={task.title} onChange={(event) => update("title", event.target.value)} placeholder="例如：精读论文并形成一页方法笔记" /></label>
      <ProjectDateField className="inline-action-date" label="行动日期" value={task.dueDate} kind={task.dueDateKind} onChange={(dueDate, dueDateKind) => setTask((current) => ({ ...current, dueDate, dueDateKind, autoSchedulePaused: false }))} />
      <ActionEstimateField dateKind={task.dueDateKind} dueDate={scheduledProjectDate(task.dueDate, task.dueDateKind)} estimatedDays={task.estimatedDays || 0} title={task.title} currentFocus={task.currentFocus} definitionOfDone={task.definitionOfDone} steps={task.steps} details={task.details} projectTitle={detail.project.title} stageTitle={milestone?.title || ""} onChange={(days) => update("estimatedDays", days)} />
      <ActionOptionalFields hasContent={Boolean(task.currentFocus || task.definitionOfDone || task.steps.length || task.details)}>
      <label className="inline-action-focus"><span>本次推进 · 可选</span><textarea value={task.currentFocus} onChange={(event) => update("currentFocus", event.target.value)} placeholder="名称已说清要做什么时，可以留空" /></label>
      <label className="inline-action-done"><span>完成标志 · 可选</span><textarea value={task.definitionOfDone} onChange={(event) => update("definitionOfDone", event.target.value)} placeholder="需要额外约定停止条件时再填写" /></label>
      <ActionStepEditor steps={task.steps} onChange={(steps) => update("steps", steps)} />
      <label className="inline-action-details"><span>补充说明 <em>可选</em></span><textarea value={task.details} onChange={(event) => update("details", event.target.value)} placeholder="记录资料位置、注意事项，或真正开始时容易忘记的上下文。" /></label>
      </ActionOptionalFields>
    </div>
    <footer><Button variant="secondary" type="button" disabled={saving} onClick={onCancel}>取消</Button><Button variant="primary" disabled={saving || !task.title.trim()} type="submit">{saving ? "正在保存…" : "保存行动"}</Button></footer>
  </form>;
}

function ProjectBackground({ detail }: { detail: ProjectDetail }) {
  const { project } = detail;
  return <details className="project-background-panel">
    <summary><span><b>项目背景</b><small>为什么做，以及创建来源等低频信息</small></span><em>展开</em></summary>
    <div>
      <section><span>为什么值得做</span><p>{project.motivation || "还没有记录这个项目为什么值得投入。"}</p></section>
      <aside><span><b>创建来源</b>{project.sourceNote || "本人创建"}</span><span><b>创建时间</b>{formatProjectDate(project.createdAt)}</span><span><b>最近更新</b>{formatProjectDate(project.updatedAt)}</span></aside>
    </div>
  </details>;
}

function StageRouteEditor({ projectId, planningMode, milestones, tasks, saving, onSave, onComplete, onRemove, onMove }: { projectId: string; planningMode: ProjectPlanningMode; milestones: Milestone[]; tasks: ProjectTask[]; saving: boolean; onSave: (milestone: Milestone) => Promise<boolean>; onComplete: (milestone: Milestone) => void; onRemove: (milestone: Milestone) => void; onMove: (milestone: Milestone, direction: -1 | 1) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Milestone | null>(null);
  const orderedMilestones = milestones.filter((milestone) => milestone.status !== "superseded").sort((left, right) => left.sortOrder - right.sortOrder);
  function closeEditor() { setDraft(null); setEditingId(null); }
  function edit(item?: Milestone) {
    const nextEditingId = item?.id || "new";
    if (editingId === nextEditingId) {
      closeEditor();
      return;
    }
    const now = new Date().toISOString();
    const next = item ? { ...item } : { ...emptyMilestone(projectId, now), status: orderedMilestones.some((node) => node.status === "current") ? "planned" as const : "current" as const, sortOrder: Math.max(0, ...milestones.map((node) => node.sortOrder)) + 10 };
    setDraft(next);
    setEditingId(nextEditingId);
  }
  async function submit(event: FormEvent) { event.preventDefault(); if (draft?.title.trim() && await onSave(draft)) closeEditor(); }
  function editorPanel(index: number) {
    if (!draft) return null;
    const isNew = editingId === "new";
    return <section className="stage-editor-panel">
      <header><div><span>{isNew ? planningMode === "adaptive" ? "新候选节点" : "新阶段" : planningMode === "adaptive" ? "编辑检查点" : "编辑阶段"}</span><strong>{isNew ? "为路线补充下一站" : draft.title || "未命名节点"}</strong><p>{planningMode === "adaptive" ? "将状态设为当前检查点即可并行开展，不会暂停其他检查点；未来节点保留方向即可。" : "阶段名称说明要抵达哪里，完成标准说明满足什么条件才算通过。"}</p></div><Button variant="secondary" type="button" onClick={closeEditor}>× 收起编辑</Button></header>
      <StageInlineForm
        draft={draft}
        saving={saving}
        onChange={setDraft}
        onCancel={closeEditor}
        onRemove={isNew ? undefined : () => { onRemove(draft); closeEditor(); }}
        canMoveUp={!isNew && index > 0}
        canMoveDown={!isNew && index < orderedMilestones.length - 1}
        onMove={isNew ? undefined : (direction) => { onMove(draft, direction); closeEditor(); }}
        onSubmit={submit}
        planningMode={planningMode}
      />
    </section>;
  }
  return <section className="project-stage-overview stage-route-page">
    <header><h2>里程碑路线</h2><Button variant="secondary" type="button" aria-expanded={editingId === "new"} onClick={() => edit()}>{editingId === "new" ? "收起编辑" : "＋ 添加里程碑"}</Button></header>
    {editingId === "new" && editorPanel(orderedMilestones.length)}
    <div className="project-stage-vertical">{orderedMilestones.map((milestone, index) => {
      const stageTasks = tasks.filter((task) => task.milestoneId === milestone.id);
      const isEditing = editingId === milestone.id;
      const hasNextPlanned = orderedMilestones.slice(index + 1).some((item) => item.status === "planned");
      return <article className={`project-stage-node ${milestone.status} ${isEditing ? "editing" : ""}`} key={milestone.id}>
        <button aria-expanded={isEditing} className="stage-node-button" onClick={() => edit(milestone)}><i>{milestone.status === "completed" ? "✓" : index + 1}</i><span><small>{milestone.status === "current" ? planningMode === "adaptive" ? "当前检查点" : "当前阶段" : milestone.status === "completed" ? "已完成" : planningMode === "adaptive" ? "候选节点" : "待开始"}</small><strong>{milestone.title}</strong><em>{stageTasks.filter((task) => task.status === "done").length}/{stageTasks.filter((task) => task.status !== "cancelled").length} 行动{milestone.dueDate ? ` · ${projectDateLabel(milestone.dueDate, milestone.dueDateKind).text}` : ""}</em></span><b className="stage-node-toggle">{isEditing ? "收起" : "编辑"}</b></button>
        {milestone.status === "current" && !isEditing && <Button variant="secondary" className="stage-node-complete" disabled={saving} onClick={() => onComplete(milestone)}>✓ {hasNextPlanned ? planningMode === "adaptive" ? "完成此检查点" : "完成并进入下一阶段" : planningMode === "adaptive" ? "完成检查点" : "完成阶段"}</Button>}
        {isEditing && editorPanel(index)}
      </article>;
    })}</div>
    <RetiredMilestones milestones={milestones} />
  </section>;
}

function RetiredMilestones({ milestones }: { milestones: Milestone[] }) {
  const retired = milestones.filter((node) => node.status === "superseded").sort((a, b) => a.sortOrder - b.sortOrder);
  return retired.length ? <details className="project-retired-route"><summary>已替代的里程碑（{retired.length}）</summary>
    {retired.map((node) => <article key={node.id}><strong>{node.title}</strong>{node.definitionOfDone && <p>{node.definitionOfDone}</p>}</article>)}
  </details> : null;
}

function StageInlineForm({ draft, saving, onChange, onCancel, onRemove, canMoveUp = false, canMoveDown = false, onMove, onSubmit, planningMode = "staged" }: { draft: Milestone; saving: boolean; onChange: (draft: Milestone) => void; onCancel: () => void; onRemove?: () => void; canMoveUp?: boolean; canMoveDown?: boolean; onMove?: (direction: -1 | 1) => void; onSubmit: (event: FormEvent) => void; planningMode?: ProjectPlanningMode }) {
  const statusOptions: Array<{ value: Milestone["status"]; label: string; description: string }> = [
    { value: "planned", label: planningMode === "adaptive" ? "候选节点" : "待开始", description: planningMode === "adaptive" ? "仅保留粗略方向" : "保留在后续路线中" },
    { value: "current", label: planningMode === "adaptive" ? "当前检查点" : "当前阶段", description: "项目此刻正在推进" },
    ...(draft.status === "completed" ? [{ value: "completed" as const, label: "已完成", description: "这个阶段已经验收" }] : []),
  ];
  return <form className="stage-inline-form" onSubmit={onSubmit}>
    <div className="stage-form-fields">
      <label className="stage-form-field stage-form-field-wide"><span>阶段名称<small>用一句短语描述这一站要抵达的结果</small></span><input autoFocus value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} placeholder="例如：完成第一轮真实使用验证" /></label>
      <label className="stage-form-field stage-form-field-wide"><span>完成标准<small>写清楚什么证据出现后，可以把阶段标记为完成</small></span><textarea value={draft.definitionOfDone} onChange={(event) => onChange({ ...draft, definitionOfDone: event.target.value })} placeholder="例如：连续使用两周，完成主要问题清单并确定下一轮调整范围" /></label>
      <fieldset className="stage-status-field"><legend>阶段状态</legend><p>状态会决定它在路线中的强调方式。</p><div>{statusOptions.map((option) => <button className={draft.status === option.value ? "active" : ""} key={option.value} type="button" onClick={() => onChange({ ...draft, status: option.value })}><strong>{option.label}</strong><small>{option.description}</small></button>)}</div></fieldset>
      <ProjectDateField className="stage-form-field stage-date-field" label="节点日期" value={draft.dueDate} kind={draft.dueDateKind} onChange={(dueDate, dueDateKind) => onChange({ ...draft, dueDate, dueDateKind })} />
    </div>
    <footer><div className="stage-editor-structural-actions">{onMove && <><Button variant="secondary" type="button" disabled={!canMoveUp || saving} onClick={() => onMove(-1)}>↑ 上移</Button><Button variant="secondary" type="button" disabled={!canMoveDown || saving} onClick={() => onMove(1)}>↓ 下移</Button></>}{onRemove && <Button variant="danger" type="button" onClick={onRemove}>删除阶段</Button>}</div><span /><Button variant="secondary" type="button" onClick={onCancel}>收起</Button><Button variant="primary" type="submit" disabled={saving || !draft.title.trim()}>保存阶段</Button></footer>
  </form>;
}

function ProjectAccumulationBoard({ projectId, milestones, accumulations, saving, onSave, onRemove }: {
  projectId: string;
  milestones: Milestone[];
  accumulations: ProjectAccumulation[];
  saving: boolean;
  onSave: (accumulation: ProjectAccumulation) => Promise<boolean>;
  onRemove: (accumulation: ProjectAccumulation) => void;
}) {
  const [draft, setDraft] = useState<ProjectAccumulation | null>(null);
  const activeMilestones = milestones.filter((item) => item.status !== "superseded");
  const startNew = () => setDraft(emptyAccumulation(projectId));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || (!draft.title.trim() && !draft.content.trim())) return;
    if (await onSave(draft)) setDraft(null);
  }
  return <section className="project-accumulation-board">
    <header><h2>成果与积累</h2><Button variant="primary" type="button" disabled={Boolean(draft)} onClick={startNew}>＋ 添加记录</Button></header>
    {draft && <form className="project-accumulation-form" onSubmit={(event) => void submit(event)}>
      <header><div><strong>{draft.id ? "编辑这张便签" : "贴一张积累便签"}</strong><small>随手写下已经留下的东西，不需要整理成固定格式</small></div><Button variant="ghost" type="button" onClick={() => setDraft(null)}>关闭</Button></header>
      <label><span>小标题 · 可选</span><input autoFocus value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="例如：第一次真实使用后的发现" /></label>
      <label><span>写点什么</span><textarea className="project-accumulation-content" value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} placeholder="论文读到哪里、试过什么、冒出的想法、得到的结果、做出的决定……都可以直接写在这里。" /></label>
      <label><span>贴到哪里 · 可选</span><SelectMenu label="积累关联范围" value={draft.milestoneId || ""} onChange={(value) => setDraft({ ...draft, milestoneId: value || null })} options={[{ value: "", label: "整个项目都能看到" }, ...activeMilestones.map((item) => ({ value: item.id, label: `${item.status === "completed" ? "已完成" : item.status === "current" ? "当前" : "候选"} · ${item.title}` }))]} /></label>
      <label><span>参考链接或文件位置 · 可选</span><input value={draft.reference} onChange={(event) => setDraft({ ...draft, reference: event.target.value })} placeholder="DOI、网页、笔记或实验结果路径" /></label>
      <label className="project-inline-check"><input type="checkbox" checked={!!draft.isOutcome} onChange={(event) => setDraft({ ...draft, isOutcome: event.target.checked })} />标为已确认成果</label>
      <footer><small>标题和正文任意写一个即可。</small><div><Button variant="secondary" type="button" disabled={saving} onClick={() => setDraft(null)}>取消</Button><Button variant="primary" type="submit" disabled={saving || (!draft.title.trim() && !draft.content.trim())}>{saving ? "正在保存…" : "贴上便签"}</Button></div></footer>
    </form>}
    <div className="project-accumulation-list">{accumulations.length ? accumulations.map((item) => {
      const milestone = milestones.find((candidate) => candidate.id === item.milestoneId);
      return <article key={item.id}><i className="project-accumulation-pin" aria-hidden="true" /><header><em>{item.isOutcome ? "已确认成果" : "积累"}{milestone && " · " + milestone.title}</em><time>{formatProjectDate(item.updatedAt)}</time></header>{item.title && <h3>{item.title}</h3>}{item.content && <p>{item.content}</p>}{item.reference && (item.id.startsWith("asaba-worker-") ? <WorkerSourceLinks value={item.reference} /> : <small className="project-accumulation-reference">参考 · {item.reference}</small>)}<footer><span /><div><Button variant="secondary" size="small" type="button" onClick={() => setDraft({ ...item })}>编辑</Button><Button variant="danger" size="small" type="button" disabled={saving} onClick={() => onRemove(item)}>删除</Button></div></footer></article>;
    }) : <p className="project-empty-copy">这里还没有便签。读到一点、试出一点、想到一点，都可以先贴下来。</p>}</div>
  </section>;
}

function WorkerSourceLinks({ value }: { value: string }) {
  const [error, setError] = useState("");
  const urls = value.split("\n").filter(url => /^https?:\/\//i.test(url));
  return <details><summary>来源 · {urls.length} 条</summary><ol>{urls.map(url => <li key={url}>
    <Button variant="ghost" size="small" wrap onClick={() => void openUrl(url).catch(reason => setError(String(reason)))}>{url}</Button>
  </li>)}</ol>{error && <p role="status">{error}</p>}</details>;
}

function ProjectRoutePlanningAssistant({ detail, saving, onApply }: {
  detail: ProjectDetail;
  saving: boolean;
  onApply: (draft: ProjectRouteDraft) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [currentSituation, setCurrentSituation] = useState("");
  const [requirements, setRequirements] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [response, setResponse] = useState<DeepSeekStructuredResponse<ProjectRouteProposal> | null>(null);
  const completed = detail.milestones.filter((item) => item.status === "completed");

  async function generate() {
    setBusy(true); setError(""); setResponse(null);
    try {
      const model = await resolveAvailableDeepSeekModel("projectReplan", desktopApi.deepseek.apiModels);
      const input = buildRouteAiContext(detail, {
        currentSituation: currentSituation.trim(),
        requirements: requirements.trim(),
        purpose: "梳理滚动项目的检查点主线，表达串行、并行和汇合关系；不要生成下一行动。",
      });
      const result = await desktopApi.deepseek.planProjectRoute({
        model,
        input,
        allowedMilestoneIds: detail.milestones.map((item) => item.id),
        allowedTaskIds: detail.tasks.map((item) => item.id),
      });
      setResponse(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  function updateNode(index: number, patch: Partial<ProjectRouteProposalNode>) {
    if (!response) return;
    setResponse({ ...response, content: { ...response.content, nodes: response.content.nodes.map((node, nodeIndex) => nodeIndex === index ? { ...node, ...patch, action: node.existingMilestoneId && node.action === "keep" && Object.keys(patch).some((key) => key !== "action") ? "update" : node.action } : node) } });
  }
  function addNode() {
    if (!response) return;
    const node: ProjectRouteProposalNode = { ref: `new-${crypto.randomUUID()}`, existingMilestoneId: null, action: "create", title: "", definitionOfDone: "", dueDate: "", status: "planned", predecessorRefs: [] };
    setResponse({ ...response, content: { ...response.content, nodes: [...response.content.nodes, node] } });
  }
  function removeNode(index: number) {
    if (!response) return;
    const target = response.content.nodes[index];
    if (target.existingMilestoneId) { updateNode(index, { action: "supersede" }); return; }
    setResponse({ ...response, content: { ...response.content, nodes: response.content.nodes.filter((_, nodeIndex) => nodeIndex !== index).map((node) => ({ ...node, predecessorRefs: node.predecessorRefs.filter((ref) => ref !== target.ref) })) } });
  }
  function toggleParent(index: number, ref: string) {
    if (!response) return;
    const node = response.content.nodes[index];
    updateNode(index, { predecessorRefs: node.predecessorRefs.includes(ref) ? node.predecessorRefs.filter((item) => item !== ref) : [...node.predecessorRefs, ref] });
  }
  async function apply() {
    if (!response) return;
    setError("");
    try {
      prepareProjectRoute(detail.project, detail.milestones, response.content, new Date().toISOString(), (_ref, index) => `preview-${index}`);
      if (await onApply({ projectId: detail.project.id, currentSituation: currentSituation.trim(), requirements: requirements.trim(), proposal: response.content, model: response.model, tokenUsage: response.tokenUsage })) {
        setOpen(false); setResponse(null); setCurrentSituation(""); setRequirements("");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  const detachedTasks = response ? detail.tasks.filter((task) => task.status !== "done" && task.status !== "cancelled" && response.content.nodes.some((node) => node.action === "supersede" && node.existingMilestoneId === task.milestoneId)) : [];
  return <section className="project-route-ai-bar"><div><span>AI 主线规划</span><strong>用已有积累梳理项目会怎样发展</strong><p>生成检查点和连接关系，不混入具体下一行动；采用前可逐项编辑。</p></div><Button variant="primary" type="button" onClick={() => { setOpen(true); setError(""); }}>AI 推荐主线</Button>
    {open && <div className="project-ai-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy && !saving) setOpen(false); }}><section className="project-ai-modal project-route-ai-modal" role="dialog" aria-modal="true"><header><div><span>滚动项目 · 路线草案</span><h2>AI 推荐主线</h2></div><IconButton aria-label="关闭主线规划" variant="ghost" size="small" disabled={busy || saving} onClick={() => setOpen(false)}>×</IconButton></header>
      <aside className="project-ai-scope"><strong>本次将发送</strong><p>项目目标与背景、{detail.accumulations.length} 条已积累、全部路线节点和行动摘要。已完成节点只作为锁定历史，不允许 AI 修改。</p></aside>
      {!response && <><div className="project-route-ai-project"><span>项目目标</span><strong>{detail.project.outcome}</strong><small>{detail.milestones.length} 个节点 · {detail.accumulations.length} 条积累</small></div><label><span>当前情况 · 可选</span><textarea autoFocus disabled={busy} value={currentSituation} onChange={(event) => setCurrentSituation(event.target.value)} placeholder="例如：已经完成基线复现，现在要决定先做消融实验还是扩展数据集。" /></label><label><span>主线要求与限制 · 可选</span><textarea disabled={busy} value={requirements} onChange={(event) => setRequirements(event.target.value)} placeholder="例如：两个月内形成可投稿结果；最多并行两条实验线；优先复用现有代码。" /></label><Button variant="primary" disabled={busy} onClick={() => void generate()}>{busy ? "正在梳理已有工作…" : "生成可编辑路线草案"}</Button></>}
      {error && <p className="project-ai-error" role="alert">{error}{!response && <Button size="small" variant="danger" onClick={() => void generate()}>重试</Button>}</p>}
      {response && <div className="project-route-ai-draft"><header><div><strong>{response.content.summary}</strong><small>{response.model} · {response.tokenUsage.totalTokens} tokens</small></div><Button variant="secondary" size="small" type="button" onClick={addNode}>＋ 添加节点</Button></header>
        {completed.length > 0 && <details className="project-route-locked"><summary>锁定的完成历史（{completed.length}）</summary>{completed.map((item) => <div key={item.id}><span>✓</span><strong>{item.title}</strong><small>{item.definitionOfDone}</small></div>)}</details>}
        <div className="project-route-ai-nodes">{response.content.nodes.map((node, index) => {
          const predecessorOptions = [...completed.map((item) => ({ ref: item.id, label: `已完成 · ${item.title}` })), ...response.content.nodes.filter((candidate) => candidate.ref !== node.ref && candidate.action !== "supersede").map((candidate) => ({ ref: candidate.ref, label: candidate.title || "未命名节点" }))];
          return <article className={node.action === "supersede" ? "superseded" : ""} key={node.ref}><header><span>{node.existingMilestoneId ? "已有节点" : "新节点"}</span><div>{node.existingMilestoneId ? <SelectMenu label="节点处理方式" value={node.action} onChange={(value) => updateNode(index, { action: value as ProjectRouteProposalNode["action"] })} options={[{ value: "keep", label: "保留" }, { value: "update", label: "调整" }, { value: "supersede", label: "标为被替代" }]} /> : <em>将新建</em>}<Button variant="danger" size="small" type="button" onClick={() => removeNode(index)}>{node.existingMilestoneId ? "替代" : "移除"}</Button></div></header>{node.action !== "supersede" && <><label><span>节点名称</span><input value={node.title} onChange={(event) => updateNode(index, { title: event.target.value })} /></label><label><span>完成标准</span><textarea value={node.definitionOfDone} onChange={(event) => updateNode(index, { definitionOfDone: event.target.value })} /></label><div className="project-route-ai-node-meta"><SelectMenu label="节点状态" value={node.status} onChange={(value) => updateNode(index, { status: value as "current" | "planned" })} options={[{ value: "current", label: "当前检查点" }, { value: "planned", label: "候选节点" }]} /><input aria-label="节点截止日期" type="date" value={node.dueDate} onChange={(event) => updateNode(index, { dueDate: event.target.value })} /></div><details className="project-route-ai-parents"><summary>前置关系 · {node.predecessorRefs.length ? `${node.predecessorRefs.length} 项` : "独立起点"}</summary>{predecessorOptions.map((option) => <label key={option.ref}><input type="checkbox" checked={node.predecessorRefs.includes(option.ref)} onChange={() => toggleParent(index, option.ref)} /><span>{option.label}</span></label>)}</details></>}</article>;
        })}</div>
        {detachedTasks.length > 0 && <aside className="project-route-impact"><strong>采用后有 {detachedTasks.length} 项未完成行动会保留并解除节点关联</strong><ul>{detachedTasks.map((task) => <li key={task.id}>{task.title}</li>)}</ul></aside>}
        {(response.content.assumptions.length > 0 || response.content.risks.length > 0) && <details className="project-route-ai-notes"><summary>假设与风险</summary><ul>{[...response.content.assumptions, ...response.content.risks].map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
        <footer><Button variant="secondary" disabled={saving} onClick={() => setResponse(null)}>调整输入后重生成</Button><Button variant="primary" disabled={saving || busy} onClick={() => void apply()}>{saving ? "正在应用…" : "确认采用这条主线"}</Button></footer>
      </div>}
    </section></div>}
  </section>;
}

function ProposalBoard({ projectId, proposals, saving, onSave, onReview, onRemove }: { projectId: string; proposals: ProjectProposal[]; saving: boolean; onSave: (proposal: ProjectProposal) => void; onReview: (proposal: ProjectProposal, status: ProposalStatus, reviewNote: string) => void; onRemove: (proposal: ProjectProposal) => void }) {
  const [showComposer, setShowComposer] = useState(false);
  const [draft, setDraft] = useState(() => emptyProposal(projectId));
  function submit(event: FormEvent) { event.preventDefault(); if (!draft.title.trim()) return; onSave(draft); setDraft(emptyProposal(projectId)); setShowComposer(false); }
  return <section className="proposal-board"><header><div><h2>想法与提案</h2><p>先收集，再判断价值和成本；不会自动变成任务。</p></div><Button variant="secondary" type="button" onClick={() => setShowComposer((value) => !value)}>{showComposer ? "收起" : "＋ 提交一个想法"}</Button></header>{showComposer && <form className="proposal-composer" onSubmit={submit}><input autoFocus value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="想法是什么？" /><textarea value={draft.problem} onChange={(event) => setDraft({ ...draft, problem: event.target.value })} placeholder="它想解决什么问题？" /><div><input value={draft.expectedValue} onChange={(event) => setDraft({ ...draft, expectedValue: event.target.value })} placeholder="预期价值" /><input value={draft.cost} onChange={(event) => setDraft({ ...draft, cost: event.target.value })} placeholder="可能成本" /></div><Button variant="primary" type="submit" disabled={saving || !draft.title.trim()}>放入提案池</Button></form>}<div className="proposal-list">{proposals.length ? proposals.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} saving={saving} onReview={onReview} onRemove={onRemove} />) : <p className="project-empty-copy">还没有项目想法。想到新功能或方向时，可以先放在这里等待评审。</p>}</div></section>;
}

function ProposalCard({ proposal, saving, onReview, onRemove }: { proposal: ProjectProposal; saving: boolean; onReview: (proposal: ProjectProposal, status: ProposalStatus, reviewNote: string) => void; onRemove: (proposal: ProjectProposal) => void }) {
  const [open, setOpen] = useState(false); const [status, setStatus] = useState<ProposalStatus>(proposal.status); const [note, setNote] = useState(proposal.reviewNote);
  return <article className={`proposal-card ${proposal.status}`}><header className="proposal-card-summary"><button className="proposal-card-toggle" onClick={() => setOpen((value) => !value)}><span><small>{proposalStatusLabels[proposal.status]}</small><strong>{proposal.title}</strong></span></button><div><Button variant="danger" size="small" type="button" className="proposal-card-delete" disabled={saving} aria-label={`删除提案：${proposal.title}`} onClick={() => onRemove(proposal)}>删除</Button><Button variant="secondary" size="small" type="button" className="proposal-card-review" onClick={() => setOpen((value) => !value)}>{open ? "收起" : "评审"}</Button></div></header>{open && <div><p><b>要解决的问题</b>{proposal.problem || "尚未补充"}</p><p><b>预期价值</b>{proposal.expectedValue || "尚未补充"}</p><p><b>可能成本</b>{proposal.cost || "尚未补充"}</p><label><span>评审结论</span><SelectMenu label="评审结论" value={status} onChange={(value) => setStatus(value as ProposalStatus)} options={Object.entries(proposalStatusLabels).map(([value, label]) => ({ value, label }))} /></label><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="为什么做出这个判断？" /><Button variant="primary" disabled={saving} onClick={() => onReview(proposal, status, note)}>保存评审</Button></div>}</article>;
}

function ProjectCreationAiAssistant({ draft, saving, onApply, onCreateStandalone }: {
  draft: WorkspaceDraft;
  saving: boolean;
  onApply: (proposal: ProjectCreationProposal) => void;
  onCreateStandalone: (proposal: ProjectCreationProposal) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [response, setResponse] = useState<DeepSeekStructuredResponse<ProjectCreationProposal> | null>(null);
  const [effortAndOutcome, setEffortAndOutcome] = useState("");

  async function generate() {
    setBusy(true); setError(""); setResponse(null);
    try {
      const model = await resolveAvailableDeepSeekModel("projectCreate", desktopApi.deepseek.apiModels);
      const input = compactObject({
        effortAndOutcome: effortAndOutcome.trim(),
        title: draft.project.title,
        outcome: draft.project.outcome,
        motivation: draft.project.motivation,
        category: draft.project.category,
        targetDate: draft.project.targetDate,
        chosenPlanningMode: draft.project.planningMode,
        firstAction: {
          title: draft.task.title,
          currentFocus: draft.task.currentFocus,
          definitionOfDone: draft.task.definitionOfDone,
          details: draft.task.details,
          dueDate: draft.task.dueDate,
        },
        userEnteredNodes: draft.milestones.map((milestone) => ({ title: milestone.title, definitionOfDone: milestone.definitionOfDone, dueDate: milestone.dueDate,
              dueDateKind: "target", status: milestone.status })),
      });
      const result = await desktopApi.deepseek.createProjectPlan({ model, input });
      if (effortAndOutcome.trim()) {
        const constraint = `目标与投入约束：${effortAndOutcome.trim()}`;
        result.content.project.motivation = `${result.content.project.motivation}\n\n${constraint}`.trim();
        result.content.firstAction.details = `${result.content.firstAction.details}\n\n${constraint}`.trim();
      }
      setResponse(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  function updateProposal(patch: Partial<ProjectCreationProposal>) {
    if (response) setResponse({ ...response, content: { ...response.content, ...patch } });
  }

  return <details className="project-ai-creation" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><span><strong>让 AI 帮我找到省力的推进方式</strong><small>先达到你认可的结果；默认直接推进，只展开眼前一步。</small></span><em>{open ? "收起" : "AI 帮我判断"}</em></summary>
    <div>
      <aside><strong>调用前会发送</strong><p>仅发送本页填写的名称、结果、背景、日期、第一行动、节点，以及下面的目标与投入约束。</p></aside>
      <label><span>做到什么程度、最多投入多少 · 可选</span><textarea disabled={busy} value={effortAndOutcome} onChange={(event) => { setEffortAndOutcome(event.target.value); setResponse(null); }} placeholder="例如：只求考试通过，总共投入三小时；不安排系统课程和完整笔记。" /></label>
      {!response && <Button type="button" variant="primary" disabled={busy || saving} onClick={() => void generate()}>{busy ? "正在生成判断…" : "生成可编辑草案"}</Button>}
      {error && <p className="project-ai-error">{error} <Button size="small" variant="danger" type="button" onClick={() => void generate()}>重试</Button></p>}
      {response && <section className="project-ai-preview">
        <header><div><span>AI 草案 · {response.model}</span><strong>{response.content.classification === "standalone_action" ? "建议作为独立行动" : `建议${planningModeLabels[response.content.planningMode]}`}</strong><p>{response.content.reason}</p></div><small>{response.tokenUsage.totalTokens} tokens</small></header>
        {response.content.classification === "project" ? <>
          <label><span>项目名称</span><input value={response.content.project.title} onChange={(event) => updateProposal({ project: { ...response.content.project, title: event.target.value } })} /></label>
          <label><span>核心结果</span><textarea value={response.content.project.outcome} onChange={(event) => updateProposal({ project: { ...response.content.project, outcome: event.target.value } })} /></label>
          <label><span>推进方式</span><SelectMenu label="AI 建议推进方式" value={response.content.planningMode} onChange={(value) => updateProposal({ planningMode: value as ProjectPlanningMode })} options={(Object.keys(planningModeLabels) as ProjectPlanningMode[]).map((value) => ({ value, label: planningModeLabels[value] }))} /></label>
          <footer><Button type="button" variant="secondary" onClick={() => setResponse(null)}>重新生成</Button><Button type="button" variant="primary" onClick={() => { onApply(response.content); setOpen(false); }}>采用到编辑器</Button></footer>
        </> : <>
          <label><span>行动名称</span><input value={response.content.firstAction.title} onChange={(event) => updateProposal({ firstAction: { ...response.content.firstAction, title: event.target.value } })} /></label>
          <label><span>本次推进</span><textarea value={response.content.firstAction.currentFocus} onChange={(event) => updateProposal({ firstAction: { ...response.content.firstAction, currentFocus: event.target.value } })} /></label>
          <label><span>完成标志</span><textarea value={response.content.firstAction.definitionOfDone} onChange={(event) => updateProposal({ firstAction: { ...response.content.firstAction, definitionOfDone: event.target.value } })} /></label>
          <footer><Button type="button" variant="secondary" onClick={() => setResponse(null)}>重新生成</Button><Button type="button" variant="primary" disabled={saving} onClick={() => void onCreateStandalone(response.content)}>确认创建独立行动</Button></footer>
        </>}
        {(response.content.assumptions.length > 0 || response.content.risks.length > 0) && <details><summary>查看假设与风险</summary><ul>{[...response.content.assumptions, ...response.content.risks].map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
      </section>}
    </div>
  </details>;
}

function ProjectAiPlanningPanel({ detail, saving, askProjectDecision, onApplyAdjustment, onRefreshDetail, asabaAdjustment, onConsumeAsabaAdjustment }: {
  onRefreshDetail: () => Promise<ProjectDetail>;
  askProjectDecision: AskProjectDecision;
  asabaAdjustment: AsabaAdjustmentRequest | null;
  onConsumeAsabaAdjustment: (id: string) => void;
  detail: ProjectDetail;
  saving: boolean;
  onApplyAdjustment: (adjustment: ProjectAdjustmentDraft) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [trigger, setTrigger] = useState("");
  const [effortAndOutcome, setEffortAndOutcome] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [replan, setReplan] = useState<DeepSeekStructuredResponse<ProjectReplanProposal> | null>(null);
  const [basedOn, setBasedOn] = useState("");
  const [suggestion, setSuggestion] = useState<AsabaAdjustmentRequest | null>(null);
  const [assessment, setAssessment] = useState("");
  const [patchSelection, setPatchSelection] = useState({ outcome: false, targetDate: false, reviewDate: false });
  const currentMilestones = detail.milestones.filter((milestone) => milestone.status !== "superseded");
  const openTasks = detail.tasks.filter((task) => task.status !== "done" && task.status !== "cancelled");

  useEffect(() => {
    if (!asabaAdjustment || busy || saving) return;
    setTrigger(asabaAdjustment.request);
    setEffortAndOutcome("");
    setSuggestion(asabaAdjustment);
    setAssessment("");
    setReplan(null);
    setError("");
    setOpen(true);
    onConsumeAsabaAdjustment(asabaAdjustment.id);
  }, [asabaAdjustment, busy, saving, onConsumeAsabaAdjustment]);

  async function generateReplan() {
    if (!trigger.trim()) return;
    setBusy(true); setError(""); setAssessment("");
    try {
      let change = suggestion;
      if (!change) {
        const request = ["请判断这项变化是否有必要调整现有计划。", trigger.trim(), effortAndOutcome.trim()].filter(Boolean).join("\n\n");
        const result = await askProjectDecision(detail.project.id, request);
        if (!result.canAdjust) {
          setAssessment([result.answer.summary, ...result.answer.unknowns].join("\n"));
          return;
        }
        change = { id: crypto.randomUUID(), projectId: detail.project.id, request: trigger.trim(),
          suggestion: result.answer.nextAction, expectedUpdatedAt: result.expectedUpdatedAt };
      }
      const fresh = await onRefreshDetail();
      if (fresh.project.status !== "active" || fresh.project.isDraft ||
          (change.expectedUpdatedAt !== undefined && change.expectedUpdatedAt !== fresh.project.updatedAt)) {
        setSuggestion(null);
        throw new Error("项目已有变化，请重新评估。");
      }
      const milestones = fresh.milestones.filter((item) => item.status === "planned" || item.status === "current");
      const tasks = fresh.tasks.filter((item) => item.status !== "done" && item.status !== "cancelled");
      const model = await resolveAvailableDeepSeekModel("projectReplan", desktopApi.deepseek.apiModels);
      const input = buildRouteAiContext(fresh, { reportedChange: trigger.trim(), effortAndOutcome: effortAndOutcome.trim(),
        unverifiedSuggestion: change.suggestion, purpose: "只提出被本次新事实直接影响的局部修改，保留仍适用的路线与已完成的工作。没有依据的项目字段或日期填 null。" });
      const result = await desktopApi.deepseek.replanProject({
        model,
        input,
        allowedMilestoneIds: milestones.map((item) => item.id),
        allowedTaskIds: tasks.map((item) => item.id),
      });
      setBasedOn(fresh.project.updatedAt);
      setPatchSelection({ outcome: false, targetDate: false, reviewDate: false });
      setReplan({ ...result, content: {
        ...result.content,
        milestoneChanges: result.content.milestoneChanges.map((item) => ({ ...item, selected: false })),
        newMilestones: result.content.newMilestones.map((item) => ({ ...item, selected: false })),
        taskChanges: result.content.taskChanges.map((item) => ({ ...item, selected: false })),
        newTasks: result.content.newTasks.map((item) => ({ ...item, selected: false })),
      } });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  const hasSelection = replan && (Object.entries(replan.content.projectPatch).some(([key, value]) => value !== null && patchSelection[key as keyof typeof patchSelection]) ||
    [replan.content.milestoneChanges, replan.content.newMilestones, replan.content.taskChanges, replan.content.newTasks].some(items => items.some(item => item.selected)));

  async function applyReplan() {
    if (!replan || !hasSelection) return;
    const proposal: ProjectReplanProposal = {
      ...replan.content,
      projectPatch: {
        outcome: patchSelection.outcome ? replan.content.projectPatch.outcome : null,
        targetDate: patchSelection.targetDate ? replan.content.projectPatch.targetDate : null,
        reviewDate: patchSelection.reviewDate ? replan.content.projectPatch.reviewDate : null,
      },
    };
    if (await onApplyAdjustment({ projectId: detail.project.id, trigger: trigger.trim(), expectedUpdatedAt: basedOn, proposal, model: replan.model, tokenUsage: replan.tokenUsage })) setOpen(false);
  }

  function updateReplanList<Key extends "milestoneChanges" | "newMilestones" | "taskChanges" | "newTasks">(key: Key, index: number, patch: Partial<ProjectReplanProposal[Key][number]>) {
    if (!replan) return;
    setReplan({ ...replan, content: { ...replan.content, [key]: replan.content[key].map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) } });
  }

  return <section className="project-ai-planning-bar" id="project-ai-planning">
    <div><span>计划调整</span><strong>出现新事实时，再评估是否调整。</strong></div>
    <div><Button variant="primary" onClick={() => { setSuggestion(null); setAssessment(""); setOpen(true); setError(""); setReplan(null); }}>报告变化</Button></div>
    {open && <div className="project-ai-modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy && !saving) setOpen(false); }}><section className="project-ai-modal" role="dialog" aria-modal="true" aria-label="评估计划变化"><header><div><span>DeepSeek API</span><h2>评估计划变化</h2></div><IconButton aria-label="关闭规划窗口" size="small" variant="ghost" disabled={busy || saving} onClick={() => setOpen(false)}>×</IconButton></header>
      <aside className="project-ai-scope"><strong>本次将发送</strong><p>报告的变化、约束和相关项目记录。建议调整时会读取现有路线，以便生成可逐项确认的草案。</p></aside>
      {!replan && suggestion && <p><strong>浅羽建议 · 待核对</strong> {suggestion.suggestion}</p>}
      {!replan && <label><span>这次的目标与投入约束 · 可选</span><textarea disabled={busy} value={effortAndOutcome} onChange={(event) => { setEffortAndOutcome(event.target.value); setSuggestion(null); setAssessment(""); }} placeholder="例如：现在只有半小时；只求够用，先沿用已有资料，不加新阶段。" /></label>}
      {!replan && <><label><span>发生了什么变化？</span><textarea autoFocus disabled={busy} value={trigger} onChange={(event) => { setTrigger(event.target.value); setSuggestion(null); setAssessment(""); }} placeholder="例如：导师通知开题答辩提前到九月中下旬；这是已经确认的新截止。" /></label><Button variant="primary" disabled={busy || !trigger.trim()} onClick={() => void generateReplan()}>{busy ? "正在评估…" : suggestion ? "生成局部草案" : "评估是否需要调整"}</Button></>}
      {assessment && <p role="status">{assessment}</p>}
      {error && <p className="project-ai-error">{error}<Button size="small" variant="danger" onClick={() => void generateReplan()}>重试</Button></p>}
      {replan && <div className="project-ai-replan-preview"><header><div><strong>{replan.content.summary}</strong><small>{replan.model} · {replan.tokenUsage.totalTokens} tokens</small></div></header>
        <section><h3>项目字段</h3>{(["outcome", "targetDate", "reviewDate"] as const).map((key) => replan.content.projectPatch[key] !== null && <label className="project-ai-check-row" key={key}><input type="checkbox" checked={patchSelection[key]} onChange={(event) => setPatchSelection({ ...patchSelection, [key]: event.target.checked })} /><span><strong>{key === "outcome" ? "核心结果" : key === "targetDate" ? "项目目标日期" : "下次校准"}</strong><input value={replan.content.projectPatch[key] || ""} onChange={(event) => setReplan({ ...replan, content: { ...replan.content, projectPatch: { ...replan.content.projectPatch, [key]: event.target.value } } })} /></span></label>)}</section>
        <ReplanList title="节点调整" items={replan.content.milestoneChanges} existingTitle={(item) => currentMilestones.find(node => node.id === item.id)?.title} onChange={(index, patch) => updateReplanList("milestoneChanges", index, patch)} />
        <ReplanList title="新增节点" items={replan.content.newMilestones} onChange={(index, patch) => updateReplanList("newMilestones", index, patch)} />
        <ReplanList title="行动调整" items={replan.content.taskChanges} existingTitle={(item) => openTasks.find(task => task.id === item.id)?.title} onChange={(index, patch) => updateReplanList("taskChanges", index, patch)} />
        <ReplanList title="新增行动" items={replan.content.newTasks} onChange={(index, patch) => updateReplanList("newTasks", index, patch)} />
        {(replan.content.assumptions.length > 0 || replan.content.risks.length > 0) && <aside><strong>假设与风险</strong><ul>{[...replan.content.assumptions, ...replan.content.risks].map((item, index) => <li key={index}>{item}</li>)}</ul></aside>}
        <footer><Button variant="secondary" onClick={() => setReplan(null)}>放弃草案</Button><Button variant="primary" disabled={saving || !hasSelection} onClick={() => void applyReplan()}>{saving ? "正在应用…" : "应用已勾选调整"}</Button></footer>
      </div>}
    </section></div>}
  </section>;
}

function ReplanList<Item extends { selected: boolean; title?: string | null; action?: string; dueDate?: string | null }>({ title, items, existingTitle, onChange }: { title: string; items: Item[]; existingTitle?: (item: Item) => string | undefined; onChange: (index: number, patch: Partial<Item>) => void }) {
  if (!items.length) return null;
  return <section className="project-ai-replan-list"><h3>{title}</h3>{items.map((item, index) => <label className="project-ai-check-row" key={index}><input type="checkbox" checked={item.selected} onChange={(event) => onChange(index, { selected: event.target.checked } as Partial<Item>)} /><span><strong>{item.action ? aiChangeActionLabel(item.action) : "新增"}{existingTitle?.(item) ? " · " + existingTitle(item) : ""}</strong>{"title" in item && <input value={item.title || ""} onChange={(event) => onChange(index, { title: event.target.value } as Partial<Item>)} />}{"dueDate" in item && <input type="date" value={item.dueDate || ""} onChange={(event) => onChange(index, { dueDate: event.target.value } as Partial<Item>)} />}</span></label>)}</section>;
}

function aiChangeActionLabel(action: string) {
  return ({ complete: "标记完成", postpone: "推迟或调整", supersede: "标记为被替代", replace: "替换并保留历史", cancel: "取消并保留历史" } as Record<string, string>)[action] || action;
}

function compactObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactObject).filter((item) => item !== undefined);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactObject(item)]).filter(([, item]) => item !== undefined));
  if (typeof value === "string") return value.trim() || undefined;
  return value;
}

function ProjectEditor({ draft, projects, suggestedTags, saving, onChange, onCancel, onDelete, onSave, onCreateStandalone, onCreateWeek }: {
  draft: WorkspaceDraft;
  projects: ProjectSummary[];
  suggestedTags: string[];
  saving: boolean;
  onChange: (draft: WorkspaceDraft) => void;
  onCancel: () => void;
  onDelete: () => void;
  onSave: () => void;
  onCreateStandalone: (proposal: ProjectCreationProposal) => Promise<boolean>;
  onCreateWeek: () => void;
}) {
  const { project } = draft;
  const update = (patch: Partial<Project>) => onChange({ ...draft, project: { ...project, ...patch } });
  const hasChildren = projects.some((candidate) => candidate.parentProjectId === project.id);
  const parents = projects.filter((candidate) => candidate.id !== project.id && !candidate.isDraft && !candidate.parentProjectId);
  const [newTag, setNewTag] = useState("");
  const tags = project.tags ?? [];
  function addTag(tag: string) {
    if (!tag.trim()) return;
    update({ tags: normalizeProjectTags([...tags, tag]) });
    setNewTag("");
  }
  return <div className="project-editor">
    <header className="editor-toolbar">
      <div><Button variant="ghost" size="small" type="button" onClick={onCancel}>← 返回</Button><span>{project.id ? "编辑项目" : "新建项目"}</span></div>
      <Button variant="primary" type="button" disabled={saving || !project.title.trim() || !project.outcome.trim()} onClick={onSave}>{saving ? "保存中…" : "保存项目"}</Button>
    </header>
    <div className="project-editor-scroll"><div className="project-editor-layout"><div className="project-editor-paper">
      <label><span>项目名称</span><input className="project-editor-title" autoFocus value={project.title} onChange={(event) => update({ title: event.target.value })} /></label>
      <label><span>期望结果</span><textarea value={project.outcome} onChange={(event) => update({ outcome: event.target.value })} /></label>
      {project.id && <label className="project-inline-check"><input type="checkbox" checked={draft.recordGoalChange} onChange={(event) => onChange({ ...draft, recordGoalChange: event.target.checked })} />记录方向调整</label>}
      <details className="project-editor-optional">
        <summary>项目设置</summary>
        <div className="project-editor-grid">
          {project.id && <label><span>项目状态</span><SelectMenu label="项目状态" value={project.status} onChange={(value) => update({ status: value as ProjectStatus })} options={Object.entries(statusLabels).map(([value, label]) => ({ value, label }))} /></label>}
          <ProjectDateField label="项目日期" value={project.targetDate} kind={project.targetDateKind} onChange={(targetDate, targetDateKind) => update({ targetDate, targetDateKind })} />
          <DateField label="回顾日期" value={project.reviewDate} onChange={(reviewDate) => update({ reviewDate })} />
          {!hasChildren && <label><span>上级项目</span><SelectMenu label="上级项目" value={project.parentProjectId ?? ""} onChange={(value) => { if ((value || null) !== project.parentProjectId) update({ parentProjectId: value || null, supportsMilestoneId: null }); }} options={[{ value: "", label: "独立项目" }, ...parents.map(({ id, title }) => ({ value: id, label: title }))]} /></label>}
        </div>
        <label><span>项目背景</span><textarea value={project.motivation} onChange={(event) => update({ motivation: event.target.value })} /></label>
        <section className="project-tag-editor" aria-label="项目标签">
          <label><span>标签</span><input value={newTag} onChange={(event) => setNewTag(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); addTag(newTag); } }} /></label>
          <Button size="small" type="button" disabled={!newTag.trim()} onClick={() => addTag(newTag)}>添加标签</Button>
          <div className="project-tag-list">{tags.map((tag) => <Button key={tag} size="small" variant="secondary" type="button" aria-label={"移除标签 " + tag} onClick={() => update({ tags: tags.filter((item) => item !== tag) })}>#{tag} ×</Button>)}</div>
          <div className="project-tag-list">{suggestedTags.filter((tag) => !tags.includes(tag)).map((tag) => <Button key={tag} size="small" variant="ghost" type="button" onClick={() => addTag(tag)}>＋ {tag}</Button>)}</div>
        </section>
      </details>
      {!project.id && <details className="project-editor-optional"><summary>第一项行动</summary>
        <label><span>行动名称</span><input value={draft.task.title} onChange={(event) => onChange({ ...draft, task: { ...draft.task, title: event.target.value } })} /></label>
      </details>}
      {!project.id && <Button variant="ghost" size="small" type="button" onClick={onCreateWeek}>按周规划创建</Button>}
      {!project.id && <ProjectCreationAiAssistant draft={draft} saving={saving} onApply={(proposal) => {
            const now = new Date().toISOString();
            const milestones = proposal.milestones.map((milestone, index): Milestone => ({
              id: "",
              projectId: "",
              title: milestone.title,
              definitionOfDone: milestone.definitionOfDone,
              status: milestone.status,
              dueDate: milestone.dueDate,
              dueDateKind: "target",
              sortOrder: (index + 1) * 10,
              createdAt: now,
              updatedAt: now,
            }));
            onChange({
              ...draft,
              project: {
                ...draft.project,
                title: proposal.project.title,
                outcome: proposal.project.outcome,
                motivation: proposal.project.motivation,
                category: proposal.project.category,
                targetDate: proposal.project.targetDate,
                targetDateKind: "target",
                reviewDate: proposal.project.reviewDate,
                planningMode: proposal.planningMode,
              },
              milestones: proposal.planningMode === "direct" ? [] : milestones,
              task: {
                ...draft.task,
                direction: proposal.firstAction.direction,
                title: proposal.firstAction.title,
                currentFocus: proposal.firstAction.currentFocus,
                definitionOfDone: proposal.firstAction.definitionOfDone,
                details: proposal.firstAction.details,
                dueDate: proposal.firstAction.dueDate,
                dueDateKind: "target",
              },
            });
          }} onCreateStandalone={onCreateStandalone} />}
      {project.id && <section className="project-editor-danger-zone"><strong>永久删除项目</strong><Button variant="danger" disabled={saving} type="button" onClick={onDelete}>删除项目</Button></section>}
    </div></div></div>
  </div>;
}

function milestoneStatusLabel(node: Milestone) {
  return node.status === "completed" ? "已达成" : node.status === "current" ? "当前里程碑" : "后续里程碑";
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
    direction: "uncategorized",
    title: "",
    actionType: "organize",
    definitionOfDone: "",
    steps: [],
    currentFocus: "",
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

function emptyAccumulation(projectId: string): ProjectAccumulation {
  const now = new Date().toISOString();
  return { id: "", projectId, milestoneId: null, title: "", content: "", reference: "", createdAt: now, updatedAt: now };
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

function formatProjectDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

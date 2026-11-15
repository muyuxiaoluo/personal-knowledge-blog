import type { ProjectRepository } from "./data/project-repository";
import type { Project, ProjectTask } from "./project-types";
import { assertProjectActionIsCurrent, validateAsabaPlanSave, type AsabaPlanSave } from "./asaba-planning";

export async function writeAsabaPlan(projectRepository: ProjectRepository, saveNote: (id: string, request: string) => Promise<unknown>, command: AsabaPlanSave): Promise<{ projectId?: string }> {
  validateAsabaPlanSave(command);
  const { id, draft, request, attachMilestone } = command;
  const now = new Date().toISOString();
  const taskId = "task-asaba-plan-" + id;
  const task: ProjectTask = {
    id: taskId, projectId: null, milestoneId: null, direction: "uncategorized", title: draft.action.trim(),
    actionType: "organize", definitionOfDone: draft.completionCondition?.trim() ?? "", steps: [], currentFocus: "", details: request.trim(), benefit: "",
    dueDate: "", status: "later", waitingFor: "", resumeAction: "", context: "anywhere", sortOrder: 10,
    createdAt: now, updatedAt: now, completedAt: null,
  };
  const currentProjects = await projectRepository.list();
  let savedProjectId: string | undefined;
  if (draft.kind === "note") {
    await saveNote(id, request);
    return {};
  }
  if (draft.kind === "new_project") {
    const projectId = "project-asaba-plan-" + id;
    if (!currentProjects.some(project => project.id === projectId)) {
      const project: Project = {
        id: projectId, title: draft.title.trim(), outcome: draft.outcome.trim(), motivation: request.trim(),
        projectType: "main", planningMode: "direct", parentProjectId: null, supportsMilestoneId: null,
        status: "active", category: "uncategorized", sortOrder: (currentProjects.length + 1) * 10,
        isDraft: false, sourceNote: "浅羽规划", targetDate: "", reviewDate: "", completedAt: null, createdAt: now, updatedAt: now,
      };
      await projectRepository.saveWorkspace(project, [], task.title ? { ...task, status: "next" } : null);
    }
    savedProjectId = projectId;
  } else if (draft.kind === "existing_project") {
    const detail = draft.projectId ? await projectRepository.get(draft.projectId) : null;
    if (!detail || detail.project.status === "completed" || detail.project.isDraft) throw new Error("该项目已不可用，请重新生成建议。");
    if (!detail.tasks.some(item => item.id === taskId)) {
      if (draft.expectedUpdatedAt !== undefined) assertProjectActionIsCurrent(detail, task.title, draft.expectedUpdatedAt, command.repeatCompletedAction);
      const milestoneId = attachMilestone ? draft.milestone?.id ?? null : null;
      const current = detail.milestones.filter(item => item.status === "current");
      if (attachMilestone && (!milestoneId || (draft.expectedUpdatedAt !== undefined
        ? !detail.milestones.some(item => item.id === milestoneId && (item.status === "current" || item.status === "planned"))
        : current.length !== 1 || current[0].id !== milestoneId))) throw new Error("关联节点已变化。请取消关联或重新生成建议。");
      await projectRepository.saveTask({ ...task, projectId: detail.project.id, milestoneId, direction: detail.project.category,
        sortOrder: Math.max(0, ...detail.tasks.map(item => item.sortOrder)) + 10 }, draft.expectedUpdatedAt);
    }
    savedProjectId = detail.project.id;
  } else if (!(await projectRepository.listStandaloneTasks()).some(item => item.id === taskId)) {
    await projectRepository.saveTask(task);
  }
  return { projectId: savedProjectId };
}

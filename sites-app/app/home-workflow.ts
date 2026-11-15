import { actionDeadline } from "./project-dates";
import { isConfirmedTodayPlan, isContinuablePlan } from "./action-planning";
import { isSourceArticle, isThoughtInboxArticle } from "./article-helpers";
import type { ArticleRepository } from "./data/article-repository";
import { calendarDayDifference } from "./date-helpers";
import type { MilestoneStatus, ProjectStatus, ProjectTaskStatus } from "./project-types";
import type { StoredArticle } from "./types";
import type { TaskPlan } from "./work-types";

export type HomeTaskCandidate = {
  id: string;
  projectId: string | null;
  projectStatus: ProjectStatus | null;
  projectDraft?: boolean;
  milestoneStatus?: MilestoneStatus;
  status: ProjectTaskStatus;
  plan: TaskPlan | null;
  planCarriedFrom: string;
  dueDate: string;
  stageDueDate: string;
  dueDateKind?: import("./project-types").ProjectDateKind | null;
  stageDueDateKind?: import("./project-types").ProjectDateKind | null;
  projectTargetDate?: string;
  projectTargetDateKind?: import("./project-types").ProjectDateKind | null;
  sortOrder: number;
  weekBlocked?: boolean;
};

export function selectHomeTaskCandidates<Task extends HomeTaskCandidate>(
  tasks: Task[],
  today: string,
  activeTaskId: string | null,
  limit = 3,
): Task[] {
  const available = tasks
    .filter((task) => !task.projectDraft && !task.weekBlocked && !["done", "cancelled", "waiting"].includes(task.status) && (task.projectStatus === null || task.projectStatus === "active"))
    .sort((left, right) => homeTaskRank(left, today) - homeTaskRank(right, today));
  const active = activeTaskId ? tasks.find((task) => task.id === activeTaskId) : undefined;
  const ordered = [
    active,
    ...available.filter((task) => isConfirmedTodayPlan(task.plan, today)),
    ...available.filter((task) => isContinuablePlan(task.plan, today)),
    ...available.filter((task) => task.status === "next" && (task.milestoneStatus === undefined || task.milestoneStatus === "current") &&
      (task.plan?.source === "auto" || !task.plan?.plannedDate || task.plan.plannedDate <= today)),
  ].filter((task): task is Task => Boolean(task));
  const seen = new Set<string>();
  return ordered.filter((task) => {
    if (seen.has(task.id)) return false;
    seen.add(task.id);
    return true;
  }).slice(0, Math.max(1, limit));
}

export type QuickCloseoutOutcome = "progressed" | "small_step" | "blocked";

const closeoutLabels: Record<QuickCloseoutOutcome, string> = {
  progressed: "今天推进了一些",
  small_step: "完成了当前小步",
  blocked: "遇到阻塞，先停在这里",
};

export function buildQuickCloseout(
  outcome: QuickCloseoutOutcome,
  note: string,
  nextFocus: string,
  fallbackFocus: string,
) {
  const detail = note.trim();
  return {
    result: detail ? `${closeoutLabels[outcome]}：${detail}` : closeoutLabels[outcome],
    nextFocus: nextFocus.trim() || fallbackFocus.trim(),
  };
}

export function decodeTaskProgressLog(body: string) {
  const prefix = "行动推进｜";
  if (!body.startsWith(prefix)) return null;
  try {
    const parsed = JSON.parse(body.slice(prefix.length)) as { taskId?: unknown; result?: unknown; nextFocus?: unknown };
    return typeof parsed.result === "string" && typeof parsed.nextFocus === "string" && parsed.result.trim() && parsed.nextFocus.trim()
      ? { taskId: typeof parsed.taskId === "string" ? parsed.taskId : null, result: parsed.result.trim(), nextFocus: parsed.nextFocus.trim() }
      : null;
  } catch {
    return null;
  }
}

export type ContextualEcho = {
  article: StoredArticle;
  reason: string;
};

type EchoTaskContext = {
  projectTitle: string;
  stageTitle: string;
  title: string;
  currentFocus: string;
  benefit: string;
};

type EchoWeeklyContext = {
  primaryOutcome: string;
  secondaryOutcome: string;
};

const genericEchoTerms = new Set([
  "独立行动",
  "未关联阶段",
  "阅读与判断",
  "写作修订",
  "真实使用与反馈",
  "验收与整理",
  "方案判断",
  "建立", "创建", "开始", "完成", "推进", "继续", "准备", "进行",
  "检查", "确认", "整理", "记录", "总结", "分析", "研究", "学习",
  "优化", "改进", "实现", "使用", "验证", "测试", "阅读", "编写",
  "项目", "阶段", "任务", "行动", "计划", "目标", "结果", "问题",
]);

export function contextualEchoTerms(
  task: EchoTaskContext | null,
  weeklyFocus: EchoWeeklyContext | null,
) {
  const source = task
    ? [task.projectTitle, task.stageTitle, task.title, task.currentFocus, task.benefit]
    : [weeklyFocus?.primaryOutcome ?? "", weeklyFocus?.secondaryOutcome ?? ""];
  const terms = source.flatMap((value) => {
    const phrase = value.replace(/\s+/g, " ").trim();
    if (!phrase) return [];
    return [phrase, ...phrase.split(/[\s、，。；：/·（）()《》！？!?]+/)];
  });
  return meaningfulEchoTerms(terms).slice(0, 8);
}

function meaningfulEchoTerms(terms: string[]) {
  return [...new Set(terms.map((term) => term.trim().toLowerCase()))]
    .filter((term) => term.length >= 2 && term.length <= 60 && !genericEchoTerms.has(term));
}

type EchoMatch = { article: StoredArticle; matched: string[] };

function rankContextualEcho(matches: EchoMatch[], today: string): ContextualEcho | null {
  const ranked = matches.flatMap(({ article, matched }) => {
    const articleDate = (article.updated || article.created).slice(0, 10);
    if (article.storage.deletedAt || isSourceArticle(article) || isThoughtInboxArticle(article) || !articleDate || articleDate >= today) return [];
    const metadata = `${article.title} ${article.summary} ${article.project} ${article.tags.join(" ")}`.toLowerCase();
    // 完整短语及其子词只计一次，避免重复命中虚增相关性。
    const independent = matched.filter((term) => !matched.some((other) => other !== term && other.includes(term)));
    const score = independent.reduce((total, term) =>
      total + (term.length >= 4 ? 4 : 2) + (metadata.includes(term) ? 2 : 0), 0);
    // 正文中孤立的短词不足以推荐，需要更具体的短语、元数据命中或多个独立词。
    return score >= 4 ? [{ article, matched: independent, score }] : [];
  }).sort((left, right) => right.score - left.score
    || String(right.article.updated || right.article.created).localeCompare(String(left.article.updated || left.article.created)));
  const best = ranked[0];
  if (!best) return null;
  const matched = [...best.matched].sort((left, right) => right.length - left.length).slice(0, 2);
  return { article: best.article, reason: `旧记录中提到了 ${matched.join("、")}` };
}

export function selectContextualEcho(articles: StoredArticle[], terms: string[], today: string): ContextualEcho | null {
  const meaningfulTerms = meaningfulEchoTerms(terms);
  return rankContextualEcho(articles.map((article) => {
    const text = `${article.title} ${article.summary} ${article.body} ${article.project} ${article.tags.join(" ")}`.toLowerCase();
    return { article, matched: meaningfulTerms.filter((term) => text.includes(term)) };
  }), today);
}

export async function findContextualEcho(
  repository: Pick<ArticleRepository, "listSummaries">,
  terms: string[],
  today: string,
): Promise<ContextualEcho | null> {
  terms = meaningfulEchoTerms(terms);
  const batches = await Promise.all(terms.map(async (term) => {
    try {
      return await repository.listSummaries(16, 0, term);
    } catch {
      return [];
    }
  }));
  const matches = new Map<string, EchoMatch>();
  batches.forEach((articles, termIndex) => {
    const term = terms[termIndex];
    articles.forEach((article) => {
      const current = matches.get(article.id) ?? { article, matched: [] };
      if (!current.matched.includes(term)) current.matched.push(term);
      matches.set(article.id, current);
    });
  });
  return rankContextualEcho([...matches.values()], today);
}

function homeTaskRank(task: HomeTaskCandidate, today: string) {
  const planRank = task.plan?.plannedDate === today ? 0 : task.status === "next" ? 4 : 10;
  const dueDate = actionDeadline(task);
  const dueDifference = dueDate ? calendarDayDifference(dueDate, today) : null;
  const dueRank = dueDifference === null ? 30 : Math.max(0, dueDifference);
  return planRank + dueRank / 100 + task.sortOrder / 1000;
}

import { isContinuablePlan } from "./action-planning";
import { isSourceArticle, isThoughtInboxArticle } from "./article-helpers";
import type { ArticleRepository } from "./data/article-repository";
import { calendarDayDifference } from "./date-helpers";
import type { ProjectStatus, ProjectTaskStatus } from "./project-types";
import type { StoredArticle } from "./types";
import type { TaskPlan } from "./work-types";

export type HomeTaskCandidate = {
  id: string;
  projectId: string | null;
  projectStatus: ProjectStatus | null;
  status: ProjectTaskStatus;
  plan: TaskPlan | null;
  planCarriedFrom: string;
  dueDate: string;
  stageDueDate: string;
  sortOrder: number;
};

export function selectHomeTaskCandidates<Task extends HomeTaskCandidate>(
  tasks: Task[],
  today: string,
  activeTaskId: string | null,
  limit = 3,
): Task[] {
  const available = tasks
    .filter((task) => !["done", "cancelled", "waiting"].includes(task.status) && task.projectStatus !== "completed")
    .sort((left, right) => homeTaskRank(left, today) - homeTaskRank(right, today));
  const active = activeTaskId ? tasks.find((task) => task.id === activeTaskId) : undefined;
  const ordered = [
    active,
    ...available.filter((task) => isContinuablePlan(task.plan, today)),
    ...available.filter((task) => task.plan?.plannedDate === today),
    ...available.filter((task) => task.status === "next" && (task.projectStatus === "active" || task.projectId === null)),
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
  return [...new Set(terms)]
    .filter((term) => term.length >= 2 && term.length <= 60 && !genericEchoTerms.has(term))
    .slice(0, 8);
}

export async function findContextualEcho(
  repository: Pick<ArticleRepository, "listSummaries">,
  terms: string[],
  today: string,
): Promise<ContextualEcho | null> {
  const batches = await Promise.all(terms.map(async (term) => {
    try {
      return await repository.listSummaries(16, 0, term);
    } catch {
      return [];
    }
  }));
  const ranked = new Map<string, { article: StoredArticle; matched: Set<string>; score: number }>();
  batches.forEach((articles, termIndex) => {
    const term = terms[termIndex];
    articles.forEach((article, resultIndex) => {
      const articleDate = (article.updated || article.created).slice(0, 10);
      if (isSourceArticle(article) || isThoughtInboxArticle(article) || (articleDate && articleDate >= today)) return;
      const current = ranked.get(article.id) ?? { article, matched: new Set<string>(), score: 0 };
      const metadata = `${article.title} ${article.summary} ${article.project} ${article.category} ${article.tags.join(" ")}`;
      current.matched.add(term);
      current.score += Math.max(1, terms.length - termIndex) + Math.max(0, 4 - resultIndex / 4);
      if (metadata.includes(term)) current.score += 5;
      ranked.set(article.id, current);
    });
  });
  const best = [...ranked.values()].sort((left, right) =>
    right.score - left.score
    || String(right.article.updated || right.article.created).localeCompare(String(left.article.updated || left.article.created)),
  )[0];
  if (!best) return null;
  const matched = [...best.matched].sort((left, right) => right.length - left.length).slice(0, 2);
  return {
    article: best.article,
    reason: matched.length ? `旧记录中提到了 ${matched.join("、")}` : "与当前行动有关",
  };
}

function homeTaskRank(task: HomeTaskCandidate, today: string) {
  const planRank = task.plan?.plannedDate === today ? 0 : task.status === "next" ? 4 : 10;
  const dueDate = task.dueDate || task.stageDueDate;
  const dueDifference = dueDate ? calendarDayDifference(dueDate, today) : null;
  const dueRank = dueDifference === null ? 30 : Math.max(0, dueDifference);
  return planRank + dueRank / 100 + task.sortOrder / 1000;
}

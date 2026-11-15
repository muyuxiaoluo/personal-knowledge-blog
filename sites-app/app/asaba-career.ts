import type { ResearchReport } from "./asaba-worker";

export type AsabaIntent = "note" | "progress" | "plan" | "research" | "document" | "delegate" | "career";

export function asabaIntents(text: string): AsabaIntent[] {
  const request = text.trim().replace(/^浅羽[，,：:\s]*/u, "");
  if (!request) return [];
  if (/^(?:请|帮我)?(?:记一下|记个笔记|记下|记一笔|随手记|帮我记)/u.test(request)) return ["note"];
  const matches: AsabaIntent[] = [];
  if (/(?:项目|行动|任务).{0,20}(?:进度|进展|做到哪|状态|卡在哪)|(?:做到哪|做到了哪)/u.test(request)) matches.push("progress");
  if (/(?:论文|文档|稿件).{0,18}(?:排版|格式)|(?:检查|核对).{0,18}(?:排版|格式)/u.test(request)) matches.push("document");
  if (/委托|交给\s*codex|让\s*codex/iu.test(request)) matches.push("delegate");
  if (/(求职|找工作|校招|投简历|岗位准备)/u.test(request) && /准备|规划|安排|路线|差距/u.test(request)) matches.push("career");
  if (!matches.includes("career") && !matches.includes("progress") && /调研|搜(?:索|集|一下|搜)|查(?:一下|查|找)|联网/u.test(request)) matches.push("research");
  if (!matches.length && /规划|安排|帮我做|新建项目|想要|我想|计划/u.test(request)) matches.push("plan");
  return matches.length ? matches : ["note", "plan", "progress", "research", "document", "delegate", "career"];
}

export type CareerScope = { topic: string; queries: string[]; projectId: string | null; background: string };
export type CareerStage = { title: string; done: string; sourceIds: string[] };
export type CareerRoute = {
  title: string; outcome: string;
  gaps: { requirement: string; evidence: string; unknown: string; sourceIds: string[] }[];
  stages: CareerStage[]; nextAction: string;
};
export type CareerReport = { research: ResearchReport; route: CareerRoute | null };
export type CareerReview = {
  projectId: string | null; snapshot: string | null;
  title: string; outcome: string; stages: CareerStage[]; action: string;
};
export type CareerWrite = Omit<CareerReview, "stages"> & {
  jobId: string; stages: Array<Pick<CareerStage, "title" | "done">>; body: string; links: string[];
};

export function careerResearchTopic(request: string) {
  // Offer only public vocabulary, even when the surrounding request contains personal details.
  const publicTerms = request.match(/机器人|自动驾驶|嵌入式|前端|后端|算法|软件|测试|数据分析|产品经理|科研|ROS2|SLAM|C\+\+/giu) ?? [];
  return [...new Set(publicTerms)].join(" ");
}

export function careerRecruitmentBatch(request: string, year = new Date().getFullYear()) {
  const explicit = request.match(/20\d{2}\s*年?\s*(?:的\s*)?(?:校招|春招|秋招|招聘|求职)/u)?.[0]?.trim();
  if (explicit) return explicit;
  if (/明年/u.test(request)) return `${year + 1} 年`;
  const opening = request.split(/[，,。；;]/u, 1)[0];
  const statedYear = opening.match(/(20\d{2})\s*年/u)?.[1];
  if (statedYear && /求职|岗位|找工作/u.test(opening)) return `${statedYear} 年`;
  return request.match(/校招|春招|秋招/u)?.[0] ?? "";
}

export function careerUnknown(value: string) {
  return /^(?:unknown|n\/?a|未知|不明)[。.]?$/iu.test(value.trim()) ? "需要补充与该要求相关的项目或技能证据。" : value;
}

export function careerArchiveText(report: CareerReport, review: CareerReview) {
  const citations = (ids: string[]) => ids.map(id => `[${id}]`).join(" ");
  return [
    "期望结果 · " + review.outcome.trim(),
    "岗位要求与能力差距",
    ...(report.route?.gaps.map(item => [`${item.requirement} ${citations(item.sourceIds)}`,
      item.evidence && `已提供的依据 · ${item.evidence}`, item.unknown && `待验证 · ${careerUnknown(item.unknown)}`].filter(Boolean).join("\n")) ?? []),
    ...review.stages.map(stage => `${stage.title} · ${stage.done} ${citations(stage.sourceIds)}`),
    ...report.research.limitations.map(item => `调研局限 · ${item}`),
    ...report.research.sources.map(item => `[${item.id}] ${item.title} · ${item.url}`),
  ].join("\n\n");
}

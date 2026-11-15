import type { ResearchReport } from "./asaba-worker";

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

import type { ProjectSummary } from "./project-types";
import type { AsabaJob } from "./companion-types";

export type ResearchSource = {
  id: string; url: string; title: string; excerpt: string; date: string | null; accessedAt: string; readAt: string | null;
};
export type ResearchReport = {
  sources: ResearchSource[];
  findings: { text: string; sourceIds: string[] }[];
  positions: { sourceId: string; company: string; role: string; requirements: string[] }[];
  limitations: string[];
  nextAction: string;
};
export type DocumentReport = {
  issues: { location: string; property: string; actual: string; expected: string }[];
  manual: string[]; omitted: number; checked: number; nextAction: string;
};
export type ResearchInput = { topic: string; queries: string[]; model: string; background?: string };
export type DocumentInput = { thesis: string; template: string };
export type WorkerRequest<T> = { requestId: string; projectId: string | null; input: T };
export type WorkerArchive = { jobId: string; projectId: string; action: string };

const researchPrefix = /^(?:浅羽[，,：:\s]*)?(?:请\s*)?(?:帮我|请你|替我)?\s*(?:在网上|联网|后台)?\s*(?:查一查|查一下|查查|查找|调查|调研|搜集|搜索|搜一下|搜搜)\s*/u;
const localQuestion = /项目(?:的)?(?:进度|进展|记录|积累|计划)|行动(?:的)?(?:进度|状态)|做到哪|做到了哪/u;
const personal = /(?:我的(?:学历|毕业|简历|学校|电话|邮箱|联系方式|住址|健康|财务|身份|姓名)|结合我|根据我|我(?:的|是|在|于|读)|@[\w.-]+\.[A-Za-z]{2,}|\b1[3-9]\d{9}\b)/u;

export function needsResearchReview(topic: string) {
  return personal.test(topic) || /[\r\n]/.test(topic);
}

export function researchIntent(request: string) {
  const trimmed = request.trim();
  const prefix = trimmed.match(researchPrefix)?.[0];
  if (!prefix || localQuestion.test(trimmed)) return null;
  const topic = trimmed.slice(prefix.length).trim().slice(0, 400);
  if (!topic) return null;
  return needsResearchReview(topic) ? { topic: "", requiresReview: true } : { topic, requiresReview: false };
}

export function researchProject(topic: string, selected: string | null, projects: ProjectSummary[]) {
  const eligible = projects.filter(project => !project.isDraft && project.status !== "completed");
  if (selected) return eligible.find(project => project.id === selected)?.id ?? null;
  const named = eligible.filter(project => topic.includes(project.title));
  if (named.length === 1) return named[0].id;
  const career = eligible.filter(project => project.category === "career");
  if (named.length === 0 && career.length === 1 && /岗位|招聘|求职|校招/.test(topic)
    && /机器人|ROS2|SLAM/.test(topic) && /机器人|ROS2|SLAM/.test(career[0].title + career[0].outcome)) return career[0].id;
  return null;
}

export function researchQueries(topic: string) {
  const clean = topic.trim().replace(/\s+/g, " ");
  const shorten = (value: string) => Array.from(value).slice(0, 128).join("");
  const queries = [shorten(clean)];
  if (/岗位|招聘|求职|职位|校招/i.test(clean)) {
    queries.unshift(shorten("官方招聘 岗位职责 任职要求 " + clean));
    if (/SLAM|ROS2|机器人/i.test(clean)) {
      queries.push(shorten("招聘官网 定位 SLAM " + clean), shorten("招聘官网 C++ ROS2 系统软件 " + clean));
    }
  }
  return [...new Set(queries.filter(Boolean))];
}

export function jobStatusLabel(job: AsabaJob) {
  if (job.agent === "codex") return null;
  return ({
    queued: "等候执行", running: "处理中", recovering: "检查上次进度", review: "成果待确认", reviewed: "已归档",
    completed: "已完成", interrupted: "已中断", cancelled: "已取消", failed: "处理失败",
  })[job.state];
}

export function workerArchiveContent(job: AsabaJob) {
  if (!job.report || job.agent === "codex") throw new Error("委托还没有可保存的成果。");
  if (job.agent === "document") {
    const report = job.report as DocumentReport;
    return {
      title: "论文格式检查",
      body: [`已比对 ${report.checked} 项属性，发现 ${report.issues.length + report.omitted} 处差异。`,
        ...report.issues.slice(0, 30).map(item => `${item.location} · ${item.property}：${item.actual} → ${item.expected}`),
        ...(report.issues.length + report.omitted > 30 ? ["其余差异可在本机委托里核对。"] : []),
        ...report.manual.slice(0, 10).map(item => `待核对 · ${item}`)].join("\n"),
      urls: [],
    };
  }
  const report = job.report as ResearchReport;
  const sourceLabel = (id: string) => `[${id}]`;
  return {
    title: job.title,
    body: [`来源 ${report.sources.length} 条，识别岗位 ${report.positions.length} 条。`,
      ...report.findings.map(item => `${item.text} ${item.sourceIds.map(sourceLabel).join(" ")}`),
      ...report.positions.map(item => `${sourceLabel(item.sourceId)} ${item.company} · ${item.role} · ${item.requirements.join("、")}`),
      ...report.limitations.map(item => `局限 · ${item}`),
      ...report.sources.map(source => `${sourceLabel(source.id)} ${source.title} · 发布 ${source.date?.slice(0, 10) ?? "未知"} · 查阅 ${(source.readAt || source.accessedAt).slice(0, 10)} · ${source.readAt ? "已读取正文" : "仅搜索摘要"}`)].join("\n"),
    urls: report.sources.map(source => source.url),
  };
}

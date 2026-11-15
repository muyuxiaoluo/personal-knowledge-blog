export const asabaCapabilities = {
  note: { label: "记一下", description: "只记录想法或备忘，尤其是明确暂不执行。保留用户原话。", parameters: {}, personalContext: false, external: false, confirm: true },
  progress: { label: "查询项目进度", description: "查看某个项目实际做到哪里、正在等什么。", parameters: { project: "用户提到的项目名称或简称" }, personalContext: true, external: false, confirm: false },
  plan: { label: "分析下一步", description: "分析已有项目、判断假设情境的下一步，或评估是否值得立项。不会直接写入。", parameters: { project: "用户提到的项目名称或简称，可省略" }, personalContext: true, external: true, confirm: true },
  delegate: { label: "准备代码委托", description: "用户明确希望委托 Codex 修改或检查代码，准备可编辑的委托。", parameters: { project: "用户提到的项目名称或简称，可省略" }, personalContext: true, external: true, confirm: true },
  research: { label: "公开资料调研", description: "查询公开资料、最新岗位要求或其他外部信息。", parameters: { topic: "从请求中提取的公开研究主题，不含个人细节" }, personalContext: false, external: true, confirm: true },
  document: { label: "检查论文格式", description: "核对论文或其他文档格式。", parameters: {}, personalContext: false, external: true, confirm: true },
  career: { label: "求职调研与路线", description: "结合个人背景做求职准备和路线规划。单纯问最新岗位要求用 research。", parameters: {}, personalContext: true, external: true, confirm: true },
  recap: { label: "今日回顾", description: "回顾今天实际做过的工作。", parameters: {}, personalContext: true, external: false, confirm: false },
} as const;

export type AsabaCapabilityId = keyof typeof asabaCapabilities;
type AsabaCapabilityCall = { id: AsabaCapabilityId; args: { project?: string; topic?: string } };
export type AsabaRouteResult =
  | { kind: "ready"; call: AsabaCapabilityCall }
  | { kind: "clarify"; question: string }
  | { kind: "manual"; reason: "unavailable" | "invalid" };

export type AsabaLocalRouter = (request: string, catalog: typeof asabaCapabilities) => Promise<unknown>;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isAsabaCapability(value: unknown): value is AsabaCapabilityId {
  return typeof value === "string" && Object.hasOwn(asabaCapabilities, value);
}

export async function routeAsabaRequest(request: string, adapter: AsabaLocalRouter): Promise<AsabaRouteResult> {
  const text = request.trim();
  if (!text || text.length > 4000) return { kind: "manual", reason: "invalid" };
  let result: unknown;
  try { result = await adapter(text, asabaCapabilities); }
  catch { return { kind: "manual", reason: "unavailable" }; }
  if (result === null) return { kind: "manual", reason: "unavailable" };
  const invalid = { kind: "manual", reason: "invalid" } as const;
  if (!record(result)) return invalid;
  if (result.kind === "clarify" && Object.keys(result).length === 2 && typeof result.question === "string") {
    const question = result.question.trim();
    return question && question.length <= 140 ? { kind: "clarify", question } : invalid;
  }
  if (result.kind !== "call" || Object.keys(result).length !== 3 || !isAsabaCapability(result.id) || !record(result.args)) return invalid;
  const allowed = asabaCapabilities[result.id].parameters;
  const args: AsabaCapabilityCall["args"] = {};
  for (const [key, value] of Object.entries(result.args)) {
    if ((key !== "project" && key !== "topic") || !Object.hasOwn(allowed, key) || typeof value !== "string" || value.length > 140) return invalid;
    if (value.trim()) args[key] = value.trim();
  }
  return { kind: "ready", call: { id: result.id, args } };
}

export function matchAsabaProject<T extends { id: string; title: string; isDraft?: boolean }>(projects: T[], name: string) {
  const query = name.trim().normalize("NFKC").toLowerCase();
  if (!query) return undefined;
  const eligible = projects.filter(project => !project.isDraft);
  const exact = eligible.filter(project => project.title.normalize("NFKC").toLowerCase() === query);
  const candidates = exact.length ? exact : eligible.filter(project => project.title.normalize("NFKC").toLowerCase().includes(query));
  return candidates.length === 1 ? candidates[0] : undefined;
}

export type AsabaLocalProjectProgress = {
  title: string;
  outcome: string;
  status: "active" | "paused" | "completed";
  recent: { title: string; date: string; text: string } | null;
  next: string[];
  waiting: string[];
};

export type CompanionAction = { kind: "open_project" | "open_note" | "prepare_note" | "start_task" | "capture" | "open_observer" | "open_settings"; id: string; label: string; text?: string };
export type CompanionAskScope = "chat" | "work" | "news";
export type CompanionEvidence = { id: string; threadId: string; title: string; projectPath: string; occurredAt: string; updatedAt: string; status: string; text: string; limited: boolean };
export type CompanionMessage = { id: string; role: "user" | "assistant"; text: string; createdAt: string; evidenceIds: string[]; actions: CompanionAction[] };
export type CompanionContext = {
  updatedAt?: string;
  model?: string;
  projects?: Array<{ id: string; title: string; outcome: string; status: string }>;
  tasks?: Array<{ id: string; title: string; projectId: string | null; projectTitle: string }>;
  notes?: Array<{ id: string; title: string; summary: string; project: string; at?: string }>;
  news?: Array<{ title: string; summary: string; url: string; matched?: boolean }>;
  brief?: { date: string; news: string[]; tip?: string } | null;
  activeFocus?: { id: string; taskId: string | null; projectId: string | null; label: string; startedAt: string } | null;
};
export type AsabaFocusCommand = {
  id: string; operation: "start" | "stop"; label?: string; taskId?: string; projectId?: string;
  sessionId?: string;
};
export type AsabaActivity = { application: string; continuousSeconds: number; idleSeconds: number; available: boolean };
export type CompanionStatus = { enabled: boolean; collecting: boolean; thinking: boolean; checkedAt: string; error: string; records: CompanionEvidence[]; messages: CompanionMessage[]; context: CompanionContext; callsToday: number; dailyLimit: number; engineInstalled: boolean; keyConfigured: boolean };

export type AsabaNote = { id: string; text: string; url: string; projectId: string; application?: string; shotId?: string };
export type AsabaShot = { id: string; application: string; at: string };
export type AsabaObservation = { enabled: boolean; sourceApplication: string | null; sourceShot: AsabaShot | null; browser: string | null; games: string[]; sourceIsBrowser: boolean };
export type AsabaRecap = { text: string; local_model: boolean; day: string; generated_at: string; items: Array<{ at: string; end: string | null; kind: string; text: string; source: string | null }> };
export type AsabaJob = {
  id: string; noteId: string; projectId: string; title: string; description: string; repository: string;
  agent: "codex"; workspaceMode: "copy" | "original"; hadLocalChanges: boolean; previousJobId: string | null;
  base: string | null; sessionId: string | null; updatedAt: string; summary: string | null; commands: string[];
  diff: string | null; error: string | null;
  state: "queued" | "running" | "recovering" | "review" | "reviewed" | "completed" | "interrupted" | "cancelled" | "failed";
};
export type AsabaDelegation = Pick<AsabaJob, "noteId" | "projectId" | "title" | "description" | "repository"> & {
  requestId: string; agent: AsabaJob["agent"]; workspaceMode: AsabaJob["workspaceMode"]; previousJobId?: string; allowLocalChanges?: boolean;
};
export const asabaJobLabels: Record<AsabaJob["state"], string> = {
  queued: "准备副本", running: "排查中", recovering: "核对上次会话", review: "待复测", reviewed: "已查看",
  completed: "已排查", interrupted: "已中断", cancelled: "已取消", failed: "排查遇到问题",
};

export function companionTodayRecords(records: CompanionEvidence[], today = new Date().toLocaleDateString("en-CA")) {
  return records.filter(record => {
    const date = new Date(record.occurredAt);
    return Number.isFinite(date.getTime()) && date.toLocaleDateString("en-CA") === today;
  });
}
export function companionProjectName(path: string) { return path.replace(/[\\/]$/, "").split(/[\\/]/).pop() || "未关联项目"; }
export function companionReadout(status: CompanionStatus) {
  const brief = status.context.brief;
  const news = (status.context.news ?? []).filter(item => item.matched);
  return [brief ? `${brief.date}，每日早报。\n${brief.news.map((text, index) => `第${index + 1}条。${text}`).join("\n")}${brief.tip ? "\n" + brief.tip : ""}` : "", news.length ? `关注的 AI 资讯标题。\n${news.map(item => item.title).join("。\n")}。` : ""].filter(Boolean).join("\n\n");
}

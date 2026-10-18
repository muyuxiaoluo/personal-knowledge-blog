export type ObserverConfig = {
  roots: string[];
  screenshot: boolean;
  analyze: boolean;
  model: string;
  intervalSeconds: number;
  taskId: string | null;
  taskLabel: string;
};
export type ObserverClaim = { text: string; evidenceIds: string[] };
export type ObserverFileNote = { text: string; evidenceId: string; quote: string };
export type ObserverContext = { id: string; capturedAt: string; windowTitle: string; application: string; files: Array<{ evidenceId: string; path: string; kind: string; after: string | null; excerptLimited: boolean }>; omittedFiles: number };
export type ObserverAnalysis = {
  version?: number;
  observations: ObserverClaim[];
  resumeHint: ObserverClaim | null;
  uncertainties: string[];
  screenContent?: { kind: "chat" | "editor" | "document" | "terminal" | "browser" | "other"; text: string; location: string | null } | null;
  fileNotes?: ObserverFileNote[];
  resumeLocation?: ObserverFileNote | null;
};
export type WorkObservation = {
  id: string;
  sessionId: string;
  capturedAt: string;
  trigger: "manual" | "automatic";
  taskId: string | null;
  taskLabel: string;
  windowTitle: string;
  application: string;
  screenshot: boolean;
  fileChanges: Array<{ path: string; kind: "created" | "modified" | "deleted"; before: string | null; after: string | null; excerptLimited: boolean }>;
  fileChangeCount?: number | null;
  notes: string[];
  analysis: ObserverAnalysis | null;
  analysisError: string | null;
  model: string;
  elapsedMs: number;
  context?: ObserverContext[];
  pendingMentions?: Array<{ evidenceId: string; path: string; quote: string }>;
  analysisCoverage?: { totalFileChanges: number; includedFileIndices: number[]; omittedFileCount: number; truncatedFileIndices: number[]; unreadableFileIndices: number[]; contextRecordIds: string[] } | null;
};
export type ObserverStatus = { config: ObserverConfig; enabled: boolean; busy: boolean; status: string; records: WorkObservation[]; storagePath: string };

export function observerDisplayPath(path: string): string {
  return path.startsWith("\\\\?\\UNC\\") ? `\\\\${path.slice(8)}` : path.replace(/^\\\\\?\\/, "");
}

/** Source names stay separate from model prose so a draft cannot fabricate a citation. */
export function observerEvidenceLabel(id: string, observation: WorkObservation): string {
  if (id === "screen" && observation.screenshot) return "本次整屏截图";
  if (id === "window") return "前台窗口";
  for (const sample of observation.context ?? []) {
    const file = sample.files.find((file) => file.evidenceId === id);
    if (file) return `较早采样 · ${file.path.split(/[\\/]/).pop() || file.path}`;
  }
  const match = /^file:(\d+)$/.exec(id);
  const file = match ? observation.fileChanges[Number(match[1])] : undefined;
  return file ? file.path.split(/[\\/]/).pop() || file.path : "来源不可用";
}

export function observerScreenLabel(kind: NonNullable<ObserverAnalysis["screenContent"]>["kind"]): string {
  return ({ chat: "聊天显示的内容 · 不代表已执行", browser: "网页显示的内容 · 不代表已执行", editor: "编辑器显示的内容", document: "文档显示的内容", terminal: "输出画面 · 未核验运行结果", other: "屏幕显示的内容" })[kind];
}

export function observationSessions(records: WorkObservation[]): Array<{ id: string; records: WorkObservation[] }> {
  const groups = new Map<string, WorkObservation[]>();
  for (const record of records) {
    const existing = groups.get(record.sessionId) ?? [];
    existing.push(record);
    groups.set(record.sessionId, existing);
  }
  return [...groups].map(([id, records]) => ({ id, records: records.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)) }));
}

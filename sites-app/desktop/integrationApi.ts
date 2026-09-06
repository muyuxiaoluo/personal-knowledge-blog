import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { DeepSeekModeOptions, DeepSeekSnapshot } from "../app/ai-types";
import type {
  DeepSeekModel,
  DeepSeekStructuredResponse,
  NextActionProposal,
  ProjectCreationProposal,
  ProjectReplanProposal,
} from "../app/ai-api-types";
import type {
  GitHubRepositorySnapshot,
  ModelBalance,
  SecretKind,
  UsageConsoleSnapshot,
} from "../app/integration-types";
import type {
  AiBriefSnapshot,
  CitySuggestion,
  DashboardFetchResult,
  DashboardLocation,
  MorningBriefSnapshot,
  WeatherSnapshot,
} from "../app/dashboard-types";
import type { QuickLink } from "../app/workspace-preferences";
import type {
  FinanceAiApiResponse,
  FinanceImportPreview,
  FinanceImportSource,
  FinanceInsightSnapshot,
} from "../app/finance-types";
import type { HealthAiAdviceContent } from "../app/health-types";

function requireTauri() {
  if (!isTauri()) throw new Error("该功能需要在真实桌面应用中使用");
}

export const desktopApi = {
  finance: {
    previewImport: (path: string, source: FinanceImportSource) => {
      requireTauri();
      return invoke<FinanceImportPreview>("finance_preview_import", { path, source });
    },
    generateMonthlyReport: (snapshot: FinanceInsightSnapshot, model: string) => {
      requireTauri();
      return invoke<FinanceAiApiResponse>("finance_generate_monthly_report", { snapshot, model });
    },
  },
  deepseek: {
    apiModels: () => { requireTauri(); return invoke<DeepSeekModel[]>("deepseek_api_list_models"); },
    createProjectPlan: (request: { model: string; input: unknown; allowedMilestoneIds?: string[]; allowedTaskIds?: string[] }) => { requireTauri(); return invoke<DeepSeekStructuredResponse<ProjectCreationProposal>>("deepseek_api_project_create", { request }); },
    replanProject: (request: { model: string; input: unknown; allowedMilestoneIds: string[]; allowedTaskIds: string[] }) => { requireTauri(); return invoke<DeepSeekStructuredResponse<ProjectReplanProposal>>("deepseek_api_project_replan", { request }); },
    suggestNextAction: (request: { model: string; input: unknown; allowedMilestoneIds: string[]; allowedTaskIds: string[] }) => { requireTauri(); return invoke<DeepSeekStructuredResponse<NextActionProposal>>("deepseek_api_next_action", { request }); },
    healthAdvice: (request: { model: string; input: unknown }) => { requireTauri(); return invoke<DeepSeekStructuredResponse<HealthAiAdviceContent>>("deepseek_api_health_advice", { request }); },
    prepare: () => { requireTauri(); return invoke<DeepSeekSnapshot>("deepseek_prepare"); },
    status: () => { requireTauri(); return invoke<DeepSeekSnapshot>("deepseek_get_status"); },
    configureModes: (options: DeepSeekModeOptions) => { requireTauri(); return invoke<DeepSeekSnapshot>("deepseek_configure_modes", options); },
    attachImage: (name: string, mime: string, dataUrl: string) => { requireTauri(); return invoke<DeepSeekSnapshot>("deepseek_attach_image", { name, mime, dataUrl }); },
    removeAttachment: () => { requireTauri(); return invoke<DeepSeekSnapshot>("deepseek_remove_attachment"); },
    send: (prompt: string) => { requireTauri(); return invoke<DeepSeekSnapshot>("deepseek_send_message", { prompt }); },
    stop: () => { requireTauri(); return invoke<DeepSeekSnapshot>("deepseek_stop_generation"); },
    newConversation: () => { requireTauri(); return invoke<DeepSeekSnapshot>("deepseek_new_conversation"); },
    restore: (conversationRef: string) => { requireTauri(); return invoke<DeepSeekSnapshot>("deepseek_restore_conversation", { conversationRef }); },
    deleteConversation: (conversationRef: string) => { requireTauri(); return invoke<void>("deepseek_delete_conversation", { conversationRef }); },
    showOfficial: () => { requireTauri(); return invoke<void>("deepseek_show_official"); },
    release: () => isTauri() ? invoke<void>("deepseek_release") : Promise.resolve(),
  },
  secrets: {
    status: (kind: SecretKind) => { requireTauri(); return invoke<boolean>("secret_status", { kind }); },
    set: (kind: SecretKind, value: string) => { requireTauri(); return invoke<void>("secret_set", { kind, value }); },
    delete: (kind: SecretKind) => { requireTauri(); return invoke<void>("secret_delete", { kind }); },
  },
  github: {
    fetch: (owner: string, name: string) => { requireTauri(); return invoke<GitHubRepositorySnapshot>("github_fetch_repository", { owner, name }); },
  },
  balances: {
    deepseek: () => { requireTauri(); return invoke<ModelBalance>("deepseek_fetch_balance"); },
    qwen: () => { requireTauri(); return invoke<ModelBalance>("qwen_fetch_balance"); },
  },
  usage: {
    open: (provider: "deepseek" | "qwen") => { requireTauri(); return invoke<void>("usage_console_open", { provider }); },
    read: (provider: "deepseek" | "qwen") => { requireTauri(); return invoke<UsageConsoleSnapshot>("usage_console_snapshot", { provider }); },
    qwenMonitor: (start: string, end: string) => { requireTauri(); return invoke<UsageConsoleSnapshot>("qwen_fetch_monitor_usage", { start, end }); },
  },
  dashboard: {
    searchCities: (query: string) => { requireTauri(); return invoke<CitySuggestion[]>("dashboard_search_cities", { query }); },
    weather: (location: DashboardLocation, etag = "") => { requireTauri(); return invoke<DashboardFetchResult<WeatherSnapshot>>("dashboard_fetch_weather", { location, etag }); },
    aiBrief: (etag = "") => { requireTauri(); return invoke<DashboardFetchResult<AiBriefSnapshot>>("dashboard_fetch_ai_brief", { etag }); },
    morningBrief: (date: string, etag = "") => { requireTauri(); return invoke<DashboardFetchResult<MorningBriefSnapshot>>("dashboard_fetch_morning_brief", { date, etag }); },
  },
};

export async function openQuickLink(link: QuickLink) {
  if (!isTauri()) {
    window.open(link.url, "_blank", "noopener,noreferrer");
    return;
  }
  if (link.openMode === "external") {
    await openUrl(link.url);
    return;
  }
  if (link.area === "entertainment") {
    await invoke("entertainment_open", { url: link.url });
    return;
  }
  await invoke("tool_browser_open", {
    url: link.url,
    allowInsecureHttp: link.allowInsecureHttp,
  });
}

export async function openInternalUrl(url: string) {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("tool_browser_open", { url, allowInsecureHttp: false });
}

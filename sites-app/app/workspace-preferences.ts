export type QuickLinkCategory = "research" | "creative" | "content" | "general";
export type ToolArea = "ai" | "development" | "accounts" | "entertainment" | "web";
export type LinkOpenMode = "internal" | "external";

export type QuickLink = {
  id: string;
  title: string;
  url: string;
  category: QuickLinkCategory;
  area: ToolArea;
  openMode: LinkOpenMode;
  allowInsecureHttp: boolean;
  pinned: boolean;
  order: number;
};

export type WorkspacePreferences = {
  displayName: string;
  avatarDataUrl: string;
  quickLinks: QuickLink[] | null;
};

export const defaultQuickLinks: QuickLink[] = [
  { id: "deepseek", title: "DeepSeek", url: "https://chat.deepseek.com", category: "general", area: "ai", openMode: "external", allowInsecureHttp: false, pinned: true, order: 0 },
  { id: "qwen", title: "千问", url: "https://www.qianwen.com/", category: "general", area: "ai", openMode: "external", allowInsecureHttp: false, pinned: false, order: 1 },
  { id: "gemini", title: "Gemini", url: "https://gemini.google.com", category: "general", area: "ai", openMode: "external", allowInsecureHttp: false, pinned: false, order: 2 },
  { id: "grok", title: "Grok", url: "https://grok.com", category: "general", area: "ai", openMode: "external", allowInsecureHttp: false, pinned: false, order: 3 },
  { id: "chatgpt", title: "ChatGPT", url: "https://chatgpt.com", category: "general", area: "ai", openMode: "external", allowInsecureHttp: false, pinned: false, order: 4 },
  { id: "doubao", title: "豆包", url: "https://www.doubao.com/chat/", category: "general", area: "ai", openMode: "external", allowInsecureHttp: false, pinned: false, order: 5 },
  { id: "zhipu", title: "智谱清言", url: "https://chatglm.cn/", category: "general", area: "ai", openMode: "external", allowInsecureHttp: false, pinned: false, order: 6 },
  { id: "claude", title: "Claude", url: "https://claude.ai/", category: "general", area: "ai", openMode: "external", allowInsecureHttp: false, pinned: false, order: 7 },
  { id: "kimi", title: "Kimi", url: "https://www.kimi.com/zh/", category: "general", area: "ai", openMode: "external", allowInsecureHttp: false, pinned: false, order: 8 },
  { id: "bilibili", title: "哔哩哔哩", url: "https://www.bilibili.com", category: "content", area: "entertainment", openMode: "internal", allowInsecureHttp: false, pinned: true, order: 9 },
  { id: "douyin", title: "抖音", url: "https://www.douyin.com", category: "content", area: "entertainment", openMode: "internal", allowInsecureHttp: false, pinned: false, order: 10 },
  { id: "zotero", title: "Zotero", url: "https://www.zotero.org", category: "research", area: "web", openMode: "external", allowInsecureHttp: false, pinned: true, order: 11 },
  { id: "github", title: "GitHub", url: "https://github.com", category: "creative", area: "development", openMode: "internal", allowInsecureHttp: false, pinned: true, order: 12 },
  { id: "arxiv", title: "arXiv", url: "https://arxiv.org", category: "research", area: "web", openMode: "external", allowInsecureHttp: false, pinned: false, order: 13 },
  { id: "scholar", title: "Google 学术", url: "https://scholar.google.com", category: "research", area: "web", openMode: "external", allowInsecureHttp: false, pinned: false, order: 14 },
];

export function normalizeDisplayName(value: string) {
  return [...value.trim()].slice(0, 24).join("");
}

export function workspaceTitle(displayName: string) {
  const normalized = normalizeDisplayName(displayName);
  return normalized || "个人工作台";
}

export function normalizeAvatarDataUrl(value: string) {
  if (value.length > 2_000_000) return "";
  return /^data:image\/(?:jpeg|png|webp);base64,[a-z\d+/=]+$/i.test(value) ? value : "";
}

export function readLegacyQuickLinks(storage: Pick<Storage, "getItem">): QuickLink[] {
  try {
    const current = storage.getItem("life-strategy.quick-links-v2");
    if (current) return normalizeQuickLinks(JSON.parse(current));
    const legacy = storage.getItem("life-strategy.quick-links");
    if (legacy) return (JSON.parse(legacy) as Array<{ title: string; url: string }>).map((link, index) => ({
      id: `legacy-${index}`,
      ...link,
      category: inferQuickLinkCategory(link.url),
      area: "web",
      openMode: "external",
      allowInsecureHttp: false,
      pinned: index < 4,
      order: index,
    }));
  } catch { /* use defaults */ }
  return defaultQuickLinks.map((link) => ({ ...link }));
}

export function inferQuickLinkCategory(url: string): QuickLinkCategory {
  const value = url.toLocaleLowerCase();
  if (/arxiv|scholar|zotero/.test(value)) return "research";
  if (/github|figma|notion/.test(value)) return "creative";
  if (/bilibili|douyin|youtube/.test(value)) return "content";
  return "general";
}

export function normalizeQuickLinks(value: unknown): QuickLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<QuickLink>;
    if (typeof candidate.id !== "string" || typeof candidate.title !== "string" || typeof candidate.url !== "string") return [];
    return [{
      id: candidate.id,
      title: candidate.title,
      url: candidate.url,
      category: isQuickLinkCategory(candidate.category) ? candidate.category : inferQuickLinkCategory(candidate.url),
      area: isToolArea(candidate.area) ? candidate.area : "web",
      openMode: candidate.openMode === "internal" || candidate.openMode === "external" ? candidate.openMode : "external",
      allowInsecureHttp: candidate.allowInsecureHttp === true,
      pinned: candidate.pinned === true,
      order: typeof candidate.order === "number" ? candidate.order : index,
    }];
  });
}

export function addDefaultEntertainmentLinks(links: QuickLink[]) {
  const entertainmentDefaults = defaultQuickLinks.filter((link) => link.area === "entertainment");
  const defaultByHost = new Map(entertainmentDefaults.map((link) => [hostOf(link.url), link]));
  const migrated = links.map((link) => defaultByHost.has(hostOf(link.url)) ? {
    ...link,
    area: "entertainment" as const,
    category: "content" as const,
    openMode: "internal" as const,
    allowInsecureHttp: false,
  } : link);
  const existingHosts = new Set(migrated.filter((link) => link.area === "entertainment").map((link) => hostOf(link.url)).filter(Boolean));
  const additions = entertainmentDefaults
    .filter((link) => !existingHosts.has(hostOf(link.url)))
    .map((link, index) => ({ ...link, order: migrated.length + index }));
  return [...migrated, ...additions];
}

export function addDefaultAiLinks(links: QuickLink[]) {
  const defaults = defaultQuickLinks.filter((link) => link.area === "ai" && link.id !== "deepseek");
  const upgraded = links.map((link) => link.area === "ai" && link.id === "qwen"
    ? { ...link, title: "千问", url: "https://www.qianwen.com/" }
    : link);
  const existingIds = new Set(upgraded.filter((link) => link.area === "ai").map((link) => link.id));
  const existingHosts = new Set(upgraded.filter((link) => link.area === "ai").map((link) => hostOf(link.url)).filter(Boolean));
  const additions = defaults
    .filter((link) => !existingIds.has(link.id) && !existingHosts.has(hostOf(link.url)))
    .map((link, index) => ({ ...link, order: upgraded.length + index }));
  return [...upgraded, ...additions];
}

function isQuickLinkCategory(value: unknown): value is QuickLinkCategory {
  return value === "research" || value === "creative" || value === "content" || value === "general";
}

function isToolArea(value: unknown): value is ToolArea {
  return value === "ai" || value === "development" || value === "accounts" || value === "entertainment" || value === "web";
}

function hostOf(value: string) {
  try { return new URL(value).hostname.replace(/^www\./, "").toLocaleLowerCase(); }
  catch { return ""; }
}

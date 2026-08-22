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
  quickLinks: QuickLink[] | null;
};

export const defaultQuickLinks: QuickLink[] = [
  { id: "deepseek", title: "DeepSeek", url: "https://chat.deepseek.com", category: "general", area: "ai", openMode: "external", allowInsecureHttp: false, pinned: true, order: 0 },
  { id: "qwen", title: "Qwen", url: "https://chat.qwen.ai", category: "general", area: "ai", openMode: "external", allowInsecureHttp: false, pinned: false, order: 1 },
  { id: "gemini", title: "Gemini", url: "https://gemini.google.com", category: "general", area: "ai", openMode: "external", allowInsecureHttp: false, pinned: false, order: 2 },
  { id: "grok", title: "Grok", url: "https://grok.com", category: "general", area: "ai", openMode: "external", allowInsecureHttp: false, pinned: false, order: 3 },
  { id: "bilibili", title: "哔哩哔哩", url: "https://www.bilibili.com", category: "content", area: "entertainment", openMode: "internal", allowInsecureHttp: false, pinned: true, order: 4 },
  { id: "douyin", title: "抖音", url: "https://www.douyin.com", category: "content", area: "entertainment", openMode: "internal", allowInsecureHttp: false, pinned: false, order: 5 },
  { id: "zotero", title: "Zotero", url: "https://www.zotero.org", category: "research", area: "web", openMode: "external", allowInsecureHttp: false, pinned: true, order: 6 },
  { id: "github", title: "GitHub", url: "https://github.com", category: "creative", area: "development", openMode: "internal", allowInsecureHttp: false, pinned: true, order: 7 },
  { id: "arxiv", title: "arXiv", url: "https://arxiv.org", category: "research", area: "web", openMode: "external", allowInsecureHttp: false, pinned: false, order: 8 },
  { id: "scholar", title: "Google 学术", url: "https://scholar.google.com", category: "research", area: "web", openMode: "external", allowInsecureHttp: false, pinned: false, order: 9 },
];

export function normalizeDisplayName(value: string) {
  return value.trim().slice(0, 24);
}

export function workspaceTitle(displayName: string) {
  const normalized = normalizeDisplayName(displayName);
  return normalized ? `${normalized}的个人工作台` : "个人工作台";
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

function isQuickLinkCategory(value: unknown): value is QuickLinkCategory {
  return value === "research" || value === "creative" || value === "content" || value === "general";
}

function isToolArea(value: unknown): value is ToolArea {
  return value === "ai" || value === "development" || value === "accounts" || value === "entertainment" || value === "web";
}

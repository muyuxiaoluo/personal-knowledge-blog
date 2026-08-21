export type QuickLinkCategory = "research" | "creative" | "content" | "general";

export type QuickLink = {
  id: string;
  title: string;
  url: string;
  category: QuickLinkCategory;
  pinned: boolean;
  order: number;
};

export type WorkspacePreferences = {
  displayName: string;
  quickLinks: QuickLink[] | null;
};

export const defaultQuickLinks: QuickLink[] = [
  { id: "bilibili", title: "哔哩哔哩", url: "https://www.bilibili.com", category: "content", pinned: true, order: 0 },
  { id: "douyin", title: "抖音", url: "https://www.douyin.com", category: "content", pinned: false, order: 1 },
  { id: "zotero", title: "Zotero", url: "https://www.zotero.org", category: "research", pinned: true, order: 2 },
  { id: "github", title: "GitHub", url: "https://github.com", category: "creative", pinned: true, order: 3 },
  { id: "arxiv", title: "arXiv", url: "https://arxiv.org", category: "research", pinned: true, order: 4 },
  { id: "scholar", title: "Google 学术", url: "https://scholar.google.com", category: "research", pinned: false, order: 5 },
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
    if (current) return JSON.parse(current) as QuickLink[];
    const legacy = storage.getItem("life-strategy.quick-links");
    if (legacy) return (JSON.parse(legacy) as Array<{ title: string; url: string }>).map((link, index) => ({
      id: `legacy-${index}`,
      ...link,
      category: inferQuickLinkCategory(link.url),
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

import type { Article, StoredArticle } from "./types";

export type EntertainmentProvider = "bilibili" | "douyin";

export type EntertainmentCaptureSnapshot = {
  requestId: string;
  provider: EntertainmentProvider;
  canonicalUrl: string;
  contentId?: string;
  title: string;
  author?: string;
  description?: string;
  thumbnailUrl?: string;
  playbackSeconds?: number;
  selectedText?: string;
  capturedAt: string;
};

export type EntertainmentCaptureRequest = {
  mode: "explore" | "thought";
  snapshot: EntertainmentCaptureSnapshot;
  thought?: string;
  quote?: string;
};

export type CaptureRelationKind = "note" | "task" | "proposal";

export type CaptureRelation = {
  kind: CaptureRelationKind;
  id: string;
};

type CaptureMetadata = Pick<
  EntertainmentCaptureSnapshot,
  "provider" | "canonicalUrl" | "contentId" | "author" | "thumbnailUrl" | "playbackSeconds" | "capturedAt"
>;

const metadataPrefix = "workbench:capture:v1:";
const relationPrefix = "workbench:capture-relation:v1:";
const originPrefix = "workbench:capture-origin:v1:";
const maximumMetadataLength = 1_900;

export function providerLabel(provider: EntertainmentProvider) {
  return provider === "bilibili" ? "哔哩哔哩" : "抖音";
}

export function formatPlaybackTime(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "";
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3_600);
  const minutes = Math.floor((rounded % 3_600) / 60);
  const remaining = rounded % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

export function captureMetadata(article: Pick<Article, "source">): CaptureMetadata | null {
  const encoded = article.source.find((item) => item.startsWith(metadataPrefix));
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(encoded.slice(metadataPrefix.length))) as CaptureMetadata;
    if ((parsed.provider !== "bilibili" && parsed.provider !== "douyin") || !/^https:\/\//i.test(parsed.canonicalUrl)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function captureRelations(article: Pick<Article, "source">): CaptureRelation[] {
  return article.source.flatMap((item) => {
    if (!item.startsWith(relationPrefix)) return [];
    const [kind, ...idParts] = item.slice(relationPrefix.length).split(":");
    if ((kind !== "note" && kind !== "task" && kind !== "proposal") || !idParts.length) return [];
    return [{ kind, id: decodeURIComponent(idParts.join(":")) } as CaptureRelation];
  });
}

export function captureOriginId(article: Pick<Article, "source">) {
  const value = article.source.find((item) => item.startsWith(originPrefix));
  return value ? decodeURIComponent(value.slice(originPrefix.length)) : "";
}

export function appendCaptureRelation<T extends Article>(article: T, relation: CaptureRelation): T {
  const token = `${relationPrefix}${relation.kind}:${encodeURIComponent(relation.id)}`;
  const source = article.source.includes(token) ? article.source : [...article.source, token];
  return { ...article, source, branch: "已整理", stage: "已整理" };
}

export function withCaptureOrigin(source: string[], sourceArticleId: string) {
  const token = `${originPrefix}${encodeURIComponent(sourceArticleId)}`;
  return source.includes(token) ? source : [...source, token];
}

export function sourceForCapturedResult(source: string[], sourceArticleId: string) {
  const withoutRelations = source.filter((item) => !item.startsWith(relationPrefix) && !item.startsWith(originPrefix));
  return withCaptureOrigin(withoutRelations, sourceArticleId);
}

export function preserveCaptureSourceMetadata(current: string[], kind: string, url: string) {
  const hidden = current.filter(isCaptureToken);
  return [kind, ...(url.trim() ? [url.trim()] : []), ...hidden];
}

export function findExistingCapturedSource(
  articles: StoredArticle[],
  snapshot: EntertainmentCaptureSnapshot,
) {
  return articles.find((article) => {
    if (article.collection !== "sources") return false;
    const metadata = captureMetadata(article);
    const sourceUrl = article.source.find((item) => /^https?:\/\//i.test(item));
    return normalizeCaptureUrl(metadata?.canonicalUrl || sourceUrl || "") === normalizeCaptureUrl(snapshot.canonicalUrl);
  });
}

export function buildCapturedArticle(request: EntertainmentCaptureRequest): Article {
  const { snapshot } = request;
  const platform = providerLabel(snapshot.provider);
  const playback = formatPlaybackTime(snapshot.playbackSeconds);
  const quote = (request.quote ?? snapshot.selectedText ?? "").trim().slice(0, 1_000);
  const thought = (request.thought ?? "").trim();
  const description = (snapshot.description ?? "").trim().slice(0, 4_000);
  const sourceLines = [
    `- 平台：${platform}`,
    snapshot.author ? `- 作者：${snapshot.author}` : "",
    playback ? `- 视频时间：${playback}` : "",
    `- 收集时间：${new Date(snapshot.capturedAt).toLocaleString("zh-CN")}`,
    `- 原始内容：[${snapshot.title}](${snapshot.canonicalUrl})`,
  ].filter(Boolean).join("\n");
  const metadata = encodeMetadata(snapshot);
  const source = [platform, snapshot.canonicalUrl, ...(metadata ? [metadata] : [])];

  if (request.mode === "thought") {
    const quoteBlock = quote ? `\n\n> ${quote.replace(/\n+/g, "\n> ")}` : "";
    return {
      ...emptyCaptureArticle(),
      title: captureTitle(thought),
      created: snapshot.capturedAt.slice(0, 10),
      branch: "待分类",
      stage: "种子",
      type: "想法",
      tags: [platform, "视频记录"],
      source,
      summary: plainExcerpt(thought),
      body: `${thought}${quoteBlock}\n\n---\n\n### 来源\n\n${sourceLines}`,
    };
  }

  return {
    ...emptyCaptureArticle(),
    collection: "sources",
    collectionLabel: "探索资料",
    title: snapshot.title || `${platform}内容`,
    created: snapshot.capturedAt.slice(0, 10),
    branch: "收藏中",
    stage: "已收藏",
    category: "探索资料",
    type: "外部资料",
    tags: [platform, "视频"],
    source,
    summary: description || `来自 ${platform} 的收藏${playback ? ` · ${playback}` : ""}`,
    body: `${description ? `${description}\n\n` : ""}### 来源\n\n${sourceLines}`,
  };
}

function emptyCaptureArticle(): Article {
  return {
    id: "",
    slug: "",
    collection: "notes",
    collectionLabel: "笔记",
    title: "",
    created: "",
    updated: "",
    branch: "待分类",
    subbranch: "",
    stage: "种子",
    validity: "待验证",
    category: "uncategorized",
    tags: [],
    type: "想法",
    project: "",
    projectId: "",
    confidence: "低",
    source: [],
    reviewDate: "",
    summary: "",
    next: "",
    body: "",
  };
}

function encodeMetadata(snapshot: EntertainmentCaptureSnapshot) {
  const metadata: CaptureMetadata = {
    provider: snapshot.provider,
    canonicalUrl: snapshot.canonicalUrl,
    contentId: snapshot.contentId,
    author: snapshot.author,
    thumbnailUrl: snapshot.thumbnailUrl,
    playbackSeconds: snapshot.playbackSeconds,
    capturedAt: snapshot.capturedAt,
  };
  let token = `${metadataPrefix}${encodeURIComponent(JSON.stringify(metadata))}`;
  if (token.length <= maximumMetadataLength) return token;
  delete metadata.thumbnailUrl;
  token = `${metadataPrefix}${encodeURIComponent(JSON.stringify(metadata))}`;
  return token.length <= maximumMetadataLength ? token : "";
}

function isCaptureToken(value: string) {
  return value.startsWith(metadataPrefix) || value.startsWith(relationPrefix) || value.startsWith(originPrefix);
}

function normalizeCaptureUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    return `${url.origin}${url.pathname.replace(/\/$/, "")}${url.search}`;
  } catch {
    return value.trim().replace(/\/$/, "");
  }
}

function captureTitle(text: string) {
  const line = text.split(/\r?\n/).map((item) => item.trim()).find(Boolean) || "视频记录";
  return line.length > 42 ? `${line.slice(0, 42)}…` : line;
}

function plainExcerpt(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 180);
}

import type { ExternalSourceInput } from "./dashboard-types";

export function normalizeAiHighlightKeywords(input: string | string[]) {
  const values = Array.isArray(input) ? input : input.split(/[\n,，;；]+/);
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const keyword = value.trim().slice(0, 20);
    const key = keyword.toLocaleLowerCase("zh-CN");
    if (!keyword || seen.has(key) || seen.size >= 12) return [];
    seen.add(key);
    return [keyword];
  });
}

export function normalizeExternalSourceInput(input: ExternalSourceInput, fallbackSourceLabel: string) {
  const url = input.url.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("收藏链接格式不正确");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("收藏链接必须使用 HTTP 或 HTTPS");
  const summary = input.summary?.trim().slice(0, 4_000) || "";
  const fallbackTitle = summary.split("\n").find((line) => line.trim())?.trim() || `${fallbackSourceLabel} · 待看内容`;
  return {
    url: parsed.toString(),
    title: input.title?.trim().slice(0, 120) || (fallbackTitle.length > 34 ? `${fallbackTitle.slice(0, 34)}…` : fallbackTitle),
    summary,
    sourceLabel: input.sourceLabel?.trim().slice(0, 60) || fallbackSourceLabel,
  };
}

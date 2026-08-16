import type { Article } from "./types";

export function isInboxArticle(article: Pick<Article, "branch">) {
  return article.branch === "待分类";
}

export function isSourceArticle(article: Pick<Article, "collection" | "type">) {
  return article.collection === "sources" || article.type === "外部资料";
}

export function isThoughtInboxArticle(article: Pick<Article, "branch" | "collection" | "type">) {
  return isInboxArticle(article) && !isSourceArticle(article);
}

export function pickRediscoverySource<T extends Pick<Article, "branch" | "collection" | "type" | "title" | "summary" | "body" | "tags" | "source" | "created">>(
  articles: T[],
  context: string,
  today: string,
) {
  const tokens = uniqueSearchTokens(context);
  const todayTime = new Date(`${today}T12:00:00`).getTime();
  const candidates = articles
    .filter((article) => isSourceArticle(article)
      && article.branch !== "已归档"
      && article.source.some((item) => /^https?:\/\//i.test(item)))
    .map((article) => {
      const text = [article.title, article.summary, article.body, article.tags.join(" "), article.source.join(" ")].join(" ").toLocaleLowerCase("zh-CN");
      const matched = tokens.filter((token) => text.includes(token));
      const createdTime = new Date(`${article.created.slice(0, 10)}T12:00:00`).getTime();
      const ageDays = Number.isFinite(createdTime) ? Math.max(0, Math.floor((todayTime - createdTime) / 86_400_000)) : 0;
      return { article, matched, ageDays };
    })
    .filter((item) => item.matched.length > 0 || item.ageDays >= 7)
    .sort((left, right) => {
      const relevance = right.matched.length - left.matched.length;
      return relevance || right.ageDays - left.ageDays;
    });
  const best = candidates[0];
  if (!best) return null;
  return {
    article: best.article,
    reason: best.matched.length
      ? `与你今天的安排相关：${best.matched.slice(0, 2).join("、")}`
      : `已经收藏 ${best.ageDays} 天，值得再看一眼`,
  };
}

function uniqueSearchTokens(value: string) {
  const segments = value.toLocaleLowerCase("zh-CN")
    .split(/[\s、，。；：/·（）()《》]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
  const tokens = segments.flatMap((segment) => {
    if (!/[\u3400-\u9fff]/.test(segment) || segment.length <= 4) return [segment];
    return [segment, ...Array.from({ length: segment.length - 3 }, (_, index) => segment.slice(index, index + 4))];
  });
  return [...new Set(tokens)];
}

import type { Article } from "./types";

export function isInboxArticle(article: Pick<Article, "branch">) {
  return article.branch === "待分类";
}

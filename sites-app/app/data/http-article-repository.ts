import type { Article, StoredArticle } from "../types";
import {
  ArticleRepositoryError,
  sortArticles,
  toStoredArticle,
  type ArticleRepository,
} from "./article-repository";

type FetchLike = typeof fetch;
type ArticleApiResponse = {
  articles?: Article[];
  article?: Article;
  error?: string;
  ok?: boolean;
};

export class HttpArticleRepository implements ArticleRepository {
  constructor(
    private readonly baseUrl = "/api/articles",
    private readonly fetcher: FetchLike = fetch,
  ) {}

  async list(): Promise<StoredArticle[]> {
    try {
      const response = await this.fetcher(this.baseUrl, { cache: "no-store" });
      const data = (await response.json()) as ArticleApiResponse;
      if (!response.ok) throw new Error(data.error || "读取失败");
      return sortArticles(((data.articles || []) as Article[]).map(toStoredArticle));
    } catch (error) {
      throw new ArticleRepositoryError(
        error instanceof Error ? error.message : "读取知识库失败",
        "read_failed",
        error,
      );
    }
  }

  async save(article: Article): Promise<StoredArticle> {
    try {
      const response = await this.fetcher(this.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(article),
      });
      const data = (await response.json()) as ArticleApiResponse;
      if (!response.ok) throw new Error(data.error || "保存失败");
      if (!data.article) throw new Error("保存结果缺少内容");
      return toStoredArticle(data.article);
    } catch (error) {
      throw new ArticleRepositoryError(
        error instanceof Error ? error.message : "保存内容失败",
        "save_failed",
        error,
      );
    }
  }

  async remove(id: string): Promise<void> {
    try {
      const response = await this.fetcher(this.baseUrl, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = (await response.json()) as ArticleApiResponse;
      if (!response.ok) throw new Error(data.error || "移除失败");
    } catch (error) {
      throw new ArticleRepositoryError(
        error instanceof Error ? error.message : "移除内容失败",
        "remove_failed",
        error,
      );
    }
  }
}

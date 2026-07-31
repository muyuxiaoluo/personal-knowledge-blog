import type { Article, StoredArticle } from "../types";

export type ArticleChange = {
  article: StoredArticle;
  operation: "upsert" | "delete";
};

export type SyncedArticleVersion = {
  id: string;
  version: number;
};

export type RemoteApplyResult = {
  applied: number;
  conflicts: number;
};

export interface ArticleRepository {
  list(): Promise<StoredArticle[]>;
  save(article: Article): Promise<StoredArticle>;
  remove(id: string): Promise<void>;
}

export interface SyncCapableArticleRepository extends ArticleRepository {
  getDeviceId(): Promise<string>;
  listPendingChanges(): Promise<ArticleChange[]>;
  markSynced(versions: SyncedArticleVersion[]): Promise<void>;
  applyRemoteChanges(changes: ArticleChange[]): Promise<RemoteApplyResult>;
  getSyncCursor(): Promise<string>;
  setSyncCursor(cursor: string): Promise<void>;
}

export class ArticleRepositoryError extends Error {
  constructor(
    message: string,
    readonly code: "read_failed" | "save_failed" | "remove_failed" | "invalid_data",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ArticleRepositoryError";
  }
}

export function toStoredArticle(article: Article): StoredArticle {
  return {
    ...article,
    tags: [...article.tags],
    source: [...article.source],
    storage: article.storage ?? {
      version: 1,
      deviceId: "",
      syncStatus: "synced",
      deletedAt: null,
    },
  };
}

export function sortArticles(articles: StoredArticle[]) {
  return [...articles].sort((a, b) =>
    String(b.updated || b.created).localeCompare(String(a.updated || a.created)),
  );
}

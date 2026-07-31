export type Article = {
  id: string;
  slug: string;
  collection: string;
  collectionLabel: string;
  title: string;
  created: string;
  updated: string;
  branch: string;
  subbranch: string;
  stage: string;
  validity: string;
  category: string;
  tags: string[];
  type: string;
  project: string;
  confidence: string;
  source: string[];
  reviewDate: string;
  summary: string;
  next: string;
  body: string;
  storage?: ArticleStorageMetadata;
};

export type ArticleSyncStatus = "synced" | "pending" | "conflict";

export type ArticleStorageMetadata = {
  version: number;
  deviceId: string;
  syncStatus: ArticleSyncStatus;
  deletedAt: string | null;
};

export type StoredArticle = Article & {
  storage: ArticleStorageMetadata;
};

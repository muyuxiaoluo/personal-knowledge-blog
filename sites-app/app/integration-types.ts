export type GitHubRepositoryConfig = {
  id: string;
  owner: string;
  name: string;
  displayName: string;
  enabled: boolean;
  homePinned: boolean;
  order: number;
};

export type GitHubCommit = {
  sha: string;
  message: string;
  author: string;
  committedAt: string;
  url: string;
};

export type GitHubRelease = {
  id: number;
  name: string;
  tagName: string;
  publishedAt: string;
  url: string;
};

export type GitHubRepositorySnapshot = {
  repository: string;
  url: string;
  commits: GitHubCommit[];
  releases: GitHubRelease[];
  fetchedAt: string;
};

export type ModelBalance = {
  provider: "deepseek" | "qwen";
  available: boolean;
  amount: string;
  cashAmount: string;
  grantedAmount: string;
  currency: string;
  fetchedAt: string;
  message: string;
};

export type ModelUsageRow = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type UsageConsoleSnapshot = {
  provider: "deepseek" | "qwen";
  rows: ModelUsageRow[];
  fetchedAt: string;
  message: string;
};

export type IntegrationCache<T> = {
  key: string;
  value: T;
  fetchedAt: string;
};

export type SecretKind =
  | "github_pat"
  | "deepseek_api_key"
  | "aliyun_access_key_id"
  | "aliyun_access_key_secret"
  | "qwen_monitor_credential";

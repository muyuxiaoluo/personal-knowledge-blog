import type { StoredArticle } from "../types";
import type {
  ArticleChange,
  SyncCapableArticleRepository,
  SyncedArticleVersion,
} from "./article-repository";

export type LoginResult = {
  accessToken: string;
  expiresAt: string;
  username: string;
};

export type SyncResult = {
  uploaded: number;
  downloaded: number;
  conflicts: number;
  cursor: string;
};

type SyncResponse = {
  protocolVersion?: 2;
  cursor: string;
  hasMore?: boolean;
  accepted: SyncedArticleVersion[];
  conflicts: ArticleChange[];
  changes: ArticleChange[];
};

type CloudSyncClientOptions = {
  timeoutMs?: number;
  maxPages?: number;
};

const legacyPageSize = 5000;

export class CloudSyncError extends Error {
  constructor(
    message: string,
    readonly code:
      | "network_error"
      | "unauthorized"
      | "invalid_response"
      | "server_error",
  ) {
    super(message);
    this.name = "CloudSyncError";
  }
}

export class CloudSyncClient {
  private readonly timeoutMs: number;
  private readonly maxPages: number;

  constructor(
    private readonly repository: SyncCapableArticleRepository,
    private readonly baseUrl: string,
    options: CloudSyncClientOptions = {},
  ) {
    this.timeoutMs = positiveInteger(options.timeoutMs, 15_000);
    this.maxPages = positiveInteger(options.maxPages, 100);
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const response = await this.request("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    return parseLoginResult(response);
  }

  async sync(accessToken: string): Promise<SyncResult> {
    const [initialCursor, deviceId, pending] = await Promise.all([
      this.repository.getSyncCursor(),
      this.repository.getDeviceId(),
      this.repository.listPendingChanges(),
    ]);
    let cursor = initialCursor;
    let outgoing = pending;
    let uploaded = 0;
    let downloaded = 0;
    let conflicts = 0;

    for (let page = 1; page <= this.maxPages; page += 1) {
      const response = await this.request("/v1/sync", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ cursor, deviceId, changes: outgoing }),
      });
      const result = parseSyncResponse(response);
      const shouldContinue =
        result.hasMore ?? result.changes.length >= legacyPageSize;
      validatePageCursor(result, cursor, shouldContinue);

      const remoteResult = await this.repository.commitSyncResult(
        result.accepted,
        [...result.changes, ...result.conflicts],
        result.cursor,
      );
      uploaded += result.accepted.length;
      downloaded += remoteResult.applied;
      conflicts += remoteResult.conflicts;

      if (!shouldContinue) {
        return {
          uploaded,
          downloaded,
          conflicts,
          cursor: result.cursor,
        };
      }
      if (page === this.maxPages) {
        throw new CloudSyncError(
          "同步数据页数超出安全上限，请稍后继续同步。",
          "invalid_response",
        );
      }
      cursor = result.cursor;
      outgoing = [];
    }

    throw new CloudSyncError("同步未能完成。", "invalid_response");
  }

  private async request(path: string, init: RequestInit) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...init.headers,
          },
        });
      } catch {
        throw connectionError(controller.signal.aborted);
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        if (controller.signal.aborted) throw connectionError(true);
        if (response.ok) {
          throw new CloudSyncError(
            "同步服务器返回了无法识别的数据。",
            "invalid_response",
          );
        }
      }

      if (response.status === 401) {
        throw new CloudSyncError("登录已失效，请重新登录。", "unauthorized");
      }
      if (!response.ok) {
        const message =
          isRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : "同步服务器暂时不可用。";
        throw new CloudSyncError(message, "server_error");
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseLoginResult(value: unknown): LoginResult {
  if (
    !isRecord(value) ||
    typeof value.accessToken !== "string" ||
    typeof value.expiresAt !== "string" ||
    typeof value.username !== "string"
  ) {
    throw invalidResponse("登录响应格式不正确。");
  }
  return {
    accessToken: value.accessToken,
    expiresAt: value.expiresAt,
    username: value.username,
  };
}

function parseSyncResponse(value: unknown): SyncResponse {
  if (
    !isRecord(value) ||
    typeof value.cursor !== "string" ||
    !Array.isArray(value.accepted) ||
    !Array.isArray(value.conflicts) ||
    !Array.isArray(value.changes) ||
    (value.protocolVersion !== undefined && value.protocolVersion !== 2) ||
    (value.hasMore !== undefined && typeof value.hasMore !== "boolean")
  ) {
    throw invalidResponse("同步响应格式不正确。");
  }
  return {
    ...(value.protocolVersion === 2 ? { protocolVersion: 2 as const } : {}),
    cursor: value.cursor,
    ...(typeof value.hasMore === "boolean" ? { hasMore: value.hasMore } : {}),
    accepted: value.accepted.map(parseSyncedVersion),
    conflicts: value.conflicts.map(parseArticleChange),
    changes: value.changes.map(parseArticleChange),
  };
}

function parseSyncedVersion(value: unknown): SyncedArticleVersion {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1
  ) {
    throw invalidResponse("同步响应中的确认记录不正确。");
  }
  return { id: value.id, version: Number(value.version) };
}

function parseArticleChange(value: unknown): ArticleChange {
  if (
    !isRecord(value) ||
    (value.operation !== "upsert" && value.operation !== "delete") ||
    (value.changeId !== undefined &&
      (typeof value.changeId !== "string" || !value.changeId))
  ) {
    throw invalidResponse("同步响应中的文章变更不正确。");
  }
  return {
    article: parseStoredArticle(value.article),
    operation: value.operation,
    ...(typeof value.changeId === "string" ? { changeId: value.changeId } : {}),
  };
}

function parseStoredArticle(value: unknown): StoredArticle {
  const stringFields = [
    "id",
    "slug",
    "collection",
    "collectionLabel",
    "title",
    "created",
    "updated",
    "branch",
    "subbranch",
    "stage",
    "validity",
    "category",
    "type",
    "project",
    "confidence",
    "reviewDate",
    "summary",
    "next",
    "body",
  ];
  if (
    !isRecord(value) ||
    stringFields.some((field) => typeof value[field] !== "string") ||
    !value.id ||
    (value.projectId !== undefined && typeof value.projectId !== "string") ||
    !isStringArray(value.tags) ||
    !isStringArray(value.source) ||
    !isRecord(value.storage) ||
    !Number.isSafeInteger(value.storage.version) ||
    Number(value.storage.version) < 1 ||
    typeof value.storage.deviceId !== "string" ||
    !["synced", "pending", "conflict"].includes(
      String(value.storage.syncStatus),
    ) ||
    (value.storage.deletedAt !== null &&
      typeof value.storage.deletedAt !== "string")
  ) {
    throw invalidResponse("同步响应中的文章数据不完整。");
  }
  return value as StoredArticle;
}

function connectionError(timedOut: boolean) {
  return new CloudSyncError(
    timedOut
      ? "同步服务器响应超时，本地内容不受影响。"
      : "暂时无法连接同步服务器，本地内容不受影响。",
    "network_error",
  );
}

function validatePageCursor(
  result: SyncResponse,
  previousCursor: string,
  shouldContinue: boolean,
) {
  if (shouldContinue && result.cursor === previousCursor) {
    throw invalidResponse("同步服务器没有推进分页游标，已停止以避免重复同步。");
  }
  if (result.protocolVersion !== 2) return;
  if (!/^\d+$/.test(result.cursor)) {
    throw invalidResponse("同步服务器返回了无效游标。");
  }
  if (
    /^\d+$/.test(previousCursor) &&
    BigInt(result.cursor) < BigInt(previousCursor)
  ) {
    throw invalidResponse("同步服务器返回的游标发生倒退。");
  }
}

function invalidResponse(message: string) {
  return new CloudSyncError(message, "invalid_response");
}

function positiveInteger(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

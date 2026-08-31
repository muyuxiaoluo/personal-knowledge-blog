import type { StoredArticle } from "../types";
import type {
  ArticleChange,
  SyncCapableArticleRepository,
  SyncedArticleVersion,
} from "./article-repository";
import {
  type RemoteSyncEntity,
  type SyncAccepted,
  type SyncConflictResponse,
  type SyncEntityType,
  type SyncFailed,
  type UniversalSyncRepository,
  type UniversalSyncResponse,
} from "./universal-sync-repository";
import {
  type AttachmentRepository,
  attachmentManifestFromSyncPayload,
} from "./attachment-repository";

export type LoginResult = {
  accessToken: string;
  expiresAt: string;
  username: string;
  refreshToken?: string;
  refreshExpiresAt?: string;
};

export type SyncResult = {
  uploaded: number;
  downloaded: number;
  conflicts: number;
  cursor: string;
  protocolVersion?: 2 | 3;
  limited?: boolean;
  attachmentUploads?: number;
  attachmentDownloads?: number;
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
  universalRepository?: UniversalSyncRepository;
  attachmentRepository?: AttachmentRepository;
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
  private readonly universalRepository?: UniversalSyncRepository;
  private readonly attachmentRepository?: AttachmentRepository;
  private v3Supported: boolean | null = null;

  constructor(
    private readonly repository: SyncCapableArticleRepository,
    private readonly baseUrl: string,
    options: CloudSyncClientOptions = {},
  ) {
    this.timeoutMs = positiveInteger(options.timeoutMs, 15_000);
    this.maxPages = positiveInteger(options.maxPages, 100);
    this.universalRepository = options.universalRepository;
    this.attachmentRepository = options.attachmentRepository;
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const deviceId = await this.universalRepository?.getDeviceId();
    const response = await this.request("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password, ...(deviceId ? { deviceId } : {}) }),
    });
    return parseLoginResult(response);
  }

  async refresh(refreshToken: string): Promise<LoginResult> {
    const response = await this.request("/v3/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    });
    return parseLoginResult(response);
  }

  async logout(refreshToken: string) {
    await this.request("/v3/auth/logout", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    });
  }

  async sync(accessToken: string): Promise<SyncResult> {
    if (this.universalRepository && await this.supportsV3()) {
      return this.syncV3(accessToken);
    }
    return this.syncV2(accessToken);
  }

  private async supportsV3() {
    if (this.v3Supported !== null) return this.v3Supported;
    try {
      const response = await this.request("/v3/health", { method: "GET" });
      this.v3Supported = isRecord(response)
        && Array.isArray(response.protocolVersions)
        && response.protocolVersions.includes(3);
    } catch (error) {
      if (error instanceof CloudSyncError && error.code === "server_error") {
        this.v3Supported = false;
      } else {
        throw error;
      }
    }
    return this.v3Supported;
  }

  private async syncV2(accessToken: string): Promise<SyncResult> {
    const [initialCursor, deviceId, pending] = await Promise.all([
      this.repository.getSyncCursor(),
      this.repository.getDeviceId(),
      this.repository.listPendingChanges(),
    ]);
    let cursor = initialCursor;
    let outgoing = pending.filter((change) => !change.article.body.includes("attachment://"));
    const limited = outgoing.length !== pending.length || Boolean(this.universalRepository);
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
          ...(this.universalRepository ? { protocolVersion: 2 as const, limited } : {}),
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

  private async syncV3(accessToken: string): Promise<SyncResult> {
    const repository = this.universalRepository;
    if (!repository) throw new CloudSyncError("通用同步尚未初始化。", "invalid_response");
    let cursor = await repository.getCursor();
    const deviceId = await repository.getDeviceId();
    let uploaded = 0;
    let downloaded = 0;
    let conflicts = 0;
    let attachmentUploads = 0;
    let attachmentDownloads = 0;

    for (let page = 1; page <= this.maxPages; page += 1) {
      const outgoing = await repository.listPending();
      if (this.attachmentRepository) {
        for (const item of outgoing) {
          if (item.entityType !== "attachment" || item.operation !== "upsert") continue;
          const manifest = attachmentManifestFromSyncPayload(item.id, item.payload);
          if (!manifest) throw invalidResponse(`附件 ${item.id} 的清单不完整。`);
          attachmentUploads += await this.attachmentRepository.uploadForSync(
            this.baseUrl,
            accessToken,
            manifest,
          );
        }
      }
      const response = await this.request("/v3/sync", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ cursor, deviceId, changes: outgoing }),
      });
      const result = parseV3SyncResponse(response);
      if (result.hasMore && result.cursor === cursor) {
        throw invalidResponse("同步服务器没有推进 v3 分页游标。");
      }
      if (this.attachmentRepository) {
        const remoteAttachments = [
          ...result.changes,
          ...result.conflicts.flatMap((item) => item.remote ? [item.remote] : []),
        ];
        for (const item of remoteAttachments) {
          if (item.entityType !== "attachment" || item.operation !== "upsert") continue;
          const manifest = attachmentManifestFromSyncPayload(item.id, item.payload);
          if (!manifest) throw invalidResponse(`云端附件 ${item.id} 的清单不完整。`);
          if (await this.attachmentRepository.downloadForSync(
            this.baseUrl,
            accessToken,
            manifest,
          )) attachmentDownloads += 1;
        }
      }
      await repository.commit(result);
      uploaded += result.accepted.length;
      downloaded += result.changes.length;
      conflicts += result.conflicts.length;
      cursor = result.cursor;
      const moreLocal = (await repository.listPending(1)).length > 0;
      if (!result.hasMore && !moreLocal) {
        return {
          uploaded,
          downloaded,
          conflicts,
          cursor,
          protocolVersion: 3,
          limited: false,
          attachmentUploads,
          attachmentDownloads,
        };
      }
      if (page === this.maxPages) {
        throw new CloudSyncError("同步数据页数超出安全上限，请稍后继续同步。", "invalid_response");
      }
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
    ...(typeof value.refreshToken === "string" ? { refreshToken: value.refreshToken } : {}),
    ...(typeof value.refreshExpiresAt === "string" ? { refreshExpiresAt: value.refreshExpiresAt } : {}),
  };
}

function parseV3SyncResponse(value: unknown): UniversalSyncResponse {
  if (
    !isRecord(value)
    || value.protocolVersion !== 3
    || typeof value.cursor !== "string"
    || typeof value.hasMore !== "boolean"
    || !Array.isArray(value.accepted)
    || !Array.isArray(value.conflicts)
    || !Array.isArray(value.failed)
    || !Array.isArray(value.changes)
  ) {
    throw invalidResponse("同步服务器返回的 v3 数据不完整。");
  }
  return {
    protocolVersion: 3,
    cursor: value.cursor,
    hasMore: value.hasMore,
    accepted: value.accepted.map(parseV3Accepted),
    conflicts: value.conflicts.map(parseV3Conflict),
    failed: value.failed.map(parseV3Failed),
    changes: value.changes.map((item) => parseV3Remote(item, true)),
  };
}

const v3EntityTypes = new Set<SyncEntityType>([
  "article", "attachment", "project", "milestone", "task", "log", "proposal",
  "task_plan", "focus_session", "weekly_focus", "weekly_review", "daily_closeout",
  "calendar_event", "rest_day", "preference",
]);

function parseEntityType(value: unknown): SyncEntityType {
  if (typeof value !== "string" || !v3EntityTypes.has(value as SyncEntityType)) {
    throw invalidResponse("同步响应包含未知的数据类型。");
  }
  return value as SyncEntityType;
}

function parseV3Accepted(value: unknown): SyncAccepted {
  if (!isRecord(value)
    || typeof value.id !== "string" || !value.id
    || typeof value.changeId !== "string" || !value.changeId
    || !Number.isSafeInteger(value.version) || Number(value.version) < 1) {
    throw invalidResponse("同步响应中的 v3 确认记录不正确。");
  }
  return {
    entityType: parseEntityType(value.entityType),
    id: value.id,
    version: Number(value.version),
    changeId: value.changeId,
  };
}

function parseV3Remote(value: unknown, requireChangeId: boolean): RemoteSyncEntity {
  if (!isRecord(value)
    || typeof value.id !== "string" || !value.id
    || !isRecord(value.payload)
    || (value.operation !== "upsert" && value.operation !== "delete")
    || !Number.isSafeInteger(value.version) || Number(value.version) < 1
    || typeof value.updatedAt !== "string"
    || (value.deletedAt !== null && typeof value.deletedAt !== "string")
    || (requireChangeId && (typeof value.changeId !== "string" || !value.changeId))) {
    throw invalidResponse("同步响应中的 v3 远端记录不正确。");
  }
  return {
    entityType: parseEntityType(value.entityType),
    id: value.id,
    payload: value.payload,
    version: Number(value.version),
    operation: value.operation,
    changeId: typeof value.changeId === "string" ? value.changeId : "server-conflict",
    deletedAt: value.deletedAt,
    updatedAt: value.updatedAt,
  };
}

function parseV3Conflict(value: unknown): SyncConflictResponse {
  if (!isRecord(value)
    || typeof value.id !== "string" || !value.id
    || typeof value.changeId !== "string" || !value.changeId
    || (value.remote !== null && !isRecord(value.remote))) {
    throw invalidResponse("同步响应中的 v3 冲突记录不正确。");
  }
  return {
    changeId: value.changeId,
    entityType: parseEntityType(value.entityType),
    id: value.id,
    remote: value.remote === null ? null : parseV3Remote(value.remote, false),
  };
}

function parseV3Failed(value: unknown): SyncFailed {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.index) || Number(value.index) < 0
    || typeof value.changeId !== "string"
    || typeof value.error !== "string" || !value.error) {
    throw invalidResponse("同步响应中的 v3 错误记录不正确。");
  }
  return { index: Number(value.index), changeId: value.changeId, error: value.error };
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

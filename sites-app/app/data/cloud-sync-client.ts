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
  cursor: string;
  accepted: SyncedArticleVersion[];
  conflicts: ArticleChange[];
  changes: ArticleChange[];
};

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
  constructor(
    private readonly repository: SyncCapableArticleRepository,
    private readonly baseUrl: string,
  ) {}

  async login(username: string, password: string): Promise<LoginResult> {
    const response = await this.request("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    return parseLoginResult(response);
  }

  async sync(accessToken: string): Promise<SyncResult> {
    const [cursor, deviceId, pending] = await Promise.all([
      this.repository.getSyncCursor(),
      this.repository.getDeviceId(),
      this.repository.listPendingChanges(),
    ]);

    const response = await this.request("/v1/sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ cursor, deviceId, changes: pending }),
    });
    const result = parseSyncResponse(response);

    await this.repository.markSynced(result.accepted);
    const remoteResult = await this.repository.applyRemoteChanges([
      ...result.changes,
      ...result.conflicts,
    ]);
    await this.repository.setSyncCursor(result.cursor);

    return {
      uploaded: result.accepted.length,
      downloaded: remoteResult.applied,
      conflicts: remoteResult.conflicts,
      cursor: result.cursor,
    };
  }

  private async request(path: string, init: RequestInit) {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...init.headers,
        },
      });
    } catch {
      throw new CloudSyncError(
        "暂时无法连接同步服务器，本地内容不受影响。",
        "network_error",
      );
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
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
  }
}

function parseLoginResult(value: unknown): LoginResult {
  if (
    !isRecord(value) ||
    typeof value.accessToken !== "string" ||
    typeof value.expiresAt !== "string" ||
    typeof value.username !== "string"
  ) {
    throw new CloudSyncError("登录响应格式不正确。", "invalid_response");
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
    !Array.isArray(value.changes)
  ) {
    throw new CloudSyncError("同步响应格式不正确。", "invalid_response");
  }
  return value as SyncResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

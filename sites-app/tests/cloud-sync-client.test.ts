import assert from "node:assert/strict";
import test from "node:test";
import type { Article, StoredArticle } from "../app/types";
import type {
  ArticleChange,
  RemoteApplyResult,
  SyncCapableArticleRepository,
  SyncedArticleVersion,
} from "../app/data/article-repository";
import {
  CloudSyncClient,
  CloudSyncError,
} from "../app/data/cloud-sync-client";
import type { UniversalSyncRepository } from "../app/data/universal-sync-repository";
import type { AttachmentRepository } from "../app/data/attachment-repository";
import { errorMessage } from "../app/data/error-message";

test("password change sends authenticated credentials and preserves server validation errors", async context => {
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  let request: RequestInit | undefined;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://example.test/v1/auth/change-password"); request = init;
    return Response.json({ changed: true });
  };
  const client = new CloudSyncClient(new RecordingRepository(), "https://example.test");
  await client.changePassword("token", "old-password", "new-password-123");
  assert.equal(new Headers(request?.headers).get("Authorization"), "Bearer token");
  assert.deepEqual(JSON.parse(String(request?.body)), { currentPassword: "old-password", newPassword: "new-password-123" });
  globalThis.fetch = async () => Response.json({ error: "当前密码不正确。" }, { status: 400 });
  await assert.rejects(client.changePassword("token", "wrong", "new-password-123"), /当前密码不正确/);
});

test("native string errors retain the actual sync failure", () => {
  assert.equal(errorMessage("无法检查云端附件：连接失败", "同步没有完成"), "无法检查云端附件：连接失败");
});

test("unavailable remote images do not prevent committing records and their manifests", async context => {
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  const remote = { entityType: "attachment", id: "image", operation: "upsert", changeId: "remote-image", version: 1, deletedAt: null, updatedAt: "2026-09-09T00:00:00Z", payload: { original_hash: "a".repeat(64), preview_hash: "b".repeat(64), original_mime_type: "image/png", preview_mime_type: "image/png" } };
  let committed = false;
  const repo = { getCursor: async () => "", getDeviceId: async () => "device", listPending: async () => [], commit: async (result: { changes: unknown[] }) => { assert.deepEqual(result.changes[0], remote); committed = true; } } as unknown as UniversalSyncRepository;
  globalThis.fetch = async url => Response.json(String(url).endsWith("/v3/health") ? { protocolVersions: [3] } : { protocolVersion: 3, cursor: "1", hasMore: false, accepted: [], conflicts: [], failed: [], changes: [remote] });
  const attachmentRepository = { downloadForSync: async () => { throw "附件下载中断"; } } as unknown as AttachmentRepository;
  const result = await new CloudSyncClient(new RecordingRepository(), "https://example.test", { universalRepository: repo, attachmentRepository }).sync("token");
  assert.equal(committed, true);
  assert.equal(result.deferredDownloads, 1);
  attachmentRepository.downloadForSync = async () => { throw "附件下载失败：HTTP 401 Unauthorized"; };
  await assert.rejects(new CloudSyncClient(new RecordingRepository(), "https://example.test", { universalRepository: repo, attachmentRepository }).sync("token"), error => error instanceof CloudSyncError && error.code === "unauthorized");
});

test("a failed attachment is retained for retry while other records complete", async context => {
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  const pending = [
    { entityType: "attachment", id: "image", changeId: "image-change", operation: "upsert", baseVersion: 0, payload: { original_hash: "a".repeat(64), preview_hash: "b".repeat(64), original_mime_type: "image/png", preview_mime_type: "image/png" } },
    { entityType: "task", id: "task", changeId: "task-change", operation: "upsert", baseVersion: 0, payload: {} },
  ];
  const errors: string[] = [];
  const sent: string[] = [];
  const repo = {
    getCursor: async () => "", getDeviceId: async () => "device", listPending: async () => pending,
    markError: async (id: string, error: string) => { errors.push(error); pending.splice(pending.findIndex(i => i.changeId === id), 1); },
    commit: async () => { pending.length = 0; },
  } as unknown as UniversalSyncRepository;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/v3/health")) return Response.json({ protocolVersions: [3] });
    const body = JSON.parse(String(init?.body));
    sent.push(...body.changes.map((item: { id: string }) => item.id));
    return Response.json({ protocolVersion: 3, cursor: "1", hasMore: false, accepted: body.changes.map((i: object) => ({ ...i, version: 1 })), changes: [], conflicts: [], failed: [] });
  };
  const attachmentRepository = { uploadForSync: async () => { throw "无法检查云端附件：连接失败"; } } as unknown as AttachmentRepository;
  const result = await new CloudSyncClient(new RecordingRepository(), "https://example.test", { universalRepository: repo, attachmentRepository }).sync("token");
  assert.deepEqual(sent, ["task"]);
  assert.equal(result.uploaded, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(errors, ["无法检查云端附件：连接失败"]);
});

test("login rejection is not reported as an expired session", async context => {
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => Response.json({ error: "账户或密码不正确。" }, { status: 401 });
  const client = new CloudSyncClient(new RecordingRepository(), "https://example.test");
  await assert.rejects(client.login("owner", "wrong-password"), error => error instanceof CloudSyncError && error.code === "unauthorized" && error.message.includes("账户或密码不正确") && !error.message.includes("失效"));
  await assert.rejects(client.refresh("expired-token"), /登录已失效/);
});

test("v3 parses the existing task_plan_history and daily_situation types", async context => {
  const original = globalThis.fetch; context.after(() => { globalThis.fetch = original; });
  const changes = ["task_plan_history", "daily_situation"].map(entityType => ({ entityType, id: "id", version: 1, payload: {}, operation: "upsert", changeId: entityType, updatedAt: "2026-09-07T00:00:00Z", deletedAt: null }));
  const committed: unknown[] = [];
  globalThis.fetch = (async input => new Response(JSON.stringify(String(input).endsWith("/v3/health") ? { protocolVersions: [2, 3] } : { protocolVersion: 3, cursor: "2", hasMore: false, accepted: [], conflicts: [], failed: [], changes }), { status: 200 })) as typeof fetch;
  const universal = { getCursor: async () => "", getDeviceId: async () => "device", listPending: async () => [], commit: async (response: unknown) => { committed.push(response); } } as unknown as UniversalSyncRepository;
  const client = new CloudSyncClient(new RecordingRepository(), "https://example.test", { universalRepository: universal });
  const result = await client.sync("token"); assert.equal(result.downloaded, 2); assert.equal(committed.length, 1);
});

class RecordingRepository implements SyncCapableArticleRepository {
  readonly commits: Array<{
    versions: SyncedArticleVersion[];
    changes: ArticleChange[];
    cursor: string;
  }> = [];

  constructor(readonly pending: ArticleChange[] = []) {}

  async list() {
    return [];
  }

  async save(article: Article) {
    return article as StoredArticle;
  }

  async remove() {}

  async getDeviceId() {
    return "test-device";
  }

  async listPendingChanges() {
    return this.pending;
  }

  async markSynced() {}

  async applyRemoteChanges(changes: ArticleChange[]): Promise<RemoteApplyResult> {
    return { applied: changes.length, conflicts: 0 };
  }

  async commitSyncResult(
    versions: SyncedArticleVersion[],
    changes: ArticleChange[],
    cursor: string,
  ): Promise<RemoteApplyResult> {
    this.commits.push({ versions, changes, cursor });
    return { applied: changes.length, conflicts: 0 };
  }

  async getSyncCursor() {
    return "100";
  }

  async setSyncCursor() {}
}

test("uploads once and commits every downloaded page", async (context) => {
  const local = article("notes/local", 1, "test-device", "本地待上传");
  const repository = new RecordingRepository([
    {
      article: local,
      operation: "upsert",
      changeId: "test-device:notes/local:1:upsert",
    },
  ]);
  const requests: Array<Record<string, unknown>> = [];
  const responses = [
    {
      protocolVersion: 2,
      cursor: "5000",
      hasMore: true,
      accepted: [{ id: local.id, version: 1 }],
      conflicts: [],
      changes: [
        { article: article("notes/remote-a", 2, "phone"), operation: "upsert" },
      ],
    },
    {
      protocolVersion: 2,
      cursor: "5001",
      hasMore: false,
      accepted: [],
      conflicts: [],
      changes: [
        { article: article("notes/remote-b", 1, "tablet"), operation: "upsert" },
      ],
    },
  ];
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json(responses.shift());
  }) as typeof fetch;

  const result = await new CloudSyncClient(repository, "https://sync.test/").sync(
    "token",
  );

  assert.deepEqual(result, {
    uploaded: 1,
    downloaded: 2,
    conflicts: 0,
    cursor: "5001",
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].cursor, "100");
  assert.equal((requests[0].changes as unknown[]).length, 1);
  assert.equal(requests[1].cursor, "5000");
  assert.deepEqual(requests[1].changes, []);
  assert.deepEqual(
    repository.commits.map((commit) => commit.cursor),
    ["5000", "5001"],
  );
});

test("rejects malformed response elements before advancing local state", async (context) => {
  const repository = new RecordingRepository();
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () =>
    Response.json({
      protocolVersion: 2,
      cursor: "101",
      hasMore: false,
      accepted: [{ id: "notes/local", version: "one" }],
      conflicts: [],
      changes: [],
    })) as typeof fetch;

  await assert.rejects(
    () => new CloudSyncClient(repository, "https://sync.test").sync("token"),
    (error) =>
      error instanceof CloudSyncError && error.code === "invalid_response",
  );
  assert.equal(repository.commits.length, 0);
});

test("rejects a stalled pagination cursor before committing the page", async (context) => {
  const repository = new RecordingRepository();
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () =>
    Response.json({
      protocolVersion: 2,
      cursor: "100",
      hasMore: true,
      accepted: [],
      conflicts: [],
      changes: [
        { article: article("notes/repeated", 1, "phone"), operation: "upsert" },
      ],
    })) as typeof fetch;

  await assert.rejects(
    () => new CloudSyncClient(repository, "https://sync.test").sync("token"),
    (error) =>
      error instanceof CloudSyncError && error.code === "invalid_response",
  );
  assert.equal(repository.commits.length, 0);
});

test("aborts a stalled sync request without changing local state", async (context) => {
  const repository = new RecordingRepository();
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    })) as typeof fetch;

  await assert.rejects(
    () =>
      new CloudSyncClient(repository, "https://sync.test", {
        timeoutMs: 10,
      }).sync("token"),
    (error) =>
      error instanceof CloudSyncError &&
      error.code === "network_error" &&
      error.message.includes("超时"),
  );
  assert.equal(repository.commits.length, 0);
});

function article(
  id: string,
  version: number,
  deviceId: string,
  title = "远端文章",
): StoredArticle {
  return {
    id,
    slug: id.split("/").at(-1) || "article",
    collection: "notes",
    collectionLabel: "笔记",
    title,
    created: "2026-08-01",
    updated: "2026-08-01T08:00:00.000Z",
    branch: "知识整理",
    subbranch: "",
    stage: "常青",
    validity: "有效",
    category: "笔记",
    tags: ["同步"],
    type: "记录",
    project: "",
    projectId: "",
    confidence: "中",
    source: ["测试"],
    reviewDate: "",
    summary: "同步测试",
    next: "",
    body: "用于验证分页同步。",
    storage: {
      version,
      deviceId,
      syncStatus: "synced",
      deletedAt: null,
    },
  };
}

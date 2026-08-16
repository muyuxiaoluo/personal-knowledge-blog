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

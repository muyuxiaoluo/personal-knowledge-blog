import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSyncServer } from "../src/app.mjs";
import { SyncDatabase } from "../src/database.mjs";

const authSecret = "test-secret-that-is-longer-than-thirty-two-characters";

test("authenticates and synchronizes article changes", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mind-sync-"));
  const database = new SyncDatabase(path.join(directory, "test.sqlite3"));
  database.ensureOwner("owner", "a-secure-test-password");
  const server = createSyncServer({
    database,
    authSecret,
    logger: { error() {} },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const health = await fetch(`${baseUrl}/v1/health`).then((response) =>
    response.json(),
  );
  assert.equal(health.status, "ok");

  const loginResponse = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "owner",
      password: "a-secure-test-password",
    }),
  });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json();
  assert.ok(login.accessToken);

  const article = createArticle("thoughts/test", 1, "windows-device");
  const firstSync = await sync(baseUrl, login.accessToken, {
    cursor: "",
    deviceId: "windows-device",
    changes: [{ article, operation: "upsert" }],
  });
  assert.deepEqual(firstSync.accepted, [{ id: article.id, version: 1 }]);
  assert.equal(firstSync.changes.length, 1);
  assert.equal(firstSync.changes[0].article.storage.syncStatus, "synced");

  const pull = await sync(baseUrl, login.accessToken, {
    cursor: "",
    deviceId: "second-device",
    changes: [],
  });
  assert.equal(pull.changes.length, 1);
  assert.equal(pull.changes[0].article.title, "测试想法");

  const conflicting = createArticle(
    "thoughts/test",
    1,
    "second-device",
    "另一种写法",
  );
  const conflictResult = await sync(baseUrl, login.accessToken, {
    cursor: firstSync.cursor,
    deviceId: "second-device",
    changes: [{ article: conflicting, operation: "upsert" }],
  });
  assert.equal(conflictResult.accepted.length, 0);
  assert.equal(conflictResult.conflicts.length, 1);
  assert.equal(conflictResult.conflicts[0].article.title, "测试想法");

  const newer = createArticle(
    "thoughts/test",
    2,
    "second-device",
    "更新后的想法",
  );
  const updateResult = await sync(baseUrl, login.accessToken, {
    cursor: firstSync.cursor,
    deviceId: "second-device",
    changes: [{ article: newer, operation: "upsert" }],
  });
  assert.deepEqual(updateResult.accepted, [
    { id: newer.id, version: newer.storage.version },
  ]);
});

async function sync(baseUrl, token, payload) {
  const response = await fetch(`${baseUrl}/v1/sync`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function createArticle(id, version, deviceId, title = "测试想法") {
  return {
    id,
    slug: "test",
    collection: "thoughts",
    collectionLabel: "想法与随笔",
    title,
    created: "2026-07-31",
    updated: "2026-07-31T08:00:00.000Z",
    branch: "思考随笔",
    subbranch: "生活观察",
    stage: "种子",
    validity: "待验证",
    category: "想法与随笔",
    tags: ["测试"],
    type: "记录",
    project: "",
    confidence: "低",
    source: ["本地记录"],
    reviewDate: "",
    summary: "测试同步",
    next: "",
    body: "这是一条测试内容。",
    storage: {
      version,
      deviceId,
      syncStatus: "pending",
      deletedAt: null,
    },
  };
}

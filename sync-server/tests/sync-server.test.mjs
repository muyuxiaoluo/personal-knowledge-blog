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

  const malformedLogin = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: {}, password: [] }),
  });
  assert.equal(malformedLogin.status, 400);

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

  const malformedArticle = await fetch(`${baseUrl}/v1/sync`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      cursor: "",
      deviceId: "windows-device",
      changes: [
        {
          article: { ...createArticle("thoughts/bad", 1, "windows-device"), tags: "bad" },
          operation: "upsert",
          changeId: "windows-device:thoughts/bad:1",
        },
      ],
    }),
  });
  assert.equal(malformedArticle.status, 400);

  const article = createArticle("thoughts/test", 1, "windows-device");
  const firstSync = await sync(baseUrl, login.accessToken, {
    cursor: "",
    deviceId: "windows-device",
    changes: [
      { article, operation: "upsert", changeId: "windows-device:thoughts/test:1" },
    ],
  });
  assert.equal(firstSync.protocolVersion, 2);
  assert.equal(firstSync.hasMore, false);
  assert.deepEqual(firstSync.accepted, [{ id: article.id, version: 1 }]);
  assert.equal(firstSync.changes.length, 0);

  const retry = await sync(baseUrl, login.accessToken, {
    cursor: "",
    deviceId: "windows-device",
    changes: [
      { article, operation: "upsert", changeId: "windows-device:thoughts/test:1" },
    ],
  });
  assert.deepEqual(retry.accepted, [{ id: article.id, version: 1 }]);
  assert.equal(retry.changes.length, 0);
  assert.equal(
    database.database.prepare("SELECT COUNT(*) AS count FROM changes").get().count,
    1,
  );

  const pull = await sync(baseUrl, login.accessToken, {
    cursor: "",
    deviceId: "second-device",
    changes: [],
  });
  assert.equal(pull.changes.length, 1);
  assert.equal(pull.changes[0].article.title, "测试想法");

  const equivalent = createArticle("thoughts/test", 1, "second-device");
  const equivalentResult = await sync(baseUrl, login.accessToken, {
    cursor: "",
    deviceId: "second-device",
    changes: [
      {
        article: equivalent,
        operation: "upsert",
        changeId: "second-device:thoughts/test:1:same-content",
      },
    ],
  });
  assert.deepEqual(equivalentResult.accepted, [
    { id: equivalent.id, version: equivalent.storage.version },
  ]);
  assert.equal(equivalentResult.conflicts.length, 0);

  const conflicting = createArticle(
    "thoughts/test",
    1,
    "second-device",
    "另一种写法",
  );
  const conflictResult = await sync(baseUrl, login.accessToken, {
    cursor: firstSync.cursor,
    deviceId: "second-device",
    changes: [
      {
        article: conflicting,
        operation: "upsert",
        changeId: "second-device:thoughts/test:1:different-content",
      },
    ],
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
    changes: [
      {
        article: newer,
        operation: "upsert",
        changeId: "second-device:thoughts/test:2",
      },
    ],
  });
  assert.deepEqual(updateResult.accepted, [
    { id: newer.id, version: newer.storage.version },
  ]);
  assert.equal(
    database.database.prepare("SELECT COUNT(*) AS count FROM changes").get().count,
    1,
  );

  const shortPassword = await fetch(`${baseUrl}/v1/auth/change-password`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      currentPassword: "a-secure-test-password",
      newPassword: "too-short",
    }),
  });
  assert.equal(shortPassword.status, 400);

  const passwordChange = await fetch(`${baseUrl}/v1/auth/change-password`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      currentPassword: "a-secure-test-password",
      newPassword: "a-different-secure-password",
    }),
  });
  assert.equal(passwordChange.status, 200);

  const revokedToken = await fetch(`${baseUrl}/v1/sync`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ cursor: "", deviceId: "windows-device", changes: [] }),
  });
  assert.equal(revokedToken.status, 401);

  const oldPasswordLogin = await loginRequest(
    baseUrl,
    "a-secure-test-password",
  );
  assert.equal(oldPasswordLogin.status, 401);
  const newPasswordLogin = await loginRequest(
    baseUrl,
    "a-different-secure-password",
  );
  assert.equal(newPasswordLogin.status, 200);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const failed = await loginRequest(baseUrl, "definitely-wrong", {
      "X-Forwarded-For": `203.0.113.${attempt + 1}`,
    });
    assert.equal(failed.status, 401);
  }
  const limited = await loginRequest(baseUrl, "definitely-wrong", {
    "X-Forwarded-For": "198.51.100.200",
  });
  assert.equal(limited.status, 429);
});

test("applies CORS headers only for allowlisted origins", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mind-cors-"));
  const database = new SyncDatabase(path.join(directory, "test.sqlite3"));
  database.ensureOwner("owner", "a-secure-test-password");
  const server = createSyncServer({
    database,
    authSecret,
    logger: { error() {} },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  // 无 Origin（非浏览器客户端）：不输出 CORS 头，请求正常成功。
  const plain = await fetch(`${baseUrl}/v1/health`);
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get("access-control-allow-origin"), null);

  // 白名单内的桌面端来源：回显 Origin。
  const allowed = await fetch(`${baseUrl}/v1/health`, {
    headers: { Origin: "http://tauri.localhost" },
  });
  assert.equal(
    allowed.headers.get("access-control-allow-origin"),
    "http://tauri.localhost",
  );
  assert.equal(allowed.headers.get("vary"), "Origin");

  // 白名单外的来源：不输出 CORS 头，由浏览器拦截。
  const blocked = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ username: "owner", password: "wrong" }),
  });
  assert.equal(blocked.status, 401);
  assert.equal(
    blocked.headers.get("access-control-allow-origin"),
    null,
  );

  // 预检请求：白名单内返回 CORS 头，白名单外不返回。
  const preflightAllowed = await fetch(`${baseUrl}/v1/sync`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://tauri.localhost",
      "Access-Control-Request-Method": "POST",
    },
  });
  assert.equal(preflightAllowed.status, 204);
  assert.equal(
    preflightAllowed.headers.get("access-control-allow-origin"),
    "http://tauri.localhost",
  );
  const preflightBlocked = await fetch(`${baseUrl}/v1/sync`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example",
      "Access-Control-Request-Method": "POST",
    },
  });
  assert.equal(preflightBlocked.status, 204);
  assert.equal(
    preflightBlocked.headers.get("access-control-allow-origin"),
    null,
  );
});

test("honors custom CORS origins and wildcard opt-in", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mind-cors-"));
  const database = new SyncDatabase(path.join(directory, "test.sqlite3"));
  database.ensureOwner("owner", "a-secure-test-password");
  const server = createSyncServer({
    database,
    authSecret,
    logger: { error() {} },
    allowedOrigins: ["https://custom.example"],
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  // 自定义来源被放行，默认 Tauri 来源反而被拒。
  const custom = await fetch(`${baseUrl}/v1/health`, {
    headers: { Origin: "https://custom.example" },
  });
  assert.equal(
    custom.headers.get("access-control-allow-origin"),
    "https://custom.example",
  );
  const tauri = await fetch(`${baseUrl}/v1/health`, {
    headers: { Origin: "http://tauri.localhost" },
  });
  assert.equal(tauri.headers.get("access-control-allow-origin"), null);

  // 空白名单应在启动时直接报错。
  assert.throws(
    () =>
      createSyncServer({
        database,
        authSecret,
        logger: { error() {} },
        allowedOrigins: ["  "],
      }),
    /至少需要包含一个来源/,
  );
});

function loginRequest(baseUrl, password, headers = {}) {
  return fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ username: "owner", password }),
  });
}

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

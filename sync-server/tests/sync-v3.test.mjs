import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSyncServer } from "../src/app.mjs";
import { SyncDatabase } from "../src/database.mjs";

const authSecret = "test-secret-that-is-longer-than-thirty-two-characters";

test("v3 sync is versioned, idempotent, paged and keeps blobs private", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mind-sync-v3-"));
  const database = new SyncDatabase(path.join(directory, "test.sqlite3"));
  database.ensureOwner("owner", "a-secure-test-password");
  const server = createSyncServer({ database, authSecret, logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const loginResponse = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "owner",
      password: "a-secure-test-password",
      deviceId: "windows-device",
    }),
  });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json();
  assert.ok(login.refreshToken);
  assert.ok(new Date(login.expiresAt).getTime() - Date.now() <= 16 * 60 * 1000);

  const refreshedResponse = await fetch(`${baseUrl}/v3/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: login.refreshToken }),
  });
  assert.equal(refreshedResponse.status, 200);
  const refreshed = await refreshedResponse.json();
  assert.notEqual(refreshed.refreshToken, login.refreshToken);
  const replay = await fetch(`${baseUrl}/v3/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: login.refreshToken }),
  });
  assert.equal(replay.status, 401);

  const projectChange = {
    entityType: "project",
    id: "project-one",
    baseVersion: 0,
    operation: "upsert",
    payload: { id: "project-one", title: "项目一" },
    changeId: "windows-device:project-one:first",
  };
  const first = await syncV3(baseUrl, refreshed.accessToken, {
    cursor: "",
    deviceId: "windows-device",
    changes: [projectChange],
  });
  assert.deepEqual(first.accepted.map(({ id, version }) => ({ id, version })), [
    { id: "project-one", version: 1 },
  ]);

  const retry = await syncV3(baseUrl, refreshed.accessToken, {
    cursor: "",
    deviceId: "windows-device",
    changes: [projectChange],
  });
  assert.equal(retry.accepted[0].version, 1);
  assert.equal(
    database.database.prepare("SELECT COUNT(*) AS count FROM sync_changes").get().count,
    1,
  );

  const standalone = await syncV3(baseUrl, refreshed.accessToken, {
    cursor: first.cursor,
    deviceId: "windows-device",
    changes: [
      {
        entityType: "task", id: "standalone-task", baseVersion: 0, operation: "upsert",
        payload: { id: "standalone-task", project_id: null, milestone_id: null, direction: "learning", status: "next" },
        changeId: "windows-device:standalone-task:first",
      },
      {
        entityType: "log", id: "standalone-log", baseVersion: 0, operation: "upsert",
        payload: { id: "standalone-log", project_id: null, task_id: "standalone-task", kind: "continuation", body: "下次继续" },
        changeId: "windows-device:standalone-log:first",
      },
    ],
  });
  assert.equal(standalone.accepted.length, 2);

  const dailyRecords = await syncV3(baseUrl, refreshed.accessToken, {
    cursor: standalone.cursor, deviceId: "windows-device", changes: [
      { entityType: "task_plan_history", id: "2026-09-04:standalone-task", baseVersion: 0, operation: "upsert", payload: { id: "2026-09-04:standalone-task", task_id: "standalone-task", planned_date: "2026-09-04", task_title: "读论文", current_focus: "读方法", created_at: "2026-09-04T00:00:00Z" }, changeId: "windows:history:1" },
      { entityType: "daily_situation", id: "2026-09-04", baseVersion: 0, operation: "upsert", payload: { situation_date: "2026-09-04", reason: "临时协助实验", actual_work: "样品测量", tasks_json: "[]", updated_at: "2026-09-05T00:00:00Z" }, changeId: "windows:situation:1" },
    ],
  });
  assert.equal(dailyRecords.accepted.length, 2);
  assert.equal(dailyRecords.failed.length, 0);

  const conflict = await syncV3(baseUrl, refreshed.accessToken, {
    cursor: first.cursor,
    deviceId: "second-device",
    changes: [{
      ...projectChange,
      payload: { id: "project-one", title: "离线改写" },
      changeId: "second-device:project-one:stale",
    }],
  });
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.conflicts[0].remote.payload.title, "项目一");

  const mixed = await syncV3(baseUrl, refreshed.accessToken, {
    cursor: first.cursor,
    deviceId: "second-device",
    changes: [
      { entityType: "unknown", id: "bad" },
      {
        entityType: "preference",
        id: "app_meta:workspace_display_name",
        baseVersion: 0,
        operation: "upsert",
        payload: { key: "workspace_display_name", value: "木鱼" },
        changeId: "second-device:display-name:1",
      },
    ],
  });
  assert.equal(mixed.failed.length, 1);
  assert.equal(mixed.accepted.length, 1);

  const pulled = await syncV3(baseUrl, refreshed.accessToken, {
    cursor: "",
    deviceId: "third-device",
    changes: [],
  });
  assert.equal(pulled.changes.some((item) => item.entityType === "project"), true);
  assert.equal(pulled.changes.some((item) => item.entityType === "preference"), true);
  assert.equal(pulled.changes.find((item) => item.entityType === "daily_situation")?.payload.situation_date, "2026-09-04");
  assert.equal(pulled.changes.find((item) => item.entityType === "task_plan_history")?.payload.task_title, "读论文");
  assert.equal(pulled.changes.find((item) => item.entityType === "task" && item.id === "standalone-task")?.payload.project_id, null);
  assert.equal(pulled.changes.find((item) => item.entityType === "log" && item.id === "standalone-log")?.payload.kind, "continuation");

  const blob = Buffer.from("not-a-real-image-but-hash-verified");
  const blobHash = createHash("sha256").update(blob).digest("hex");
  const uploaded = await fetch(`${baseUrl}/v3/blobs/${blobHash}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${refreshed.accessToken}`,
      "Content-Type": "image/png",
      "Content-Length": String(blob.length),
    },
    body: blob,
  });
  assert.equal(uploaded.status, 201);
  const head = await fetch(`${baseUrl}/v3/blobs/${blobHash}`, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${refreshed.accessToken}` },
  });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get("content-length")), blob.length);
  const downloaded = await fetch(`${baseUrl}/v3/blobs/${blobHash}`, {
    headers: { Authorization: `Bearer ${refreshed.accessToken}` },
  });
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), blob);

  const anonymous = await fetch(`${baseUrl}/v3/blobs/${blobHash}`);
  assert.equal(anonymous.status, 401);

  const attachmentPayload = {
    id: "attachment-one",
    original_hash: blobHash,
    preview_hash: blobHash,
    original_mime_type: "image/png",
    preview_mime_type: "image/png",
    original_bytes: blob.length,
    preview_bytes: blob.length,
  };
  const attachmentUpsert = await syncV3(baseUrl, refreshed.accessToken, {
    cursor: pulled.cursor,
    deviceId: "windows-device",
    changes: [{
      entityType: "attachment",
      id: "attachment-one",
      baseVersion: 0,
      operation: "upsert",
      payload: attachmentPayload,
      changeId: "windows-device:attachment-one:create",
    }],
  });
  await syncV3(baseUrl, refreshed.accessToken, {
    cursor: attachmentUpsert.cursor,
    deviceId: "windows-device",
    changes: [{
      entityType: "attachment",
      id: "attachment-one",
      baseVersion: 1,
      operation: "delete",
      payload: attachmentPayload,
      changeId: "windows-device:attachment-one:delete",
    }],
  });
  const expiredAt = "2020-01-01T00:00:00.000Z";
  database.database.prepare(
    "UPDATE sync_entities SET deleted_at = ?, updated_at = ? WHERE entity_type = 'attachment' AND entity_id = 'attachment-one'",
  ).run(expiredAt, expiredAt);
  database.database.prepare(
    "UPDATE sync_changes SET changed_at = ? WHERE entity_type = 'attachment' AND entity_id = 'attachment-one'",
  ).run(expiredAt);
  database.database.prepare("UPDATE user_blobs SET created_at = ? WHERE sha256 = ?").run(expiredAt, blobHash);
  const maintenance = database.runMaintenance({ now: new Date("2021-01-01T00:00:00.000Z") });
  assert.equal(maintenance.compactedChanges >= 1, true);
  assert.equal(maintenance.removedUserLinks, 1);
  assert.equal(maintenance.removedBlobs, 1);
  assert.equal(
    database.database.prepare(
      "SELECT COUNT(*) AS count FROM sync_changes WHERE entity_type = 'attachment' AND entity_id = 'attachment-one'",
    ).get().count,
    1,
  );
  const afterMaintenance = await fetch(`${baseUrl}/v3/blobs/${blobHash}`, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${refreshed.accessToken}` },
  });
  assert.equal(afterMaintenance.status, 404);

  const logout = await fetch(`${baseUrl}/v3/auth/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: refreshed.refreshToken }),
  });
  assert.equal(logout.status, 200);
  const afterLogout = await fetch(`${baseUrl}/v3/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: refreshed.refreshToken }),
  });
  assert.equal(afterLogout.status, 401);
});

async function syncV3(baseUrl, token, payload) {
  const response = await fetch(`${baseUrl}/v3/sync`, {
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

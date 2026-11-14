import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mealSlotAt, photoDateTime, jpegCaptureTime, type MealPhoto } from "../app/meal-photo";
import { HealthRepository } from "../app/data/health-repository";
import { FinanceRepository } from "../app/data/finance-repository";
import { PrivateRepository, type PrivateResponse } from "../app/data/private-repository";
import { PrivateCrypto, createRecoveryCode } from "../app/data/private-crypto";
import type { SqliteDatabase, SqliteValue } from "../app/data/sqlite-article-repository";
import { PrivateSyncClient, privateRequest } from "../app/data/private-sync-client";
import { accountBinding, type SecretStore } from "../app/data/secret-store";
// @ts-expect-error The integration test executes the actual server module in a third SQLite database.
import { initializePrivateSync, syncPrivate, syncPrivatePhotos } from "../../sync-server/src/private-sync.mjs";

const image = "data:image/jpeg;base64,/9j/2Q==";
function photo(id = "a".repeat(64)): MealPhoto { return { id, date: "2026-10-26", slot: "lunch", eatenAt: "12:30", capturedAt: "2026-10-26T12:30:00", imageDataUrl: image, description: "", reviewed: false, createdAt: "2026-10-26T05:00:00Z" }; }
class Adapter implements SqliteDatabase {
  constructor(readonly db: DatabaseSync) {}
  async execute(sql: string, values: SqliteValue[] = []) { return { rowsAffected: Number(this.db.prepare(sql).run(...values).changes) }; }
  async select<T>(sql: string, values: SqliteValue[] = []) { return this.db.prepare(sql).all(...values) as T[]; }
}
async function fixture(t: test.TestContext) {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  const adapter = new Adapter(sqlite), health = new HealthRepository(adapter);
  await health.ready(); await new FinanceRepository(adapter).ready();
  const records = new PrivateRepository(adapter); await records.ready();
  return { sqlite, health, records, photos: health.mealPhotos, stream: records.photoRepository() };
}
test("meal photo preselects meal times and uses EXIF wall time before file time", () => {
  assert.deepEqual(["05:00", "09:59", "10:00", "14:59", "15:00", "17:00", "21:59", "22:00"].map(mealSlotAt), ["breakfast", "breakfast", "lunch", "lunch", "snack", "dinner", "dinner", "snack"]);
  assert.deepEqual(photoDateTime({ lastModified: 0 }, "2026:10:25 12:30:00"), { date: "2026-10-25", time: "12:30", capturedAt: "2026-10-25T12:30:00", estimated: false });
  assert.equal(photoDateTime({ lastModified: Date.parse("2026-10-26T12:00:00Z") }).estimated, true);
  assert.equal(jpegCaptureTime(new Uint8Array([0xff, 0xd8, 0xff]).buffer), "");
});
test("JPEG parser reads original capture time in either TIFF byte order and bounds-checks malformed offsets", () => {
  for (const little of [true, false]) {
    const data = new ArrayBuffer(80), v = new DataView(data), bytes = new Uint8Array(data);
    v.setUint16(0, 0xffd8); v.setUint16(2, 0xffe1); v.setUint16(4, 76); bytes.set([69,120,105,102,0,0], 6);
    const base = 12; v.setUint16(base, little ? 0x4949 : 0x4d4d); v.setUint16(base + 2, 42, little); v.setUint32(base + 4, 8, little);
    v.setUint16(base + 8, 1, little); v.setUint16(base + 10, 0x8769, little); v.setUint32(base + 18, 26, little);
    v.setUint16(base + 26, 1, little); v.setUint16(base + 28, 0x9003, little); v.setUint16(base + 30, 2, little); v.setUint32(base + 32, 20, little); v.setUint32(base + 36, 44, little);
    bytes.set(new TextEncoder().encode("2026:10:25 18:42:03\0"), base + 44);
    assert.equal(jpegCaptureTime(data), "2026:10:25 18:42:03");
    v.setUint32(base + 36, 99999, little); assert.equal(jpegCaptureTime(data), "");
  }
});
test("offline photo storage deduplicates originals, rejects invalid dates and keeps photos out of ordinary private records", async t => {
  const f = await fixture(t);
  assert.equal(await f.photos.add(photo()), true); assert.equal(await f.photos.add({ ...photo(), date: "2026-10-25" }), false);
  assert.equal((await f.photos.list("2026-10-26")).length, 1);
  for (const patch of [{ date: "2026-99-99" }, { date: "2026-02-30" }, { imageDataUrl: "https://example.com/food.jpg" }, { imageDataUrl: "data:image/jpeg;base64,/9j/" + "A".repeat(100000) }]) await assert.rejects(f.photos.add({ ...photo("b".repeat(64)), ...patch }));
  const cipher = await PrivateCrypto.fromRecoveryCode(createRecoveryCode());
  assert.equal((await f.records.prepare(cipher)).length, 0);
  const outgoing = await f.stream.prepare(cipher); assert.equal(outgoing.length, 1);
  assert.ok(!outgoing[0].envelope.ciphertext.includes(image));
  assert.equal((await cipher.decrypt(outgoing[0].id, outgoing[0].envelope) as {kind: string}).kind, "health_meal_photos");
});
test("confirming a photo appends once, preserves manual meal time and a failed transaction never marks it reviewed", async t => {
  const f = await fixture(t);
  await f.health.saveMeal({ date: photo().date, slot: "lunch", eatenAt: "12:00", description: "手工记录", updatedAt: "" });
  await f.photos.add(photo()); await f.photos.draft(photo().id, "米饭和青菜");
  await f.photos.confirm(photo().id, "米饭和青菜"); await f.photos.confirm(photo().id, "重复确认不追加");
  const meal = (await f.health.listMeals(photo().date))[0]; assert.equal(meal.description, "手工记录\n米饭和青菜"); assert.equal(meal.eatenAt, "12:00");
  assert.equal((await f.photos.list(photo().date))[0].reviewed, true);
  await f.photos.add(photo("b".repeat(64)));
  f.sqlite.exec("CREATE TRIGGER reject_photo_review BEFORE UPDATE ON health_meal_photos WHEN NEW.reviewed=1 BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  await assert.rejects(f.photos.confirm("b".repeat(64), "失败的草稿"));
  assert.equal((await f.health.listMeals(photo().date))[0].description, meal.description);
  await f.photos.remove(photo().id); assert.equal((await f.health.listMeals(photo().date))[0].description, meal.description);
});
test("overlong meal preserves both original text and unreviewed photo", async t => {
  const f = await fixture(t); await f.photos.add(photo());
  await f.health.saveMeal({ date: photo().date, slot: "lunch", eatenAt: "", description: "饭".repeat(3999), updatedAt: "" });
  await assert.rejects(f.photos.confirm(photo().id, "新照片描述"), /4000/);
  assert.equal((await f.photos.list(photo().date))[0].reviewed, false);
  assert.equal((await f.health.listMeals(photo().date))[0].description.length, 3999);
});
test("encrypted photo pages apply between local SQLite devices without leaking into the text channel", async t => {
  const a = await fixture(t), b = await fixture(t), cipher = await PrivateCrypto.fromRecoveryCode(createRecoveryCode());
  await a.photos.add(photo()); const sent = await a.stream.prepare(cipher);
  const page: PrivateResponse = { version: 4, keyId: cipher.keyId, cursor: 1, hasMore: false, results: [], records: sent.map(r => ({ id: r.id, version: 1, envelope: r.envelope })) };
  await assert.rejects(b.records.receive(page, cipher, [], 0)); assert.equal(await b.records.meta("cursor"), "");
  await b.stream.receive(page, cipher, [], 0); assert.equal((await b.photos.list(photo().date))[0].imageDataUrl, image);
  assert.equal((await b.stream.prepare(cipher)).length, 0, "received photos do not echo back");
  const malformed = await cipher.encrypt(sent[0].id, { kind: "health_meal_photos", key: [photo().id], row: { ...(await cipher.decrypt(sent[0].id, sent[0].envelope) as {row: object}).row, id: "b".repeat(64) } });
  await assert.rejects(b.stream.receive({ ...page, cursor: 2, records: [{ id: sent[0].id, version: 2, envelope: malformed }] }, cipher, [], 1));
  assert.equal(await b.stream.meta("cursor"), "1");
});

test("photo sync is opt-in, retries a lost response, isolates old clients and propagates confirmed meals and deletions", async t => {
  const phone = await fixture(t), desktop = await fixture(t), server = new DatabaseSync(":memory:"); t.after(() => server.close());
  server.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1)"); initializePrivateSync(server);
  const code = createRecoveryCode(), cipher = await PrivateCrypto.fromRecoveryCode(code), binding = await accountBinding("https://example.test", "owner");
  const secrets: SecretStore = { get: async key => key === `private_${binding}` ? code : null, set: async () => {}, remove: async () => {} };
  await phone.records.enable(binding, cipher.keyId, true); await desktop.records.enable(binding, cipher.keyId, true);
  let photoCalls = 0, lose = false;
  const transport = async (_server: string, endpoint: string, body: unknown) => {
    if (endpoint.endsWith("/photos/sync")) {
      photoCalls++; const response = syncPrivatePhotos(server, 1, body);
      if (lose) { lose = false; throw new Error("lost photo response"); } return response;
    }
    return syncPrivate(server, 1, body);
  };
  const client = (device: typeof phone) => new PrivateSyncClient(device.records, "https://example.test", "owner", async () => "token", secrets, transport);
  const a = client(phone), b = client(desktop);
  await phone.photos.add(photo()); await a.sync(); assert.equal(photoCalls, 0);
  await phone.records.setMeta("photo_enabled", "1"); await desktop.records.setMeta("photo_enabled", "1");
  lose = true; await assert.rejects(a.sync(), /lost photo response/); await a.sync(); await b.sync();
  assert.equal((await desktop.photos.list(photo().date)).length, 1); assert.equal((await phone.stream.status()).pending, 0);
  assert.equal(server.prepare("SELECT count(*) n FROM private_photo_records").get()!.n, 1);
  assert.equal(server.prepare("SELECT count(*) n FROM private_records").get()!.n, 0);
  const raw = JSON.stringify(server.prepare("SELECT * FROM private_photo_records").all()) + JSON.stringify(server.prepare("SELECT * FROM private_photo_receipts").all());
  for (const value of [image, "meal_date", "2026-10-26", "health_meal_photos"]) assert.ok(!raw.includes(value));
  await desktop.photos.confirm(photo().id, "米饭和青菜"); await b.sync(); await a.sync();
  assert.equal((await phone.photos.list(photo().date))[0].reviewed, true);
  assert.equal((await phone.health.listMeals(photo().date))[0].description, "米饭和青菜");
  await phone.photos.remove(photo().id); await a.sync(); await b.sync();
  assert.equal((await desktop.photos.list(photo().date)).length, 0);
  assert.equal((await desktop.health.listMeals(photo().date))[0].description, "米饭和青菜");
  await phone.records.setMeta("photo_enabled", "0"); const before = photoCalls;
  await phone.photos.add(photo("b".repeat(64))); await a.sync(); assert.equal(photoCalls, before);
  assert.equal((await phone.stream.status()).pending, 1);
});

test("simultaneous photo drafts require explicit conflict resolution and a sync switch changed in flight retains the queue", async t => {
  const a = await fixture(t), b = await fixture(t), server = new DatabaseSync(":memory:"); t.after(() => server.close());
  server.exec("CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1)"); initializePrivateSync(server);
  const code = createRecoveryCode(), cipher = await PrivateCrypto.fromRecoveryCode(code), binding = await accountBinding("https://example.test", "owner");
  const secrets: SecretStore = { get: async () => code, set: async () => {}, remove: async () => {} };
  for (const d of [a, b]) { await d.records.enable(binding, cipher.keyId, true); await d.records.setMeta("photo_enabled", "1"); }
  let disableInFlight = false;
  const transport = async (_s: string, endpoint: string, body: unknown) => {
    if (!endpoint.endsWith("/photos/sync")) return syncPrivate(server, 1, body);
    const response = syncPrivatePhotos(server, 1, body);
    if (disableInFlight) { disableInFlight = false; await a.records.setMeta("photo_enabled", "0"); }
    return response;
  };
  const clients = [a, b].map(d => new PrivateSyncClient(d.records, "https://example.test", "owner", async () => "token", secrets, transport));
  await a.photos.add(photo()); disableInFlight = true; await clients[0].sync(); assert.equal((await a.stream.status()).pending, 1);
  await a.records.setMeta("photo_enabled", "1"); await clients[0].sync(); await clients[1].sync();
  await a.photos.draft(photo().id, "手机备注"); await b.photos.draft(photo().id, "电脑备注");
  await clients[0].sync(); await clients[1].sync(); assert.equal((await b.records.status()).conflicts, 1);
  const conflicts = await b.records.conflicts(); assert.ok(conflicts[0].local_id.startsWith("photo:"));
  await b.records.resolve(conflicts[0].local_id, "local"); await clients[1].sync(); await clients[0].sync();
  assert.equal((await a.photos.list(photo().date))[0].description, "电脑备注");
});

test("old servers report a photo-specific upgrade message without exposing their response", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => Response.json({ error: "private details" }, { status: 404 });
  await assert.rejects(privateRequest("https://example.test", "/v4/private/photos/sync", {}), /服务器尚未支持餐食照片同步/);
});

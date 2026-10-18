import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WorkspacePreferencesRepository } from "../app/data/workspace-preferences-repository";
import { FOCUS_REMINDER_KEY } from "../app/focus-reminder";
import type { SqliteDatabase, SqliteExecuteResult, SqliteValue } from "../app/data/sqlite-article-repository";
import { addDefaultAiLinks, addDefaultEntertainmentLinks, normalizeAvatarDataUrl, normalizeDisplayName, normalizeQuickLinks, readLegacyQuickLinks, workspaceTitle } from "../app/workspace-preferences";

class NodeSqliteAdapter implements SqliteDatabase {
  constructor(private readonly database: DatabaseSync) {}
  async execute(sql: string, bindValues: SqliteValue[] = []): Promise<SqliteExecuteResult> {
    const result = this.database.prepare(sql).run(...bindValues);
    return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
  }
  async select<T>(sql: string, bindValues: SqliteValue[] = []): Promise<T[]> {
    return this.database.prepare(sql).all(...bindValues) as T[];
  }
}

test("focus reminders default to 45 minutes and persist disabling or interval changes", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new WorkspacePreferencesRepository(new NodeSqliteAdapter(database));
  assert.equal(await repository.getFocusReminderMinutes(), 45);
  await repository.saveFocusReminderMinutes(0);
  assert.equal(await repository.getFocusReminderMinutes(), 0);
  await repository.saveFocusReminderMinutes(90);
  assert.equal(await repository.getFocusReminderMinutes(), 90);
  database.prepare("UPDATE app_meta SET value = ? WHERE key = ?").run("garbage", FOCUS_REMINDER_KEY);
  assert.equal(await repository.getFocusReminderMinutes(), 45);
  assert.equal(await repository.saveFocusReminderMinutes(-1), 45);
  database.close();
});

test("stores workspace identity and quick links in app metadata", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new WorkspacePreferencesRepository(new NodeSqliteAdapter(database));
  assert.deepEqual(await repository.getPreferences(), { displayName: "", avatarDataUrl: "", quickLinks: null });
  await repository.saveDisplayName("  小洛  ");
  await repository.saveAvatarDataUrl("data:image/png;base64,YXZhdGFy");
  await repository.saveQuickLinks([{ id: "docs", title: "文档", url: "https://example.com", category: "general", area: "web", openMode: "external", allowInsecureHttp: false, pinned: true, order: 0 }]);
  assert.deepEqual(await repository.getPreferences(), {
    displayName: "小洛",
    avatarDataUrl: "data:image/png;base64,YXZhdGFy",
    quickLinks: [{ id: "docs", title: "文档", url: "https://example.com", category: "general", area: "web", openMode: "external", allowInsecureHttp: false, pinned: true, order: 0 }],
  });
  database.close();
});

test("stores device health reminder preferences with safe defaults", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new WorkspacePreferencesRepository(new NodeSqliteAdapter(database));
  assert.deepEqual(await repository.getHealthReminder(), { enabled: false, time: "22:00" });
  assert.deepEqual(await repository.saveHealthReminder({ enabled: true, time: "21:45" }), { enabled: true, time: "21:45" });
  assert.deepEqual(await repository.getHealthReminder(), { enabled: true, time: "21:45" });
  database.close();
});

test("formats workspace titles and imports legacy quick links without rewriting storage", () => {
  assert.equal(workspaceTitle(""), "个人工作台");
  assert.equal(workspaceTitle("  小洛 "), "小洛");
  assert.equal(normalizeDisplayName("一".repeat(30)).length, 24);
  assert.equal([...normalizeDisplayName("😀".repeat(30))].length, 24);
  assert.equal(normalizeAvatarDataUrl("data:image/svg+xml;base64,PHN2Zz4="), "");
  const storage = { getItem: (key: string) => key === "life-strategy.quick-links" ? JSON.stringify([{ title: "Zotero", url: "https://zotero.org" }]) : null };
  assert.deepEqual(readLegacyQuickLinks(storage)[0], { id: "legacy-0", title: "Zotero", url: "https://zotero.org", category: "research", area: "web", openMode: "external", allowInsecureHttp: false, pinned: true, order: 0 });
});

test("migrates quick links without silently opting old entries into embedded browsing", () => {
  const [link] = normalizeQuickLinks([{ id: "old", title: "旧入口", url: "https://example.com", category: "general", pinned: true, order: 2 }]);
  assert.equal(link.area, "web");
  assert.equal(link.openMode, "external");
  assert.equal(link.allowInsecureHttp, false);
});

test("moves the built-in entertainment platforms into the editable link library once", async () => {
  const legacyLinks = [
    { id: "docs", title: "文档", url: "https://example.com", category: "general", area: "web", openMode: "external", allowInsecureHttp: false, pinned: true, order: 0 },
    { id: "bilibili-old", title: "哔哩哔哩", url: "https://www.bilibili.com", category: "content", area: "web", openMode: "external", allowInsecureHttp: false, pinned: false, order: 1 },
  ] as const;
  const links = addDefaultEntertainmentLinks([...legacyLinks]);
  assert.deepEqual(links.filter((link) => link.area === "entertainment").map((link) => link.title), ["哔哩哔哩", "抖音"]);
  assert.equal(addDefaultEntertainmentLinks(links).length, links.length);

  const database = new DatabaseSync(":memory:");
  const adapter = new NodeSqliteAdapter(database);
  const repository = new WorkspacePreferencesRepository(adapter);
  await repository.getPreferences();
  database.prepare("INSERT INTO app_meta(key, value) VALUES(?, ?)").run("workspace_quick_links_v1", JSON.stringify(legacyLinks));
  const migrated = await repository.getPreferences();
  assert.deepEqual(migrated.quickLinks?.filter((link) => link.area === "entertainment").map((link) => link.title), ["哔哩哔哩", "抖音"]);
  database.close();
});

test("adds editable AI links, including the official ChatGPT website, only during migration", async () => {
  const links = addDefaultAiLinks([]);
  assert.deepEqual(links.map((link) => link.title), ["千问", "Gemini", "Grok", "ChatGPT", "豆包", "智谱清言", "Claude", "Kimi"]);
  assert.equal(links.find((link) => link.id === "chatgpt")?.url, "https://chatgpt.com");
  assert.equal(addDefaultAiLinks(links).length, links.length);

  const database = new DatabaseSync(":memory:");
  const repository = new WorkspacePreferencesRepository(new NodeSqliteAdapter(database));
  await repository.getPreferences();
  database.prepare("INSERT INTO app_meta(key, value) VALUES(?, ?)").run("workspace_quick_links_v3", JSON.stringify([]));
  const migrated = await repository.getPreferences();
  assert.deepEqual(migrated.quickLinks?.map((link) => link.title), ["哔哩哔哩", "抖音", "千问", "Gemini", "Grok", "ChatGPT", "豆包", "智谱清言", "Claude", "Kimi"]);
  await repository.saveQuickLinks(migrated.quickLinks?.filter((link) => link.id !== "chatgpt") ?? []);
  assert.equal((await repository.getPreferences()).quickLinks?.some((link) => link.id === "chatgpt"), false);
  database.close();
});

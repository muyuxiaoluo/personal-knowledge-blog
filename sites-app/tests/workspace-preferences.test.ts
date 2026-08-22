import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WorkspacePreferencesRepository } from "../app/data/workspace-preferences-repository";
import type { SqliteDatabase, SqliteExecuteResult, SqliteValue } from "../app/data/sqlite-article-repository";
import { normalizeDisplayName, normalizeQuickLinks, readLegacyQuickLinks, workspaceTitle } from "../app/workspace-preferences";

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

test("stores workspace identity and quick links in app metadata", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new WorkspacePreferencesRepository(new NodeSqliteAdapter(database));
  assert.deepEqual(await repository.getPreferences(), { displayName: "", quickLinks: null });
  await repository.saveDisplayName("  小洛  ");
  await repository.saveQuickLinks([{ id: "docs", title: "文档", url: "https://example.com", category: "general", area: "web", openMode: "external", allowInsecureHttp: false, pinned: true, order: 0 }]);
  assert.deepEqual(await repository.getPreferences(), {
    displayName: "小洛",
    quickLinks: [{ id: "docs", title: "文档", url: "https://example.com", category: "general", area: "web", openMode: "external", allowInsecureHttp: false, pinned: true, order: 0 }],
  });
  database.close();
});

test("formats workspace titles and imports legacy quick links without rewriting storage", () => {
  assert.equal(workspaceTitle(""), "个人工作台");
  assert.equal(workspaceTitle("  小洛 "), "小洛的个人工作台");
  assert.equal(normalizeDisplayName("一".repeat(30)).length, 24);
  const storage = { getItem: (key: string) => key === "life-strategy.quick-links" ? JSON.stringify([{ title: "Zotero", url: "https://zotero.org" }]) : null };
  assert.deepEqual(readLegacyQuickLinks(storage)[0], { id: "legacy-0", title: "Zotero", url: "https://zotero.org", category: "research", area: "web", openMode: "external", allowInsecureHttp: false, pinned: true, order: 0 });
});

test("migrates quick links without silently opting old entries into embedded browsing", () => {
  const [link] = normalizeQuickLinks([{ id: "old", title: "旧入口", url: "https://example.com", category: "general", pinned: true, order: 2 }]);
  assert.equal(link.area, "web");
  assert.equal(link.openMode, "external");
  assert.equal(link.allowInsecureHttp, false);
});

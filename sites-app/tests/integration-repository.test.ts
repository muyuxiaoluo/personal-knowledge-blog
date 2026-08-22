import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { IntegrationRepository } from "../app/data/integration-repository";
import type { SqliteDatabase, SqliteExecuteResult, SqliteValue } from "../app/data/sqlite-article-repository";

class NodeSqliteAdapter implements SqliteDatabase {
  constructor(private readonly database: DatabaseSync) {}
  async execute(sql: string, bindValues: SqliteValue[] = []): Promise<SqliteExecuteResult> {
    const result = this.database.prepare(sql).run(...bindValues as Array<string | number | null>);
    return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
  }
  async select<T>(sql: string, bindValues: SqliteValue[] = []): Promise<T[]> {
    return this.database.prepare(sql).all(...bindValues as Array<string | number | null>) as T[];
  }
}

test("stores GitHub configuration separately from cached responses", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = new IntegrationRepository(new NodeSqliteAdapter(database));
  await repository.saveGitHubRepository({ id: "repo-1", owner: "owner", name: "private", displayName: "私人仓库", enabled: true, homePinned: true, order: 0 });
  await repository.saveCache("github:repo-1", { commits: 3 }, "2026-08-21T00:00:00Z");
  assert.equal((await repository.listGitHubRepositories())[0].displayName, "私人仓库");
  assert.deepEqual((await repository.getCache<{ commits: number }>("github:repo-1"))?.value, { commits: 3 });
  await repository.deleteGitHubRepository("repo-1");
  assert.equal((await repository.listGitHubRepositories()).length, 0);
  assert.equal(await repository.getCache("github:repo-1"), null);
  database.close();
});

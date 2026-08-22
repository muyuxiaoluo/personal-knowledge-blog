import type { GitHubRepositoryConfig, IntegrationCache } from "../integration-types";
import type { SqliteDatabase } from "./sqlite-article-repository";

type RepositoryRow = {
  id: string;
  owner: string;
  name: string;
  display_name: string;
  enabled: number;
  home_pinned: number;
  sort_order: number;
};

type CacheRow = { cache_key: string; payload_json: string; fetched_at: string };

export class IntegrationRepository {
  private initialization: Promise<void> | null = null;

  constructor(private readonly database: SqliteDatabase) {}

  private async initialize() {
    this.initialization ??= (async () => {
      await this.database.execute(`CREATE TABLE IF NOT EXISTS github_repositories (
        id TEXT PRIMARY KEY NOT NULL,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        home_pinned INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        UNIQUE(owner, name)
      )`);
      await this.database.execute(`CREATE TABLE IF NOT EXISTS integration_cache (
        cache_key TEXT PRIMARY KEY NOT NULL,
        payload_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      )`);
      await this.database.execute("CREATE INDEX IF NOT EXISTS idx_github_repositories_order ON github_repositories(home_pinned DESC, sort_order ASC)");
    })().catch((error) => {
      this.initialization = null;
      throw error;
    });
    await this.initialization;
  }

  async listGitHubRepositories(): Promise<GitHubRepositoryConfig[]> {
    await this.initialize();
    const rows = await this.database.select<RepositoryRow>(
      "SELECT * FROM github_repositories ORDER BY home_pinned DESC, sort_order ASC, owner ASC, name ASC",
    );
    return rows.map((row) => ({
      id: row.id,
      owner: row.owner,
      name: row.name,
      displayName: row.display_name,
      enabled: Boolean(row.enabled),
      homePinned: Boolean(row.home_pinned),
      order: Number(row.sort_order),
    }));
  }

  async saveGitHubRepository(config: GitHubRepositoryConfig): Promise<void> {
    await this.initialize();
    await this.database.execute(
      `INSERT INTO github_repositories(id, owner, name, display_name, enabled, home_pinned, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, name = excluded.name,
         display_name = excluded.display_name, enabled = excluded.enabled,
         home_pinned = excluded.home_pinned, sort_order = excluded.sort_order`,
      [config.id, config.owner, config.name, config.displayName, config.enabled ? 1 : 0, config.homePinned ? 1 : 0, config.order],
    );
  }

  async deleteGitHubRepository(id: string): Promise<void> {
    await this.initialize();
    await this.database.execute("DELETE FROM github_repositories WHERE id = ?", [id]);
    await this.database.execute("DELETE FROM integration_cache WHERE cache_key = ?", [`github:${id}`]);
  }

  async getCache<T>(key: string): Promise<IntegrationCache<T> | null> {
    await this.initialize();
    const rows = await this.database.select<CacheRow>(
      "SELECT * FROM integration_cache WHERE cache_key = ? LIMIT 1",
      [key],
    );
    if (!rows[0]) return null;
    try {
      return { key: rows[0].cache_key, value: JSON.parse(rows[0].payload_json) as T, fetchedAt: rows[0].fetched_at };
    } catch {
      await this.database.execute("DELETE FROM integration_cache WHERE cache_key = ?", [key]);
      return null;
    }
  }

  async saveCache<T>(key: string, value: T, fetchedAt = new Date().toISOString()): Promise<void> {
    await this.initialize();
    await this.database.execute(
      `INSERT INTO integration_cache(cache_key, payload_json, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`,
      [key, JSON.stringify(value), fetchedAt],
    );
  }
}

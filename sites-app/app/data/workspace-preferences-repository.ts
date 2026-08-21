import type { QuickLink, WorkspacePreferences } from "../workspace-preferences";
import { normalizeDisplayName } from "../workspace-preferences";
import type { SqliteDatabase } from "./sqlite-article-repository";

const displayNameKey = "workspace_display_name";
const quickLinksKey = "workspace_quick_links_v1";

export class WorkspacePreferencesRepository {
  private initialization: Promise<void> | null = null;

  constructor(private readonly database: SqliteDatabase) {}

  private async initialize() {
    this.initialization ??= this.database.execute(`CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    )`).then(() => undefined).catch((error) => {
      this.initialization = null;
      throw error;
    });
    await this.initialization;
  }

  async getPreferences(): Promise<WorkspacePreferences> {
    await this.initialize();
    const rows = await this.database.select<{ key: string; value: string }>(
      "SELECT key, value FROM app_meta WHERE key IN (?, ?)",
      [displayNameKey, quickLinksKey],
    );
    const values = new Map(rows.map((row) => [row.key, row.value]));
    return {
      displayName: normalizeDisplayName(values.get(displayNameKey) ?? ""),
      quickLinks: parseQuickLinks(values.get(quickLinksKey)),
    };
  }

  async saveDisplayName(name: string): Promise<void> {
    await this.write(displayNameKey, normalizeDisplayName(name));
  }

  async saveQuickLinks(links: QuickLink[]): Promise<void> {
    await this.write(quickLinksKey, JSON.stringify(links));
  }

  private async write(key: string, value: string) {
    await this.initialize();
    await this.database.execute(
      `INSERT INTO app_meta(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }
}

function parseQuickLinks(value: string | undefined): QuickLink[] | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((item): item is QuickLink => Boolean(
      item && typeof item.id === "string" && typeof item.title === "string" && typeof item.url === "string",
    ));
  } catch {
    return null;
  }
}

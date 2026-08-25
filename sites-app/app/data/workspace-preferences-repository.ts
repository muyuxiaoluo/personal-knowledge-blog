import type { QuickLink, WorkspacePreferences } from "../workspace-preferences";
import { addDefaultEntertainmentLinks, normalizeAvatarDataUrl, normalizeDisplayName, normalizeQuickLinks } from "../workspace-preferences";
import type { SqliteDatabase } from "./sqlite-article-repository";

const displayNameKey = "workspace_display_name";
const avatarDataUrlKey = "workspace_avatar_data_url";
const legacyQuickLinksKeyV1 = "workspace_quick_links_v1";
const legacyQuickLinksKeyV2 = "workspace_quick_links_v2";
const quickLinksKey = "workspace_quick_links_v3";

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
      "SELECT key, value FROM app_meta WHERE key IN (?, ?, ?, ?, ?)",
      [displayNameKey, avatarDataUrlKey, quickLinksKey, legacyQuickLinksKeyV2, legacyQuickLinksKeyV1],
    );
    const values = new Map(rows.map((row) => [row.key, row.value]));
    let quickLinks = parseQuickLinks(values.get(quickLinksKey));
    if (!quickLinks) {
      const legacyQuickLinks = parseQuickLinks(values.get(legacyQuickLinksKeyV2)) ?? parseQuickLinks(values.get(legacyQuickLinksKeyV1));
      if (legacyQuickLinks) {
        quickLinks = addDefaultEntertainmentLinks(legacyQuickLinks);
        await this.write(quickLinksKey, JSON.stringify(quickLinks));
      }
    }
    return {
      displayName: normalizeDisplayName(values.get(displayNameKey) ?? ""),
      avatarDataUrl: normalizeAvatarDataUrl(values.get(avatarDataUrlKey) ?? ""),
      quickLinks,
    };
  }

  async saveDisplayName(name: string): Promise<void> {
    await this.write(displayNameKey, normalizeDisplayName(name));
  }

  async saveAvatarDataUrl(dataUrl: string): Promise<void> {
    await this.write(avatarDataUrlKey, normalizeAvatarDataUrl(dataUrl));
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
    return normalizeQuickLinks(parsed);
  } catch {
    return null;
  }
}

import type { QuickLink, WorkspacePreferences } from "../workspace-preferences";
import { addDefaultAiLinks, addDefaultEntertainmentLinks, normalizeAvatarDataUrl, normalizeDisplayName, normalizeQuickLinks } from "../workspace-preferences";
import { normalizeHealthReminderPreferences, parseHealthReminderPreferences, type HealthReminderPreferences } from "../reminder-preferences";
import type { SqliteDatabase } from "./sqlite-article-repository";
import { FOCUS_REMINDER_KEY, normalizeFocusReminderMinutes } from "../focus-reminder";

const displayNameKey = "workspace_display_name";
const avatarDataUrlKey = "workspace_avatar_data_url";
const legacyQuickLinksKeyV1 = "workspace_quick_links_v1";
const legacyQuickLinksKeyV2 = "workspace_quick_links_v2";
const legacyQuickLinksKeyV3 = "workspace_quick_links_v3";
const legacyQuickLinksKeyV4 = "workspace_quick_links_v4";
const quickLinksKey = "workspace_quick_links_v5";
const healthReminderKey = "workspace_health_reminder_v1";

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

  async ready() {
    await this.initialize();
  }

  async getPreferences(): Promise<WorkspacePreferences> {
    await this.initialize();
    const rows = await this.database.select<{ key: string; value: string }>(
      "SELECT key, value FROM app_meta WHERE key IN (?, ?, ?, ?, ?, ?, ?)",
      [displayNameKey, avatarDataUrlKey, quickLinksKey, legacyQuickLinksKeyV4, legacyQuickLinksKeyV3, legacyQuickLinksKeyV2, legacyQuickLinksKeyV1],
    );
    const values = new Map(rows.map((row) => [row.key, row.value]));
    let quickLinks = parseQuickLinks(values.get(quickLinksKey));
    if (!quickLinks) {
      const legacyQuickLinks = parseQuickLinks(values.get(legacyQuickLinksKeyV4)) ?? parseQuickLinks(values.get(legacyQuickLinksKeyV3)) ?? parseQuickLinks(values.get(legacyQuickLinksKeyV2)) ?? parseQuickLinks(values.get(legacyQuickLinksKeyV1));
      if (legacyQuickLinks) {
        quickLinks = addDefaultAiLinks(addDefaultEntertainmentLinks(legacyQuickLinks));
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

  async getHealthReminder(): Promise<HealthReminderPreferences> {
    await this.initialize();
    const rows = await this.database.select<{ value: string }>(
      "SELECT value FROM app_meta WHERE key = ? LIMIT 1",
      [healthReminderKey],
    );
    return parseHealthReminderPreferences(rows[0]?.value);
  }

  async saveHealthReminder(preferences: HealthReminderPreferences): Promise<HealthReminderPreferences> {
    const normalized = normalizeHealthReminderPreferences(preferences);
    await this.write(healthReminderKey, JSON.stringify(normalized));
    return normalized;
  }

  private async write(key: string, value: string) {
    await this.initialize();
    await this.database.execute(
      `INSERT INTO app_meta(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  async getFocusReminderMinutes(): Promise<number> {
    await this.initialize();
    const rows = await this.database.select<{ value: string }>("SELECT value FROM app_meta WHERE key = ? LIMIT 1", [FOCUS_REMINDER_KEY]);
    const value = rows[0]?.value;
    return value === undefined ? 45 : normalizeFocusReminderMinutes(Number(value));
  }

  async saveFocusReminderMinutes(minutes: number): Promise<number> {
    const normalized = normalizeFocusReminderMinutes(minutes);
    await this.write(FOCUS_REMINDER_KEY, String(normalized));
    return normalized;
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

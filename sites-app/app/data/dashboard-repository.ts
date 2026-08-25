import type {
  CalendarEvent,
  CalendarRecurrence,
  DashboardCache,
  DashboardLocation,
  DashboardPreferences,
} from "../dashboard-types";
import { defaultDashboardPreferences } from "../dashboard-types";
import { normalizeAiHighlightKeywords } from "../dashboard-helpers";
import type { SqliteDatabase } from "./sqlite-article-repository";

type PreferenceRow = {
  city_name: string;
  admin1: string;
  admin2: string;
  admin3: string;
  admin4: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  ai_highlight_keywords: string;
  weather_enabled: number;
  calendar_enabled: number;
  ai_hot_enabled: number;
  morning_brief_enabled: number;
};

type CacheRow = {
  cache_key: string;
  payload_json: string;
  etag: string;
  fetched_at: string;
  expires_at: string;
};

type EventRow = {
  id: string;
  title: string;
  event_date: string;
  recurrence: CalendarRecurrence;
  lunar_month: number | null;
  lunar_day: number | null;
  lunar_leap_month: number;
  important: number;
  color: string;
  reminder_days: number;
  notes: string;
  created_at: string;
  updated_at: string;
};

const migrations = [
  `CREATE TABLE IF NOT EXISTS dashboard_preferences (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    city_name TEXT NOT NULL DEFAULT '',
    admin1 TEXT NOT NULL DEFAULT '',
    admin2 TEXT NOT NULL DEFAULT '',
    admin3 TEXT NOT NULL DEFAULT '',
    admin4 TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    latitude REAL,
    longitude REAL,
    timezone TEXT NOT NULL DEFAULT '',
    ai_highlight_keywords TEXT NOT NULL DEFAULT '[]',
    weather_enabled INTEGER NOT NULL DEFAULT 1,
    calendar_enabled INTEGER NOT NULL DEFAULT 1,
    ai_hot_enabled INTEGER NOT NULL DEFAULT 1,
    morning_brief_enabled INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS dashboard_cache (
    cache_key TEXT PRIMARY KEY NOT NULL,
    payload_json TEXT NOT NULL,
    etag TEXT NOT NULL DEFAULT '',
    fetched_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS calendar_events (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    event_date TEXT NOT NULL DEFAULT '',
    recurrence TEXT NOT NULL,
    lunar_month INTEGER,
    lunar_day INTEGER,
    lunar_leap_month INTEGER NOT NULL DEFAULT 0,
    important INTEGER NOT NULL DEFAULT 1,
    color TEXT NOT NULL DEFAULT '#c87557',
    reminder_days INTEGER NOT NULL DEFAULT 3,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_calendar_events_updated ON calendar_events(updated_at DESC)",
] as const;

export class DashboardRepository {
  private initialization: Promise<void> | null = null;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async initialize() {
    this.initialization ??= (async () => {
      for (const statement of migrations) await this.database.execute(statement);
      const columns = await this.database.select<{ name: string }>("PRAGMA table_info(dashboard_preferences)");
      const existing = new Set(columns.map((column) => column.name));
      const additions = [
        ["admin2", "TEXT NOT NULL DEFAULT ''"],
        ["admin3", "TEXT NOT NULL DEFAULT ''"],
        ["admin4", "TEXT NOT NULL DEFAULT ''"],
        ["ai_highlight_keywords", "TEXT NOT NULL DEFAULT '[]'"],
      ] as const;
      for (const [column, definition] of additions) {
        if (!existing.has(column)) await this.database.execute(`ALTER TABLE dashboard_preferences ADD COLUMN ${column} ${definition}`);
      }
    })().catch((error) => {
      this.initialization = null;
      throw error;
    });
    await this.initialization;
  }

  async getPreferences(): Promise<DashboardPreferences> {
    await this.initialize();
    const rows = await this.database.select<PreferenceRow>("SELECT * FROM dashboard_preferences WHERE id = 1 LIMIT 1");
    const row = rows[0];
    if (!row) return structuredClone(defaultDashboardPreferences);
    const location = validLocationRow(row) ? {
      name: row.city_name,
      admin1: row.admin1,
      admin2: row.admin2,
      admin3: row.admin3,
      admin4: row.admin4,
      country: row.country,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      timezone: row.timezone,
    } : null;
    return {
      location,
      aiHighlightKeywords: parseHighlightKeywords(row.ai_highlight_keywords),
      modules: {
        weather: Boolean(row.weather_enabled),
        calendar: Boolean(row.calendar_enabled),
        aiHot: Boolean(row.ai_hot_enabled),
        morningBrief: Boolean(row.morning_brief_enabled),
      },
    };
  }

  async savePreferences(preferences: DashboardPreferences): Promise<void> {
    await this.initialize();
    const location = normalizeLocation(preferences.location);
    await this.database.execute(
      `INSERT INTO dashboard_preferences(
        id, city_name, admin1, admin2, admin3, admin4, country, latitude, longitude, timezone, ai_highlight_keywords,
        weather_enabled, calendar_enabled, ai_hot_enabled, morning_brief_enabled
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        city_name = excluded.city_name, admin1 = excluded.admin1, country = excluded.country,
        admin2 = excluded.admin2, admin3 = excluded.admin3, admin4 = excluded.admin4,
        latitude = excluded.latitude, longitude = excluded.longitude, timezone = excluded.timezone,
        ai_highlight_keywords = excluded.ai_highlight_keywords,
        weather_enabled = excluded.weather_enabled, calendar_enabled = excluded.calendar_enabled,
        ai_hot_enabled = excluded.ai_hot_enabled, morning_brief_enabled = excluded.morning_brief_enabled`,
      [
        location?.name ?? "", location?.admin1 ?? "", location?.admin2 ?? "", location?.admin3 ?? "", location?.admin4 ?? "", location?.country ?? "",
        location?.latitude ?? null, location?.longitude ?? null, location?.timezone ?? "",
        JSON.stringify(normalizeAiHighlightKeywords(preferences.aiHighlightKeywords)),
        preferences.modules.weather ? 1 : 0,
        preferences.modules.calendar ? 1 : 0,
        preferences.modules.aiHot ? 1 : 0,
        preferences.modules.morningBrief ? 1 : 0,
      ],
    );
  }

  async getCache<T>(key: string): Promise<DashboardCache<T> | null> {
    await this.initialize();
    const rows = await this.database.select<CacheRow>("SELECT * FROM dashboard_cache WHERE cache_key = ? LIMIT 1", [key]);
    if (!rows[0]) return null;
    try {
      return {
        key: rows[0].cache_key,
        value: JSON.parse(rows[0].payload_json) as T,
        etag: rows[0].etag,
        fetchedAt: rows[0].fetched_at,
        expiresAt: rows[0].expires_at,
      };
    } catch {
      await this.database.execute("DELETE FROM dashboard_cache WHERE cache_key = ?", [key]);
      return null;
    }
  }

  async saveCache<T>(key: string, value: T, etag: string, fetchedAt: string, maxAgeSeconds: number) {
    await this.initialize();
    const expiresAt = new Date(new Date(fetchedAt).getTime() + Math.max(0, maxAgeSeconds) * 1000).toISOString();
    await this.database.execute(
      `INSERT INTO dashboard_cache(cache_key, payload_json, etag, fetched_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET payload_json = excluded.payload_json,
         etag = excluded.etag, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
      [key, JSON.stringify(value), etag, fetchedAt, expiresAt],
    );
    return { key, value, etag, fetchedAt, expiresAt } satisfies DashboardCache<T>;
  }

  async touchCache(key: string, fetchedAt: string, maxAgeSeconds: number) {
    await this.initialize();
    const expiresAt = new Date(new Date(fetchedAt).getTime() + Math.max(0, maxAgeSeconds) * 1000).toISOString();
    await this.database.execute("UPDATE dashboard_cache SET fetched_at = ?, expires_at = ? WHERE cache_key = ?", [fetchedAt, expiresAt, key]);
  }

  async listEvents(): Promise<CalendarEvent[]> {
    await this.initialize();
    const rows = await this.database.select<EventRow>("SELECT * FROM calendar_events ORDER BY updated_at DESC, title ASC");
    return rows.map(rowToEvent);
  }

  async saveEvent(event: CalendarEvent): Promise<CalendarEvent> {
    await this.initialize();
    const normalized = normalizeEvent(event, this.clock());
    await this.database.execute(
      `INSERT INTO calendar_events(
        id, title, event_date, recurrence, lunar_month, lunar_day, lunar_leap_month,
        important, color, reminder_days, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, event_date = excluded.event_date,
        recurrence = excluded.recurrence, lunar_month = excluded.lunar_month,
        lunar_day = excluded.lunar_day, lunar_leap_month = excluded.lunar_leap_month,
        important = excluded.important, color = excluded.color, reminder_days = excluded.reminder_days,
        notes = excluded.notes, updated_at = excluded.updated_at`,
      [
        normalized.id, normalized.title, normalized.date, normalized.recurrence,
        normalized.lunarMonth, normalized.lunarDay, normalized.lunarLeapMonth ? 1 : 0,
        normalized.important ? 1 : 0, normalized.color, normalized.reminderDays,
        normalized.notes, normalized.createdAt, normalized.updatedAt,
      ],
    );
    return normalized;
  }

  async deleteEvent(id: string) {
    await this.initialize();
    await this.database.execute("DELETE FROM calendar_events WHERE id = ?", [id]);
  }
}

function validLocationRow(row: PreferenceRow) {
  return Boolean(row.city_name && row.timezone && row.latitude !== null && row.longitude !== null);
}

function parseHighlightKeywords(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? normalizeAiHighlightKeywords(parsed) : [];
  } catch {
    return [];
  }
}

function normalizeLocation(location: DashboardLocation | null) {
  if (!location) return null;
  if (!location.name.trim() || !location.timezone.trim()) throw new Error("城市信息不完整");
  if (!Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90) throw new Error("城市纬度不正确");
  if (!Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180) throw new Error("城市经度不正确");
  return {
    ...location,
    name: location.name.trim(),
    admin1: location.admin1.trim(),
    admin2: location.admin2?.trim() ?? "",
    admin3: location.admin3?.trim() ?? "",
    admin4: location.admin4?.trim() ?? "",
    country: location.country.trim(),
    timezone: location.timezone.trim(),
  };
}

function normalizeEvent(event: CalendarEvent, now: Date): CalendarEvent {
  const title = event.title.trim();
  if (!title) throw new Error("重要日期标题不能为空");
  if (title.length > 60) throw new Error("重要日期标题不能超过 60 个字符");
  if (!isRecurrence(event.recurrence)) throw new Error("重要日期重复规则不正确");
  if (event.recurrence !== "yearlyLunar" && !validDate(event.date)) throw new Error("请选择有效日期");
  if (event.recurrence === "yearlyLunar") {
    if (!event.lunarMonth || event.lunarMonth < 1 || event.lunarMonth > 12) throw new Error("农历月份不正确");
    if (!event.lunarDay || event.lunarDay < 1 || event.lunarDay > 30) throw new Error("农历日期不正确");
  }
  const timestamp = now.toISOString();
  return {
    ...event,
    id: event.id || `calendar-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    date: event.recurrence === "yearlyLunar" ? "" : event.date,
    lunarMonth: event.recurrence === "yearlyLunar" ? event.lunarMonth : null,
    lunarDay: event.recurrence === "yearlyLunar" ? event.lunarDay : null,
    lunarLeapMonth: event.recurrence === "yearlyLunar" && event.lunarLeapMonth,
    color: /^#[0-9a-f]{6}$/i.test(event.color) ? event.color : "#c87557",
    reminderDays: Number.isFinite(event.reminderDays) ? Math.min(365, Math.max(0, Math.round(event.reminderDays))) : 0,
    notes: event.notes.trim().slice(0, 500),
    createdAt: event.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

function rowToEvent(row: EventRow): CalendarEvent {
  return {
    id: row.id,
    title: row.title,
    date: row.event_date,
    recurrence: row.recurrence,
    lunarMonth: row.lunar_month,
    lunarDay: row.lunar_day,
    lunarLeapMonth: Boolean(row.lunar_leap_month),
    important: Boolean(row.important),
    color: row.color,
    reminderDays: Number(row.reminder_days),
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isRecurrence(value: string): value is CalendarRecurrence {
  return value === "once" || value === "yearlyGregorian" || value === "yearlyLunar";
}

function validDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

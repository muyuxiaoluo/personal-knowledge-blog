export type DashboardModuleKey = "weather" | "calendar" | "aiHot" | "morningBrief";

export type DashboardLocation = {
  name: string;
  admin1: string;
  admin2?: string;
  admin3?: string;
  admin4?: string;
  country: string;
  latitude: number;
  longitude: number;
  timezone: string;
};

export type DashboardPreferences = {
  location: DashboardLocation | null;
  aiHighlightKeywords: string[];
  modules: Record<DashboardModuleKey, boolean>;
};

export const defaultDashboardPreferences: DashboardPreferences = {
  location: null,
  aiHighlightKeywords: [],
  modules: {
    weather: true,
    calendar: true,
    aiHot: true,
    morningBrief: true,
  },
};

export type DashboardFetchResult<T> = {
  value: T | null;
  notModified: boolean;
  etag: string;
  fetchedAt: string;
  maxAgeSeconds: number;
};

export type DashboardCache<T> = {
  key: string;
  value: T;
  etag: string;
  fetchedAt: string;
  expiresAt: string;
};

export type CitySuggestion = DashboardLocation & {
  id: number;
  featureCode: string;
  kindLabel: string;
  providerLabel: string;
};

export type WeatherCurrent = {
  time: string;
  temperature: number;
  apparentTemperature: number;
  weatherCode: number;
  windSpeed: number;
  isDay: boolean;
};

export type WeatherHour = {
  time: string;
  precipitationProbability: number;
  precipitation: number;
  rain: number;
  showers: number;
  weatherCode: number;
};

export type WeatherDay = {
  date: string;
  weatherCode: number;
  temperatureMax: number;
  temperatureMin: number;
  precipitationProbabilityMax: number;
  precipitationSum: number;
  sunrise: string;
  sunset: string;
};

export type WeatherSnapshot = {
  location: DashboardLocation;
  current: WeatherCurrent;
  hourly: WeatherHour[];
  daily: WeatherDay[];
  attribution: { name: string; url: string };
};

export type AiBriefItem = {
  id: string;
  title: string;
  summary: string;
  reason: string;
  sourceName: string;
  category: string;
  publishedAt: string;
  score: number;
  originalUrl: string;
  aihotUrl: string;
};

export type AiHotTopic = {
  id: string;
  title: string;
  summary: string;
  score: number;
  url: string;
};

export type AiDailyBrief = {
  date: string;
  lead: string;
  url: string;
};

export type AiBriefSnapshot = {
  items: AiBriefItem[];
  topics: AiHotTopic[];
  daily: AiDailyBrief | null;
  attribution: { name: string; url: string };
  warnings?: string[];
};

export type MorningBriefSnapshot = {
  date: string;
  news: string[];
  tip: string;
  sourceUrl: string;
  imageUrl: string;
  publishedAt: string;
  attribution: { name: string; url: string };
};

export type CalendarRecurrence = "once" | "yearlyGregorian" | "yearlyLunar";

export type CalendarEvent = {
  milestone?: { projectId: string; projectTitle: string; dateKind: "target" | "deadline" };
  id: string;
  title: string;
  date: string;
  recurrence: CalendarRecurrence;
  lunarMonth: number | null;
  lunarDay: number | null;
  lunarLeapMonth: boolean;
  important: boolean;
  color: string;
  reminderDays: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type CalendarOccurrence = {
  event: CalendarEvent;
  date: string;
  daysRemaining: number;
};

export type RestDay = {
  date: string;
  note: string;
  createdAt: string;
  updatedAt: string;
};

export type OfficialHolidayDay = {
  date: string;
  name: string;
  kind: "holiday" | "workday";
};

export type ExternalSourceInput = {
  url: string;
  title?: string;
  summary?: string;
  sourceLabel?: string;
};

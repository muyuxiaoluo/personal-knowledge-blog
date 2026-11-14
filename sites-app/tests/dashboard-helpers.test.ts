import assert from "node:assert/strict";
import test from "node:test";
import { eventOccursOn, matchingAiKeywords, morningBriefRefreshSlot, nextCalendarOccurrences, normalizeAiHighlightKeywords, normalizeExternalSourceInput, occurrenceDateInYear, prioritizeAiBriefItems, rainVerdict } from "../app/dashboard-helpers";
import type { AiBriefItem, CalendarEvent, WeatherSnapshot } from "../app/dashboard-types";

test("AI highlights keep the actual 0, 2 or 6 stories and prioritize matching interests stably", () => {
  const items: AiBriefItem[] = Array.from({ length: 6 }, (_, index) => ({
    id: String(index), title: index === 5 ? "OpenAI update" : `News ${index}`, summary: "", reason: "", category: "", sourceName: "test", publishedAt: "", score: 0, originalUrl: "", aihotUrl: "",
  }));
  assert.deepEqual(prioritizeAiBriefItems([], ["OpenAI"]), []);
  assert.deepEqual(prioritizeAiBriefItems(items.slice(0, 2), ["OpenAI"]), items.slice(0, 2));
  assert.deepEqual(prioritizeAiBriefItems(items, ["OpenAI"]).map((item) => item.id), ["5", "0", "1", "2", "3", "4"]);
  assert.equal(items[0].id, "0");
});

function weather(probability: number, precipitation = 0): WeatherSnapshot {
  return {
    location: { name: "上海", admin1: "上海市", country: "中国", latitude: 31.2, longitude: 121.4, timezone: "Asia/Shanghai" },
    current: { time: "2026-08-24T09:20", temperature: 28, apparentTemperature: 31, weatherCode: 1, windSpeed: 8, isDay: true },
    hourly: [
      { time: "2026-08-24T08:00", precipitationProbability: 100, precipitation: 1, rain: 1, showers: 0, weatherCode: 61 },
      { time: "2026-08-24T10:00", precipitationProbability: probability, precipitation, rain: precipitation, showers: 0, weatherCode: precipitation ? 61 : 2 },
      { time: "2026-08-24T11:00", precipitationProbability: probability, precipitation, rain: precipitation, showers: 0, weatherCode: precipitation ? 61 : 2 },
    ],
    daily: [],
    attribution: { name: "Open-Meteo", url: "https://open-meteo.com" },
  };
}

test("classifies rain using only the remaining hours and the agreed thresholds", () => {
  assert.equal(rainVerdict(weather(29)).tone, "unlikely");
  assert.equal(rainVerdict(weather(30)).tone, "possible");
  assert.equal(rainVerdict(weather(59)).tone, "possible");
  assert.equal(rainVerdict(weather(60)).tone, "expected");
  assert.equal(rainVerdict(weather(10, 0.1)).tone, "expected");
  assert.equal(rainVerdict(weather(45)).timeRange, "10:00—12:00");
});

test("refreshes the morning brief once per Beijing-time retry window", () => {
  assert.equal(morningBriefRefreshSlot("2026-08-24", "2026-08-24", 9), "");
  assert.equal(morningBriefRefreshSlot("2026-08-23", "2026-08-24", 6), "");
  assert.equal(morningBriefRefreshSlot(null, "2026-08-24", 6), "2026-08-24:before-08");
  assert.equal(morningBriefRefreshSlot("2026-08-23", "2026-08-24", 7), "");
  assert.equal(morningBriefRefreshSlot("2026-08-23", "2026-08-24", 8), "2026-08-24:08");
  assert.equal(morningBriefRefreshSlot("2026-08-23", "2026-08-24", 11), "2026-08-24:11");
  assert.equal(morningBriefRefreshSlot("2026-08-23", "2026-08-24", 12), "2026-08-24:after-11");
});

test("normalizes AI attention keywords and matches title, summary or category", () => {
  assert.deepEqual(normalizeAiHighlightKeywords(" 新模型，模型发布\n新模型 "), ["新模型", "模型发布"]);
  const item = { title: "某公司发布新模型", summary: "能力明显提升", reason: "", category: "模型" };
  assert.deepEqual(matchingAiKeywords(item, ["开源", "新模型", "能力提升"]), ["新模型"]);
});

test("keeps structured AI source metadata when collecting into the explore library", () => {
  const normalized = normalizeExternalSourceInput({
    url: "https://example.com/ai-story",
    title: "一条准确的 AI 新闻标题",
    summary: "这段摘要会进入收藏正文和摘要字段。",
    sourceLabel: "示例媒体",
  }, "example.com");
  assert.equal(normalized.title, "一条准确的 AI 新闻标题");
  assert.equal(normalized.summary, "这段摘要会进入收藏正文和摘要字段。");
  assert.equal(normalized.sourceLabel, "示例媒体");
  assert.equal(normalized.url, "https://example.com/ai-story");
  assert.throws(() => normalizeExternalSourceInput({ url: "javascript:alert(1)" }, "外部链接"), /HTTP/);
});

function event(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "event-1",
    title: "重要日期",
    date: "2026-08-24",
    recurrence: "once",
    lunarMonth: null,
    lunarDay: null,
    lunarLeapMonth: false,
    important: true,
    color: "#c87557",
    reminderDays: 3,
    notes: "",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

test("resolves one-time, Gregorian yearly and lunar yearly occurrences", () => {
  const birthday = event({ id: "birthday", date: "2024-09-02", recurrence: "yearlyGregorian" });
  const lunar = event({ id: "lunar", date: "", recurrence: "yearlyLunar", lunarMonth: 1, lunarDay: 1 });
  assert.equal(occurrenceDateInYear(birthday, 2026), "2026-09-02");
  assert.equal(occurrenceDateInYear(lunar, 2026), "2026-02-17");
  assert.equal(eventOccursOn(lunar, "2026-02-17"), true);
});

test("does not shift February 29 and only resolves a matching lunar leap month", () => {
  const leapDay = event({ date: "2024-02-29", recurrence: "yearlyGregorian" });
  assert.equal(occurrenceDateInYear(leapDay, 2026), null);
  assert.equal(nextCalendarOccurrences([leapDay], "2026-01-01", 1)[0]?.date, "2028-02-29");

  const leapLunar = event({ date: "", recurrence: "yearlyLunar", lunarMonth: 6, lunarDay: 1, lunarLeapMonth: true });
  assert.equal(occurrenceDateInYear(leapLunar, 2025), "2025-07-25");
  assert.equal(occurrenceDateInYear(leapLunar, 2026), null);
});

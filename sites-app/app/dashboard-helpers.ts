import { Lunar } from "lunar-javascript";
import { calendarDayDifference } from "./date-helpers";
import { normalizeAiHighlightKeywords } from "./dashboard-normalization";
import type {
  AiBriefItem,
  CalendarEvent,
  CalendarOccurrence,
  WeatherHour,
  WeatherSnapshot,
} from "./dashboard-types";

export { normalizeAiHighlightKeywords, normalizeExternalSourceInput } from "./dashboard-normalization";

export type RainVerdict = {
  tone: "expected" | "possible" | "unlikely";
  label: string;
  detail: string;
  maxProbability: number;
  timeRange: string;
};

export function morningBriefRefreshSlot(valueDate: string | null, nowDate: string, hour: number) {
  if (valueDate === nowDate) return "";
  if (hour < 8) return valueDate ? "" : `${nowDate}:before-08`;
  if (hour <= 11) return `${nowDate}:${String(hour).padStart(2, "0")}`;
  return `${nowDate}:after-11`;
}

export function matchingAiKeywords(item: Pick<AiBriefItem, "title" | "summary" | "reason" | "category">, keywords: string[]) {
  const content = `${item.title}\n${item.summary}\n${item.reason}\n${item.category}`.toLocaleLowerCase("zh-CN");
  return normalizeAiHighlightKeywords(keywords).filter((keyword) => content.includes(keyword.toLocaleLowerCase("zh-CN")));
}

export function rainVerdict(snapshot: WeatherSnapshot, nowLocal = snapshot.current.time): RainVerdict {
  const today = nowLocal.slice(0, 10);
  const currentHour = `${nowLocal.slice(0, 13)}:00`;
  const remaining = snapshot.hourly.filter((hour) => hour.time.slice(0, 10) === today && hour.time >= currentHour);
  const maxProbability = remaining.reduce((maximum, hour) => Math.max(maximum, hour.precipitationProbability), 0);
  const predictedRain = remaining.some((hour) => hour.precipitation > 0 || hour.rain > 0 || hour.showers > 0);
  const active = remaining.filter((hour) => hour.precipitationProbability >= 30 || hour.precipitation > 0 || hour.rain > 0 || hour.showers > 0);
  const timeRange = firstContinuousRange(active);
  if (predictedRain || maxProbability >= 60) {
    return {
      tone: "expected",
      label: "预计会下雨",
      detail: timeRange ? `${timeRange} 请留意降雨` : "今天剩余时段请留意降雨",
      maxProbability,
      timeRange,
    };
  }
  if (maxProbability >= 30) {
    return {
      tone: "possible",
      label: "可能有雨",
      detail: timeRange ? `${timeRange} 有阵雨可能` : "今天有小概率阵雨",
      maxProbability,
      timeRange,
    };
  }
  return {
    tone: "unlikely",
    label: "大概率不下雨",
    detail: "今天剩余时段降雨概率较低",
    maxProbability,
    timeRange: "",
  };
}

function firstContinuousRange(hours: WeatherHour[]) {
  if (!hours.length) return "";
  const sorted = [...hours].sort((left, right) => left.time.localeCompare(right.time));
  const first = sorted[0];
  let last = first;
  for (const hour of sorted.slice(1)) {
    if (hourDifference(last.time, hour.time) !== 1) break;
    last = hour;
  }
  return `${first.time.slice(11, 16)}—${addOneHour(last.time).slice(11, 16)}`;
}

function hourDifference(left: string, right: string) {
  return Math.round((new Date(`${right}:00Z`).getTime() - new Date(`${left}:00Z`).getTime()) / 3_600_000);
}

function addOneHour(value: string) {
  const date = new Date(`${value}:00Z`);
  date.setUTCHours(date.getUTCHours() + 1);
  return date.toISOString().slice(0, 16);
}

export function zonedIsoMinute(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}T${read("hour")}:${read("minute")}`;
}

export function nextCalendarOccurrences(events: CalendarEvent[], today: string, limit = 3): CalendarOccurrence[] {
  return events.flatMap((event) => {
    const date = nextOccurrenceDate(event, today);
    const daysRemaining = date ? calendarDayDifference(date, today) : null;
    return date && daysRemaining !== null ? [{ event, date, daysRemaining }] : [];
  }).sort((left, right) => left.date.localeCompare(right.date) || left.event.title.localeCompare(right.event.title)).slice(0, limit);
}

export function occurrenceDateInYear(event: CalendarEvent, year: number) {
  if (event.recurrence === "once") return event.date.startsWith(`${year}-`) ? event.date : null;
  if (event.recurrence === "yearlyGregorian") {
    const monthDay = event.date.slice(5);
    return validDate(`${year}-${monthDay}`) ? `${year}-${monthDay}` : null;
  }
  if (event.lunarMonth === null || event.lunarDay === null) return null;
  try {
    const month = event.lunarLeapMonth ? -event.lunarMonth : event.lunarMonth;
    const solar = Lunar.fromYmd(year, month, event.lunarDay).getSolar();
    return solar.toYmd();
  } catch {
    return null;
  }
}

export function eventOccursOn(event: CalendarEvent, date: string) {
  if (event.recurrence === "once") return event.date === date;
  const year = Number(date.slice(0, 4));
  if (event.recurrence === "yearlyGregorian") return occurrenceDateInYear(event, year) === date;
  return [year - 1, year].some((lunarYear) => occurrenceDateInYear(event, lunarYear) === date);
}

function nextOccurrenceDate(event: CalendarEvent, today: string) {
  if (event.recurrence === "once") return event.date >= today ? event.date : null;
  const year = Number(today.slice(0, 4));
  if (event.recurrence === "yearlyGregorian") {
    for (let candidateYear = year; candidateYear <= year + 8; candidateYear += 1) {
      const candidate = occurrenceDateInYear(event, candidateYear);
      if (candidate && candidate >= today) return candidate;
    }
    return null;
  }
  for (let lunarYear = year - 1; lunarYear <= year + 20; lunarYear += 1) {
    const candidate = occurrenceDateInYear(event, lunarYear);
    if (candidate && candidate >= today) return candidate;
  }
  return null;
}

function validDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

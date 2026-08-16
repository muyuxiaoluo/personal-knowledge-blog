const DAY_IN_MILLISECONDS = 86_400_000;

export function localDate(value = new Date()) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 10);
}

export function calendarDayDifference(value: string, today = localDate()) {
  const target = parseCalendarDate(value);
  const current = parseCalendarDate(today);
  if (target === null || current === null) return null;
  return Math.round((target - current) / DAY_IN_MILLISECONDS);
}

export function formatRelativeDueDate(value: string, today = localDate()) {
  if (!value) return "";
  const difference = calendarDayDifference(value, today);
  if (difference === null) return value;
  if (difference < 0) return `已过期 ${Math.abs(difference)} 天`;
  if (difference === 0) return "今天截止";
  if (difference === 1) return "明天截止";
  const [, , month, day] = value.match(/^(\d{4})-(\d{2})-(\d{2})/) ?? [];
  return month && day ? `${Number(month)}月${Number(day)}日截止` : value;
}

function parseCalendarDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) return null;
  return timestamp;
}

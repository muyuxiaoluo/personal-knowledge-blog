import type { OfficialHolidayDay } from "./dashboard-types";

const sourceUrl = "https://www.gov.cn/zhengce/content/202511/content_7047090.htm";

function dateRange(start: string, end: string, name: string): OfficialHolidayDay[] {
  const result: OfficialHolidayDay[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    result.push({ date: cursor.toISOString().slice(0, 10), name, kind: "holiday" });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

export const officialHolidaySource = {
  label: "国务院办公厅 2026 年节假日安排",
  url: sourceUrl,
};

const holidayDays: OfficialHolidayDay[] = [
  ...dateRange("2026-01-01", "2026-01-03", "元旦"),
  { date: "2026-01-04", name: "元旦调休", kind: "workday" },
  ...dateRange("2026-02-15", "2026-02-23", "春节"),
  { date: "2026-02-14", name: "春节调休", kind: "workday" },
  { date: "2026-02-28", name: "春节调休", kind: "workday" },
  ...dateRange("2026-04-04", "2026-04-06", "清明节"),
  ...dateRange("2026-05-01", "2026-05-05", "劳动节"),
  { date: "2026-05-09", name: "劳动节调休", kind: "workday" },
  ...dateRange("2026-06-19", "2026-06-21", "端午节"),
  ...dateRange("2026-09-25", "2026-09-27", "中秋节"),
  ...dateRange("2026-10-01", "2026-10-07", "国庆节"),
  { date: "2026-09-20", name: "国庆节调休", kind: "workday" },
  { date: "2026-10-10", name: "国庆节调休", kind: "workday" },
];

export const officialHolidayDays = holidayDays.sort((left, right) => left.date.localeCompare(right.date));

export function officialHolidayOn(date: string) {
  return officialHolidayDays.find((item) => item.date === date) ?? null;
}

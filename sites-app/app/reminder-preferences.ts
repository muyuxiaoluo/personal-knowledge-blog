import type { HealthDailyLog } from "./health-types";

export type HealthReminderPreferences = {
  enabled: boolean;
  time: string;
};

export const defaultHealthReminderPreferences: HealthReminderPreferences = {
  enabled: false,
  time: "22:00",
};

export function normalizeHealthReminderPreferences(value: unknown): HealthReminderPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...defaultHealthReminderPreferences };
  }
  const candidate = value as Partial<HealthReminderPreferences>;
  return {
    enabled: candidate.enabled === true,
    time: typeof candidate.time === "string" && isReminderTime(candidate.time)
      ? candidate.time
      : defaultHealthReminderPreferences.time,
  };
}

export function parseHealthReminderPreferences(value: string | undefined): HealthReminderPreferences {
  if (!value) return { ...defaultHealthReminderPreferences };
  try {
    return normalizeHealthReminderPreferences(JSON.parse(value));
  } catch {
    return { ...defaultHealthReminderPreferences };
  }
}

export function missingHealthReminderItems(log: HealthDailyLog): Array<"sleep" | "activity"> {
  const sleepRecorded = log.sleepMinutes !== null || Boolean(log.sleepStart && log.sleepEnd);
  const activityRecorded = log.steps !== null || log.activityMinutes !== null || Boolean(log.activityNote.trim());
  return [
    ...(!sleepRecorded ? ["sleep" as const] : []),
    ...(!activityRecorded ? ["activity" as const] : []),
  ];
}

export function healthReminderBody(missing: Array<"sleep" | "activity">) {
  if (missing.length === 2) return "今天的睡眠和活动还没补全。现在花一分钟记录一下吧。";
  if (missing[0] === "sleep") return "今天的睡眠信息还没补全。现在花一分钟记录一下吧。";
  return "今天的步数或运动量还没记录。现在花一分钟补上吧。";
}

function isReminderTime(value: string) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

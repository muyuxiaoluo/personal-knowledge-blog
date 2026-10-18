export const FOCUS_REMINDER_KEY = "workspace_focus_reminder_minutes_v1";
export const FOCUS_REMINDER_INTERVALS = [0, 15, 30, 45, 60, 90] as const;

export function normalizeFocusReminderMinutes(value: unknown): number {
  return typeof value === "number" && FOCUS_REMINDER_INTERVALS.some((minutes) => minutes === value) ? value : 45;
}

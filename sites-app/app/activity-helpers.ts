import type { RestDay } from "./dashboard-types";
import type { FocusSession } from "./work-types";

export type ActivityTask = {
  id: string;
  projectId: string;
  projectTitle: string;
  title: string;
  currentFocus: string;
  completedAt: string | null;
};

export type ActivityNote = {
  id: string;
  title: string;
  created: string;
  updated: string;
};

export type ActivityDay = {
  date: string;
  tasks: ActivityTask[];
  notes: ActivityNote[];
  focusSessions: FocusSession[];
  focusSeconds: number;
  rest: boolean;
  intensity: 0 | 1 | 2 | 3 | 4;
};

export type ActivityWeek = Array<string | null>;

export function buildActivityDays({
  tasks,
  notes,
  focusSessions,
  restDays,
}: {
  tasks: ActivityTask[];
  notes: ActivityNote[];
  focusSessions: FocusSession[];
  restDays: RestDay[];
}) {
  const days = new Map<string, ActivityDay>();
  const restDates = new Set(restDays.map((day) => day.date));
  const ensure = (date: string) => {
    let day = days.get(date);
    if (!day) {
      day = { date, tasks: [], notes: [], focusSessions: [], focusSeconds: 0, rest: restDates.has(date), intensity: 0 };
      days.set(date, day);
    }
    return day;
  };

  restDates.forEach((date) => ensure(date));
  tasks.forEach((task) => {
    const date = task.completedAt ? activityDateKey(task.completedAt) : "";
    if (date) ensure(date).tasks.push(task);
  });
  notes.forEach((note) => {
    const date = activityDateKey(note.updated || note.created);
    if (date) ensure(date).notes.push(note);
  });
  focusSessions.forEach((session) => {
    if (!session.endedAt || session.durationSeconds <= 0) return;
    const date = activityDateKey(session.startedAt);
    if (!date) return;
    const day = ensure(date);
    day.focusSessions.push(session);
    day.focusSeconds += session.durationSeconds;
  });

  days.forEach((day) => {
    day.intensity = activityIntensity(day.tasks.length, day.notes.length, day.focusSeconds);
  });
  return days;
}

export function activityIntensity(taskCount: number, noteCount: number, focusSeconds: number): 0 | 1 | 2 | 3 | 4 {
  const score = taskCount * 2 + noteCount + Math.min(4, Math.ceil(Math.max(0, focusSeconds) / 1800));
  if (score <= 0) return 0;
  if (score <= 2) return 1;
  if (score <= 4) return 2;
  if (score <= 7) return 3;
  return 4;
}

export function activityDateKey(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function buildActivityWeeks(today: string, dayCount = 365): ActivityWeek[] {
  const firstDate = shiftActivityDate(today, -(Math.max(1, dayCount) - 1));
  const first = parseActivityDate(firstDate);
  const last = parseActivityDate(today);
  if (!first || !last) return [];
  const gridStart = new Date(first);
  gridStart.setUTCDate(gridStart.getUTCDate() - gridStart.getUTCDay());
  const weeks: ActivityWeek[] = [];
  for (let cursor = gridStart; cursor <= last;) {
    const week: ActivityWeek = [];
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const date = cursor.toISOString().slice(0, 10);
      week.push(date >= firstDate && date <= today ? date : null);
      cursor = new Date(cursor);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

export function shiftActivityDate(value: string, amount: number) {
  const date = parseActivityDate(value);
  if (!date) return value;
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function parseActivityDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

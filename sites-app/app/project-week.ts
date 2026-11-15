import { isValidDay } from "./action-planning";
import type { ProjectTaskStatus } from "./project-types";

export const projectWeekKey = "workspace_project_week_v1";
export const defaultWeekMinutes = [30, 0, 30, 0, 30, 0, 0];

export type WeekSettings = {
  minutes: number[];
  exceptions: Record<string, number>;
  managed: Record<string, { date: string; after: string[]; locked?: boolean }>;
};

export type WeekAction = {
  id: string;
  projectId: string | null;
  title: string;
  date: string;
  due: string;
  target?: string;
  minutes: number;
  status: ProjectTaskStatus;
  after: string[];
  fixed: boolean;
  newlyGenerated?: boolean;
};

export type WeekPlacement = { action: WeekAction; date: string; reason: string };

export type WeekAiAction = {
  ref: string;
  title: string;
  instruction: string;
  done: string;
  minutes: number;
  starter: string;
  after: string[];
};

export type WeekAiDraft = {
  title: string;
  outcome: string;
  stages: { title: string; done: string }[];
  actions: WeekAiAction[];
};
export type WeekDayChange = { date: string; minutes: number };

export function weekDate(day: string, offset: number) {
  const date = new Date(day + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function validWeekMinutes(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 1440;
}

export function readWeekSettings(value: string | null): WeekSettings {
  if (value) {
    try {
      const settings = JSON.parse(value) as WeekSettings;
      if (settings?.minutes?.length === 7 && settings.minutes.every(validWeekMinutes) && settings.exceptions && settings.managed) {
        return settings;
      }
    } catch { /* Restore defaults if unreadable. */ }
  }
  return { minutes: [...defaultWeekMinutes], exceptions: {}, managed: {} };
}

export function dayMinutes(day: string, settings: WeekSettings, rest: ReadonlySet<string>) {
  if (rest.has(day)) return 0;
  const weekday = (new Date(day + "T12:00:00Z").getUTCDay() + 6) % 7;
  return settings.exceptions[day] ?? settings.minutes[weekday] ?? 0;
}

export function scheduleWeek(today: string, actions: WeekAction[], requested: ReadonlySet<string>, settings: WeekSettings, rest: ReadonlySet<string>, explicitDates: string[] = []): WeekPlacement[] {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const lastDay = weekDate(today, 6);
  const days = [...new Set([...Array.from({ length: 7 }, (_, index) => weekDate(today, index)), ...explicitDates])].sort();
  const includedDates = new Set(days);
  const moving = new Set(actions.filter((action) => requested.has(action.id) && !action.fixed).map((action) => action.id));
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const action of actions) {
      if (!action.fixed && action.date && (action.date <= lastDay || includedDates.has(action.date)) && !moving.has(action.id) && action.after.some((id) => moving.has(id))) {
        moving.add(action.id);
        expanded = true;
      }
    }
  }
  const free = new Map(days.map((day) => [day, dayMinutes(day, settings, rest)]));
  for (const action of actions) {
    if (!moving.has(action.id) && free.has(action.date) && action.status !== "cancelled") {
      free.set(action.date, free.get(action.date)! - action.minutes);
    }
  }
  const placements = new Map<string, WeekPlacement>();
  const pending = actions.filter((action) => moving.has(action.id));
  pending.sort((a, b) => Number(Boolean(a.newlyGenerated)) - Number(Boolean(b.newlyGenerated)) ||
    (a.due || "9999").localeCompare(b.due || "9999") || (a.target || "9999").localeCompare(b.target || "9999") || (a.date || "9999").localeCompare(b.date || "9999"));
  while (pending.length) {
    const index = pending.findIndex((action) => action.after.every((id) => !moving.has(id) || placements.has(id)));
    if (index < 0) {
      for (const action of pending) placements.set(action.id, { action, date: "", reason: "行动之间存在循环依赖" });
      break;
    }
    const [action] = pending.splice(index, 1);
    let earliestDay = today;
    let blocked = false;
    for (const id of action.after) {
      const predecessor = byId.get(id);
      if (predecessor?.status === "done") continue;
      const predecessorMoves = moving.has(id);
      const date = predecessorMoves ? placements.get(id)?.date : predecessor?.date;
      if (!date || date < today || predecessor?.status === "waiting" || predecessor?.status === "cancelled") blocked = true;
      else {
        const firstDay = predecessorMoves ? date : weekDate(date, 1);
        if (firstDay > earliestDay) earliestDay = firstDay;
      }
    }
    const fixedFollower = actions.filter((item) => !moving.has(item.id) && item.date >= today && !["done", "cancelled"].includes(item.status) && item.after.includes(action.id))
      .map((item) => item.date).sort()[0];
    const eligible = days.filter((day) => day >= earliestDay && (!action.due || day <= action.due) && (!fixedFollower || day < fixedFollower));
    const fits = eligible.filter((day) => free.get(day)! >= action.minutes);
    const date = blocked ? "" : fits.includes(action.date) ? action.date : fits[0] ?? "";
    const maxFree = Math.max(0, ...eligible.map((day) => free.get(day)!));
    const reason = date ? "" : blocked ? "先完成前置行动" : !eligible.length
      ? "截止或前后依赖之间没有可用日期"
      : `可安排的日期还差至少 ${action.minutes - maxFree} 分钟`;
    if (date) free.set(date, free.get(date)! - action.minutes);
    placements.set(action.id, { action, date, reason });
  }
  return [...placements.values()];
}

export function affectedWeekActions(actions: WeekAction[], day: string, today: string, capacity: number) {
  const scheduled = day ? actions.filter((action) => action.date === day && action.status !== "cancelled") : [];
  let used = scheduled.reduce((total, action) => total + action.minutes, 0);
  const affected = new Set(actions.filter((action) => !day && !action.fixed && action.date && action.date < today).map((action) => action.id));
  for (const action of [...scheduled].reverse()) {
    if (used <= capacity) break;
    if (action.fixed) continue;
    affected.add(action.id);
    used -= action.minutes;
  }
  return { affected, excess: Math.max(0, used - capacity) };
}

export function validateWeekDraft(draft: WeekAiDraft, existingIds: string[]) {
  if (!draft.title.trim() || !draft.outcome.trim() || draft.stages.length > 6 || draft.actions.length > 7 ||
      draft.stages.some((stage) => !stage.title.trim() || !stage.done.trim())) throw new Error("AI 返回的项目规划不完整，请重试。");
  const refs = new Set(existingIds);
  for (const action of draft.actions) {
    if (!action.ref.trim() || refs.has(action.ref) || !action.title.trim() || !action.instruction.trim() ||
      !action.done.trim() || !validWeekMinutes(action.minutes) || action.minutes === 0 || action.after.some((id) => !refs.has(id))) {
      throw new Error("AI 返回的行动或前置关系无效，请重试。");
    }
    refs.add(action.ref);
  }
  return draft;
}

export function validWeekChange(date: string, today: string, minutes: number) {
  return isValidDay(date) && date >= today && validWeekMinutes(minutes);
}

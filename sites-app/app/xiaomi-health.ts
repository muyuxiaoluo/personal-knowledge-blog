import type { HealthDailyLog } from "./health-types";

export type XiaomiConnection = { connected: boolean; accountKey: string | null; terminalLoginAvailable: boolean };
export type XiaomiLoginReply = { stage: "connected" | "captcha" | "verification"; loginId: string | null; captchaDataUrl: string | null; method: string | null };
export type XiaomiQrLoginReply = { stage: "qrcode" | "waiting" | "connected"; loginId: string; imageDataUrl: string | null; expiresAt: string | null };
export type XiaomiSnapshot = { accountKey: string; fromDate: string; toDate: string; fetchedAt: string; steps: unknown[]; sleep: unknown[] };
export type XiaomiSleep = Pick<HealthDailyLog, "sleepMinutes" | "sleepStart" | "sleepEnd" | "awakeMinutes">;
export type XiaomiDay = { date: string; source: string; steps: number | null; sleep: XiaomiSleep | null };
export type XiaomiDayState = { accountKey: string; latest: XiaomiDay; stepsLocked: boolean; sleepLocked: boolean; syncedAt: string };
export type XiaomiSyncSettings = { enabled: boolean; lastSyncedAt: string; lastAttemptAt: string; error: string; diagnosticJson: string };
export const emptyXiaomiSyncSettings: XiaomiSyncSettings = { enabled: false, lastSyncedAt: "", lastAttemptAt: "", error: "", diagnosticJson: "" };

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("小米健康数据格式尚未识别");
  return value as Record<string, unknown>;
};
function numeric(value: unknown, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error("小米健康数据数值或单位异常");
  return value;
}
function valueOf(row: Record<string, unknown>) {
  try { return object(typeof row.value === "string" ? JSON.parse(row.value) : row.value); }
  catch { throw new Error("小米健康记录内容尚未识别"); }
}
const stamp = (value: unknown) => numeric(value, 946684800, 4102444800);
const beijing = (seconds: number) => new Date((seconds + 8 * 3600) * 1000).toISOString();
const dateOf = (seconds: number) => beijing(seconds).slice(0, 10);

export function normalizeXiaomiSnapshot(snapshot: XiaomiSnapshot): XiaomiDay[] {
  if (!/^[a-f0-9]{64}$/.test(snapshot.accountKey) || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.fromDate)
    || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.toDate) || snapshot.fromDate > snapshot.toDate
    || !Number.isFinite(Date.parse(snapshot.fetchedAt)) || !Array.isArray(snapshot.steps) || !Array.isArray(snapshot.sleep)) throw new Error("小米同步结果无效");
  const inWindow = (date: string) => date >= snapshot.fromDate && date <= snapshot.toDate;
  const sources = new Set<string>();
  const days = new Map<string, XiaomiDay>();
  const getDay = (date: string, source: string) => {
    sources.add(source);
    let day = days.get(date);
    if (!day) { day = { date, source, steps: null, sleep: null }; days.set(date, day); }
    return day;
  };
  const steps = new Map<string, { time: number; source: string; count: number; revision: number }>();
  for (const raw of snapshot.steps) {
    const row = object(raw), value = valueOf(row), time = stamp(row.time);
    const source = typeof row.sid === "string" && row.sid ? row.sid : "未知来源";
    const count = numeric(value.steps, 0, 200_000);
    if (!Number.isInteger(count)) throw new Error("小米步数不是整数");
    const key = JSON.stringify([source, time]);
    const revision = typeof row.update_time === "number" ? row.update_time : 0;
    const current = steps.get(key);
    if (!current || revision > current.revision || (revision === current.revision && count > current.count)) steps.set(key, { time, source, count, revision });
  }
  for (const { time, source, count } of steps.values()) {
    const date = dateOf(time);
    if (!inWindow(date)) continue;
    const day = getDay(date, source);
    day.steps = numeric((day.steps ?? 0) + count, 0, 200_000);
  }
  const nights = new Map<string, { interval: number; revision: number }>();
  for (const raw of snapshot.sleep) {
    const row = object(raw), value = valueOf(row);
    if (value.is_uncomplete === true) continue;
    const start = stamp(value.bedtime), end = stamp(value.device_wake_up_time);
    const interval = numeric((end - start) / 60, 1, 1440);
    const date = dateOf(end);
    if (!inWindow(date)) continue;
    const source = typeof row.sid === "string" && row.sid ? row.sid : "未知来源";
    // Daily form represents the main sleep episode. Keep the longest completed one.
    sources.add(source);
    const previous = nights.get(date);
    const revision = typeof row.update_time === "number" ? row.update_time : 0;
    if (previous && (previous.interval > interval || (previous.interval === interval && previous.revision > revision))) continue;
    const duration = value.duration == null ? null : numeric(value.duration, 1, Math.min(1440, interval + 1));
    if (duration !== null && !Number.isInteger(duration)) throw new Error("小米睡眠时长单位需要重新核对");
    const awake = value.sleep_awake_duration == null ? null : numeric(value.sleep_awake_duration, 0, Math.min(720, interval));
    const day = getDay(date, source);
    day.sleep = { sleepMinutes: duration, sleepStart: beijing(start).slice(11,16), sleepEnd: beijing(end).slice(11,16), awakeMinutes: awake === null ? null : Math.round(awake) };
    nights.set(date, { interval, revision });
  }
  if (sources.size > 1) throw new Error("小米返回了多个数据来源，需要先核对来源，暂未合并写入");
  return [...days.values()].sort((a,b) => a.date.localeCompare(b.date));
}

export function sleepValues(log: XiaomiSleep): XiaomiSleep {
  return { sleepMinutes: log.sleepMinutes, sleepStart: log.sleepStart, sleepEnd: log.sleepEnd, awakeMinutes: log.awakeMinutes };
}
const sameSleep = (a: XiaomiSleep, b: XiaomiSleep) => JSON.stringify(sleepValues(a)) === JSON.stringify(sleepValues(b));
const emptySleep = (log: XiaomiSleep) => log.sleepMinutes === null && !log.sleepStart && !log.sleepEnd && log.awakeMinutes === null;

export function mergeXiaomiDay(current: HealthDailyLog, incoming: XiaomiDay, previous: XiaomiDayState | null, accountKey: string, syncedAt: string, restore = false) {
  const next = { ...current };
  const matching = previous?.accountKey === accountKey;
  const stepsLocked = !restore && (previous?.stepsLocked === true || (matching && previous.latest.steps !== null
    ? current.steps !== previous.latest.steps : current.steps !== null));
  const sleepLocked = !restore && (previous?.sleepLocked === true || (matching && previous.latest.sleep
    ? !sameSleep(current, previous.latest.sleep) : !emptySleep(current)));
  if (incoming.steps !== null && !stepsLocked) next.steps = incoming.steps;
  if (incoming.sleep && !sleepLocked) Object.assign(next, incoming.sleep);
  const state: XiaomiDayState = {
    accountKey, latest: { ...incoming, steps: incoming.steps ?? (matching ? previous.latest.steps : null), sleep: incoming.sleep ?? (matching ? previous.latest.sleep : null) },
    stepsLocked, sleepLocked, syncedAt,
  };
  const changed = next.steps !== current.steps || !sameSleep(next, current);
  return { next, state, changed, protected: stepsLocked || sleepLocked };
}

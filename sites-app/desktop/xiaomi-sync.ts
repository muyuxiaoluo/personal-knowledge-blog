import { isTauri } from "@tauri-apps/api/core";
import type { HealthRepository } from "../app/data/health-repository";
import { desktopApi } from "./integrationApi";

export const XIAOMI_SYNC_EVENT = "mind-garden:xiaomi-synced";
export const XIAOMI_BUSY_EVENT = "mind-garden:xiaomi-busy";
let editing = false;
let busy = false;
export function pauseXiaomiForEditing(value: boolean) { editing = value; }
export function xiaomiSyncBusy() { return busy; }

export function isXiaomiNightlySyncDue(lastAttemptAt: string, now = new Date()) {
  const offset = 8 * 60 * 60_000;
  const beijing = new Date(now.getTime() + offset);
  let scheduledAt = Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), beijing.getUTCDate(), 22) - offset;
  if (scheduledAt > now.getTime()) scheduledAt -= 24 * 60 * 60_000;
  return !(Date.parse(lastAttemptAt) >= scheduledAt);
}

export async function syncXiaomiHealth(repository: HealthRepository) {
  if (busy) return null;
  if (editing) throw new Error("请先保存当天编辑，再同步小米数据。");
  busy = true;
  window.dispatchEvent(new Event(XIAOMI_BUSY_EVENT));
  try {
    const previousAttempt = (await repository.getXiaomiSettings()).lastAttemptAt;
    await repository.saveXiaomiSettings({ lastAttemptAt: new Date().toISOString() });
    const snapshot = await desktopApi.xiaomi.fetch();
    // A form can become dirty while the network request is in flight.
    if (editing) {
      await repository.saveXiaomiSettings({ lastAttemptAt: previousAttempt });
      throw new Error("正在编辑健康记录，本次写入已暂缓；保存后可重新同步。");
    }
    const result = await repository.applyXiaomiSnapshot(snapshot);
    window.dispatchEvent(new Event(XIAOMI_SYNC_EVENT));
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await repository.saveXiaomiSettings({ error: message }).catch(() => undefined);
    throw new Error(message);
  } finally {
    busy = false;
    window.dispatchEvent(new Event(XIAOMI_BUSY_EVENT));
  }
}

export function startXiaomiAutoSync(repository: HealthRepository) {
  let disposed = false;
  const attempt = async () => {
    if (disposed || busy || editing || !isTauri() || !navigator.onLine) return;
    const settings = await repository.getXiaomiSettings();
    if (disposed || !settings.enabled || !isXiaomiNightlySyncDue(settings.lastAttemptAt)) return;
    if (!(await desktopApi.xiaomi.status()).connected || disposed) return;
    await syncXiaomiHealth(repository);
  };
  const tick = () => { void attempt().catch(() => undefined); };
  tick();
  const timer = window.setInterval(tick, 60_000);
  window.addEventListener("focus", tick);
  window.addEventListener("online", tick);
  return () => { disposed = true; window.clearInterval(timer); window.removeEventListener("focus", tick); window.removeEventListener("online", tick); };
}

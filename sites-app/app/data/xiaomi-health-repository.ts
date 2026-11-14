import { emptyXiaomiSyncSettings, mergeXiaomiDay, normalizeXiaomiSnapshot, type XiaomiDayState, type XiaomiSnapshot, type XiaomiSyncSettings } from "../xiaomi-health";
import { assertDate, dailyWriteStatement, normalizeDaily, type HealthRepository } from "./health-repository";
import { executeSqliteTransaction, type SqliteDatabase, type SqliteStatement } from "./sqlite-article-repository";
import type { HealthDailyLog } from "../health-types";

/** Loaded only when Xiaomi settings or synchronization are used. */
export class XiaomiHealthRepository {
  constructor(private readonly database: SqliteDatabase, private readonly health: HealthRepository, private readonly clock: () => Date) {}
  async getXiaomiSettings(): Promise<XiaomiSyncSettings> {
    await this.health.ready();
    const rows = await this.database.select<{ settings_json: string }>("SELECT settings_json FROM health_xiaomi_settings WHERE id=1");
    return rows[0] ? { ...emptyXiaomiSyncSettings, ...JSON.parse(rows[0].settings_json) } : { ...emptyXiaomiSyncSettings };
  }

  async saveXiaomiSettings(patch: Partial<XiaomiSyncSettings>) {
    const settings = { ...await this.getXiaomiSettings(), ...patch };
    await this.database.execute("INSERT INTO health_xiaomi_settings(id,settings_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json", [JSON.stringify(settings)]);
    return settings;
  }

  async getXiaomiDay(date: string): Promise<XiaomiDayState | null> {
    await this.health.ready();
    assertDate(date);
    const rows = await this.database.select<{ state_json: string }>("SELECT state_json FROM health_xiaomi_days WHERE log_date=?", [date]);
    return rows[0] ? JSON.parse(rows[0].state_json) as XiaomiDayState : null;
  }

  async applyXiaomiSnapshot(snapshot: XiaomiSnapshot, restoreDate?: string) {
    await this.health.ready();
    const days = normalizeXiaomiSnapshot(snapshot);
    const batch = crypto.randomUUID();
    const statements: SqliteStatement[] = [];
    let protectedDays = 0;
    for (const incoming of days) {
      const current = await this.health.getDaily(incoming.date);
      const previous = await this.getXiaomiDay(incoming.date);
      const result = mergeXiaomiDay(current, incoming, previous, snapshot.accountKey, snapshot.fetchedAt, incoming.date === restoreDate);
      if (result.protected) protectedDays += 1;
      const next = normalizeDaily(result.next, this.clock());
      next.createdAt = current.createdAt || next.createdAt;
      statements.push(...sourceStatements(current, next, result.state, batch));
    }
    if (statements.length) await executeSqliteTransaction(this.database, statements);
    const applied = (await this.database.select<{ total: number }>("SELECT COUNT(*) AS total FROM health_xiaomi_days WHERE batch_id=?", [batch]))[0]?.total ?? 0;
    await this.saveXiaomiSettings({ lastSyncedAt: snapshot.fetchedAt, error: "" });
    return { days: applied, protectedDays, deferredDays: days.length - applied };
  }

  async restoreXiaomiDay(date: string) {
    const previous = await this.getXiaomiDay(date);
    if (!previous) throw new Error("这一天尚无小米同步记录");
    const current = await this.health.getDaily(date);
    const result = mergeXiaomiDay(current, previous.latest, previous, previous.accountKey, this.clock().toISOString(), true);
    const normalized = normalizeDaily(result.next, this.clock());
    const batch = crypto.randomUUID();
    await executeSqliteTransaction(this.database, sourceStatements(current, normalized, result.state, batch));
    const committed = await this.database.select("SELECT log_date FROM health_xiaomi_days WHERE log_date=? AND batch_id=?", [date, batch]);
    if (!committed.length) throw new Error("这一天刚刚发生了修改，已保留修改；请检查后重试。");
    return this.health.getDaily(date);
  }

}

function sourceStatements(current: HealthDailyLog, next: HealthDailyLog, state: XiaomiDayState, batch: string): SqliteStatement[] {
  const write = dailyWriteStatement(next);
  // Compare source fields inside the transaction. Concurrent edits win, and
  // unrelated notes, meals, weight and subjective ratings are never updated.
  write.sql = write.sql.slice(0, write.sql.indexOf("ON CONFLICT")) + `ON CONFLICT(log_date) DO UPDATE SET
    steps=excluded.steps, sleep_minutes=excluded.sleep_minutes, sleep_start=excluded.sleep_start,
    sleep_end=excluded.sleep_end, awake_minutes=excluded.awake_minutes,
    awake_minutes_known=excluded.awake_minutes_known, updated_at=excluded.updated_at
    WHERE health_daily_logs.steps IS ? AND health_daily_logs.sleep_minutes IS ?
    AND health_daily_logs.sleep_start IS ? AND health_daily_logs.sleep_end IS ?
    AND health_daily_logs.awake_minutes IS ? AND health_daily_logs.awake_minutes_known IS ?
    AND (health_daily_logs.steps IS NOT excluded.steps OR health_daily_logs.sleep_minutes IS NOT excluded.sleep_minutes
    OR health_daily_logs.sleep_start IS NOT excluded.sleep_start OR health_daily_logs.sleep_end IS NOT excluded.sleep_end
    OR health_daily_logs.awake_minutes IS NOT excluded.awake_minutes OR health_daily_logs.awake_minutes_known IS NOT excluded.awake_minutes_known)`;
  write.bindValues!.push(current.steps, current.sleepMinutes, current.sleepStart, current.sleepEnd, current.awakeMinutes ?? 0, current.awakeMinutes === null ? 0 : 1);
  return [write, {
    sql: `INSERT INTO health_xiaomi_days(log_date,state_json,batch_id) SELECT ?,?,? WHERE EXISTS(
      SELECT 1 FROM health_daily_logs WHERE log_date=? AND steps IS ? AND sleep_minutes IS ? AND sleep_start IS ?
      AND sleep_end IS ? AND awake_minutes IS ? AND awake_minutes_known IS ?)
      ON CONFLICT(log_date) DO UPDATE SET state_json=excluded.state_json,batch_id=excluded.batch_id`,
    bindValues: [next.date, JSON.stringify(state), batch, next.date, next.steps, next.sleepMinutes, next.sleepStart, next.sleepEnd, next.awakeMinutes ?? 0, next.awakeMinutes === null ? 0 : 1],
  }];
}


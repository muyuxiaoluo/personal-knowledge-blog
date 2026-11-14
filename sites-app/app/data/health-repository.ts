import type {
  HealthAiReport,
  HealthDailyLog,
  HealthMeal,
  HealthMealSlot,
  HealthProfile,
  HealthSex,
} from "../health-types";
import { emptyHealthDailyLog, emptyHealthProfile } from "../health-types";
import { MealPhotoRepository } from "./meal-photo-repository";
import type { XiaomiDayState, XiaomiSnapshot, XiaomiSyncSettings } from "../xiaomi-health";
import {
  executeSqliteTransaction,
  type SqliteDatabase,
  type SqliteStatement,
} from "./sqlite-article-repository";

type ProfileRow = {
  age: number | null;
  sex: HealthSex;
  height_cm: number | null;
  current_weight_kg: number | null;
  target_weight_kg: number | null;
  target_date: string;
  diet_preferences: string;
  avoid_foods: string;
  allergies: string;
  health_notes: string;
  updated_at: string;
};

type DailyRow = {
  log_date: string;
  sleep_minutes: number | null;
  sleep_start: string;
  sleep_end: string;
  awake_minutes: number;
  awake_minutes_known: number;
  sleep_quality: number | null;
  energy_level: number | null;
  steps: number | null;
  weight_kg: number | null;
  activity_minutes: number | null;
  activity_note: string;
  note: string;
  created_at: string;
  updated_at: string;
};

type MealRow = {
  meal_date: string;
  slot: HealthMealSlot;
  eaten_at: string;
  description: string;
  updated_at: string;
};

type ReportRow = { report_date: string; content: string; generated_at: string };

const migrations = [
  `CREATE TABLE IF NOT EXISTS health_xiaomi_settings (id INTEGER PRIMARY KEY CHECK(id=1), settings_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS health_xiaomi_days (log_date TEXT PRIMARY KEY, state_json TEXT NOT NULL, batch_id TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS health_profile (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    age INTEGER,
    sex TEXT NOT NULL DEFAULT 'unspecified',
    height_cm REAL,
    current_weight_kg REAL,
    target_weight_kg REAL,
    target_date TEXT NOT NULL DEFAULT '',
    diet_preferences TEXT NOT NULL DEFAULT '',
    avoid_foods TEXT NOT NULL DEFAULT '',
    allergies TEXT NOT NULL DEFAULT '',
    health_notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS health_daily_logs (
    log_date TEXT PRIMARY KEY NOT NULL,
    sleep_minutes INTEGER,
    sleep_start TEXT NOT NULL DEFAULT '',
    sleep_end TEXT NOT NULL DEFAULT '',
    awake_minutes INTEGER NOT NULL DEFAULT 0,
    awake_minutes_known INTEGER NOT NULL DEFAULT 0,
    sleep_quality INTEGER,
    energy_level INTEGER,
    steps INTEGER,
    weight_kg REAL,
    activity_minutes INTEGER,
    activity_note TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS health_meals (
    meal_date TEXT NOT NULL,
    slot TEXT NOT NULL,
    eaten_at TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (meal_date, slot)
  )`,
  `CREATE TABLE IF NOT EXISTS health_ai_reports (
    report_date TEXT PRIMARY KEY NOT NULL,
    content TEXT NOT NULL,
    generated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_health_daily_logs_date ON health_daily_logs(log_date DESC)",
  "CREATE INDEX IF NOT EXISTS idx_health_meals_date ON health_meals(meal_date DESC)",
] as const;

/** Health data stays outside sync v3. Opt-in private v4 journaling is installed separately. */
export class HealthRepository {
  private initialization: Promise<void> | null = null;
  readonly mealPhotos: MealPhotoRepository;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date(),
  ) { this.mealPhotos = new MealPhotoRepository(database); }

  private async initialize() {
    this.initialization ??= (async () => {
      for (const statement of migrations) await this.database.execute(statement);
      await this.mealPhotos.ready();
      const dailyColumns = new Set((await this.database.select<{ name: string }>("PRAGMA table_info(health_daily_logs)")).map((column) => column.name));
      if (!dailyColumns.has("sleep_minutes")) await this.database.execute("ALTER TABLE health_daily_logs ADD COLUMN sleep_minutes INTEGER");
      if (!dailyColumns.has("awake_minutes_known")) {
        await this.database.execute("ALTER TABLE health_daily_logs ADD COLUMN awake_minutes_known INTEGER NOT NULL DEFAULT 0");
        await this.database.execute("UPDATE health_daily_logs SET awake_minutes_known = 1 WHERE awake_minutes > 0");
      }
    })().catch((error) => {
      this.initialization = null;
      throw error;
    });
    await this.initialization;
  }

  async ready() {
    await this.initialize();
  }

  private async xiaomiSource() {
    const { XiaomiHealthRepository } = await import("./xiaomi-health-repository");
    return new XiaomiHealthRepository(this.database, this, this.clock);
  }
  async getXiaomiSettings(): Promise<XiaomiSyncSettings> { return (await this.xiaomiSource()).getXiaomiSettings(); }
  async saveXiaomiSettings(patch: Partial<XiaomiSyncSettings>) { return (await this.xiaomiSource()).saveXiaomiSettings(patch); }
  async getXiaomiDay(date: string): Promise<XiaomiDayState | null> { return (await this.xiaomiSource()).getXiaomiDay(date); }
  async applyXiaomiSnapshot(snapshot: XiaomiSnapshot) { return (await this.xiaomiSource()).applyXiaomiSnapshot(snapshot); }
  async restoreXiaomiDay(date: string) { return (await this.xiaomiSource()).restoreXiaomiDay(date); }

  async getProfile(): Promise<HealthProfile> {
    await this.initialize();
    const rows = await this.database.select<ProfileRow>("SELECT * FROM health_profile WHERE id = 1 LIMIT 1");
    const row = rows[0];
    return row ? rowToProfile(row) : structuredClone(emptyHealthProfile);
  }

  async saveProfile(profile: HealthProfile): Promise<HealthProfile> {
    await this.initialize();
    const normalized = normalizeProfile(profile, this.clock());
    await this.database.execute(
      `INSERT INTO health_profile(
        id, age, sex, height_cm, current_weight_kg, target_weight_kg, target_date,
        diet_preferences, avoid_foods, allergies, health_notes, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET age = excluded.age, sex = excluded.sex,
        height_cm = excluded.height_cm, current_weight_kg = excluded.current_weight_kg,
        target_weight_kg = excluded.target_weight_kg, target_date = excluded.target_date,
        diet_preferences = excluded.diet_preferences, avoid_foods = excluded.avoid_foods,
        allergies = excluded.allergies, health_notes = excluded.health_notes,
        updated_at = excluded.updated_at`,
      [
        normalized.age, normalized.sex, normalized.heightCm, normalized.currentWeightKg,
        normalized.targetWeightKg, normalized.targetDate, normalized.dietPreferences,
        normalized.avoidFoods, normalized.allergies, normalized.healthNotes, normalized.updatedAt,
      ],
    );
    return normalized;
  }

  async getDaily(date: string): Promise<HealthDailyLog> {
    await this.initialize();
    assertDate(date);
    const rows = await this.database.select<DailyRow>("SELECT * FROM health_daily_logs WHERE log_date = ? LIMIT 1", [date]);
    return rows[0] ? rowToDaily(rows[0]) : emptyHealthDailyLog(date);
  }

  async listDaily(fromDate = "", limit = 30): Promise<HealthDailyLog[]> {
    await this.initialize();
    if (fromDate) assertDate(fromDate);
    const safeLimit = Math.max(1, Math.min(366, Math.round(limit)));
    const rows = fromDate
      ? await this.database.select<DailyRow>("SELECT * FROM health_daily_logs WHERE log_date >= ? ORDER BY log_date DESC LIMIT ?", [fromDate, safeLimit])
      : await this.database.select<DailyRow>("SELECT * FROM health_daily_logs ORDER BY log_date DESC LIMIT ?", [safeLimit]);
    return rows.map(rowToDaily);
  }

  async saveDaily(log: HealthDailyLog): Promise<HealthDailyLog> {
    await this.initialize();
    const normalized = normalizeDaily(log, this.clock());
    const current = await this.getDaily(normalized.date);
    normalized.createdAt = current.createdAt || normalized.createdAt;
    const statement = dailyWriteStatement(normalized);
    await this.database.execute(statement.sql, statement.bindValues);
    return normalized;
  }

  async saveDay(log: HealthDailyLog, meals: HealthMeal[]) {
    await this.initialize();
    const now = this.clock();
    const normalizedDaily = normalizeDaily(log, now);
    const currentRows = await this.database.select<Pick<DailyRow, "created_at">>(
      "SELECT created_at FROM health_daily_logs WHERE log_date = ? LIMIT 1",
      [normalizedDaily.date],
    );
    normalizedDaily.createdAt = currentRows[0]?.created_at || normalizedDaily.createdAt;
    const seenSlots = new Set<HealthMealSlot>();
    const normalizedMeals = meals.map((meal) => {
      if (meal.date !== normalizedDaily.date) throw new Error("餐食日期与当天记录不一致");
      if (seenSlots.has(meal.slot)) throw new Error("同一餐食类型不能重复保存");
      seenSlots.add(meal.slot);
      return normalizeMeal(meal, now);
    });
    await executeSqliteTransaction(this.database, [
      dailyWriteStatement(normalizedDaily),
      ...normalizedMeals.map(mealWriteStatement),
    ]);
    return { daily: normalizedDaily, meals: normalizedMeals };
  }

  async listMeals(date: string): Promise<HealthMeal[]> {
    await this.initialize();
    assertDate(date);
    const rows = await this.database.select<MealRow>("SELECT * FROM health_meals WHERE meal_date = ? ORDER BY CASE slot WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 WHEN 'dinner' THEN 3 ELSE 4 END", [date]);
    return rows.map(rowToMeal);
  }

  async saveMeal(meal: HealthMeal): Promise<HealthMeal> {
    await this.initialize();
    const normalized = normalizeMeal(meal, this.clock());
    const statement = mealWriteStatement(normalized);
    await this.database.execute(statement.sql, statement.bindValues);
    return normalized;
  }

  async getReport(date: string): Promise<HealthAiReport | null> {
    await this.initialize();
    assertDate(date);
    const rows = await this.database.select<ReportRow>("SELECT * FROM health_ai_reports WHERE report_date = ? LIMIT 1", [date]);
    return rows[0] ? { date: rows[0].report_date, content: rows[0].content, generatedAt: rows[0].generated_at } : null;
  }

  async saveReport(report: HealthAiReport): Promise<HealthAiReport> {
    await this.initialize();
    assertDate(report.date);
    const normalized = { date: report.date, content: report.content.trim(), generatedAt: report.generatedAt || this.clock().toISOString() };
    if (!normalized.content) throw new Error("AI 建议不能为空");
    await this.database.execute(
      `INSERT INTO health_ai_reports(report_date, content, generated_at) VALUES (?, ?, ?)
       ON CONFLICT(report_date) DO UPDATE SET content = excluded.content, generated_at = excluded.generated_at`,
      [normalized.date, normalized.content, normalized.generatedAt],
    );
    return normalized;
  }
}

export async function saveHealthDay(
  repository: HealthRepository,
  log: HealthDailyLog,
  meals: HealthMeal[],
): Promise<{ daily: HealthDailyLog; meals: HealthMeal[] }> {
  // Fast Refresh can keep a repository instance created before saveDay existed.
  // Invoke the current implementation against that instance so the whole save
  // remains atomic and the already-open desktop session keeps working.
  const saveDay = typeof repository.saveDay === "function"
    ? repository.saveDay
    : HealthRepository.prototype.saveDay;
  return saveDay.call(repository, log, meals);
}

export function dailyWriteStatement(log: HealthDailyLog): SqliteStatement {
  return {
    sql: `INSERT INTO health_daily_logs(
      log_date, sleep_minutes, sleep_start, sleep_end, awake_minutes, awake_minutes_known,
      sleep_quality, energy_level, steps, weight_kg, activity_minutes, activity_note, note,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(log_date) DO UPDATE SET sleep_minutes = excluded.sleep_minutes,
      sleep_start = excluded.sleep_start,
      sleep_end = excluded.sleep_end, awake_minutes = excluded.awake_minutes,
      awake_minutes_known = excluded.awake_minutes_known,
      sleep_quality = excluded.sleep_quality, energy_level = excluded.energy_level,
      steps = excluded.steps, weight_kg = excluded.weight_kg,
      activity_minutes = excluded.activity_minutes, activity_note = excluded.activity_note,
      note = excluded.note, updated_at = excluded.updated_at`,
    bindValues: [
      log.date, log.sleepMinutes, log.sleepStart, log.sleepEnd, log.awakeMinutes ?? 0,
      log.awakeMinutes === null ? 0 : 1, log.sleepQuality, log.energyLevel, log.steps,
      log.weightKg, log.activityMinutes, log.activityNote, log.note, log.createdAt,
      log.updatedAt,
    ],
  };
}

function normalizeMeal(meal: HealthMeal, now: Date): HealthMeal {
  assertDate(meal.date);
  assertMealSlot(meal.slot);
  assertClock(meal.eatenAt, true);
  return {
    ...meal,
    eatenAt: meal.eatenAt.trim(),
    description: meal.description.trim(),
    updatedAt: now.toISOString(),
  };
}

function mealWriteStatement(meal: HealthMeal): SqliteStatement {
  if (!meal.description) {
    return {
      sql: "DELETE FROM health_meals WHERE meal_date = ? AND slot = ?",
      bindValues: [meal.date, meal.slot],
    };
  }
  return {
    sql: `INSERT INTO health_meals(meal_date, slot, eaten_at, description, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(meal_date, slot) DO UPDATE SET eaten_at = excluded.eaten_at,
        description = excluded.description, updated_at = excluded.updated_at`,
    bindValues: [meal.date, meal.slot, meal.eatenAt, meal.description, meal.updatedAt],
  };
}

function normalizeProfile(profile: HealthProfile, now: Date): HealthProfile {
  const age = nullableNumber(profile.age, "年龄", 18, 120, true);
  const heightCm = nullableNumber(profile.heightCm, "身高", 100, 250);
  const currentWeightKg = nullableNumber(profile.currentWeightKg, "当前体重", 25, 400);
  const targetWeightKg = nullableNumber(profile.targetWeightKg, "目标体重", 25, 400);
  if (profile.targetDate) assertDate(profile.targetDate);
  if (!["female", "male", "unspecified"].includes(profile.sex)) throw new Error("性别选项无效");
  return {
    age,
    sex: profile.sex,
    heightCm,
    currentWeightKg,
    targetWeightKg,
    targetDate: profile.targetDate.trim(),
    dietPreferences: profile.dietPreferences.trim(),
    avoidFoods: profile.avoidFoods.trim(),
    allergies: profile.allergies.trim(),
    healthNotes: profile.healthNotes.trim(),
    updatedAt: now.toISOString(),
  };
}

export function normalizeDaily(log: HealthDailyLog, now: Date): HealthDailyLog {
  assertDate(log.date);
  assertClock(log.sleepStart, true);
  assertClock(log.sleepEnd, true);
  if (Boolean(log.sleepStart) !== Boolean(log.sleepEnd)) throw new Error("入睡和起床时间需要一起填写");
  const timestamp = now.toISOString();
  return {
    ...log,
    sleepMinutes: nullableNumber(log.sleepMinutes, "实际睡眠时长", 1, 1_440, true),
    awakeMinutes: nullableNumber(log.awakeMinutes, "夜间清醒时间", 0, 720, true),
    sleepQuality: nullableNumber(log.sleepQuality, "睡眠感受", 1, 5, true),
    energyLevel: nullableNumber(log.energyLevel, "精神状态", 1, 5, true),
    steps: nullableNumber(log.steps, "步数", 0, 200_000, true),
    weightKg: nullableNumber(log.weightKg, "体重", 25, 400),
    activityMinutes: nullableNumber(log.activityMinutes, "额外活动时间", 0, 1_440, true),
    activityNote: log.activityNote.trim(),
    note: log.note.trim(),
    createdAt: log.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

function nullableNumber(value: number | null, label: string, min: number, max: number, integer = false) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${label}超出可填写范围`);
  }
  return value;
}

export function assertDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("日期格式无效");
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) throw new Error("日期无效");
}

function assertClock(value: string, allowEmpty: boolean) {
  if (!value && allowEmpty) return;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("时间格式无效");
}

function assertMealSlot(value: string) {
  if (!["breakfast", "lunch", "dinner", "snack"].includes(value)) throw new Error("餐食类型无效");
}

function rowToProfile(row: ProfileRow): HealthProfile {
  return {
    age: row.age,
    sex: row.sex,
    heightCm: row.height_cm,
    currentWeightKg: row.current_weight_kg,
    targetWeightKg: row.target_weight_kg,
    targetDate: row.target_date,
    dietPreferences: row.diet_preferences,
    avoidFoods: row.avoid_foods,
    allergies: row.allergies,
    healthNotes: row.health_notes,
    updatedAt: row.updated_at,
  };
}

function rowToDaily(row: DailyRow): HealthDailyLog {
  return {
    date: row.log_date,
    sleepMinutes: row.sleep_minutes,
    sleepStart: row.sleep_start,
    sleepEnd: row.sleep_end,
    awakeMinutes: row.awake_minutes_known ? row.awake_minutes : null,
    sleepQuality: row.sleep_quality,
    energyLevel: row.energy_level,
    steps: row.steps,
    weightKg: row.weight_kg,
    activityMinutes: row.activity_minutes,
    activityNote: row.activity_note,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMeal(row: MealRow): HealthMeal {
  return { date: row.meal_date, slot: row.slot, eatenAt: row.eaten_at, description: row.description, updatedAt: row.updated_at };
}

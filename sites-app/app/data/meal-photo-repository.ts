import { type MealPhoto, validMealPhotoImage } from "../meal-photo";
import { healthMealSlots } from "../health-types";
import { executeSqliteTransaction, type SqliteDatabase } from "./sqlite-article-repository";

type PhotoRow = { id: string; meal_date: string; slot: MealPhoto["slot"]; eaten_at: string; captured_at: string; image_data_url: string; description: string; reviewed: number; created_at: string };
export function validMealPhotoRow(row: Record<string, unknown>) {
  const date = typeof row.meal_date === "string" ? Date.parse(row.meal_date) : NaN;
  return typeof row.id === "string" && /^[a-f0-9]{64}$/.test(row.id)
    && typeof row.meal_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.meal_date) && Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === row.meal_date
    && healthMealSlots.some(s => s.value === row.slot)
    && typeof row.eaten_at === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.eaten_at)
    && typeof row.captured_at === "string" && row.captured_at.length <= 40 && Number.isFinite(Date.parse(row.captured_at))
    && typeof row.created_at === "string" && row.created_at.length <= 40 && Number.isFinite(Date.parse(row.created_at))
    && typeof row.image_data_url === "string" && validMealPhotoImage(row.image_data_url)
    && typeof row.description === "string" && row.description.length <= 1000 && (row.reviewed === 0 || row.reviewed === 1);
}
export class MealPhotoRepository {
  private initialization: Promise<void> | null = null;
  constructor(readonly database: SqliteDatabase) {}
  async ready() {
    this.initialization ??= this.database.execute(`CREATE TABLE IF NOT EXISTS health_meal_photos (
      id TEXT PRIMARY KEY, meal_date TEXT NOT NULL, slot TEXT NOT NULL, eaten_at TEXT NOT NULL,
      captured_at TEXT NOT NULL, image_data_url TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      reviewed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`)
      .then(async () => { await this.database.execute("CREATE INDEX IF NOT EXISTS idx_meal_photos_date ON health_meal_photos(meal_date, eaten_at)"); })
      .catch(e => { this.initialization = null; throw e; });
    await this.initialization;
  }
  async list(date: string) {
    await this.ready();
    const rows = await this.database.select<PhotoRow>("SELECT * FROM health_meal_photos WHERE meal_date=? ORDER BY eaten_at,id", [date]);
    return rows.map(r => ({ id: r.id, date: r.meal_date, slot: r.slot, eatenAt: r.eaten_at, capturedAt: r.captured_at, imageDataUrl: r.image_data_url, description: r.description, reviewed: r.reviewed === 1, createdAt: r.created_at }));
  }
  async add(photo: MealPhoto) {
    await this.ready();
    const row: PhotoRow = { id: photo.id, meal_date: photo.date, slot: photo.slot, eaten_at: photo.eatenAt, captured_at: photo.capturedAt, image_data_url: photo.imageDataUrl, description: photo.description, reviewed: photo.reviewed ? 1 : 0, created_at: photo.createdAt };
    if (!validMealPhotoRow(row)) throw new Error("照片日期、餐次或内容无效，请检查后重试。");
    const result = await this.database.execute("INSERT OR IGNORE INTO health_meal_photos(id,meal_date,slot,eaten_at,captured_at,image_data_url,description,reviewed,created_at) VALUES (?,?,?,?,?,?,?,?,?)", Object.values(row));
    return (result.rowsAffected ?? 0) > 0;
  }
  async draft(id: string, description: string) {
    await this.ready();
    if (!description.trim() || description.length > 1000) throw new Error("请填写 1000 字以内的餐食描述。");
    await this.database.execute("UPDATE health_meal_photos SET description=? WHERE id=? AND reviewed=0", [description.trim(), id]);
  }
  async confirm(id: string, description: string) {
    await this.ready();
    if (!description.trim() || description.length > 1000) throw new Error("请填写 1000 字以内的餐食描述。");
    const text = description.trim(), now = new Date().toISOString();
    // Append to the latest meal inside one transaction; never replace an existing manual entry.
    await executeSqliteTransaction(this.database, [
      { sql: `INSERT INTO health_meals(meal_date,slot,eaten_at,description,updated_at)
        SELECT meal_date,slot,eaten_at,?,? FROM health_meal_photos WHERE id=? AND reviewed=0
        ON CONFLICT(meal_date,slot) DO UPDATE SET description=CASE WHEN instr(health_meals.description,excluded.description)>0 THEN health_meals.description WHEN health_meals.description='' THEN excluded.description ELSE health_meals.description||char(10)||excluded.description END,
        eaten_at=CASE WHEN health_meals.eaten_at='' THEN excluded.eaten_at ELSE health_meals.eaten_at END,updated_at=excluded.updated_at
        WHERE instr(health_meals.description,excluded.description)>0 OR length(health_meals.description)+length(excluded.description)+1<=4000`, bindValues: [text, now, id] },
      { sql: `UPDATE health_meal_photos SET description=?,reviewed=1 WHERE id=? AND reviewed=0 AND EXISTS(
        SELECT 1 FROM health_meals m WHERE m.meal_date=health_meal_photos.meal_date AND m.slot=health_meal_photos.slot AND instr(m.description,?)>0)`, bindValues: [text, id, text] },
    ]);
    const rows = await this.database.select<{reviewed: number}>("SELECT reviewed FROM health_meal_photos WHERE id=?", [id]);
    if (rows[0]?.reviewed === 0) throw new Error("这餐文字已接近 4000 字，请先精简餐食记录；照片草稿已保留。");
  }
  async remove(id: string) { await this.ready(); await this.database.execute("DELETE FROM health_meal_photos WHERE id=?", [id]); }
}

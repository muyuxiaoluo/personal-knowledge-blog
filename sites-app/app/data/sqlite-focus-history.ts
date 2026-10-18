import type { FocusSession, FocusSessionUpdateInput } from "../work-types";
import { WorkRepositoryError } from "./work-repository";
import type { SqliteDatabase } from "./sqlite-article-repository";
import type { FocusSessionRow } from "./sqlite-work-repository";

export async function updateFocusHistory(database: SqliteDatabase, input: FocusSessionUpdateInput, now: Date, mapSession: (row: FocusSessionRow) => FocusSession): Promise<FocusSession> {
  const start = new Date(input.startedAt).getTime();
  const end = new Date(input.endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > now.getTime()) {
    throw new WorkRepositoryError("结束时间必须晚于开始时间，且不能晚于当前时间", "invalid_data");
  }
  try {
    const rows = await database.select<FocusSessionRow>("SELECT * FROM focus_sessions WHERE id = ? LIMIT 1", [input.id]);
    if (!rows[0]) throw new WorkRepositoryError("没有找到这次投入", "invalid_data");
    const current = mapSession(rows[0]);
    if (!current.endedAt) throw new WorkRepositoryError("请先暂停当前投入，再修改历史记录", "invalid_data");
    const startedAt = new Date(start).toISOString();
    const endedAt = new Date(end).toISOString();
    const durationSeconds = Math.max(1, Math.round((end - start) / 1000));
    const result = await database.execute(
      "UPDATE focus_sessions SET started_at = ?, ended_at = ?, duration_seconds = ? WHERE id = ? AND ended_at IS NOT NULL",
      [startedAt, endedAt, durationSeconds, input.id],
    );
    if (!result.rowsAffected) throw new WorkRepositoryError("记录已发生变化，请重新打开", "invalid_data");
    return { ...current, startedAt, endedAt, durationSeconds };
  } catch (error) {
    if (error instanceof WorkRepositoryError) throw error;
    throw new WorkRepositoryError("修改投入记录失败", "save_failed", error);
  }
}

export async function deleteFocusHistory(database: SqliteDatabase, id: string): Promise<void> {
  try {
    const result = await database.execute("DELETE FROM focus_sessions WHERE id = ? AND ended_at IS NOT NULL", [id]);
    if (!result.rowsAffected) throw new WorkRepositoryError("记录不存在或仍在投入中，请先暂停", "invalid_data");
  } catch (error) {
    if (error instanceof WorkRepositoryError) throw error;
    throw new WorkRepositoryError("删除投入记录失败", "save_failed", error);
  }
}

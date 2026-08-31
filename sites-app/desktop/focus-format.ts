export function formatFocusDuration(seconds: number, clock = false) {
  const normalized = Math.max(0, Math.floor(seconds));
  if (clock) {
    const hours = Math.floor(normalized / 3600);
    const minutes = Math.floor(normalized % 3600 / 60);
    const remaining = normalized % 60;
    return `${hours > 0 ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
  }
  if (normalized < 60) return `${Math.max(1, normalized)} 秒`;
  const totalMinutes = Math.max(1, Math.round(normalized / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours} 小时${minutes ? ` ${minutes} 分钟` : ""}` : `${minutes} 分钟`;
}

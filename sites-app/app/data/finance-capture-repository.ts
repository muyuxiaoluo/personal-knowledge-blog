import { captureCandidates, captureTransaction, type FinanceCapture } from "../finance-capture";
import { FINANCE_CATEGORIES, type FinanceCategory } from "../finance-types";
import { executeSqliteTransaction, type SqliteDatabase, type SqliteStatement } from "./sqlite-article-repository";
import { insertTransactionSql, transactionBindValues } from "./finance-repository";

export class FinanceCaptureRepository {
  constructor(private readonly database: SqliteDatabase, private readonly clock = () => new Date()) {}

  async list(): Promise<FinanceCapture[]> {
    return this.database.select<FinanceCapture>("SELECT * FROM finance_capture_events ORDER BY received_at DESC, id");
  }

  async complete(id: string, description: string, category: FinanceCategory, kind: Exclude<FinanceCapture["kind"], "unknown">) {
    if (!description.trim() || description.length > 500 || !FINANCE_CATEGORIES.some(c => c.value === category)
      || !["expense", "income", "refund", "transfer"].includes(kind)) throw new Error("请填写用途并确认交易类型");
    const event = await this.get(id);
    if (event.state === "duplicate") throw new Error("这条通知已关联，请先取消关联");
    const now = this.clock().toISOString();
    const next = { ...event, state: "completed" as const, description: description.trim(), category, kind, updated_at: now };
    const transaction = captureTransaction(next, next.description, category, kind);
    const statements: SqliteStatement[] = [];
    if (event.transaction_id && event.transaction_id !== transaction.id) throw new Error("请到原账目修改已关联的消费");
    const exists = await this.database.select<{ id: string }>("SELECT id FROM finance_transactions WHERE id=?", [transaction.id]);
    if (exists.length) {
      // Keep the user's budget role, project, note classification and creation time.
      statements.push({ sql: "UPDATE finance_transactions SET description=?,merchant=?,merchant_normalized=?,category=?,category_confirmed=?,kind=?,direction=?,status='通知已补全',updated_at=? WHERE id=? AND import_batch_id IS NULL", bindValues: [transaction.description, transaction.merchant, transaction.merchantNormalized, category, category !== "other" ? 1 : 0, transaction.kind, transaction.direction, now, transaction.id] });
    } else statements.push({ sql: insertTransactionSql, bindValues: transactionBindValues(transaction) });
    statements.push({ sql: "UPDATE finance_capture_events SET state='completed',description=?,category=?,kind=?,transaction_id=?,duplicate_of=NULL,updated_at=? WHERE id=?", bindValues: [next.description, category, kind, transaction.id, now, id] });
    await executeSqliteTransaction(this.database, statements);
  }

  async link(id: string, targetId: string) {
    const events = await this.list();
    const event = events.find(e => e.id === id), target = events.find(e => e.id === targetId);
    if (!event || !target || event.state !== "pending" || event.transaction_id || !captureCandidates(event, events).some(e => e.id === targetId)) throw new Error("关联对象已变化，请刷新后确认");
    // Both devices choose the same leader even if they click opposite directions offline.
    // A completed ledger entry wins; otherwise prefer a known movement, then the stable ID.
    const rank = (e: FinanceCapture) => `${e.transaction_id ? "0" : e.kind === "unknown" ? "2" : "1"}:${e.id}`;
    const [leader, follower] = [event, target].sort((a, b) => rank(a).localeCompare(rank(b)));
    await this.database.execute("UPDATE finance_capture_events SET state='duplicate',duplicate_of=?,updated_at=? WHERE id=? AND state='pending' AND transaction_id IS NULL", [leader.id, this.clock().toISOString(), follower.id]);
  }

  async ignore(id: string) {
    const event = await this.get(id);
    if (event.transaction_id) throw new Error("已有正式账目，请编辑交易类型或用途");
    await this.database.execute("UPDATE finance_capture_events SET state='ignored',duplicate_of=NULL,updated_at=? WHERE id=?", [this.clock().toISOString(), id]);
  }

  async reopen(id: string) {
    await this.database.execute("UPDATE finance_capture_events SET state='pending',duplicate_of=NULL,updated_at=? WHERE id=?", [this.clock().toISOString(), id]);
  }

  private async get(id: string) {
    const event = (await this.database.select<FinanceCapture>("SELECT * FROM finance_capture_events WHERE id=?", [id]))[0];
    if (!event) throw new Error("交易通知不存在，请刷新后重试");
    return event;
  }
}

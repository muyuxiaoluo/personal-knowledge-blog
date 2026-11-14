import type { FinanceCategory, FinanceTransaction } from "./finance-types";

/** One notification is evidence. Only a confirmed consumption becomes a ledger entry. */
export type FinanceCapture = {
  id: string;
  event_key: string;
  source: "wechat" | "cmb";
  amount_cents: number;
  received_at: string;
  kind: "expense" | "unknown" | "refund" | "income" | "transfer";
  state: "pending" | "completed" | "duplicate" | "ignored";
  description: string;
  category: FinanceCategory;
  transaction_id: string | null;
  duplicate_of: string | null;
  updated_at: string;
};

export const financeCaptureSchema = `CREATE TABLE IF NOT EXISTS finance_capture_events (
  id TEXT PRIMARY KEY NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK(source IN ('wechat','cmb')),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  received_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'unknown',
  state TEXT NOT NULL DEFAULT 'pending',
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other',
  transaction_id TEXT,
  duplicate_of TEXT,
  updated_at TEXT NOT NULL
)`;

export const captureSourceLabel = (source: FinanceCapture["source"]) => source === "wechat" ? "微信支付" : "招商银行";

export function captureCandidates(event: FinanceCapture, events: FinanceCapture[]) {
  return events.filter(other => other.id !== event.id && other.source !== event.source
    && other.state !== "ignored" && other.state !== "duplicate"
    && other.amount_cents === event.amount_cents
    && (other.kind === event.kind || other.kind === "unknown" || event.kind === "unknown")
    && Math.abs(Date.parse(other.received_at) - Date.parse(event.received_at)) <= 180_000);
}

export function captureTransaction(event: FinanceCapture, description: string, category: FinanceCategory, kind = event.kind): FinanceTransaction {
  const source = event.source === "wechat" ? "wechat" : "custom";
  return {
    id: `finance-capture-${event.id}`, occurredAt: event.received_at,
    amountCents: event.amount_cents, source, accountId: `finance-account-${source}`,
    kind: kind === "unknown" ? "expense" : kind, direction: kind === "transfer" ? "neutral" : kind === "refund" || kind === "income" ? "in" : "out",
    description, merchant: description, merchantNormalized: description.trim().toLowerCase(),
    externalTransactionId: "", paymentMethod: "", status: event.state === "pending" ? "通知待补全" : "通知已补全",
    category, budgetRole: "unknown", categoryConfirmed: category !== "other", budgetRoleConfirmed: false,
    projectId: null, lifeDomain: null, importBatchId: null, relatedTransactionId: null,
    valueRating: null, duplicateFingerprint: "", createdAt: event.received_at, updatedAt: event.updated_at,
  };
}

/** Unknown movements and ambiguous cross-source pairs do not enter spending totals. */
export function pendingCaptureTransactions(events: FinanceCapture[]) {
  return events.filter(event => event.state === "pending" && !event.transaction_id && event.kind === "expense"
    && captureCandidates(event, events).length === 0)
    .map(event => captureTransaction(event, "待补全用途", "other"));
}

export function mergeCaptureTransactions(transactions: FinanceTransaction[], events: FinanceCapture[]) {
  const existing = new Set(transactions.map(t => t.id));
  return [...transactions, ...pendingCaptureTransactions(events).filter(t => !existing.has(t.id))];
}

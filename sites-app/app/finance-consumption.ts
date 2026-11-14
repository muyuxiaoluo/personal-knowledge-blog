import type { FinanceTransaction } from "./finance-types";

/** Refunds reduce the original purchase; cash-flow records retain their full amounts. */
export function financeConsumptionTransactions(transactions: FinanceTransaction[]): FinanceTransaction[] {
  const refunded = new Map<string, number>();
  for (const transaction of transactions) {
    if (transaction.kind !== "refund" || !transaction.relatedTransactionId) continue;
    refunded.set(transaction.relatedTransactionId, (refunded.get(transaction.relatedTransactionId) ?? 0) + transaction.amountCents);
  }
  return transactions.filter(transaction => transaction.kind === "expense").map(transaction => ({
    ...transaction,
    amountCents: Math.max(0, transaction.amountCents - (refunded.get(transaction.id) ?? 0)),
  })).filter(transaction => transaction.amountCents > 0);
}

export const financeNeedsConfirmation = (transaction: FinanceTransaction) => transaction.kind === "expense"
  && !transaction.categoryConfirmed;

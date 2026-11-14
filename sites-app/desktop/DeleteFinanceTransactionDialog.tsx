import { useState } from "react";
import type { FinanceTransaction } from "../app/finance-types";
import type { FinanceRepository } from "../app/data/finance-repository";
import { Button } from "./DesktopControls";

export function DeleteFinanceTransactionDialog({ transaction, repository, onClose, onDeleted }: {
  transaction: FinanceTransaction; repository: Pick<FinanceRepository, "deleteManualTransaction">;
  onClose: () => void; onDeleted: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await repository.deleteManualTransaction(transaction.id);
    } catch (error) {
      setError(error instanceof Error ? error.message : "删除未完成，请重试");
      setBusy(false);
      return;
    }
    await onDeleted();
  }
  return <div className="wealth-modal-backdrop"><section className="wealth-dialog compact" role="dialog" aria-modal="true" aria-label="删除补记账单">
    <header><div><span>删除补记</span><h2>删除这笔账单？</h2></div><Button iconOnly aria-label="关闭删除提示" disabled={busy} onClick={onClose}>×</Button></header>
    <div className="wealth-delete-summary"><strong>{transaction.merchant || transaction.description}</strong><b>¥{(transaction.amountCents / 100).toFixed(2)}</b><small>{transaction.occurredAt.replace("T", " ").slice(0, 16)}</small></div>
    <p className="wealth-muted">删除后，这笔补记会从流水、消费统计和消费日历中移除。</p>
    {error && <p role="alert">{error}</p>}
    <footer><Button disabled={busy} onClick={onClose}>保留账单</Button><Button variant="danger" disabled={busy} onClick={() => void remove()}>{busy ? "正在删除…" : "确认删除"}</Button></footer>
  </section></div>;
}

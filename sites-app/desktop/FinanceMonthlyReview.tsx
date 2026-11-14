import { useState } from "react";
import { groupFinanceReview } from "../app/finance-classification";
import { FINANCE_CATEGORIES, FINANCE_CATEGORY_LABELS, type FinanceCategory, type FinanceImportPreview, type FinanceTransaction } from "../app/finance-types";
import { Button, SelectMenu } from "./DesktopControls";

const money = (cents: number) => `¥${(cents / 100).toFixed(2)}`;

export function FinanceMonthlyReview({ transactions, onConfirm, onImport, onManual }: {
  transactions: FinanceTransaction[];
  onConfirm: (key: string, ids: string[], category: FinanceCategory, remember: boolean) => Promise<void>;
  onImport: () => void;
  onManual: () => void;
}) {
  const groups = groupFinanceReview(transactions);
  return <div className="wealth-content wealth-monthly-review">
    <section className="wealth-panel"><header><div><span>每月集中整理</span><h2>{groups.length ? `${groups.length} 组消费待分类` : "本月账单分类已整理"}</h2></div><div className="wealth-row-actions"><Button variant="secondary" onClick={onImport}>导入月度账单</Button><Button variant="secondary" onClick={onManual}>补记银行卡 / 其他</Button></div></header>
      <p className="wealth-muted">相似商户与用途放在一起确认，记住后会用于下次导入。消费性质、关联项目和是否值得都可留到复盘时补充。</p>
      {!groups.length && <p className="wealth-muted">已记住的分类会自动沿用。新商户和拿不准的消费会出现在这里，也可以暂时保留待分类。</p>}
    </section>
    {groups.map(group => <ReviewGroup key={JSON.stringify([group.key, group.transactions.map(item => item.id)])} group={group} onConfirm={onConfirm} />)}
  </div>;
}

function ReviewGroup({ group, onConfirm }: {
  group: ReturnType<typeof groupFinanceReview>[number];
  onConfirm: (key: string, ids: string[], category: FinanceCategory, remember: boolean) => Promise<void>;
}) {
  const [category, setCategory] = useState(group.category);
  const [selected, setSelected] = useState(() => new Set(group.transactions.map(item => item.id)));
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const total = group.transactions.filter(item => selected.has(item.id)).reduce((sum, item) => sum + item.amountCents, 0);
  async function save() {
    if (busy || !selected.size) return;
    setBusy(true); setError("");
    try { await onConfirm(group.key, [...selected], category, remember); }
    catch (error) { setError(error instanceof Error ? error.message : "分类保存失败，请重试"); }
    finally { setBusy(false); }
  }
  return <section className="wealth-panel wealth-review-group" aria-label={`整理 ${group.merchant}`}>
    <header><div><span>{group.transactions.length} 笔 · 建议 {FINANCE_CATEGORY_LABELS[group.category]}</span><h3>{group.merchant}</h3></div><strong>{money(total)}</strong></header>
    <p className="wealth-muted">{[...new Set(group.transactions.map(item => item.description).filter(Boolean))].slice(0, 3).join("；") || "账单未提供商品说明"}</p>
    <fieldset disabled={busy} className="wealth-review-controls">
      <SelectMenu label="这组消费的分类" value={category} onChange={value => setCategory(value as FinanceCategory)} options={FINANCE_CATEGORIES} />
      <label className="wealth-check"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />记住这类分类</label>
      <Button variant="primary" disabled={!selected.size || busy} onClick={() => void save()}>{busy ? "正在保存…" : `确认 ${selected.size} 笔分类`}</Button>
    </fieldset>
    <details><summary>查看明细 / 排除个别交易</summary><ul className="wealth-review-items">{group.transactions.map(item => <li key={item.id}><label><input type="checkbox" disabled={busy} checked={selected.has(item.id)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; })} /><span>{item.occurredAt.slice(0, 16).replace("T", " ")} · {item.description || item.merchant}</span><strong>{money(item.amountCents)}</strong></label></li>)}</ul></details>
    {error && <p role="alert">{error}</p>}
  </section>;
}

export function ImportCaptureReview({ preview, busy, onMatch }: { preview: FinanceImportPreview; busy: boolean; onMatch: (rowNumber: number, captureId: string) => void }) {
  const records = preview.records.filter(record => record.selected && record.decision !== "duplicate" && record.decision !== "skipped" && record.captureCandidates?.length);
  if (!records.length) return null;
  return <section className="wealth-import-matches" aria-label="核对已有通知记录"><h3>这些账单可能已经通过通知记过</h3><p className="wealth-muted">金额相同且时间相近仅作为线索。确认是同一笔后勾选，本机统计将采用账单，保留原通知；撤销导入会恢复原记录。</p>
    {records.map(record => <div key={record.rowNumber}><strong>{record.merchant || record.description} · {money(record.amountCents)} · {record.occurredAt.slice(0, 16).replace("T", " ")}</strong>{record.captureCandidates!.map(candidate => <label className="wealth-check" key={candidate.id}><input type="checkbox" disabled={busy} checked={record.matchedCaptureIds?.includes(candidate.id) ?? false} onChange={() => onMatch(record.rowNumber, candidate.id)} />同一笔：{candidate.label}</label>)}</div>)}
  </section>;
}

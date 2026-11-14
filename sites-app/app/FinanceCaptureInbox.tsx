import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { FinanceCaptureRepository } from "./data/finance-capture-repository";
import { captureCandidates, captureSourceLabel, type FinanceCapture } from "./finance-capture";
import { FINANCE_CATEGORIES, FINANCE_CATEGORY_LABELS, type FinanceCategory } from "./finance-types";

const money = (value: number) => `¥${(value / 100).toFixed(2)}`;
const stamp = (value: string) => new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function FinanceCaptureInbox({ repository, focusId, onChanged, hiddenIds = [] }: {
  repository: FinanceCaptureRepository; focusId?: string | null; onChanged?: () => void | Promise<void>; hiddenIds?: string[];
}) {
  const [events, setEvents] = useState<FinanceCapture[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => { try { setEvents(await repository.list()); } catch { setError("交易通知暂时无法读取，请重试"); } }, [repository]);
  useEffect(() => { void refresh(); const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => { if (focusId) setEditing(focusId); }, [focusId]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await fn(); setEditing(null); await refresh(); await onChanged?.(); }
    catch (e) { setError(e instanceof Error ? e.message : "保存未完成，请重试"); }
    finally { setBusy(false); }
  };
  const visibleEvents = events.filter(e => !hiddenIds.includes(e.id) && !hiddenIds.includes(e.duplicate_of ?? ""));
  const pending = visibleEvents.filter(e => e.state === "pending");
  const event = visibleEvents.find(e => e.id === editing);
  return <section className="capture-inbox" aria-label="交易通知待补全">
    <h2>交易待补全{pending.length ? ` · ${pending.length} 条` : ""}</h2>
    <p className="capture-muted">明确消费且没有疑似关联的记录计入待分类支出。性质不明或疑似重复的记录确认后入账；时间为通知到达时间。</p>
    {!pending.length && <p>当前没有待补全交易。</p>}
    <div className="capture-list">{pending.map(e => <button type="button" className="capture-row" key={e.id} onClick={() => setEditing(e.id)}>
      <strong>{money(e.amount_cents)} · {captureSourceLabel(e.source)}</strong>
      <span>{stamp(e.received_at)} · {e.description || (captureCandidates(e, events).length ? "疑似关联，请确认" : e.kind === "expense" ? "待补全用途" : "待确认交易类型")}</span>
    </button>)}</div>
    {event && event.state !== "duplicate" && <CaptureForm key={event.id} event={event} events={visibleEvents} busy={busy}
      onSave={(description, category, kind) => act(() => repository.complete(event.id, description, category, kind))}
      onLink={id => act(() => repository.link(event.id, id))} onIgnore={() => act(() => repository.ignore(event.id))} onCancel={() => setEditing(null)} />}
    <details><summary>最近已处理的通知</summary>{visibleEvents.filter(e => e.state !== "pending").slice(0, 30).map(e => <div className="capture-history" key={e.id}>
      <span>{stamp(e.received_at)} · {captureSourceLabel(e.source)} · {money(e.amount_cents)} · {e.state === "completed" ? e.description : e.state === "duplicate" ? "已关联另一条通知" : "已忽略"}</span>
      <button className="capture-button" type="button" disabled={busy} onClick={() => e.state === "completed" ? setEditing(e.id) : void act(() => repository.reopen(e.id))}>{e.state === "completed" ? "修改用途" : e.state === "duplicate" ? "取消关联" : "恢复处理"}</button>
    </div>)}</details>
    {error && <p role="alert">{error}</p>}
  </section>;
}

function CaptureForm({ event, events, busy, onSave, onLink, onIgnore, onCancel }: {
  event: FinanceCapture; events: FinanceCapture[]; busy: boolean;
  onSave: (description: string, category: FinanceCategory, kind: Exclude<FinanceCapture["kind"], "unknown">) => Promise<void>;
  onLink: (id: string) => Promise<void>; onIgnore: () => Promise<void>; onCancel: () => void;
}) {
  const [description, setDescription] = useState(event.description);
  const [category, setCategory] = useState(event.category);
  const [kind, setKind] = useState(event.kind === "unknown" ? "" : event.kind);
  const [separate, setSeparate] = useState(false);
  const candidates = event.state === "pending" && !event.transaction_id ? captureCandidates(event, events) : [];
  const save = (e: FormEvent) => { e.preventDefault(); if (kind && (!candidates.length || separate)) void onSave(description, category, kind as Exclude<FinanceCapture["kind"], "unknown">); };
  return <form className="capture-form" onSubmit={save}><fieldset disabled={busy}>
    <legend>补全 {money(event.amount_cents)} · {captureSourceLabel(event.source)}</legend>
    {candidates.length > 0 && <div className="capture-candidates"><p>以下通知可能对应同一笔交易，请选择关联，或确认分别入账。</p>
      {candidates.map(c => <button className="capture-button" key={c.id} type="button" onClick={() => void onLink(c.id)}>与 {stamp(c.received_at)} {captureSourceLabel(c.source)} {money(c.amount_cents)}{c.description ? `（${c.description}）` : ""} 关联</button>)}
      <label className="capture-check"><input type="checkbox" checked={separate} onChange={e => setSeparate(e.target.checked)} />这是另一笔交易，分别入账</label>
    </div>}
    <label>交易类型<select required value={kind} onChange={e => setKind(e.target.value)}><option value="">请选择</option><option value="expense">消费支出</option><option value="transfer">资金往来（借还款 / 充值 / 提现 / 本人账户转移）</option><option value="refund">退款到账</option><option value="income">收入</option></select></label>
    <label>这笔钱用于什么<input value={description} onChange={e => setDescription(e.target.value)} maxLength={500} required placeholder="例如：午饭、地铁、买书" /></label>
    <label>分类<select value={category} onChange={e => setCategory(e.target.value as FinanceCategory)}>{FINANCE_CATEGORIES.map(c => <option key={c.value} value={c.value}>{FINANCE_CATEGORY_LABELS[c.value]}</option>)}</select></label>
    {kind === "refund" && <p className="capture-muted">保存后可在桌面端“流水 → 调整”中关联原付款，支持退押金和部分退款。</p>}
    {kind === "transfer" && <p className="capture-muted">借出、借入、归还和收回借款都可归入资金往来，保留流水，排除消费和收入统计。</p>}
    <div className="capture-actions"><button className="capture-button" type="submit" disabled={!kind || !description.trim() || candidates.length > 0 && !separate}>{busy ? "正在保存…" : "保存并继续"}</button><button className="capture-button" type="button" onClick={onCancel}>稍后处理</button>{!event.transaction_id && <button className="capture-button" type="button" onClick={() => void onIgnore()}>忽略这条通知</button>}</div>
  </fieldset></form>;
}

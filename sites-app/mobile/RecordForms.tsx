import { useEffect, useState, type FormEvent } from "react";
import type { HealthRepository } from "../app/data/health-repository";
import type { FinanceRepository } from "../app/data/finance-repository";
import { emptyHealthDailyLog, type HealthDailyLog, type HealthMeal, type HealthMealSlot } from "../app/health-types";
import { FINANCE_BUDGET_ROLES, FINANCE_CATEGORIES, type FinanceManualEntry, type FinanceTransaction } from "../app/finance-types";
import { LIFE_DOMAIN_OPTIONS } from "../app/domain-taxonomy";
export const today = () => localTimestamp().slice(0, 10);
function localTimestamp() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
const slots: Array<[HealthMealSlot, string]> = [["breakfast", "早餐"], ["lunch", "午餐"], ["dinner", "晚餐"], ["snack", "加餐"]];
export function HealthForm({ repository, date, onDate, onSaved }: { repository: HealthRepository; date: string; onDate: (s: string) => void; onSaved: () => Promise<void> }) {
  const [log, setLog] = useState(emptyHealthDailyLog(date)); const [meals, setMeals] = useState<HealthMeal[]>([]);
  const [hours, setHours] = useState(""); const [minutes, setMinutes] = useState(""); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => { let active = true; setLoading(true); void Promise.all([repository.getDaily(date), repository.listMeals(date)]).then(([day, food]) => {
    if (!active) return; setLog(day); setHours(day.sleepMinutes === null ? "" : String(Math.floor(day.sleepMinutes / 60))); setMinutes(day.sleepMinutes === null ? "" : String(day.sleepMinutes % 60));
    setMeals(slots.map(([slot]) => food.find(m => m.slot === slot) ?? { date, slot, description: "", eatenAt: "", updatedAt: "" })); setLoading(false);
  }).catch(() => { if (active) setError("读取失败，请返回后重试。"); }); return () => { active = false; }; }, [date, repository]);
  const patch = (key: keyof HealthDailyLog, value: number | string | null) => setLog(l => ({ ...l, [key]: value }));
  const save = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setError(""); try { await repository.saveDay({ ...log, sleepMinutes: hours === "" && minutes === "" ? null : Number(hours) * 60 + Number(minutes) }, meals); await onSaved(); } catch (e) { setError(e instanceof Error && !/sqlite|sql|constraint/i.test(e.message) ? e.message : "保存未完成，请重试。"); } finally { setBusy(false); } };
  return <form className="card" onSubmit={save}><label>日期<input type="date" max={today()} required value={date} disabled={busy} onChange={e => { if (e.target.value) onDate(e.target.value); }} /></label><fieldset disabled={busy || loading}><legend>今天的状态</legend>
    <span>实际睡眠总时长</span><div className="two-fields"><label>小时<input inputMode="numeric" type="number" min="0" max="24" value={hours} onChange={e => setHours(e.target.value)} /></label><label>分钟<input inputMode="numeric" type="number" min="0" max="59" value={minutes} onChange={e => setMinutes(e.target.value)} /></label></div>
    <div className="two-fields"><label>入睡时间（可选）<input type="time" value={log.sleepStart} required={Boolean(log.sleepEnd)} onChange={e => patch("sleepStart", e.target.value)} /></label><label>起床时间（可选）<input type="time" value={log.sleepEnd} required={Boolean(log.sleepStart)} onChange={e => patch("sleepEnd", e.target.value)} /></label></div>
    <p>按起床日期记录；跨夜可填写前一晚入睡时间。起止时间请一起填写，实际睡眠总时长单独记录。</p>
    {([ ["sleepQuality", "睡眠感受"], ["energyLevel", "精神状态"] ] as const).map(([key, label]) => <label key={key}>{label}<select value={log[key] ?? ""} onChange={e => patch(key, e.target.value ? Number(e.target.value) : null)}><option value="">未记录</option>{["很差", "较差", "一般", "不错", "很好"].map((v, i) => <option key={v} value={i + 1}>{v}</option>)}</select></label>)}
    {([ ["steps", "步数", 0, 200000, 1], ["weightKg", "体重（kg）", 25, 400, 0.1], ["activityMinutes", "额外活动（分钟）", 0, 1440, 1] ] as const).map(([key, label, min, max, step]) => <label key={key}>{label}<input type="number" inputMode={step < 1 ? "decimal" : "numeric"} min={min} max={max} step={step} value={log[key] ?? ""} onChange={e => patch(key, e.target.value === "" ? null : Number(e.target.value))} /></label>)}
    <label>活动简记<input maxLength={1000} value={log.activityNote} onChange={e => patch("activityNote", e.target.value)} /></label><label>备注<textarea maxLength={4000} value={log.note} onChange={e => patch("note", e.target.value)} /></label>
    <h2>吃了什么</h2>{meals.map((meal, index) => <div className="meal" key={meal.slot}><label>{slots[index][1]}<textarea value={meal.description} maxLength={4000} placeholder="简单写下吃了什么" onChange={e => setMeals(ms => ms.map((m, i) => i === index ? { ...m, description: e.target.value } : m))} /></label><label>时间（可选）<input type="time" value={meal.eatenAt} onChange={e => setMeals(ms => ms.map((m, i) => i === index ? { ...m, eatenAt: e.target.value } : m))} /></label></div>)}
    <button className="primary" type="submit">{busy ? "正在保存…" : "保存健康记录"}</button></fieldset>{error && <p role="alert">{error}</p>}</form>;
}
export function ExpenseForm({ repository, transaction, onSaved }: { repository: FinanceRepository; transaction: FinanceTransaction | null; onSaved: () => Promise<void> }) {
  const [entry, setEntry] = useState<FinanceManualEntry>(transaction ?? { amountCents: 0, occurredAt: localTimestamp(), description: "", source: "custom", category: "other", budgetRole: "unknown", projectId: null, lifeDomain: null, valueRating: null });
  const [amount, setAmount] = useState(transaction ? (transaction.amountCents / 100).toFixed(2) : ""); const [busy, setBusy] = useState(false); const [deleting, setDeleting] = useState(false); const [error, setError] = useState("");
  const patch = (value: Partial<FinanceManualEntry>) => setEntry(e => ({ ...e, ...value }));
  const save = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setError(""); try {
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) throw new Error("请输入最多两位小数的金额");
    const data = { ...entry, amountCents: Math.round(Number(amount) * 100) };
    if (transaction) await repository.updateManualTransaction(transaction.id, data); else await repository.addManualTransaction(data);
    await onSaved();
  } catch { setError("保存失败，请检查金额、时间和说明后重试。"); } finally { setBusy(false); } };
  return <form className="card" onSubmit={save}><fieldset disabled={busy}><legend>{transaction ? "编辑手工消费" : "记一笔消费"}</legend>
    <label>金额（元）<input inputMode="decimal" value={amount} placeholder="0.00" required onChange={e => setAmount(e.target.value)} /></label>
    <label>发生时间<input type="datetime-local" required value={entry.occurredAt.slice(0, 16).replace(" ", "T")} onChange={e => patch({ occurredAt: e.target.value })} /></label>
    <label>说明<input maxLength={1000} required placeholder="这笔钱花在了哪里" value={entry.description} onChange={e => patch({ description: e.target.value })} /></label>
    <label>支付来源<select value={entry.source} onChange={e => patch({ source: e.target.value as FinanceManualEntry["source"] })}><option value="custom">银行卡 / 其他</option><option value="cash">现金</option><option value="alipay">支付宝（手工）</option><option value="wechat">微信（手工）</option></select></label>
    <details><summary>更多信息（可选）</summary>
      <label>分类<select value={entry.category} onChange={e => patch({ category: e.target.value as FinanceManualEntry["category"] })}>{FINANCE_CATEGORIES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
      <label>预算角色<select value={entry.budgetRole} onChange={e => patch({ budgetRole: e.target.value as FinanceManualEntry["budgetRole"] })}>{FINANCE_BUDGET_ROLES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
      <p>项目关联：{entry.projectId ? "已关联，保存时保留" : "未关联"}。项目列表暂不传到手机，可回到桌面调整。</p>
      <label>生活领域<select value={entry.lifeDomain ?? ""} onChange={e => patch({ lifeDomain: e.target.value as FinanceManualEntry["lifeDomain"] || null })}><option value="">未选择</option>{LIFE_DOMAIN_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
      <label>是否值得<select value={entry.valueRating ?? ""} onChange={e => patch({ valueRating: e.target.value as FinanceManualEntry["valueRating"] || null })}><option value="">未评价</option><option value="worthwhile">值得</option><option value="neutral">一般</option><option value="regret">后悔</option></select></label>
    </details><button className="primary">{busy ? "正在保存…" : "保存消费"}</button>
    {transaction && <button type="button" className="danger" onClick={() => setDeleting(true)}>删除这笔手工记录</button>}
    {deleting && transaction && <div role="alertdialog" aria-label="确认删除消费"><p>删除后会同步到其他设备。确认删除这笔手工记录？</p><button type="button" onClick={() => setDeleting(false)}>取消</button><button type="button" className="danger" onClick={() => { setBusy(true); void repository.deleteManualTransaction(transaction.id).then(onSaved).catch(() => setError("删除未完成，请重试。")).finally(() => setBusy(false)); }}>确认删除</button></div>}
    </fieldset>{error && <p role="alert">{error}</p>}</form>;
}

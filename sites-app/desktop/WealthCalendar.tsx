import { useMemo, useState } from "react";
import { buildFinanceCalendar } from "../app/finance-calendar";
import { FINANCE_CATEGORY_LABELS, type FinanceTransaction } from "../app/finance-types";

const money = (cents: number) => new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(cents / 100);

export function WealthCalendar({ month, today, transactions }: { month: string; today: string; transactions: FinanceTransaction[] }) {
  const calendar = useMemo(() => buildFinanceCalendar(month, transactions), [month, transactions]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const selected = calendar.days.find((day) => day.date === selectedDate);
  return <div className="wealth-content">
    <section className="wealth-panel wealth-calendar">
      <header><div><span>消费分布</span><h2>{calendar.label}消费日历</h2></div><p className="wealth-muted">颜色越深，当天支出越高</p></header>
      <div className="wealth-calendar-summary">
        <div><span>本月已记录支出</span><strong>{money(calendar.totalCents)}</strong></div>
        <div><span>最高消费日</span><strong>{calendar.peak ? `${Number(calendar.peak.date.slice(8))}日 · ${money(calendar.peak.amountCents)}` : "暂无支出"}</strong></div>
        <div><span>消费最高两天占比</span><strong>{calendar.totalCents ? `${(calendar.topTwoShare * 100).toFixed(1)}%` : "—"}</strong><small>{calendar.spendingDays} 天有支出记录</small></div>
      </div>
      <p className="wealth-muted">消费按关联退款抵扣后的金额统计，退押金抵扣原付款当天；借还款等资金往来已排除。点击日期查看明细；无记录不代表当天没有消费。</p>
      <div className="wealth-calendar-scroll"><div className="wealth-calendar-grid" aria-label={`${calendar.label}每日消费`}>
        {["一", "二", "三", "四", "五", "六", "日"].map((day) => <div className="wealth-calendar-weekday" key={day}>周{day}</div>)}
        {Array.from({ length: calendar.leadingDays }, (_, index) => <div aria-hidden="true" key={`blank-${index}`} />)}
        {calendar.days.map((day) => {
          const level = day.amountCents && calendar.peak ? Math.ceil(day.amountCents / calendar.peak.amountCents * 4) : 0;
          return <button key={day.date} type="button" className={`wealth-calendar-day heat-${level}${day.date > today ? " future" : ""}`} aria-pressed={selectedDate === day.date} aria-current={day.date === today ? "date" : undefined} aria-label={`${day.date}，${day.transactions.length ? `支出${money(day.amountCents)}，${day.transactions.length}笔` : "无支出记录"}`} onClick={() => setSelectedDate(day.date)}>
            <span>{Number(day.date.slice(8))}{day.date === today ? <small>今天</small> : null}{day.amountCents > 0 && day.amountCents === calendar.peak?.amountCents ? <small>最高</small> : null}</span>
            <strong>{day.transactions.length ? money(day.amountCents) : "—"}</strong>
            <small>{day.transactions.length ? `${day.transactions.length} 笔支出` : day.date > today ? "尚未到来" : "无支出记录"}</small>
          </button>;
        })}
      </div></div>
    </section>
    <section className="wealth-panel" aria-live="polite">
      <h3>{selected ? `${Number(selected.date.slice(5, 7))}月${Number(selected.date.slice(8))}日 · ${money(selected.amountCents)}` : "选择一天，看看钱花在哪里"}</h3>
      {selected?.transactions.length ? <ul className="wealth-calendar-transactions">{selected.transactions.map((transaction) => <li key={transaction.id}><div><strong>{transaction.merchant || transaction.description || "未命名消费"}</strong><small>{transaction.occurredAt.slice(11, 16)} · {FINANCE_CATEGORY_LABELS[transaction.category]}{transaction.merchant && transaction.description && transaction.description !== transaction.merchant ? ` · ${transaction.description}` : ""}</small></div><b>{money(transaction.amountCents)}</b></li>)}</ul> : <p className="wealth-muted">{selected ? "这一天暂无支出记录。" : "可以先查看颜色最深的日期，判断是否有集中购物或一次性的大额消费。"}</p>}
    </section>
  </div>;
}

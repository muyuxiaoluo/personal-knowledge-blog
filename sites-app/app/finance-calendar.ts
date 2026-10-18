import type { FinanceTransaction } from "./finance-types";

export function buildFinanceCalendar(month: string, transactions: FinanceTransaction[]) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("月份格式无效");
  const [year, monthNumber] = month.split("-").map(Number);
  const first = new Date(`${month}-01T00:00:00Z`);
  const end = new Date(first);
  end.setUTCMonth(monthNumber);
  end.setUTCDate(0);
  const days = Array.from({ length: end.getUTCDate() }, (_, index) => ({
    date: `${month}-${String(index + 1).padStart(2, "0")}`,
    amountCents: 0,
    transactions: [] as FinanceTransaction[],
  }));
  const byDate = new Map(days.map((day) => [day.date, day]));
  for (const transaction of transactions) {
    if (transaction.kind !== "expense") continue;
    const day = byDate.get(transaction.occurredAt.slice(0, 10));
    if (!day) continue;
    day.amountCents += transaction.amountCents;
    day.transactions.push(transaction);
  }
  const ranked = days.filter((day) => day.amountCents > 0).sort((a, b) => b.amountCents - a.amountCents);
  const totalCents = days.reduce((total, day) => total + day.amountCents, 0);
  return {
    label: `${year}年${monthNumber}月`, days,
    leadingDays: (first.getUTCDay() + 6) % 7,
    totalCents,
    spendingDays: ranked.length,
    peak: ranked[0] ?? null,
    topTwoShare: totalCents ? ranked.slice(0, 2).reduce((total, day) => total + day.amountCents, 0) / totalCents : 0,
  };
}

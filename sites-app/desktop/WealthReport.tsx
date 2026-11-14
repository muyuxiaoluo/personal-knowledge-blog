import { FINANCE_BUDGET_ROLES, FINANCE_BUDGET_ROLE_LABELS, FINANCE_BUDGET_ROLE_GUIDANCE, type FinanceBudgetRole, type FinanceInsightSnapshot, type FinanceAiReport } from "../app/finance-types";

const money = (cents: number) => new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(cents / 100);

export function FinanceClassificationGuide({ role }: { role?: FinanceBudgetRole }) {
  return <div className="wealth-classification-guide">
    {role ? <p><strong>{FINANCE_BUDGET_ROLE_LABELS[role]}：</strong>{FINANCE_BUDGET_ROLE_GUIDANCE[role]}</p> : null}
    <details><summary>这笔钱怎么分？看常见例子</summary>
      <p>用途回答“钱花在哪”，消费性质回答“为什么花”。先按主要目的分类，再用“是否值得”记录感受，不必把每笔消费拆得很细。</p>
      <ul>
        <li>工作日午饭、解渴的水、上班地铁、用完补购的必需品：通常选弹性必要。外卖或购物平台只是购买渠道。</li>
        <li>通勤打车：主要为到岗仍可选弹性必要，再考虑哪些行程能换地铁。晚归、身体不适或赶时间时保留例外。</li>
        <li>为口味买饮料、和朋友聚餐：通常选生活体验。餐饮或人情关系按主要目的选择，值得的部分可以保留预算。</li>
        <li>凑单、重复囤货、买完不用：通常选自由消费；确实后悔再标记“后悔 / 可减少”。</li>
      </ul>
      <p>省钱看替代后的差额：例如一次打车25元换成3.60元地铁，省21.40元；5元饮料换2元水，省3元。这些只是示例，月省多少还要看你愿意替代的次数。</p>
      <dl>{FINANCE_BUDGET_ROLES.filter((item) => item.value !== "unknown").map((item) => <div key={item.value}><dt>{item.label}</dt><dd>{FINANCE_BUDGET_ROLE_GUIDANCE[item.value]}</dd></div>)}</dl>
    </details>
  </div>;
}

export function FinanceGoalSummary({ snapshot }: { snapshot: FinanceInsightSnapshot }) {
  const ready = snapshot.incomeBaselineCents > 0 && snapshot.budgetSavingsTargetCents > 0;
  const allowance = snapshot.incomeBaselineCents - snapshot.budgetSavingsTargetCents;
  const remaining = allowance - snapshot.expenseCents;
  const roleTotal = (role: FinanceBudgetRole) => snapshot.budgetRoleTotals.find((item) => item.role === role)?.amountCents ?? 0;
  return <section className="wealth-panel wealth-goal-summary">
    <header><div><span>先看储蓄目标</span><h2>{!ready ? "先补全月收入与储蓄目标" : allowance < 0 ? "储蓄目标已超过规划收入" : remaining >= 0 ? "目前记录的支出仍在目标范围内" : `按已有支出，距目标还差 ${money(-remaining)}`}</h2></div></header>
    <p className="wealth-muted">{!ready ? "在预算中设置后，再判断需要省多少。先保留正常生活所需。" : allowance < 0 ? "即使不消费也无法仅靠这份收入达标，请先调整目标金额或期限。" : remaining >= 0 ? `本月还可安排 ${money(remaining)}，需覆盖尚未入账的房租、三餐、通勤等开支；不必为了多省一点取消所有享受。` : "先检查账单是否完整、是否包含一次性支出，再减少不值得的消费、比较替代方式。若会影响基本生活，应调整目标或期限。"}</p>
    <div className="wealth-report-facts">
      <div><span>规划月收入</span><strong>{money(snapshot.incomeBaselineCents)}</strong></div>
      <div><span>希望存下</span><strong>{money(snapshot.budgetSavingsTargetCents)}</strong></div>
      <div><span>已记录支出</span><strong>{money(snapshot.expenseCents)}</strong></div>
    </div>
    <p>已确认的固定必要支出 {money(roleTotal("fixed-essential"))}，弹性必要支出 {money(roleTotal("variable-essential"))}。先保障这些需求，再比较单价、方式和频次；这些金额不等于最低生活费。</p>
    <p className="wealth-muted">以上按规划月收入与已记录消费计算；已关联退款抵扣原消费，借还款等资金往来已排除。未关联的退款单列。{snapshot.sampleInsufficient ? "记录还不够，暂不判断长期变化。" : ""}</p>
    {snapshot.pendingConfirmation.count > 0 ? <p className="wealth-muted">还有 {snapshot.pendingConfirmation.count} 笔支出（{money(snapshot.pendingConfirmation.amountCents)}）待分类，可到“月度整理”按组确认。</p> : null}
  </section>;
}

export function FinanceReportContent({ report }: { report: FinanceAiReport }) {
  if (report.content.presentationVersion !== 2) return <section className="wealth-panel"><h3>月报已改为生活与省钱建议</h3><p className="wealth-muted">旧版报告仍保存在本机。请重新生成，查看更易读的分析、应保留的开支和具体行动。</p></section>;
  const content = report.content;
  return <section className="wealth-ai-report">
    <article className="wealth-panel"><h3>本月最重要的判断</h3><p className="wealth-report-lead">{content.overview}</p><h3>先保障日常生活</h3><p>{content.essentialStructure}</p>
      {content.worthwhileSpending.length ? <ul>{content.worthwhileSpending.map((item) => <li key={item}>{item}</li>)}</ul> : null}
    </article>
    {content.opportunities.length ? <section className="wealth-panel"><h3>优先考虑这些调整</h3><div className="wealth-opportunity-grid">{content.opportunities.map((item, index) => <article key={`${index}-${item.title}`}>
      <span>建议 {index + 1} · {item.confidence === "high" ? "优先考虑" : "先确认是否适合"}</span><h3>{item.title}</h3>
      <b>{item.maximumSavingCents > 0 ? `不再重复这类消费，最多可少花 ${money(item.maximumSavingCents)}` : "先确认替代方式，再计算能省多少"}</b>
      <p>{item.reason}</p><p><strong>怎么做：</strong>{item.action}</p>{item.tradeoff ? <small>需要权衡：{item.tradeoff}</small> : null}
    </article>)}</div></section> : null}
    {content.nextActions.length ? <section className="wealth-panel"><h3>接下来只做这几件事</h3><ol>{content.nextActions.map((item) => <li key={item}>{item}</li>)}</ol></section> : null}
    {content.pendingConfirmations.length || content.questions.length ? <section className="wealth-panel"><h3>还需要你判断</h3><ul>{[...content.pendingConfirmations, ...content.questions].map((item, index) => <li key={index}>{item}</li>)}</ul></section> : null}
    <footer className="wealth-report-meta">生成于 {new Date(report.generatedAt).toLocaleString("zh-CN")}<details><summary>生成详情</summary>{report.model} · 用量 {report.tokenUsage.totalTokens.toLocaleString("zh-CN")}</details></footer>
  </section>;
}

import "./styles/wealth.css";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { LIFE_DOMAIN_OPTIONS, type LifeDomain } from "../app/domain-taxonomy";
import type { FinanceRepository } from "../app/data/finance-repository";
import {
  buildFinanceInsightSnapshot,
  countFinanceImportRecords,
  fingerprintFinanceSnapshot,
  validateFinanceAiReportContent,
} from "../app/finance-analysis";
import {
  FINANCE_BUDGET_ROLES,
  FINANCE_BUDGET_ROLE_LABELS,
  FINANCE_CATEGORIES,
  FINANCE_CATEGORY_LABELS,
  emptyFinanceBudget,
  emptyFinanceSettings,
  type FinanceAiReport,
  type FinanceBudget,
  type FinanceBudgetRole,
  type FinanceCategory,
  type FinanceImportBatch,
  type FinanceImportPreview,
  type FinanceImportSource,
  type FinanceMonthlySummary,
  type FinanceSettings,
  type FinanceSource,
  type FinanceTransaction,
  type FinanceValueRating,
} from "../app/finance-types";
import type { ProjectSummary } from "../app/project-types";
import { resolveAvailableDeepSeekModel } from "../app/ai-model-settings";
import { Button, SelectMenu } from "./DesktopControls";
import { desktopApi, openInternalUrl } from "./integrationApi";
import { ThemeSticker } from "./DesktopThemes";

type WealthView = "overview" | "transactions" | "budget" | "report";

const transactionKindLabels: Record<FinanceTransaction["kind"], string> = {
  expense: "支出",
  income: "收入",
  transfer: "转账",
  refund: "退款",
  repayment: "还款",
  adjustment: "调整",
};

const sourceLabels: Record<FinanceSource, string> = {
  alipay: "支付宝",
  wechat: "微信",
  cash: "现金",
  custom: "其他",
};

const financeSourceOptions = Object.entries(sourceLabels).map(([value, label]) => ({ value, label }));
const financeCategoryOptions = FINANCE_CATEGORIES.map(({ value, label }) => ({ value, label }));
const financeBudgetRoleOptions = FINANCE_BUDGET_ROLES.map(({ value, label }) => ({ value, label }));
const financeKnownBudgetRoleOptions = financeBudgetRoleOptions.filter((entry) => entry.value !== "unknown");
const financeLifeDomainOptions = [{ value: "", label: "不指定" }, ...LIFE_DOMAIN_OPTIONS.map(({ value, label }) => ({ value, label }))];
const financeValueRatingOptions = [
  { value: "", label: "暂不评价" },
  { value: "worthwhile", label: "值得" },
  { value: "neutral", label: "一般" },
  { value: "regret", label: "后悔 / 可减少" },
];

function financeProjectOptions(projects: ProjectSummary[]) {
  return [{ value: "", label: "不关联" }, ...projects.map((project) => ({
    value: project.id,
    label: `${project.title} · ${project.status === "active" ? "进行中" : project.status === "paused" ? "暂停" : "已完成"}`,
  }))];
}

export function WealthPage({ repository, projects, today, onNotice }: {
  repository: FinanceRepository;
  projects: ProjectSummary[];
  today: string;
  onNotice: (message: string) => void;
}) {
  const [view, setView] = useState<WealthView>("overview");
  const [month, setMonth] = useState(today.slice(0, 7));
  const [settings, setSettings] = useState<FinanceSettings>(() => structuredClone(emptyFinanceSettings));
  const [budget, setBudget] = useState<FinanceBudget>(() => emptyFinanceBudget(today.slice(0, 7)));
  const [transactions, setTransactions] = useState<FinanceTransaction[]>([]);
  const [batches, setBatches] = useState<FinanceImportBatch[]>([]);
  const [summary, setSummary] = useState<FinanceMonthlySummary | null>(null);
  const [report, setReport] = useState<FinanceAiReport | null>(null);
  const [hasDeepSeekKey, setHasDeepSeekKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [importSource, setImportSource] = useState<FinanceImportSource | null>(null);
  const [preview, setPreview] = useState<FinanceImportPreview | null>(null);
  const [importing, setImporting] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [classification, setClassification] = useState<{
    transaction: FinanceTransaction;
    category: FinanceCategory;
    budgetRole: FinanceBudgetRole;
    remember: boolean;
    projectId: string;
    lifeDomain: LifeDomain | "";
    valueRating: FinanceValueRating | "";
  } | null>(null);
  const [showSendPreview, setShowSendPreview] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [reportStale, setReportStale] = useState(false);
  const monthRef = useRef(month);
  const reportRequestRef = useRef(0);
  monthRef.current = month;

  const refresh = useCallback(async () => {
    const requestedMonth = month;
    setLoading(true);
    try {
      const [nextSettings, nextBudget, nextTransactions, nextBatches, nextSummary, nextReport, keyAvailable] = await Promise.all([
        repository.getSettings(),
        repository.getBudget(requestedMonth),
        repository.listTransactions(requestedMonth),
        repository.listBatches(),
        repository.monthlySummary(requestedMonth),
        repository.getReport(requestedMonth),
        desktopApi.secrets.status("deepseek_api_key").catch(() => false),
      ]);
      if (monthRef.current !== requestedMonth) return;
      setSettings(nextSettings);
      setBudget(nextBudget);
      setTransactions(nextTransactions);
      setBatches(nextBatches);
      setSummary(nextSummary);
      setReport(nextReport);
      setHasDeepSeekKey(keyAvailable);
    } catch (error) {
      if (monthRef.current === requestedMonth) onNotice(errorMessage(error, "财富数据暂时无法读取"));
    } finally {
      if (monthRef.current === requestedMonth) setLoading(false);
    }
  }, [month, onNotice, repository]);

  useEffect(() => { void refresh(); }, [refresh]);

  const snapshot = useMemo(() => summary ? buildFinanceInsightSnapshot(
    summary,
    budget,
    transactions,
    projects.map((project) => ({ id: project.id, category: project.category, status: project.status })),
  ) : null, [budget, projects, summary, transactions]);

  useEffect(() => {
    let active = true;
    if (!report || !snapshot) {
      setReportStale(false);
      return () => { active = false; };
    }
    void fingerprintFinanceSnapshot(snapshot).then((fingerprint) => {
      if (active) setReportStale(report.inputFingerprint !== fingerprint);
    });
    return () => { active = false; };
  }, [report, snapshot]);

  function selectMonth(nextMonth: string) {
    if (!nextMonth || nextMonth === monthRef.current || generating) return;
    monthRef.current = nextMonth;
    reportRequestRef.current += 1;
    setMonth(nextMonth);
    setSummary(null);
    setReport(null);
    setReportStale(false);
    setShowSendPreview(false);
    setLoading(true);
  }

  async function acknowledgeBackupNotice() {
    const saved = await repository.saveSettings({ ...settings, backupNoticeAcknowledged: true });
    setSettings(saved);
  }

  async function chooseImportFile() {
    if (!importSource) return;
    setImporting(true);
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "支付宝或微信账单", extensions: ["csv", "xls", "xlsx"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      const parsed = await desktopApi.finance.previewImport(selected, importSource);
      setPreview(await repository.reconcileImportPreview(parsed));
    } catch (error) {
      onNotice(errorMessage(error, "账单预览失败"));
    } finally {
      setImporting(false);
    }
  }

  function toggleImportRecord(rowNumber: number) {
    if (!preview) return;
    const records = preview.records.map((record) => {
      if (record.rowNumber !== rowNumber || record.decision === "skipped" || record.decision === "duplicate" || !record.amountCents || !record.occurredAt) return record;
      return { ...record, selected: !record.selected };
    });
    setPreview({ ...preview, records, counts: countFinanceImportRecords(records) });
  }

  async function confirmImport() {
    if (!preview) return;
    setImporting(true);
    try {
      const batch = await repository.confirmImport(preview);
      onNotice(`已导入 ${batch.statistics.importable || preview.records.filter((record) => record.selected).length} 笔流水`);
      setPreview(null);
      setImportSource(null);
      await refresh();
    } catch (error) {
      onNotice(errorMessage(error, "账单导入失败，原数据未改变"));
    } finally {
      setImporting(false);
    }
  }

  async function rollbackBatch(batch: FinanceImportBatch) {
    if (!window.confirm(`撤销 ${new Date(batch.createdAt).toLocaleString("zh-CN")} 的整批导入吗？手工修改过的批次流水也会一起移除。`)) return;
    try {
      await repository.rollbackBatch(batch.id);
      onNotice("这次导入已经撤销");
      await refresh();
    } catch (error) {
      onNotice(errorMessage(error, "撤销导入失败"));
    }
  }

  async function saveClassification() {
    if (!classification) return;
    try {
      await repository.updateClassification(
        classification.transaction.id,
        classification.category,
        classification.budgetRole,
        classification.remember,
        {
          projectId: classification.projectId || null,
          lifeDomain: classification.lifeDomain || null,
          valueRating: classification.valueRating || null,
        },
      );
      setClassification(null);
      onNotice(classification.remember ? "分类已确认，后续相似流水会沿用" : "分类已确认");
      await refresh();
    } catch (error) {
      onNotice(errorMessage(error, "分类保存失败"));
    }
  }

  async function generateReport() {
    if (!snapshot || !hasDeepSeekKey || generating) return;
    const requestId = ++reportRequestRef.current;
    const requestMonth = month;
    const requestSnapshot = snapshot;
    setGenerating(true);
    try {
      const model = await resolveAvailableDeepSeekModel("financeReport", desktopApi.deepseek.apiModels);
      const response = await desktopApi.finance.generateMonthlyReport(requestSnapshot, model);
      const content = validateFinanceAiReportContent(response.content, requestSnapshot);
      const next: FinanceAiReport = {
        month: requestMonth,
        content,
        model: response.model,
        generatedAt: new Date().toISOString(),
        inputFingerprint: await fingerprintFinanceSnapshot(requestSnapshot),
        tokenUsage: response.tokenUsage,
      };
      await repository.saveReport(next);
      if (requestId !== reportRequestRef.current || monthRef.current !== requestMonth) return;
      setReport(next);
      setReportStale(false);
      setShowSendPreview(false);
      onNotice("AI 月报已经生成；分类、预算和流水均未被自动修改");
    } catch (error) {
      if (requestId === reportRequestRef.current && monthRef.current === requestMonth) {
        onNotice(errorMessage(error, "月报生成失败，已有报告已保留"));
      }
    } finally {
      if (requestId === reportRequestRef.current) setGenerating(false);
    }
  }

  return (
    <section className="wealth-page">
      <header className="wealth-header">
        <div><span>本地财富台账</span><h1>看清钱去了哪里，再决定怎么优化</h1><p>账单文件只在本机解析；收入基线、预算与 AI 建议彼此分开。</p></div>
        <ThemeSticker section="wealth" placement="wealth-hero" />
        <div className="wealth-header-actions">
          <label><span>查看月份</span><input type="month" value={month} disabled={generating} onChange={(event) => selectMonth(event.target.value)} /></label>
          <Button variant="secondary" onClick={() => setManualOpen(true)}>补记一笔</Button>
          <Button variant="primary" onClick={() => setImportSource("alipay")}>导入账单</Button>
        </div>
      </header>

      {!settings.backupNoticeAcknowledged && (
        <aside className="wealth-privacy-notice">
          <div><strong>财务数据只保存在这台设备</strong><p>它会进入现有完整备份，但当前 .mgbak 备份包尚未加密。请把备份文件放在可信位置；财务数据不会加入云同步。</p></div>
          <Button variant="secondary" type="button" onClick={() => void acknowledgeBackupNotice()}>我已了解</Button>
        </aside>
      )}

      <nav className="wealth-tabs" aria-label="财富视图">
        {([[
          "overview", "总览",
        ], ["transactions", "流水"], ["budget", "预算"], ["report", "AI 月报"]] as Array<[WealthView, string]>).map(([id, label]) => (
          <button className={view === id ? "active" : ""} key={id} onClick={() => setView(id)}>{label}</button>
        ))}
      </nav>

      {loading && !summary ? <div className="wealth-loading">正在整理本地账目…</div> : null}
      {!loading && summary && view === "overview" && (
        <OverviewView summary={summary} budget={budget} transactions={transactions} batches={batches} onImport={setImportSource} onRollback={rollbackBatch} />
      )}
      {!loading && view === "transactions" && (
        <TransactionsView transactions={transactions} onClassify={(transaction) => setClassification({
          transaction,
          category: transaction.category,
          budgetRole: transaction.budgetRole === "unknown" ? "variable-essential" : transaction.budgetRole,
          remember: false,
          projectId: transaction.projectId ?? "",
          lifeDomain: transaction.lifeDomain ?? "",
          valueRating: transaction.valueRating ?? "",
        })} />
      )}
      {!loading && summary && view === "budget" && (
        <BudgetView repository={repository} month={month} settings={settings} budget={budget} summary={summary} onSaved={async () => { onNotice("收入基线和本月预算已保存"); await refresh(); }} onNotice={onNotice} />
      )}
      {!loading && summary && view === "report" && snapshot && (
        <ReportView
          summary={summary}
          report={report}
          reportStale={reportStale}
          snapshot={snapshot}
          hasDeepSeekKey={hasDeepSeekKey}
          showSendPreview={showSendPreview}
          generating={generating}
          onShowPreview={() => setShowSendPreview(true)}
          onHidePreview={() => setShowSendPreview(false)}
          onGenerate={() => void generateReport()}
        />
      )}

      {importSource && (
        <ImportDialog
          source={importSource}
          preview={preview}
          busy={importing}
          onSwitchSource={(nextSource) => { setImportSource(nextSource); setPreview(null); }}
          onChoose={() => void chooseImportFile()}
          onToggle={toggleImportRecord}
          onConfirm={() => void confirmImport()}
          onClose={() => { if (!importing) { setImportSource(null); setPreview(null); } }}
        />
      )}
      {manualOpen && <ManualEntryDialog repository={repository} projects={projects} today={today} onClose={() => setManualOpen(false)} onSaved={async () => { setManualOpen(false); onNotice("这笔消费已经补记"); await refresh(); }} onNotice={onNotice} />}
      {classification && (
        <div className="wealth-modal-backdrop"><section className="wealth-dialog compact" role="dialog" aria-modal="true" aria-label="确认流水分类">
          <header><div><span>确认分类</span><h2>{classification.transaction.merchant || classification.transaction.description}</h2></div><Button variant="secondary" size="small" iconOnly aria-label="关闭" type="button" onClick={() => setClassification(null)}>×</Button></header>
          <p className="wealth-muted">只有你确认过的必要性才会进入正式统计。AI 建议不会替你修改。</p>
          <div className="wealth-form-grid">
            <label><span>用途分类</span><SelectMenu label="用途分类" value={classification.category} onChange={(value) => setClassification({ ...classification, category: value as FinanceCategory })} options={financeCategoryOptions} /></label>
            <label><span>预算角色</span><SelectMenu label="预算角色" value={classification.budgetRole} onChange={(value) => setClassification({ ...classification, budgetRole: value as FinanceBudgetRole })} options={financeKnownBudgetRoleOptions} /></label>
            <label><span>关联项目</span><SelectMenu label="关联项目" value={classification.projectId} onChange={(value) => setClassification({ ...classification, projectId: value })} options={financeProjectOptions(projects)} /></label>
            <label><span>生活领域</span><SelectMenu label="生活领域" value={classification.lifeDomain} onChange={(value) => setClassification({ ...classification, lifeDomain: value as LifeDomain | "" })} options={financeLifeDomainOptions} /></label>
            <label><span>是否值得</span><SelectMenu label="是否值得" value={classification.valueRating} onChange={(value) => setClassification({ ...classification, valueRating: value as FinanceValueRating | "" })} options={financeValueRatingOptions} /></label>
          </div>
          <label className="wealth-check"><input type="checkbox" checked={classification.remember} onChange={(event) => setClassification({ ...classification, remember: event.target.checked })} /><span>以后遇到相同商户或描述时沿用此分类</span></label>
          <footer><Button variant="secondary" type="button" onClick={() => setClassification(null)}>取消</Button><Button variant="primary" onClick={() => void saveClassification()}>确认分类</Button></footer>
        </section></div>
      )}
    </section>
  );
}

function OverviewView({ summary, budget, transactions, batches, onImport, onRollback }: {
  summary: FinanceMonthlySummary;
  budget: FinanceBudget;
  transactions: FinanceTransaction[];
  batches: FinanceImportBatch[];
  onImport: (source: FinanceImportSource) => void;
  onRollback: (batch: FinanceImportBatch) => void;
}) {
  const budgetTotal = Object.values(budget.categoryLimits).reduce<number>((total, value) => total + (value ?? 0), 0);
  return <div className="wealth-content">
    <section className="wealth-stat-grid">
      <MoneyCard label="本月普通消费" value={summary.ordinaryExpenseCents} note={`退款 ${money(summary.refundCents)} 已单列`} />
      <MoneyCard label="实际收入" value={summary.actualIncomeCents} note="来自导入流水，不覆盖规划基线" positive />
      <MoneyCard label="实际结余" value={summary.actualNetCents} note="收入 + 退款 − 普通消费" positive={summary.actualNetCents >= 0} />
      <MoneyCard label="规划收入基线" value={summary.stableIncomeCents} note={`储蓄目标 ${money(budget.savingsTargetCents)}`} positive />
    </section>
    {!transactions.length ? <section className="wealth-empty-import"><div><span>从已有账单开始</span><h2>先导入大头，再补记零碎消费</h2><p>无需连接支付账户。请从官方应用导出并自行解压，确认预览后才会写入。</p></div><div className="wealth-import-cards"><ImportCard source="alipay" onClick={onImport} /><ImportCard source="wechat" onClick={onImport} /></div></section> : null}
    <div className="wealth-two-column">
      <section className="wealth-panel"><header><div><span>规划结余</span><h2>三种可执行情景</h2></div></header><div className="wealth-scenarios"><Scenario label="保持现状" value={summary.scenarios.baselineCents} /><Scenario label="温和优化" value={summary.scenarios.moderateCents} /><Scenario label="积极储蓄" value={summary.scenarios.aggressiveCents} /></div><p className="wealth-muted">积极方案只使用已确认的机会，不削减固定必要与成长投入。{summary.sampleInsufficient ? " 弹性必要支出样本不足，暂用本月数据。" : " 弹性必要支出采用最近三个月中位数。"}</p></section>
      <section className="wealth-panel"><header><div><span>预算进度</span><h2>{budgetTotal ? `${money(summary.ordinaryExpenseCents)} / ${money(budgetTotal)}` : "尚未设置分类预算"}</h2></div></header><CategoryBars summary={summary} budget={budget} /></section>
    </div>
    <div className="wealth-two-column">
      <section className="wealth-panel"><header><div><span>周期支出</span><h2>本地发现的固定节奏</h2></div></header>{summary.recurringCandidates.length ? <ul className="wealth-insight-list">{summary.recurringCandidates.slice(0, 6).map((candidate) => <li key={candidate.evidenceId}><div><strong>{candidate.displayMerchant}</strong><span>{candidate.occurrences} 次 · 约每 {candidate.intervalDays} 天</span></div><b>{money(candidate.averageAmountCents)} / 次</b></li>)}</ul> : <p className="wealth-muted">至少需要同商户、相近金额、间隔 25～35 天且出现三次，才会在这里提示。</p>}</section>
      <section className="wealth-panel"><header><div><span>最近导入</span><h2>可按整批撤销</h2></div></header>{batches.length ? <ul className="wealth-batch-list">{batches.slice(0, 5).map((batch) => <li key={batch.id}><div><strong>{sourceLabels[batch.source]} · {batch.periodStart || "未知期间"}{batch.periodEnd && batch.periodEnd !== batch.periodStart ? ` 至 ${batch.periodEnd}` : ""}</strong><span>{new Date(batch.createdAt).toLocaleString("zh-CN")} · 解析器 {batch.parserVersion}</span></div><Button variant="ghost" size="small" type="button" onClick={() => onRollback(batch)}>撤销此批</Button></li>)}</ul> : <p className="wealth-muted">还没有导入记录。手工补记不属于导入批次。</p>}</section>
    </div>
  </div>;
}

function TransactionsView({ transactions, onClassify }: { transactions: FinanceTransaction[]; onClassify: (transaction: FinanceTransaction) => void }) {
  return <div className="wealth-content"><section className="wealth-panel wealth-table-panel"><header><div><span>标准化流水</span><h2>{transactions.length ? `${transactions.length} 笔` : "这个月还没有流水"}</h2></div></header>{transactions.length ? <div className="wealth-table-wrap"><table><thead><tr><th>时间</th><th>说明</th><th>类型</th><th>分类</th><th>预算角色</th><th>金额</th><th /></tr></thead><tbody>{transactions.map((transaction) => <tr key={transaction.id}><td>{formatDateTime(transaction.occurredAt)}</td><td><strong>{transaction.merchant || transaction.description || "未命名流水"}</strong><small>{sourceLabels[transaction.source]}{transaction.projectId ? " · 已关联项目" : ""}</small></td><td>{transactionKindLabels[transaction.kind]}</td><td>{FINANCE_CATEGORY_LABELS[transaction.category]}</td><td><span className={transaction.budgetRoleConfirmed ? "confirmed-role" : "pending-role"}>{transaction.budgetRoleConfirmed ? FINANCE_BUDGET_ROLE_LABELS[transaction.budgetRole] : "待确认"}</span></td><td className={`money-cell ${transaction.direction === "in" ? "income" : ""}`}>{transaction.direction === "in" ? "+" : transaction.direction === "out" ? "−" : ""}{money(transaction.amountCents)}</td><td>{transaction.kind === "expense" ? <Button variant="secondary" type="button" onClick={() => onClassify(transaction)}>{transaction.budgetRoleConfirmed ? "调整" : "确认"}</Button> : null}</td></tr>)}</tbody></table></div> : <p className="wealth-muted">从支付宝、微信导入，或补记一笔现金消费。</p>}</section></div>;
}

function BudgetView({ repository, month, settings, budget, summary, onSaved, onNotice }: {
  repository: FinanceRepository;
  month: string;
  settings: FinanceSettings;
  budget: FinanceBudget;
  summary: FinanceMonthlySummary;
  onSaved: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [income, setIncome] = useState(() => yuanInput(settings.stableMonthlyIncomeCents));
  const [defaultTarget, setDefaultTarget] = useState(() => yuanInput(settings.defaultSavingsTargetCents));
  const [monthTarget, setMonthTarget] = useState(() => yuanInput(budget.savingsTargetCents));
  const [limits, setLimits] = useState<Record<FinanceCategory, string>>(() => Object.fromEntries(FINANCE_CATEGORIES.map((entry) => [entry.value, yuanInput(budget.categoryLimits[entry.value] ?? 0)])) as Record<FinanceCategory, string>);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setIncome(yuanInput(settings.stableMonthlyIncomeCents));
    setDefaultTarget(yuanInput(settings.defaultSavingsTargetCents));
    setMonthTarget(yuanInput(budget.savingsTargetCents));
    setLimits(Object.fromEntries(FINANCE_CATEGORIES.map((entry) => [entry.value, yuanInput(budget.categoryLimits[entry.value] ?? 0)])) as Record<FinanceCategory, string>);
  }, [budget, settings]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const monthTargetCents = parseYuan(monthTarget);
      const saved = await repository.saveBudgetPlan({
        ...settings,
        stableMonthlyIncomeCents: parseYuan(income),
        defaultSavingsTargetCents: parseYuan(defaultTarget),
      }, {
        month,
        savingsTargetCents: monthTargetCents,
        categoryLimits: Object.fromEntries(Object.entries(limits).map(([category, value]) => [category, parseYuan(value)])),
        updatedAt: "",
      });
      if (saved.settings.defaultSavingsTargetCents !== monthTargetCents) onNotice("本月目标与默认目标不同，已分别保存");
      await onSaved();
    } catch (error) {
      onNotice(errorMessage(error, "预算保存失败"));
    } finally {
      setSaving(false);
    }
  }
  return <div className="wealth-content"><form className="wealth-panel wealth-budget-form" onSubmit={submit}><header><div><span>收入与储蓄</span><h2>规划基线由你设定</h2></div><Button variant="primary" type="submit" disabled={saving}>{saving ? "保存中…" : "保存预算"}</Button></header><p className="wealth-muted">导入识别到的工资和奖金只显示为实际收入，不会改动这里的稳定税后月收入。</p><div className="wealth-form-grid three"><MoneyInput label="稳定税后月收入" value={income} onChange={setIncome} /><MoneyInput label="默认每月储蓄目标" value={defaultTarget} onChange={setDefaultTarget} /><MoneyInput label={`${month} 储蓄目标`} value={monthTarget} onChange={setMonthTarget} /></div><div className="wealth-budget-categories"><h3>分类额度</h3>{FINANCE_CATEGORIES.map((entry) => <label key={entry.value}><span><strong>{entry.label}</strong><small>已花 {money(summary.categoryTotals[entry.value])}</small></span><span className="yuan-input"><i>¥</i><input inputMode="decimal" value={limits[entry.value]} onChange={(event) => setLimits({ ...limits, [entry.value]: event.target.value })} /></span></label>)}</div></form></div>;
}

function ReportView({ summary, report, reportStale, snapshot, hasDeepSeekKey, showSendPreview, generating, onShowPreview, onHidePreview, onGenerate }: {
  summary: FinanceMonthlySummary;
  report: FinanceAiReport | null;
  reportStale: boolean;
  snapshot: ReturnType<typeof buildFinanceInsightSnapshot>;
  hasDeepSeekKey: boolean;
  showSendPreview: boolean;
  generating: boolean;
  onShowPreview: () => void;
  onHidePreview: () => void;
  onGenerate: () => void;
}) {
  return <div className="wealth-content">
    <section className="wealth-panel wealth-report-intro">
      <header><div><span>先本地计算，再让 AI 解读</span><h2>{report ? `${report.month} 月报` : "尚未生成 AI 月报"}</h2></div>{hasDeepSeekKey ? <Button variant="primary" onClick={onShowPreview}>{report ? "重新生成" : "生成月报"}</Button> : null}</header>
      <div className="wealth-scenarios"><Scenario label="规划基准结余" value={summary.scenarios.baselineCents} /><Scenario label="温和优化" value={summary.scenarios.moderateCents} /><Scenario label="积极储蓄" value={summary.scenarios.aggressiveCents} /></div>
      {!hasDeepSeekKey ? <p className="wealth-key-empty">尚未配置 DeepSeek API Key。本地统计和三种情景仍可正常使用；配置后才会显示 AI 解读按钮。</p> : null}
      {reportStale ? <p className="wealth-report-stale" role="status">这份月报生成后，流水、分类或预算已经变化。下方内容仍保留供参考，建议重新生成。</p> : null}
      <p className="wealth-muted">报告只会在你点击确认后生成。失败时不会自动重试，也不会覆盖已有报告。</p>
    </section>
    {showSendPreview ? <div className="wealth-modal-backdrop">
      <section className="wealth-dialog compact wealth-send-preview" role="dialog" aria-modal="true" aria-label="AI 月报发送前确认">
        <header><div><span>发送前确认</span><h2>只发送匿名汇总</h2></div><Button variant="secondary" size="small" iconOnly type="button" aria-label="关闭发送预览" onClick={onHidePreview}>×</Button></header>
        <div className="wealth-redaction-grid"><div><strong>将发送</strong><p>收入基线、分类与角色汇总、预算偏差、历史趋势、周期与节约候选、匿名项目编号。</p></div><div><strong>不会发送</strong><p>账号、流水号、姓名、原始备注、真实文件名、商户原文和项目名称。</p></div></div>
        <details><summary>查看实际 JSON 数据</summary><pre>{JSON.stringify(snapshot, null, 2)}</pre></details>
        <footer><Button variant="secondary" type="button" onClick={onHidePreview}>取消</Button><Button variant="primary" disabled={generating} onClick={onGenerate}>{generating ? "DeepSeek 正在生成…" : "确认发送并生成"}</Button></footer>
      </section>
    </div> : null}
    {report ? <AiReportContent report={report} /> : <section className="wealth-panel"><h2>AI 会补充什么</h2><p className="wealth-muted">它会解释必要支出结构、值得保留的消费、可节约机会与代价，并把下月行动压缩到最多三项。所有建议金额都会再次由本地证据校验。</p></section>}
  </div>;
}

function AiReportContent({ report }: { report: FinanceAiReport }) {
  return <section className="wealth-ai-report"><article className="wealth-panel"><span>本月概览</span><h2>{report.content.overview}</h2><p>{report.content.essentialStructure}</p></article><div className="wealth-two-column"><article className="wealth-panel"><h3>值得保留</h3>{report.content.worthwhileSpending.length ? <ul>{report.content.worthwhileSpending.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="wealth-muted">本月没有足够证据。</p>}</article><article className="wealth-panel"><h3>仍待确认</h3>{report.content.pendingConfirmations.length ? <ul>{report.content.pendingConfirmations.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="wealth-muted">没有额外待确认项。</p>}</article></div><section className="wealth-opportunity-grid">{report.content.opportunities.map((item) => <article key={`${item.title}-${item.evidenceIds.join("-")}`}><span>{item.confidence === "high" ? "高置信" : item.confidence === "medium" ? "中等置信" : "低置信"}</span><h3>{item.title}</h3><b>{money(item.minimumSavingCents)} ～ {money(item.maximumSavingCents)}</b><p>{item.reason}</p><small>行动：{item.action}</small>{item.tradeoff ? <small>代价：{item.tradeoff}</small> : null}</article>)}</section><section className="wealth-panel"><h3>下月只做这几件事</h3><ol>{report.content.nextActions.map((item) => <li key={item}>{item}</li>)}</ol>{report.content.questions.length ? <><h3>还需要你判断</h3><ul>{report.content.questions.map((item) => <li key={item}>{item}</li>)}</ul></> : null}<footer className="wealth-report-meta">{report.model} · {new Date(report.generatedAt).toLocaleString("zh-CN")} · {report.tokenUsage.totalTokens.toLocaleString("zh-CN")} tokens</footer></section></section>;
}

function ImportDialog({ source, preview, busy, onSwitchSource, onChoose, onToggle, onConfirm, onClose }: {
  source: FinanceImportSource;
  preview: FinanceImportPreview | null;
  busy: boolean;
  onSwitchSource: (source: FinanceImportSource) => void;
  onChoose: () => void;
  onToggle: (rowNumber: number) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const label = sourceLabels[source];
  return <div className="wealth-modal-backdrop"><section className="wealth-dialog import" role="dialog" aria-modal="true" aria-label={`导入${label}账单`}><header><div><span>{preview ? "第 4 步 · 预览识别结果" : "导入向导"}</span><h2>{preview ? `${label}账单预览` : "先从官方应用取得账单"}</h2></div><Button variant="secondary" size="small" iconOnly aria-label="关闭" type="button" disabled={busy} onClick={onClose}>×</Button></header>{!preview ? <><div className="wealth-source-switch"><button className={source === "alipay" ? "active" : ""} onClick={() => onSwitchSource("alipay")}>支付宝</button><button className={source === "wechat" ? "active" : ""} onClick={() => onSwitchSource("wechat")}>微信</button></div><ol className="wealth-guide-steps">{source === "wechat" ? <><li><strong>进入微信支付账单</strong><span>通常位于“我 → 服务 → 钱包 → 账单”，再从帮助或常见问题中选择下载账单。</span></li><li><strong>选择用于个人对账</strong><span>选择时间范围并发送到自己的邮箱。官方入口名称和可选范围可能随版本变化。</span></li><li><strong>下载并自行解压</strong><span>压缩包密码由微信提示。本版不读取带密码 ZIP，只选择解压后的 CSV/XLS/XLSX。</span></li></> : <><li><strong>进入支付宝官方账单导出入口</strong><span>从账单或交易流水页面选择明细与时间范围；入口可能随客户端版本变化。</span></li><li><strong>导出 Excel 或 CSV</strong><span>本版支持 XLS、XLSX、CSV；若只得到 PDF，请改选可编辑明细格式。</span></li><li><strong>解压后再选择文件</strong><span>不要提交真实账单到项目仓库，应用也不会保存原文件或真实文件名。</span></li></>}</ol><div className="wealth-guide-note"><strong>入口可能变化</strong><p>教程采用可维护文字，不复用旧应用截图。找不到入口时可查看官方帮助中心。</p><Button variant="secondary" type="button" onClick={() => void openInternalUrl(source === "wechat" ? "https://kf.qq.com/product/weixin.html" : "https://help.alipay.com/")}>打开{label}官方帮助</Button></div><footer><Button variant="secondary" type="button" onClick={onClose}>取消</Button><Button variant="primary" disabled={busy} onClick={onChoose}>{busy ? "正在本机解析…" : "选择解压后的账单"}</Button></footer></> : <><div className="wealth-import-counts">{(["expense", "income", "refund", "transfer", "skipped", "duplicate", "suspected", "uncertain"] as const).map((key) => <div key={key}><strong>{preview.counts[key]}</strong><span>{{ expense: "支出", income: "收入", refund: "退款", transfer: "转账", skipped: "跳过", duplicate: "重复", suspected: "疑似重复", uncertain: "待确认" }[key]}</span></div>)}</div>{preview.alreadyImported ? <p className="wealth-import-warning">相同文件指纹已经导入过，本次不能重复入账。</p> : null}<div className="wealth-preview-table"><table><thead><tr><th>导入</th><th>时间</th><th>说明</th><th>类型 / 状态</th><th>金额</th></tr></thead><tbody>{preview.records.slice(0, 300).map((record) => <tr className={`decision-${record.decision}`} key={`${record.rowNumber}-${record.externalTransactionId}`}><td><input type="checkbox" checked={record.selected} disabled={record.decision === "skipped" || record.decision === "duplicate" || !record.amountCents || !record.occurredAt} onChange={() => onToggle(record.rowNumber)} /></td><td>{formatDateTime(record.occurredAt)}</td><td><strong>{record.merchant || record.description || "无法识别"}</strong><small>{record.reason || FINANCE_CATEGORY_LABELS[record.category]}</small></td><td>{transactionKindLabels[record.kind]}<small>{record.status}</small></td><td>{money(record.amountCents)}</td></tr>)}</tbody></table></div>{preview.records.length > 300 ? <p className="wealth-muted">为保证页面流畅，只展示前 300 条；确认时会按全部选择状态入账。</p> : null}<footer><Button variant="secondary" type="button" disabled={busy} onClick={() => onSwitchSource(source)}>重新选文件</Button><Button variant="primary" disabled={busy || preview.alreadyImported || !preview.records.some((record) => record.selected)} onClick={onConfirm}>{busy ? "正在事务写入…" : `确认导入 ${preview.records.filter((record) => record.selected).length} 笔`}</Button></footer></>}</section></div>;
}

function ManualEntryDialog({ repository, projects, today, onClose, onSaved, onNotice }: {
  repository: FinanceRepository;
  projects: ProjectSummary[];
  today: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [occurredAt, setOccurredAt] = useState(() => `${today}T${new Date().toTimeString().slice(0, 5)}`);
  const [source, setSource] = useState<FinanceSource>("cash");
  const [category, setCategory] = useState<FinanceCategory>("other");
  const [budgetRole, setBudgetRole] = useState<FinanceBudgetRole>("unknown");
  const [projectId, setProjectId] = useState("");
  const [lifeDomain, setLifeDomain] = useState<LifeDomain | "">("");
  const [valueRating, setValueRating] = useState<FinanceValueRating | "">("");
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await repository.addManualTransaction({
        occurredAt: occurredAt.length === 16 ? `${occurredAt}:00` : occurredAt,
        amountCents: parseYuan(amount, true),
        description,
        source,
        category,
        budgetRole,
        projectId: projectId || null,
        lifeDomain: lifeDomain || null,
        valueRating: valueRating || null,
      });
      await onSaved();
    } catch (error) {
      onNotice(errorMessage(error, "补记失败"));
    } finally {
      setSaving(false);
    }
  }
  return <div className="wealth-modal-backdrop"><form className="wealth-dialog compact" onSubmit={submit}><header><div><span>快速补记</span><h2>留下一笔零碎消费</h2></div><Button variant="secondary" size="small" iconOnly aria-label="关闭" type="button" onClick={onClose}>×</Button></header><div className="wealth-form-grid"><MoneyInput label="金额" value={amount} onChange={setAmount} required /><label><span>发生时间</span><input type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} required /></label><label className="wide"><span>说明</span><input autoFocus value={description} onChange={(event) => setDescription(event.target.value)} placeholder="例如：早餐、打印资料" required /></label><label><span>支付来源</span><SelectMenu label="支付来源" value={source} onChange={(value) => setSource(value as FinanceSource)} options={financeSourceOptions} /></label><label><span>用途分类</span><SelectMenu label="用途分类" value={category} onChange={(value) => setCategory(value as FinanceCategory)} options={financeCategoryOptions} /></label><label><span>预算角色</span><SelectMenu label="预算角色" value={budgetRole} onChange={(value) => setBudgetRole(value as FinanceBudgetRole)} options={financeBudgetRoleOptions} /></label><label><span>关联项目</span><SelectMenu label="关联项目" value={projectId} onChange={setProjectId} options={financeProjectOptions(projects)} /></label><label><span>生活领域</span><SelectMenu label="生活领域" value={lifeDomain} onChange={(value) => setLifeDomain(value as LifeDomain | "")} options={financeLifeDomainOptions} /></label><label><span>是否值得</span><SelectMenu label="是否值得" value={valueRating} onChange={(value) => setValueRating(value as FinanceValueRating | "")} options={financeValueRatingOptions} /></label></div><footer><Button variant="secondary" type="button" onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={saving}>{saving ? "保存中…" : "保存消费"}</Button></footer></form></div>;
}

function MoneyCard({ label, value, note, positive = false }: { label: string; value: number; note: string; positive?: boolean }) { return <article className="wealth-money-card"><span>{label}</span><strong className={positive ? "positive" : ""}>{money(value)}</strong><small>{note}</small></article>; }
function Scenario({ label, value }: { label: string; value: number }) { return <div><span>{label}</span><strong className={value < 0 ? "negative" : ""}>{money(value)}</strong></div>; }
function ImportCard({ source, onClick }: { source: FinanceImportSource; onClick: (source: FinanceImportSource) => void }) { return <button className={`wealth-import-card ${source}`} onClick={() => onClick(source)}><i>{source === "alipay" ? "支" : "微"}</i><span><strong>导入{sourceLabels[source]}账单</strong><small>查看官方导出与解压步骤</small></span><b>→</b></button>; }
function CategoryBars({ summary, budget }: { summary: FinanceMonthlySummary; budget: FinanceBudget }) { const shown = FINANCE_CATEGORIES.filter((entry) => summary.categoryTotals[entry.value] || budget.categoryLimits[entry.value]).sort((left, right) => summary.categoryTotals[right.value] - summary.categoryTotals[left.value]).slice(0, 6); return shown.length ? <div className="wealth-category-bars">{shown.map((entry) => { const spent = summary.categoryTotals[entry.value]; const limit = budget.categoryLimits[entry.value] ?? 0; const width = limit ? Math.min(100, spent / limit * 100) : Math.min(100, spent / Math.max(1, summary.ordinaryExpenseCents) * 100); return <div key={entry.value}><span><strong>{entry.label}</strong><small>{money(spent)}{limit ? ` / ${money(limit)}` : ""}</small></span><i><b style={{ width: `${width}%` }} /></i></div>; })}</div> : <p className="wealth-muted">导入或补记后，这里会按用途展示本月消费结构。</p>; }
function MoneyInput({ label, value, onChange, required = false }: { label: string; value: string; onChange: (value: string) => void; required?: boolean }) { return <label><span>{label}</span><span className="yuan-input"><i>¥</i><input inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} required={required} /></span></label>; }

function money(cents: number) { return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 }).format(cents / 100); }
function yuanInput(cents: number) { return cents ? (cents / 100).toFixed(2).replace(/\.00$/, "") : ""; }
function parseYuan(value: string, positive = false) { const normalized = value.trim().replace(/[,，￥¥\s]/g, ""); if (!normalized && !positive) return 0; if (!/^\d+(\.\d{0,2})?$/.test(normalized)) throw new Error("金额最多保留两位小数"); const [integer, decimal = ""] = normalized.split("."); const result = Number(integer) * 100 + Number(decimal.padEnd(2, "0")); if (!Number.isSafeInteger(result) || result < 0 || (positive && result === 0)) throw new Error("请输入有效金额"); return result; }
function formatDateTime(value: string) { if (!value) return "无法识别"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
function errorMessage(error: unknown, fallback: string) { return typeof error === "string" && error.trim() ? error : error instanceof Error && error.message ? error.message : fallback; }

export default WealthPage;

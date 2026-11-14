import type { LifeDomain } from "../domain-taxonomy";
import { financeConsumptionTransactions } from "../finance-consumption";
import { financeCaptureSchema, mergeCaptureTransactions } from "../finance-capture";
import { FinanceCaptureRepository } from "./finance-capture-repository";
import { financeReviewGroupKey, financeRuleMatch, financeRuleMatches, financeTransportCategory } from "../finance-classification";
import { captureSourceLabel, type FinanceCapture } from "../finance-capture";
import {
  FINANCE_BUDGET_ROLES,
  FINANCE_CATEGORIES,
  emptyFinanceBudget,
  emptyFinanceSettings,
  type FinanceAccount,
  type FinanceAiReport,
  type FinanceBudget,
  type FinanceBudgetRole,
  type FinanceCategory,
  type FinanceCategoryRule,
  type FinanceImportBatch,
  type FinanceImportCounts,
  type FinanceImportPreview,
  type FinanceManualEntry,
  type FinanceSettings,
  type FinanceSource,
  type FinanceTransaction,
  type FinanceTransactionKind,
  type FinanceValueRating,
} from "../finance-types";
import {
  countFinanceImportRecords,
  financeDuplicateFingerprint,
  normalizeFinanceMerchant,
  summarizeFinanceMonth,
} from "../finance-analysis";
import {
  executeSqliteTransaction,
  type SqliteDatabase,
  type SqliteStatement,
} from "./sqlite-article-repository";

const migrations = [
  `CREATE TABLE IF NOT EXISTS finance_accounts (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS finance_import_batches (
    id TEXT PRIMARY KEY NOT NULL,
    source TEXT NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    file_hash TEXT NOT NULL UNIQUE,
    parser_version TEXT NOT NULL,
    statistics_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS finance_transactions (
    id TEXT PRIMARY KEY NOT NULL,
    occurred_at TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
    kind TEXT NOT NULL,
    direction TEXT NOT NULL,
    account_id TEXT NOT NULL,
    source TEXT NOT NULL,
    external_transaction_id TEXT NOT NULL DEFAULT '',
    merchant TEXT NOT NULL DEFAULT '',
    merchant_normalized TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    payment_method TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'other',
    budget_role TEXT NOT NULL DEFAULT 'unknown',
    category_confirmed INTEGER NOT NULL DEFAULT 0,
    budget_role_confirmed INTEGER NOT NULL DEFAULT 0,
    project_id TEXT,
    life_domain TEXT,
    import_batch_id TEXT,
    related_transaction_id TEXT,
    value_rating TEXT,
    duplicate_fingerprint TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(account_id) REFERENCES finance_accounts(id),
    FOREIGN KEY(import_batch_id) REFERENCES finance_import_batches(id)
  )`,
  `CREATE TABLE IF NOT EXISTS finance_settings (
    id INTEGER PRIMARY KEY NOT NULL CHECK(id = 1),
    stable_monthly_income_cents INTEGER NOT NULL DEFAULT 0,
    default_savings_target_cents INTEGER NOT NULL DEFAULT 0,
    backup_notice_acknowledged INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS finance_budgets (
    month TEXT PRIMARY KEY NOT NULL,
    savings_target_cents INTEGER NOT NULL DEFAULT 0,
    category_limits_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS finance_category_rules (
    id TEXT PRIMARY KEY NOT NULL,
    match_kind TEXT NOT NULL,
    match_value TEXT NOT NULL,
    category TEXT NOT NULL,
    budget_role TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(match_kind, match_value)
  )`,
  `CREATE TABLE IF NOT EXISTS finance_ai_reports (
    report_month TEXT PRIMARY KEY NOT NULL,
    content_json TEXT NOT NULL,
    model TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    input_fingerprint TEXT NOT NULL,
    token_usage_json TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_finance_transactions_occurred_at ON finance_transactions(occurred_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_finance_transactions_batch ON finance_transactions(import_batch_id)",
  "CREATE INDEX IF NOT EXISTS idx_finance_transactions_fingerprint ON finance_transactions(source, duplicate_fingerprint)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_transactions_external_id ON finance_transactions(source, external_transaction_id) WHERE external_transaction_id <> ''",
] as const;

const defaultAccounts: Array<Pick<FinanceAccount, "id" | "name" | "source">> = [
  { id: "finance-account-alipay", name: "支付宝", source: "alipay" },
  { id: "finance-account-wechat", name: "微信", source: "wechat" },
  { id: "finance-account-cash", name: "现金", source: "cash" },
  { id: "finance-account-custom", name: "其他", source: "custom" },
];

type AccountRow = { id: string; name: string; source: FinanceSource; created_at: string };
type SettingsRow = { stable_monthly_income_cents: number; default_savings_target_cents: number; backup_notice_acknowledged: number; updated_at: string };
type BudgetRow = { month: string; savings_target_cents: number; category_limits_json: string; updated_at: string };
type RuleRow = { id: string; match_kind: FinanceCategoryRule["matchKind"]; match_value: string; category: FinanceCategory; budget_role: FinanceBudgetRole; created_at: string; updated_at: string };
type BatchRow = { id: string; source: "alipay" | "wechat"; period_start: string; period_end: string; file_hash: string; parser_version: string; statistics_json: string; created_at: string };
type TransactionRow = {
  id: string;
  occurred_at: string;
  amount_cents: number;
  kind: FinanceTransactionKind;
  direction: "out" | "in" | "neutral";
  account_id: string;
  source: FinanceSource;
  external_transaction_id: string;
  merchant: string;
  merchant_normalized: string;
  description: string;
  payment_method: string;
  status: string;
  category: FinanceCategory;
  budget_role: FinanceBudgetRole;
  category_confirmed: number;
  budget_role_confirmed: number;
  project_id: string | null;
  life_domain: LifeDomain | null;
  import_batch_id: string | null;
  related_transaction_id: string | null;
  value_rating: FinanceValueRating | null;
  duplicate_fingerprint: string;
  created_at: string;
  updated_at: string;
};
type ReportRow = { report_month: string; content_json: string; model: string; generated_at: string; input_fingerprint: string; token_usage_json: string };

export class FinanceRepository {
  private initialization: Promise<void> | null = null;
  readonly captures: FinanceCaptureRepository;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date(),
  ) { this.captures = new FinanceCaptureRepository(database, clock); }

  private async initialize() {
    this.initialization ??= (async () => {
      for (const statement of migrations) await this.database.execute(statement);
      await this.database.execute(financeCaptureSchema);
      // Official bills stay local. Matching must not rewrite privately synced notification evidence.
      await this.database.execute(`CREATE TABLE IF NOT EXISTS finance_import_capture_matches (
        capture_id TEXT PRIMARY KEY NOT NULL, transaction_id TEXT NOT NULL,
        FOREIGN KEY(transaction_id) REFERENCES finance_transactions(id))`);
      await this.database.execute(`CREATE VIEW IF NOT EXISTS finance_ledger AS SELECT
        t.id,t.occurred_at,t.amount_cents,t.kind,t.direction,t.account_id,t.source,t.external_transaction_id,
        t.merchant,t.merchant_normalized,t.description,t.payment_method,t.status,t.category,t.budget_role,
        t.category_confirmed,t.budget_role_confirmed,t.project_id,t.life_domain,t.import_batch_id,
        COALESCE(refund_match.transaction_id,t.related_transaction_id) AS related_transaction_id,
        t.value_rating,t.duplicate_fingerprint,t.created_at,t.updated_at
        FROM finance_transactions t
        LEFT JOIN finance_import_capture_matches refund_match ON t.related_transaction_id = 'finance-capture-' || refund_match.capture_id
        WHERE NOT EXISTS (SELECT 1 FROM finance_import_capture_matches m WHERE t.id = 'finance-capture-' || m.capture_id)`);
      await this.database.execute("CREATE INDEX IF NOT EXISTS idx_finance_capture_pending ON finance_capture_events(state,received_at)");
      const createdAt = this.clock().toISOString();
      for (const account of defaultAccounts) {
        await this.database.execute(
          "INSERT OR IGNORE INTO finance_accounts(id, name, source, created_at) VALUES (?, ?, ?, ?)",
          [account.id, account.name, account.source, createdAt],
        );
      }
    })().catch((error) => {
      this.initialization = null;
      throw error;
    });
    await this.initialization;
  }

  async ready() {
    await this.initialize();
  }

  async listAccounts(): Promise<FinanceAccount[]> {
    await this.initialize();
    const rows = await this.database.select<AccountRow>("SELECT * FROM finance_accounts ORDER BY CASE source WHEN 'alipay' THEN 1 WHEN 'wechat' THEN 2 WHEN 'cash' THEN 3 ELSE 4 END, created_at");
    return rows.map((row) => ({ id: row.id, name: row.name, source: row.source, createdAt: row.created_at }));
  }

  async getSettings(): Promise<FinanceSettings> {
    await this.initialize();
    const rows = await this.database.select<SettingsRow>("SELECT * FROM finance_settings WHERE id = 1 LIMIT 1");
    const row = rows[0];
    return row ? {
      stableMonthlyIncomeCents: row.stable_monthly_income_cents,
      defaultSavingsTargetCents: row.default_savings_target_cents,
      backupNoticeAcknowledged: Boolean(row.backup_notice_acknowledged),
      updatedAt: row.updated_at,
    } : structuredClone(emptyFinanceSettings);
  }

  async saveSettings(settings: FinanceSettings): Promise<FinanceSettings> {
    await this.initialize();
    const normalized = normalizeSettings(settings, this.clock());
    const statement = settingsWriteStatement(normalized);
    await this.database.execute(statement.sql, statement.bindValues);
    return normalized;
  }

  async getBudget(month: string): Promise<FinanceBudget> {
    await this.initialize();
    assertMonth(month);
    const rows = await this.database.select<BudgetRow>("SELECT * FROM finance_budgets WHERE month = ? LIMIT 1", [month]);
    if (!rows[0]) {
      const settings = await this.getSettings();
      return emptyFinanceBudget(month, settings.defaultSavingsTargetCents);
    }
    return rowToBudget(rows[0]);
  }

  async saveBudget(budget: FinanceBudget): Promise<FinanceBudget> {
    await this.initialize();
    const normalized = normalizeBudget(budget, this.clock());
    const statement = budgetWriteStatement(normalized);
    await this.database.execute(statement.sql, statement.bindValues);
    return normalized;
  }

  async saveBudgetPlan(settings: FinanceSettings, budget: FinanceBudget) {
    await this.initialize();
    const now = this.clock();
    const normalizedSettings = normalizeSettings(settings, now);
    const normalizedBudget = normalizeBudget(budget, now);
    await executeSqliteTransaction(this.database, [
      settingsWriteStatement(normalizedSettings),
      budgetWriteStatement(normalizedBudget),
    ]);
    return { settings: normalizedSettings, budget: normalizedBudget };
  }

  async listTransactions(month = "", limit = 2_000): Promise<FinanceTransaction[]> {
    await this.initialize();
    const safeLimit = Math.max(1, Math.min(50_000, Math.round(limit)));
    const rows = month
      ? (assertMonth(month), await this.database.select<TransactionRow>("SELECT * FROM finance_ledger WHERE occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at DESC LIMIT ?", [`${month}-01`, `${nextMonth(month)}-01`, safeLimit]))
      : await this.database.select<TransactionRow>("SELECT * FROM finance_ledger ORDER BY occurred_at DESC LIMIT ?", [safeLimit]);
    return mergeCaptureTransactions(rows.map(rowToTransaction), await this.unmatchedCaptures()).filter(t => !month || t.occurredAt.startsWith(month))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, safeLimit);
  }

  async listCalendarExpenses(month: string): Promise<FinanceTransaction[]> {
    await this.initialize();
    assertMonth(month);
    const rows = await this.database.select<TransactionRow>(
      `SELECT * FROM finance_ledger WHERE (occurred_at >= ? AND occurred_at < ? AND kind = 'expense')
        OR (kind = 'refund' AND related_transaction_id IN (SELECT id FROM finance_ledger WHERE occurred_at >= ? AND occurred_at < ? AND kind = 'expense')) ORDER BY occurred_at DESC`,
      [`${month}-01`, `${nextMonth(month)}-01`, `${month}-01`, `${nextMonth(month)}-01`],
    );
    return financeConsumptionTransactions(mergeCaptureTransactions(rows.map(rowToTransaction), await this.unmatchedCaptures())).filter(t => t.occurredAt.startsWith(month));
  }

  async matchedCaptureIds(): Promise<string[]> {
    await this.initialize();
    return (await this.database.select<{ capture_id: string }>("SELECT capture_id FROM finance_import_capture_matches")).map(row => row.capture_id);
  }

  private async unmatchedCaptures(): Promise<FinanceCapture[]> {
    const matched = new Set(await this.matchedCaptureIds());
    return (await this.captures.list()).filter(event => !matched.has(event.id) && !matched.has(event.duplicate_of ?? ""));
  }

  async addManualTransaction(entry: FinanceManualEntry): Promise<FinanceTransaction> {
    await this.initialize();
    assertTimestamp(entry.occurredAt);
    if (!entry.description.trim()) throw new Error("请填写这笔消费的说明");
    if (!isSource(entry.source)) throw new Error("支付来源无效");
    if (!isCategory(entry.category) || !isBudgetRole(entry.budgetRole)) throw new Error("消费分类无效");
    const now = this.clock().toISOString();
    const merchant = entry.description.trim();
    const transaction: FinanceTransaction = {
      id: makeId("finance-transaction"),
      occurredAt: entry.occurredAt,
      amountCents: positiveCents(entry.amountCents, "金额"),
      kind: "expense",
      direction: "out",
      accountId: accountIdForSource(entry.source),
      source: entry.source,
      externalTransactionId: "",
      merchant,
      merchantNormalized: normalizeFinanceMerchant(merchant),
      description: merchant,
      paymentMethod: "",
      status: "手工补记",
      category: entry.category,
      budgetRole: entry.budgetRole,
      categoryConfirmed: entry.category !== "other",
      budgetRoleConfirmed: entry.budgetRole !== "unknown",
      projectId: entry.projectId || null,
      lifeDomain: entry.lifeDomain || null,
      importBatchId: null,
      relatedTransactionId: null,
      valueRating: entry.valueRating,
      duplicateFingerprint: "",
      createdAt: now,
      updatedAt: now,
    };
    transaction.duplicateFingerprint = financeDuplicateFingerprint(transaction);
    await this.database.execute(insertTransactionSql, transactionBindValues(transaction));
    return transaction;
  }

  async listBatches(limit = 20): Promise<FinanceImportBatch[]> {
    await this.initialize();
    const rows = await this.database.select<BatchRow>("SELECT * FROM finance_import_batches ORDER BY created_at DESC LIMIT ?", [Math.max(1, Math.min(100, Math.round(limit)))]);
    return rows.map(rowToBatch);
  }

  async listManualTransactions(limit = 100): Promise<FinanceTransaction[]> {
    await this.initialize();
    return (await this.database.select<TransactionRow>("SELECT * FROM finance_ledger WHERE import_batch_id IS NULL AND id NOT LIKE 'finance-capture-%' ORDER BY occurred_at DESC LIMIT ?", [Math.max(1, Math.min(2000, Math.round(limit)))])).map(rowToTransaction);
  }

  async updateManualTransaction(id: string, entry: FinanceManualEntry) {
    await this.initialize();
    assertTimestamp(entry.occurredAt);
    const amount = positiveCents(entry.amountCents, "金额");
    if (!entry.description.trim() || !isSource(entry.source) || !isCategory(entry.category) || !isBudgetRole(entry.budgetRole)) throw new Error("请检查消费说明、来源和分类");
    const existing = (await this.database.select<TransactionRow>("SELECT * FROM finance_transactions WHERE id=? AND import_batch_id IS NULL", [id]))[0];
    if (!existing) throw new Error("没有找到这笔手工记录");
    const merchant = entry.description.trim();
    const fingerprint = financeDuplicateFingerprint({ ...rowToTransaction(existing), ...entry, merchant });
    await this.database.execute(`UPDATE finance_transactions SET occurred_at=?,amount_cents=?,description=?,merchant=?,merchant_normalized=?,source=?,account_id=?,category=?,budget_role=?,category_confirmed=?,budget_role_confirmed=?,project_id=?,life_domain=?,value_rating=?,duplicate_fingerprint=?,updated_at=? WHERE id=? AND import_batch_id IS NULL`,
      [entry.occurredAt, amount, merchant, merchant, normalizeFinanceMerchant(merchant), entry.source, accountIdForSource(entry.source), entry.category, entry.budgetRole, entry.category === "other" ? 0 : 1, entry.budgetRole === "unknown" ? 0 : 1, entry.projectId || null, entry.lifeDomain || null, entry.valueRating, fingerprint, this.clock().toISOString(), id]);
  }

  async deleteManualTransaction(id: string) {
    await this.initialize();
    const existing = await this.database.select<{ id: string }>("SELECT id FROM finance_transactions WHERE id = ? AND import_batch_id IS NULL AND id NOT LIKE 'finance-capture-%'", [id]);
    if (!existing.length) throw new Error("没有找到这笔补记账单，导入账单和交易通知请在原入口处理");
    const linked = await this.database.select<{ total: number }>("SELECT COUNT(*) AS total FROM finance_transactions WHERE related_transaction_id = ?", [id]);
    if (linked[0]?.total) throw new Error("这笔补记已关联退款，请先解除退款关联再删除");
    // The private journal's DELETE trigger records the tombstone atomically.
    const result = await this.database.execute(`DELETE FROM finance_transactions WHERE id = ? AND import_batch_id IS NULL AND id NOT LIKE 'finance-capture-%'
      AND NOT EXISTS (SELECT 1 FROM finance_transactions related WHERE related.related_transaction_id = ?)`, [id, id]);
    if (!result.rowsAffected) throw new Error("账单已变化，请刷新后重试");
  }

  async reconcileImportPreview(preview: FinanceImportPreview): Promise<FinanceImportPreview> {
    await this.initialize();
    if (!/^[a-f0-9]{64}$/i.test(preview.fileHash)) throw new Error("账单文件指纹无效");
    const imported = await this.database.select<{ total: number }>("SELECT COUNT(*) AS total FROM finance_import_batches WHERE file_hash = ?", [preview.fileHash]);
    const existing = await this.database.select<{ external_transaction_id: string; duplicate_fingerprint: string }>(
      "SELECT external_transaction_id, duplicate_fingerprint FROM finance_transactions WHERE source = ?",
      [preview.source],
    );
    const externalIds = new Set(existing.map((row) => row.external_transaction_id).filter(Boolean));
    const fingerprints = new Set(existing.map((row) => row.duplicate_fingerprint).filter(Boolean));
    const rules = await this.listRules();
    const captures = await this.unmatchedCaptures();
    const records = preview.records.map((record) => {
      let next = { ...record };
      const rule = rules.find(candidate => financeRuleMatches(candidate, record));
      if (!next.categoryConfirmed) next.category = financeTransportCategory(record) ?? next.category;
      if (rule && next.decision === "candidate") {
        next = { ...next, category: rule.category, budgetRole: rule.budgetRole, categoryConfirmed: true, budgetRoleConfirmed: rule.budgetRole !== "unknown" };
      }
      next.captureCandidates = captures.filter(event => event.state !== "ignored" && event.state !== "duplicate"
        && event.amount_cents === record.amountCents && (event.kind === record.kind || event.kind === "unknown")
        && (event.source === "wechat" ? record.source === "wechat" : true)
        && Math.abs(Date.parse(event.received_at) - Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(record.occurredAt) ? record.occurredAt : `${record.occurredAt}+08:00`)) <= 600_000)
        .map(event => ({ id: event.id, label: `${captureSourceLabel(event.source)} · ${new Date(event.received_at).toLocaleString("zh-CN")} · ${event.description || "尚未补用途"}` }));
      if (next.externalTransactionId && externalIds.has(next.externalTransactionId)) {
        return { ...next, decision: "duplicate" as const, reason: "相同来源和流水号已经存在", selected: false };
      }
      if (!next.externalTransactionId && next.duplicateFingerprint && fingerprints.has(next.duplicateFingerprint)) {
        return { ...next, decision: "suspected" as const, reason: "时间、金额、方向和描述与已有记录相似", selected: false };
      }
      return next;
    });
    return {
      ...preview,
      records,
      counts: countFinanceImportRecords(records),
      alreadyImported: (imported[0]?.total ?? 0) > 0,
    };
  }

  async confirmImport(preview: FinanceImportPreview): Promise<FinanceImportBatch> {
    await this.initialize();
    const reconciled = await this.reconcileImportPreview(preview);
    if (reconciled.alreadyImported) throw new Error("这个账单文件已经导入过，无需重复操作");
    const selected = reconciled.records.filter((record) => record.selected && record.decision !== "skipped" && record.decision !== "duplicate");
    if (!selected.length) throw new Error("当前没有选中可导入的流水");
    const now = this.clock().toISOString();
    const batch: FinanceImportBatch = {
      id: makeId("finance-import"),
      source: reconciled.source,
      periodStart: reconciled.periodStart,
      periodEnd: reconciled.periodEnd,
      fileHash: reconciled.fileHash,
      parserVersion: reconciled.parserVersion,
      statistics: countFinanceImportRecords(selected.map((record) => ({ ...record, decision: "candidate", selected: true }))),
      createdAt: now,
    };
    const statements: SqliteStatement[] = [{
      sql: "INSERT INTO finance_import_batches(id, source, period_start, period_end, file_hash, parser_version, statistics_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      bindValues: [batch.id, batch.source, batch.periodStart, batch.periodEnd, batch.fileHash, batch.parserVersion, JSON.stringify(batch.statistics), batch.createdAt],
    }];
    const transactions = selected.map((record): FinanceTransaction => ({
        id: makeId("finance-transaction"),
        occurredAt: record.occurredAt,
        amountCents: positiveCents(record.amountCents, "导入金额"),
        kind: record.kind,
        direction: record.direction,
        accountId: accountIdForSource(record.source),
        source: record.source,
        externalTransactionId: record.externalTransactionId.trim(),
        merchant: record.merchant.trim(),
        merchantNormalized: record.merchantNormalized || normalizeFinanceMerchant(record.merchant),
        description: record.description.trim(),
        paymentMethod: record.paymentMethod.trim(),
        status: record.status.trim(),
        category: record.category,
        budgetRole: record.budgetRole,
        categoryConfirmed: record.categoryConfirmed,
        budgetRoleConfirmed: record.budgetRoleConfirmed,
        projectId: null,
        lifeDomain: null,
        importBatchId: batch.id,
        relatedTransactionId: null,
        valueRating: null,
        duplicateFingerprint: record.duplicateFingerprint,
        createdAt: now,
        updatedAt: now,
      }));
    const matchedIds = new Set<string>();
    const captures = await this.captures.list();
    for (let index = 0; index < selected.length; index++) {
      const record = selected[index], transaction = transactions[index];
      for (const captureId of record.matchedCaptureIds ?? []) {
        if (matchedIds.has(captureId) || !record.captureCandidates?.some(candidate => candidate.id === captureId)) throw new Error("通知关联对象已变化或被重复选择，请重新预览");
        matchedIds.add(captureId);
        const event = captures.find(candidate => candidate.id === captureId)!;
        if (event.transaction_id) {
          const existing = (await this.database.select<TransactionRow>("SELECT * FROM finance_transactions WHERE id = ?", [event.transaction_id]))[0];
          if (existing) {
            // Retain judgments the user already made while replacing the amount/time with bill evidence.
            if (existing.category_confirmed) { transaction.category = existing.category; transaction.categoryConfirmed = true; }
            transaction.budgetRole = existing.budget_role; transaction.budgetRoleConfirmed = Boolean(existing.budget_role_confirmed);
            transaction.projectId = existing.project_id; transaction.lifeDomain = existing.life_domain; transaction.valueRating = existing.value_rating;
          }
        }
      }
    }
    const existingExpenses = (await this.database.select<TransactionRow>(
      "SELECT * FROM finance_ledger WHERE source = ? AND kind = 'expense' ORDER BY occurred_at DESC",
      [reconciled.source],
    )).map(rowToTransaction);
    const candidateExpenses = [...existingExpenses, ...transactions.filter((transaction) => transaction.kind === "expense")];
    for (const transaction of transactions) {
      if (transaction.kind !== "refund") continue;
      const related = candidateExpenses
        .filter((candidate) => !matchedIds.has(candidate.id.replace(/^finance-capture-/, "")) && candidate.amountCents === transaction.amountCents
          && candidate.merchantNormalized === transaction.merchantNormalized
          && candidate.occurredAt <= transaction.occurredAt)
        .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0];
      transaction.relatedTransactionId = related?.id ?? null;
    }
    for (const transaction of transactions) {
      statements.push({ sql: insertTransactionSql, bindValues: transactionBindValues(transaction) });
    }
    selected.forEach((record, index) => {
      for (const captureId of record.matchedCaptureIds ?? []) statements.push({ sql: "INSERT INTO finance_import_capture_matches(capture_id,transaction_id) VALUES (?,?)", bindValues: [captureId, transactions[index].id] });
    });
    await executeSqliteTransaction(this.database, statements);
    return batch;
  }

  async rollbackBatch(batchId: string) {
    await this.initialize();
    if (!batchId.trim()) throw new Error("导入批次无效");
    const linked = await this.database.select<{ total: number }>(`SELECT COUNT(*) AS total FROM finance_transactions
      WHERE kind='refund' AND COALESCE(import_batch_id,'') <> ?
      AND related_transaction_id IN (SELECT id FROM finance_transactions WHERE import_batch_id=?)`, [batchId, batchId]);
    if (linked[0]?.total) throw new Error("这批付款已关联其他记录的退款，请先解除退款关联再撤销");
    await executeSqliteTransaction(this.database, [
      { sql: "DELETE FROM finance_import_capture_matches WHERE transaction_id IN (SELECT id FROM finance_transactions WHERE import_batch_id = ?)", bindValues: [batchId] },
      { sql: "DELETE FROM finance_transactions WHERE import_batch_id = ?", bindValues: [batchId] },
      { sql: "DELETE FROM finance_import_batches WHERE id = ?", bindValues: [batchId] },
    ]);
  }

  async listRules(): Promise<FinanceCategoryRule[]> {
    await this.initialize();
    const rows = await this.database.select<RuleRow>("SELECT * FROM finance_category_rules ORDER BY updated_at DESC");
    return rows.map((row) => ({
      id: row.id,
      matchKind: row.match_kind,
      matchValue: row.match_value,
      category: row.category,
      budgetRole: row.budget_role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async listRefundCandidates(transaction: FinanceTransaction): Promise<FinanceTransaction[]> {
    await this.initialize();
    return (await this.database.select<TransactionRow>(
      `SELECT * FROM finance_ledger WHERE kind = 'expense' AND id <> ? AND occurred_at <= ? AND amount_cents >= ?
        ORDER BY CASE WHEN id = ? THEN 0 WHEN merchant_normalized = ? THEN 1 ELSE 2 END, occurred_at DESC LIMIT 200`,
      [transaction.id, transaction.occurredAt, transaction.amountCents, transaction.relatedTransactionId, transaction.merchantNormalized],
    )).map(rowToTransaction);
  }

  async updateClassification(
    transactionId: string,
    category: FinanceCategory,
    budgetRole: FinanceBudgetRole,
    remember: boolean,
    context?: { projectId: string | null; lifeDomain: LifeDomain | null; valueRating: FinanceValueRating | null;
      kind?: FinanceTransactionKind; direction?: FinanceTransaction["direction"]; relatedTransactionId?: string | null },
  ) {
    await this.initialize();
    if (!isCategory(category) || !isBudgetRole(budgetRole)) throw new Error("请选择有效的分类和消费性质");
    const rows = await this.database.select<TransactionRow>("SELECT * FROM finance_ledger WHERE id = ? LIMIT 1", [transactionId]);
    const transaction = rows[0] ? rowToTransaction(rows[0]) : null;
    if (!transaction) throw new Error("没有找到这笔流水");
    const kind = context?.kind ?? transaction.kind;
    if (!["expense", "income", "refund", "transfer", "repayment", "adjustment"].includes(kind)) throw new Error("交易类型无效");
    const direction = kind === "expense" || kind === "repayment" ? "out" : kind === "income" || kind === "refund" ? "in" : context?.direction ?? transaction.direction;
    if (!["out", "in", "neutral"].includes(direction)) throw new Error("收支方向无效");
    const relatedId = kind === "refund" ? (context?.relatedTransactionId === undefined ? transaction.relatedTransactionId : context.relatedTransactionId) : null;
    if (relatedId) {
      const original = (await this.database.select<TransactionRow>("SELECT * FROM finance_ledger WHERE id = ? AND kind = 'expense'", [relatedId]))[0];
      const refunds = await this.database.select<{ total: number }>("SELECT COALESCE(SUM(amount_cents),0) AS total FROM finance_ledger WHERE kind = 'refund' AND related_transaction_id = ? AND id <> ?", [relatedId, transactionId]);
      if (!original || relatedId === transactionId || original.occurred_at > transaction.occurredAt) throw new Error("请选择退款之前的原付款");
      if ((refunds[0]?.total ?? 0) + transaction.amountCents > original.amount_cents) throw new Error("累计退款超过原付款金额，请核对关联");
    }
    if (transaction.kind === "expense" && kind !== "expense") {
      const linked = await this.database.select<{ total: number }>("SELECT COUNT(*) AS total FROM finance_ledger WHERE kind = 'refund' AND related_transaction_id = ?", [transactionId]);
      if (linked[0]?.total) throw new Error("这笔付款已关联退款，请先解除退款关联再更改类型");
    }
    const role = kind === "expense" ? budgetRole : "unknown";
    const now = this.clock().toISOString();
    const statements: SqliteStatement[] = [{
      sql: "UPDATE finance_transactions SET category = ?, budget_role = ?, category_confirmed = 1, budget_role_confirmed = ?, kind = ?, direction = ?, related_transaction_id = ?, project_id = ?, life_domain = ?, value_rating = ?, updated_at = ? WHERE id = ?",
      bindValues: [category, role, role !== "unknown" ? 1 : 0, kind, direction, relatedId, context ? context.projectId : transaction.projectId, context ? context.lifeDomain : transaction.lifeDomain, context ? context.valueRating : transaction.valueRating, now, transactionId],
    }];
    if (transactionId.startsWith("finance-capture-")) statements.push({
      sql: "UPDATE finance_capture_events SET kind = ?, category = ?, updated_at = ? WHERE transaction_id = ? AND state = 'completed'",
      bindValues: [["expense", "income", "refund", "transfer"].includes(kind) ? kind : "unknown", category, now, transactionId],
    });
    if (remember && kind === "expense") {
      const { matchKind, matchValue } = financeRuleMatch(transaction);
      if (matchValue) statements.push({
        sql: `INSERT INTO finance_category_rules(id, match_kind, match_value, category, budget_role, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(match_kind, match_value) DO UPDATE SET category = excluded.category,
            budget_role = excluded.budget_role, updated_at = excluded.updated_at`,
        bindValues: [makeId("finance-rule"), matchKind, matchValue, category, budgetRole, now, now],
      });
    }
    await executeSqliteTransaction(this.database, statements);
  }

  async confirmClassificationGroup(month: string, groupKey: string, transactionIds: string[], category: FinanceCategory, remember: boolean) {
    await this.initialize();
    assertMonth(month);
    if (!isCategory(category) || !transactionIds.length || new Set(transactionIds).size !== transactionIds.length) throw new Error("请选择要确认的流水和分类");
    const rows = await this.database.select<TransactionRow>("SELECT * FROM finance_ledger WHERE occurred_at >= ? AND occurred_at < ? AND import_batch_id IS NOT NULL AND kind='expense'", [`${month}-01`, `${nextMonth(month)}-01`]);
    const byId = new Map(rows.map(row => [row.id, rowToTransaction(row)]));
    const transactions = transactionIds.map(id => byId.get(id));
    if (transactions.some(transaction => !transaction || transaction.categoryConfirmed || financeReviewGroupKey(transaction) !== groupKey)) throw new Error("这组流水已变化，请刷新后确认");
    const now = this.clock().toISOString();
    const statements: SqliteStatement[] = transactionIds.map(id => ({
      sql: "UPDATE finance_transactions SET category=?,category_confirmed=1,updated_at=? WHERE id=?",
      bindValues: [category, now, id],
    }));
    if (remember) {
      const { matchKind, matchValue } = financeRuleMatch(transactions[0]!);
      if (matchValue) statements.push({
        sql: `INSERT INTO finance_category_rules(id,match_kind,match_value,category,budget_role,created_at,updated_at) VALUES (?,?,?,?,'unknown',?,?)
          ON CONFLICT(match_kind,match_value) DO UPDATE SET category=excluded.category,updated_at=excluded.updated_at`,
        bindValues: [makeId("finance-rule"), matchKind, matchValue, category, now, now],
      });
    }
    await executeSqliteTransaction(this.database, statements);
    return transactionIds.length;
  }

  async monthlySummary(month: string) {
    await this.initialize();
    assertMonth(month);
    const since = `${shiftMonth(month, -8)}-01`;
    const until = `${nextMonth(month)}-01`;
    const rows = await this.database.select<TransactionRow>(`SELECT * FROM finance_ledger WHERE (occurred_at >= ? AND occurred_at < ?)
      OR (kind = 'refund' AND related_transaction_id IN (SELECT id FROM finance_ledger WHERE occurred_at >= ? AND occurred_at < ? AND kind = 'expense')) ORDER BY occurred_at`, [since, until, since, until]);
    const captures = (await this.unmatchedCaptures()).filter(event => event.received_at >= since && event.received_at < until);
    return summarizeFinanceMonth(month, mergeCaptureTransactions(rows.map(rowToTransaction), captures), await this.getSettings());
  }

  async getReport(month: string): Promise<FinanceAiReport | null> {
    await this.initialize();
    assertMonth(month);
    const rows = await this.database.select<ReportRow>("SELECT * FROM finance_ai_reports WHERE report_month = ? LIMIT 1", [month]);
    if (!rows[0]) return null;
    return {
      month: rows[0].report_month,
      content: JSON.parse(rows[0].content_json) as FinanceAiReport["content"],
      model: rows[0].model,
      generatedAt: rows[0].generated_at,
      inputFingerprint: rows[0].input_fingerprint,
      tokenUsage: JSON.parse(rows[0].token_usage_json) as FinanceAiReport["tokenUsage"],
    };
  }

  async saveReport(report: FinanceAiReport): Promise<FinanceAiReport> {
    await this.initialize();
    assertMonth(report.month);
    if (!report.inputFingerprint || !report.model || !report.content.overview) throw new Error("AI 月报内容不完整");
    await this.database.execute(
      `INSERT INTO finance_ai_reports(report_month, content_json, model, generated_at, input_fingerprint, token_usage_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(report_month) DO UPDATE SET content_json = excluded.content_json, model = excluded.model,
         generated_at = excluded.generated_at, input_fingerprint = excluded.input_fingerprint,
         token_usage_json = excluded.token_usage_json`,
      [report.month, JSON.stringify(report.content), report.model, report.generatedAt, report.inputFingerprint, JSON.stringify(report.tokenUsage)],
    );
    return report;
  }
}

function normalizeSettings(settings: FinanceSettings, now: Date): FinanceSettings {
  return {
    stableMonthlyIncomeCents: cents(settings.stableMonthlyIncomeCents, "稳定税后月收入"),
    defaultSavingsTargetCents: cents(settings.defaultSavingsTargetCents, "默认储蓄目标"),
    backupNoticeAcknowledged: Boolean(settings.backupNoticeAcknowledged),
    updatedAt: now.toISOString(),
  };
}

function settingsWriteStatement(settings: FinanceSettings): SqliteStatement {
  return {
    sql: `INSERT INTO finance_settings(id, stable_monthly_income_cents, default_savings_target_cents, backup_notice_acknowledged, updated_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET stable_monthly_income_cents = excluded.stable_monthly_income_cents,
        default_savings_target_cents = excluded.default_savings_target_cents,
        backup_notice_acknowledged = excluded.backup_notice_acknowledged, updated_at = excluded.updated_at`,
    bindValues: [
      settings.stableMonthlyIncomeCents,
      settings.defaultSavingsTargetCents,
      settings.backupNoticeAcknowledged ? 1 : 0,
      settings.updatedAt,
    ],
  };
}

function normalizeBudget(budget: FinanceBudget, now: Date): FinanceBudget {
  assertMonth(budget.month);
  const categoryLimits = Object.fromEntries(Object.entries(budget.categoryLimits).flatMap(([category, value]) => {
    if (!isCategory(category) || value === undefined) return [];
    return [[category, cents(value, `${category}预算`)]];
  })) as Partial<Record<FinanceCategory, number>>;
  return {
    month: budget.month,
    savingsTargetCents: cents(budget.savingsTargetCents, "储蓄目标"),
    categoryLimits,
    updatedAt: now.toISOString(),
  };
}

function budgetWriteStatement(budget: FinanceBudget): SqliteStatement {
  return {
    sql: `INSERT INTO finance_budgets(month, savings_target_cents, category_limits_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(month) DO UPDATE SET savings_target_cents = excluded.savings_target_cents,
        category_limits_json = excluded.category_limits_json, updated_at = excluded.updated_at`,
    bindValues: [budget.month, budget.savingsTargetCents, JSON.stringify(budget.categoryLimits), budget.updatedAt],
  };
}

export const insertTransactionSql = `INSERT INTO finance_transactions(
  id, occurred_at, amount_cents, kind, direction, account_id, source, external_transaction_id,
  merchant, merchant_normalized, description, payment_method, status, category, budget_role,
  category_confirmed, budget_role_confirmed, project_id, life_domain, import_batch_id,
  related_transaction_id, value_rating, duplicate_fingerprint, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export function transactionBindValues(transaction: FinanceTransaction) {
  return [
    transaction.id, transaction.occurredAt, transaction.amountCents, transaction.kind,
    transaction.direction, transaction.accountId, transaction.source, transaction.externalTransactionId,
    transaction.merchant, transaction.merchantNormalized, transaction.description, transaction.paymentMethod,
    transaction.status, transaction.category, transaction.budgetRole, transaction.categoryConfirmed ? 1 : 0,
    transaction.budgetRoleConfirmed ? 1 : 0, transaction.projectId, transaction.lifeDomain,
    transaction.importBatchId, transaction.relatedTransactionId, transaction.valueRating,
    transaction.duplicateFingerprint, transaction.createdAt, transaction.updatedAt,
  ];
}

function rowToTransaction(row: TransactionRow): FinanceTransaction {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    amountCents: row.amount_cents,
    kind: row.kind,
    direction: row.direction,
    accountId: row.account_id,
    source: row.source,
    externalTransactionId: row.external_transaction_id,
    merchant: row.merchant,
    merchantNormalized: row.merchant_normalized,
    description: row.description,
    paymentMethod: row.payment_method,
    status: row.status,
    category: row.category,
    budgetRole: row.budget_role,
    categoryConfirmed: Boolean(row.category_confirmed),
    budgetRoleConfirmed: Boolean(row.budget_role_confirmed),
    projectId: row.project_id,
    lifeDomain: row.life_domain,
    importBatchId: row.import_batch_id,
    relatedTransactionId: row.related_transaction_id,
    valueRating: row.value_rating,
    duplicateFingerprint: row.duplicate_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToBudget(row: BudgetRow): FinanceBudget {
  let categoryLimits: Partial<Record<FinanceCategory, number>> = {};
  try {
    const parsed = JSON.parse(row.category_limits_json) as Record<string, unknown>;
    categoryLimits = Object.fromEntries(Object.entries(parsed).filter(([category, value]) => isCategory(category) && typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) as Partial<Record<FinanceCategory, number>>;
  } catch {
    categoryLimits = {};
  }
  return { month: row.month, savingsTargetCents: row.savings_target_cents, categoryLimits, updatedAt: row.updated_at };
}

function rowToBatch(row: BatchRow): FinanceImportBatch {
  let statistics: FinanceImportCounts;
  try {
    statistics = JSON.parse(row.statistics_json) as FinanceImportCounts;
  } catch {
    statistics = countFinanceImportRecords([]);
  }
  return {
    id: row.id,
    source: row.source,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    fileHash: row.file_hash,
    parserVersion: row.parser_version,
    statistics,
    createdAt: row.created_at,
  };
}

function accountIdForSource(source: FinanceSource) {
  return defaultAccounts.find((account) => account.source === source)?.id ?? "finance-account-custom";
}

function cents(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_000_000_000) throw new Error(`${field}金额无效`);
  return value;
}

function positiveCents(value: number, field: string) {
  const normalized = cents(value, field);
  if (normalized === 0) throw new Error(`${field}必须大于 0`);
  return normalized;
}

function assertMonth(value: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error("月份格式无效");
}

function assertTimestamp(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/.test(value) || Number.isNaN(new Date(value).getTime())) throw new Error("消费时间无效");
}

function nextMonth(month: string) {
  return shiftMonth(month, 1);
}

function shiftMonth(month: string, offset: number) {
  const [year, monthValue] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthValue - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function isCategory(value: string): value is FinanceCategory {
  return FINANCE_CATEGORIES.some((entry) => entry.value === value);
}

function isBudgetRole(value: string): value is FinanceBudgetRole {
  return FINANCE_BUDGET_ROLES.some((entry) => entry.value === value);
}

function isSource(value: string): value is FinanceSource {
  return ["alipay", "wechat", "cash", "custom"].includes(value);
}

function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

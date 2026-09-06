use calamine::{open_workbook_auto, Data, ExcelDateTime, ExcelDateTimeType, Reader};
use encoding_rs::GBK;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path};

const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_ROWS: usize = 50_000;
const PARSER_VERSION: &str = "finance-parser/3";

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FinanceImportCounts {
    expense: usize,
    income: usize,
    refund: usize,
    transfer: usize,
    repayment: usize,
    adjustment: usize,
    skipped: usize,
    duplicate: usize,
    suspected: usize,
    uncertain: usize,
    importable: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinanceImportRecord {
    row_number: usize,
    source: String,
    occurred_at: String,
    amount_cents: i64,
    kind: String,
    direction: String,
    external_transaction_id: String,
    merchant: String,
    merchant_normalized: String,
    description: String,
    payment_method: String,
    status: String,
    category: String,
    budget_role: String,
    category_confirmed: bool,
    budget_role_confirmed: bool,
    duplicate_fingerprint: String,
    decision: String,
    reason: String,
    selected: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinanceImportPreview {
    source: String,
    file_hash: String,
    parser_version: String,
    period_start: String,
    period_end: String,
    records: Vec<FinanceImportRecord>,
    counts: FinanceImportCounts,
    already_imported: bool,
}

#[tauri::command]
pub async fn finance_preview_import(
    path: String,
    source: String,
) -> Result<FinanceImportPreview, String> {
    if !matches!(source.as_str(), "alipay" | "wechat") {
        return Err("首版只支持支付宝和微信账单。".into());
    }
    let import_path = Path::new(&path);
    let metadata =
        std::fs::metadata(import_path).map_err(|error| format!("无法读取所选账单：{error}"))?;
    if !metadata.is_file() {
        return Err("请选择解压后的账单文件。".into());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("账单文件不能超过 20 MB。".into());
    }
    let extension = import_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "csv" | "xls" | "xlsx") {
        return Err("请选择 CSV、XLS 或 XLSX 文件。".into());
    }
    let bytes = tokio::fs::read(import_path)
        .await
        .map_err(|error| format!("无法读取所选账单：{error}"))?;
    let file_hash = hex::encode(Sha256::digest(&bytes));
    let path = import_path.to_path_buf();
    let source_for_parse = source.clone();
    let records = tauri::async_runtime::spawn_blocking(move || {
        let tables = match extension.as_str() {
            "csv" => vec![parse_csv_table(&bytes)?],
            "xls" | "xlsx" => parse_excel_tables(&path)?,
            _ => unreachable!(),
        };
        parse_best_table(tables, &source_for_parse)
    })
    .await
    .map_err(|error| format!("账单解析任务意外中断：{error}"))??;
    let period_start = records
        .iter()
        .filter_map(|record| record.occurred_at.get(..10))
        .min()
        .unwrap_or_default()
        .to_string();
    let period_end = records
        .iter()
        .filter_map(|record| record.occurred_at.get(..10))
        .max()
        .unwrap_or_default()
        .to_string();
    let counts = count_records(&records);
    Ok(FinanceImportPreview {
        source,
        file_hash,
        parser_version: PARSER_VERSION.into(),
        period_start,
        period_end,
        records,
        counts,
        already_imported: false,
    })
}

#[tauri::command]
pub async fn finance_generate_monthly_report(
    snapshot: Value,
    model: String,
) -> Result<crate::deepseek_api::StructuredApiResponse, String> {
    validate_ai_snapshot(&snapshot)?;
    let snapshot_text =
        serde_json::to_string(&snapshot).map_err(|error| format!("无法准备月报汇总：{error}"))?;
    if snapshot_text.len() > 256 * 1024 {
        return Err("发送汇总过大，请缩小月份范围后重试。".into());
    }
    crate::deepseek_api::generate_for_finance(
        &model,
        finance_system_prompt(),
        &json!({ "anonymousMonthlySummary": snapshot }),
        finance_report_schema(),
    )
    .await
}

fn parse_csv_table(bytes: &[u8]) -> Result<Vec<Vec<String>>, String> {
    let text = decode_bill_text(bytes)?;
    let first_content_line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default();
    let delimiter =
        if first_content_line.matches('\t').count() > first_content_line.matches(',').count() {
            b'\t'
        } else {
            b','
        };
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .from_reader(text.as_bytes());
    let mut rows = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|error| format!("CSV 内容无法解析：{error}"))?;
        rows.push(record.iter().map(clean_cell).collect());
        if rows.len() > MAX_ROWS + 100 {
            return Err("账单超过 50,000 行，请缩小导出时间范围。".into());
        }
    }
    Ok(rows)
}

fn parse_excel_tables(path: &Path) -> Result<Vec<Vec<Vec<String>>>, String> {
    let mut workbook =
        open_workbook_auto(path).map_err(|error| format!("Excel 账单无法打开：{error}"))?;
    let names = workbook.sheet_names().to_vec();
    let mut tables = Vec::new();
    for name in names {
        let range = workbook
            .worksheet_range(&name)
            .map_err(|error| format!("工作表“{name}”无法读取：{error}"))?;
        let mut rows = Vec::new();
        for row in range.rows().take(MAX_ROWS + 101) {
            rows.push(row.iter().map(excel_cell_text).collect());
        }
        if rows.len() > MAX_ROWS + 100 {
            return Err("账单超过 50,000 行，请缩小导出时间范围。".into());
        }
        tables.push(rows);
    }
    if tables.is_empty() {
        return Err("Excel 文件中没有可读取的工作表。".into());
    }
    Ok(tables)
}

fn decode_bill_text(bytes: &[u8]) -> Result<String, String> {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if let Ok(value) = std::str::from_utf8(bytes) {
        return Ok(value.to_string());
    }
    let (decoded, _, had_errors) = GBK.decode(bytes);
    if had_errors {
        return Err("CSV 编码无法识别，请用 UTF-8、GBK 或 GB18030 格式重新导出。".into());
    }
    Ok(decoded.into_owned())
}

fn excel_cell_text(cell: &Data) -> String {
    if let Data::DateTime(value) = cell {
        if let Some(datetime) = format_excel_datetime(value) {
            return datetime;
        }
    }
    clean_cell(&cell.to_string())
}

fn format_excel_datetime(value: &ExcelDateTime) -> Option<String> {
    if !value.is_datetime() {
        return None;
    }
    let (year, month, day, hour, minute, second, millisecond) = value.to_ymd_hms_milli();
    let datetime = chrono::NaiveDate::from_ymd_opt(year.into(), month.into(), day.into())?
        .and_hms_opt(hour.into(), minute.into(), second.into())?
        .checked_add_signed(chrono::Duration::milliseconds(millisecond.into()))?;
    Some(datetime.format("%Y-%m-%d %H:%M:%S").to_string())
}

fn normalize_excel_serial(value: f64) -> Option<String> {
    if !value.is_finite() || !(20_000.0..=100_000.0).contains(&value) {
        return None;
    }
    format_excel_datetime(&ExcelDateTime::new(
        value,
        ExcelDateTimeType::DateTime,
        false,
    ))
}

fn parse_best_table(
    tables: Vec<Vec<Vec<String>>>,
    source: &str,
) -> Result<Vec<FinanceImportRecord>, String> {
    let mut best: Option<(Vec<Vec<String>>, usize, usize)> = None;
    for rows in tables {
        if let Some((header_index, score)) = find_header(&rows, source) {
            if best
                .as_ref()
                .map(|(_, _, best_score)| score > *best_score)
                .unwrap_or(true)
            {
                best = Some((rows, header_index, score));
            }
        }
    }
    let (rows, header_index, _) = best.ok_or_else(|| {
        let label = if source == "wechat" {
            "微信"
        } else {
            "支付宝"
        };
        format!("没有识别到{label}官方账单表头。请确认已解压，并选择导出的明细文件。")
    })?;
    let headers = header_map(&rows[header_index]);
    let mut records = Vec::new();
    for (index, row) in rows.iter().enumerate().skip(header_index + 1) {
        if row.iter().all(|cell| cell.trim().is_empty()) {
            continue;
        }
        if records.len() >= MAX_ROWS {
            return Err("账单超过 50,000 行，请缩小导出时间范围。".into());
        }
        records.push(parse_row(index + 1, row, &headers, source));
    }
    if records.is_empty() {
        return Err("账单表头已识别，但没有找到交易明细。".into());
    }
    Ok(records)
}

fn find_header(rows: &[Vec<String>], source: &str) -> Option<(usize, usize)> {
    rows.iter()
        .take(100)
        .enumerate()
        .filter_map(|(index, row)| {
            let headers = header_map(row);
            let checks = [
                has_alias(&headers, TIME_ALIASES),
                has_alias(&headers, AMOUNT_ALIASES),
                has_alias(&headers, STATUS_ALIASES),
                has_alias(&headers, DIRECTION_ALIASES),
                has_alias(&headers, MERCHANT_ALIASES),
                has_alias(&headers, EXTERNAL_ID_ALIASES),
            ];
            let score = checks.iter().filter(|value| **value).count();
            let source_marker = if source == "wechat" {
                has_alias(&headers, &["交易对方", "交易单号", "商品"])
            } else {
                has_alias(&headers, &["交易号", "商品说明", "交易分类"])
            };
            (score >= 4 && source_marker).then_some((index, score))
        })
        .max_by_key(|(_, score)| *score)
}

fn parse_row(
    row_number: usize,
    row: &[String],
    headers: &HashMap<String, usize>,
    source: &str,
) -> FinanceImportRecord {
    let raw_time = field(row, headers, TIME_ALIASES);
    let raw_amount = field(row, headers, AMOUNT_ALIASES);
    let status = field(row, headers, STATUS_ALIASES);
    let direction_text = field(row, headers, DIRECTION_ALIASES);
    let transaction_type = field(row, headers, TYPE_ALIASES);
    let merchant = field(row, headers, MERCHANT_ALIASES);
    let description = field(row, headers, DESCRIPTION_ALIASES);
    let payment_method = field(row, headers, PAYMENT_ALIASES);
    let external_transaction_id = field(row, headers, EXTERNAL_ID_ALIASES);
    let occurred_at = normalize_timestamp(&raw_time).unwrap_or_default();
    let amount_cents = parse_amount_cents(&raw_amount).unwrap_or(0);
    let (kind, direction) =
        classify_kind(&transaction_type, &direction_text, &status, &description);
    let status_class = classify_status(&status);
    let mut decision = "candidate";
    let mut reason = String::new();
    if status_class == "skipped" {
        decision = "skipped";
        reason = format!(
            "交易状态为“{}”",
            if status.is_empty() { "未知" } else { &status }
        );
    } else if occurred_at.is_empty() || amount_cents <= 0 {
        decision = "uncertain";
        reason = if occurred_at.is_empty() {
            "交易时间无法识别"
        } else {
            "金额无法识别"
        }
        .into();
    } else if status_class == "unknown" {
        decision = "uncertain";
        reason = "交易状态不明确，需要确认".into();
    } else if kind == "adjustment" {
        decision = "uncertain";
        reason = "收支方向不明确，需要确认".into();
    }
    let category = infer_category(&merchant, &description);
    let merchant_normalized = normalize_merchant(&merchant);
    let duplicate_fingerprint = if occurred_at.is_empty() || amount_cents <= 0 {
        String::new()
    } else {
        hex::encode(Sha256::digest(
            format!(
                "{}|{}|{}|{}|{}",
                occurred_at,
                amount_cents,
                direction,
                merchant_normalized,
                normalize_merchant(&description)
            )
            .as_bytes(),
        ))
    };
    FinanceImportRecord {
        row_number,
        source: source.into(),
        occurred_at,
        amount_cents,
        kind: kind.into(),
        direction: direction.into(),
        external_transaction_id: external_transaction_id.trim().into(),
        merchant: merchant.trim().into(),
        merchant_normalized,
        description: description.trim().into(),
        payment_method: payment_method.trim().into(),
        status: status.trim().into(),
        category: category.into(),
        budget_role: "unknown".into(),
        category_confirmed: false,
        budget_role_confirmed: false,
        duplicate_fingerprint,
        decision: decision.into(),
        reason,
        selected: decision == "candidate",
    }
}

fn count_records(records: &[FinanceImportRecord]) -> FinanceImportCounts {
    let mut counts = FinanceImportCounts::default();
    for record in records {
        match record.decision.as_str() {
            "skipped" => counts.skipped += 1,
            "duplicate" => counts.duplicate += 1,
            "suspected" => counts.suspected += 1,
            "uncertain" => counts.uncertain += 1,
            _ => {
                match record.kind.as_str() {
                    "expense" => counts.expense += 1,
                    "income" => counts.income += 1,
                    "refund" => counts.refund += 1,
                    "transfer" => counts.transfer += 1,
                    "repayment" => counts.repayment += 1,
                    _ => counts.adjustment += 1,
                }
                if record.selected {
                    counts.importable += 1;
                }
            }
        }
    }
    counts
}

fn classify_status(status: &str) -> &'static str {
    let normalized = normalize_merchant(status);
    if normalized.is_empty() {
        return "unknown";
    }
    if [
        "关闭",
        "失败",
        "待付款",
        "等待付款",
        "已撤销",
        "未支付",
        "已取消",
    ]
    .iter()
    .any(|value| normalized.contains(value))
    {
        return "skipped";
    }
    if [
        "成功",
        "已完成",
        "已收钱",
        "已转账",
        "已退款",
        "已存入",
        "对方已收钱",
    ]
    .iter()
    .any(|value| normalized.contains(value))
    {
        return "success";
    }
    "unknown"
}

fn classify_kind<'a>(
    transaction_type: &'a str,
    direction: &'a str,
    status: &'a str,
    description: &'a str,
) -> (&'static str, &'static str) {
    let text = format!("{transaction_type}|{direction}|{status}|{description}");
    if text.contains("退款") {
        return ("refund", "in");
    }
    if text.contains("还款") {
        return ("repayment", "out");
    }
    if transaction_type.contains("转账") || transaction_type.contains("资金转移") {
        return ("transfer", "neutral");
    }
    if direction.contains("收入")
        || direction.trim() == "收"
        || transaction_type.contains("收款")
        || transaction_type.contains("工资")
        || transaction_type.contains("奖金")
    {
        return ("income", "in");
    }
    if direction.contains("支出") || direction.trim() == "支" || direction.contains("付款") {
        return ("expense", "out");
    }
    ("adjustment", "neutral")
}

fn parse_amount_cents(value: &str) -> Option<i64> {
    let normalized = value
        .replace('¥', "")
        .replace('￥', "")
        .replace(',', "")
        .replace('，', "")
        .replace(' ', "")
        .trim_start_matches('+')
        .to_string();
    let amount = normalized.parse::<f64>().ok()?.abs();
    if !amount.is_finite() || amount > 1_000_000_000.0 {
        return None;
    }
    Some((amount * 100.0).round() as i64)
}

fn normalize_timestamp(value: &str) -> Option<String> {
    let normalized = value
        .trim()
        .replace('/', "-")
        .replace('年', "-")
        .replace('月', "-")
        .replace('日', " ")
        .replace('T', " ");
    let normalized = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    if let Ok(serial) = normalized.parse::<f64>() {
        let datetime = normalize_excel_serial(serial)?;
        return Some(datetime.replace(' ', "T"));
    }
    let formats = [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
    ];
    for format in formats {
        if format == "%Y-%m-%d" {
            if let Ok(date) = chrono::NaiveDate::parse_from_str(&normalized, format) {
                return Some(format!("{}T00:00:00", date.format("%Y-%m-%d")));
            }
        } else if let Ok(date) = chrono::NaiveDateTime::parse_from_str(&normalized, format) {
            return Some(date.format("%Y-%m-%dT%H:%M:%S").to_string());
        }
    }
    None
}

fn infer_category(merchant: &str, description: &str) -> &'static str {
    let text = format!("{merchant}{description}");
    let rules = [
        (
            "housing",
            &["房租", "物业", "水费", "电费", "燃气", "宽带"] as &[&str],
        ),
        (
            "food",
            &["餐", "饭", "咖啡", "奶茶", "外卖", "超市", "食品"],
        ),
        (
            "transport",
            &[
                "地铁", "公交", "打车", "出租", "高铁", "火车", "加油", "停车",
            ],
        ),
        ("health", &["医院", "药房", "体检", "医疗", "健身"]),
        ("learning", &["课程", "书店", "图书", "教育", "考试"]),
        ("digital", &["软件", "会员", "数码", "云服务", "应用"]),
        ("relationships", &["红包", "礼物", "婚礼", "人情"]),
        ("entertainment", &["游戏", "电影", "演出", "娱乐"]),
        ("travel", &["酒店", "机票", "景区", "旅行"]),
        ("fees", &["手续费", "利息", "服务费"]),
        ("daily", &["日用", "百货", "便利店", "洗护"]),
    ];
    rules
        .iter()
        .find(|(_, keywords)| keywords.iter().any(|keyword| text.contains(keyword)))
        .map(|(category, _)| *category)
        .unwrap_or("other")
}

fn header_map(row: &[String]) -> HashMap<String, usize> {
    row.iter()
        .enumerate()
        .filter_map(|(index, value)| {
            let key = normalize_header(value);
            (!key.is_empty()).then_some((key, index))
        })
        .collect()
}

fn has_alias(headers: &HashMap<String, usize>, aliases: &[&str]) -> bool {
    aliases
        .iter()
        .any(|alias| headers.contains_key(&normalize_header(alias)))
}

fn field(row: &[String], headers: &HashMap<String, usize>, aliases: &[&str]) -> String {
    aliases
        .iter()
        .find_map(|alias| {
            headers
                .get(&normalize_header(alias))
                .and_then(|index| row.get(*index))
        })
        .map(|value| clean_cell(value))
        .unwrap_or_default()
}

fn clean_cell(value: &str) -> String {
    value
        .trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}')
        .trim_matches('"')
        .trim()
        .to_string()
}

fn normalize_header(value: &str) -> String {
    clean_cell(value)
        .to_lowercase()
        .chars()
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn normalize_merchant(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn validate_ai_snapshot(value: &Value) -> Result<(), String> {
    const FORBIDDEN_KEYS: &[&str] = &[
        "accountnumber",
        "externaltransactionid",
        "filename",
        "merchantname",
        "projectname",
        "rawnote",
        "rawrow",
        "username",
        "description",
    ];
    match value {
        Value::Object(values) => {
            for (key, child) in values {
                let normalized = key.to_ascii_lowercase().replace('_', "").replace('-', "");
                if FORBIDDEN_KEYS.contains(&normalized.as_str()) {
                    return Err(format!("发送预览包含不允许上传的字段：{key}"));
                }
                validate_ai_snapshot(child)?;
            }
        }
        Value::Array(values) => {
            for child in values {
                validate_ai_snapshot(child)?;
            }
        }
        Value::String(value) if value.len() > 500 => {
            return Err("发送预览包含过长文本，已停止上传。".into());
        }
        _ => {}
    }
    Ok(())
}

fn finance_system_prompt() -> &'static str {
    r#"你是个人工作台中的月度财务复盘助手。输入只有本地计算后的匿名汇总，所有金额单位为人民币分。
严格要求：
1. 不猜测用户身份、商户或项目名称；不得索要账户号、流水号、姓名或原始备注。
2. 必要支出只依据输入中已经确认的预算角色；待确认项必须明确标记，不得擅自改分类。
3. 不提供投资、借贷、保险或具体金融产品的购买建议。
4. 节约机会只能引用 savingCandidates 中的 evidenceId；minimumSavingCents 与 maximumSavingCents 必须为非负整数，且不得超过对应证据金额。周期和异常证据只能用于解释或提问。
5. 最多给出三项 nextActions。情景金额可以提出解释，但客户端会以本地重算值为准。
只返回一个 JSON 对象，不要 Markdown。结构必须是：
{
  "overview": "string",
  "essentialStructure": "string",
  "pendingConfirmations": ["string"],
  "worthwhileSpending": ["string"],
  "opportunities": [{
    "title": "string", "reason": "string", "evidenceIds": ["string"],
    "minimumSavingCents": 0, "maximumSavingCents": 0,
    "confidence": "low|medium|high", "action": "string", "tradeoff": "string"
  }],
  "scenarios": {"currentCents": 0, "moderateCents": 0, "aggressiveCents": 0},
  "nextActions": ["string"],
  "questions": ["string"]
}"#
}

fn finance_report_schema() -> Value {
    let text_array = || json!({ "type": "array", "items": { "type": "string" }, "maxItems": 12 });
    let opportunity = json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "title": { "type": "string" },
            "reason": { "type": "string" },
            "evidenceIds": { "type": "array", "items": { "type": "string" }, "maxItems": 20 },
            "minimumSavingCents": { "type": "integer", "minimum": 0 },
            "maximumSavingCents": { "type": "integer", "minimum": 0 },
            "confidence": { "type": "string", "enum": ["low", "medium", "high"] },
            "action": { "type": "string" },
            "tradeoff": { "type": "string" }
        },
        "required": ["title", "reason", "evidenceIds", "minimumSavingCents", "maximumSavingCents", "confidence", "action", "tradeoff"]
    });
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "overview": { "type": "string" },
            "essentialStructure": { "type": "string" },
            "pendingConfirmations": text_array(),
            "worthwhileSpending": text_array(),
            "opportunities": { "type": "array", "items": opportunity, "maxItems": 8 },
            "scenarios": {
                "type": "object", "additionalProperties": false,
                "properties": {
                    "currentCents": { "type": "integer" },
                    "moderateCents": { "type": "integer" },
                    "aggressiveCents": { "type": "integer" }
                },
                "required": ["currentCents", "moderateCents", "aggressiveCents"]
            },
            "nextActions": { "type": "array", "items": { "type": "string" }, "maxItems": 3 },
            "questions": text_array()
        },
        "required": ["overview", "essentialStructure", "pendingConfirmations", "worthwhileSpending", "opportunities", "scenarios", "nextActions", "questions"]
    })
}

const TIME_ALIASES: &[&str] = &["交易时间", "交易创建时间", "创建时间", "付款时间", "时间"];
const AMOUNT_ALIASES: &[&str] = &["金额元", "金额", "交易金额", "金额(元)", "金额（元）"];
const STATUS_ALIASES: &[&str] = &["当前状态", "交易状态", "状态", "资金状态"];
const DIRECTION_ALIASES: &[&str] = &["收支", "收/支", "收／支", "资金流向"];
const TYPE_ALIASES: &[&str] = &["交易类型", "交易分类", "类型"];
const MERCHANT_ALIASES: &[&str] = &["交易对方", "对方", "商户名称", "对方名称"];
const DESCRIPTION_ALIASES: &[&str] = &["商品", "商品说明", "商品名称", "备注"];
const PAYMENT_ALIASES: &[&str] = &["支付方式", "付款方式", "支付渠道"];
const EXTERNAL_ID_ALIASES: &[&str] = &["交易单号", "交易号", "支付宝交易号", "微信支付单号"];

#[cfg(test)]
mod tests {
    use super::{
        decode_bill_text, excel_cell_text, normalize_timestamp, parse_best_table, parse_csv_table,
    };
    use calamine::{Data, ExcelDateTime, ExcelDateTimeType};
    use encoding_rs::GBK;

    #[test]
    fn parses_anonymous_wechat_rows_and_keeps_failed_rows_visible() {
        let rows = vec![
            vec!["微信支付账单明细".into()],
            vec![
                "交易时间".into(),
                "交易类型".into(),
                "交易对方".into(),
                "商品".into(),
                "收/支".into(),
                "金额(元)".into(),
                "支付方式".into(),
                "当前状态".into(),
                "交易单号".into(),
            ],
            vec![
                "2026-08-01 08:30:00".into(),
                "商户消费".into(),
                "匿名早餐店".into(),
                "早餐".into(),
                "支出".into(),
                "¥12.80".into(),
                "零钱".into(),
                "支付成功".into(),
                "WX-ANON-001".into(),
            ],
            vec![
                "2026-08-02 09:30:00".into(),
                "商户消费".into(),
                "匿名商户".into(),
                "订单".into(),
                "支出".into(),
                "20.00".into(),
                "零钱".into(),
                "支付失败".into(),
                "WX-ANON-002".into(),
            ],
        ];
        let records = parse_best_table(vec![rows], "wechat").expect("wechat fixture should parse");
        assert_eq!(records[0].amount_cents, 1280);
        assert_eq!(records[0].decision, "candidate");
        assert_eq!(records[1].decision, "skipped");
    }

    #[test]
    fn converts_excel_datetime_cells_before_parsing_wechat_rows() {
        let cell = Data::DateTime(ExcelDateTime::new(
            46267.8433101852,
            ExcelDateTimeType::DateTime,
            false,
        ));
        let displayed = excel_cell_text(&cell);
        assert_eq!(displayed, "2026-09-02 20:14:22");
        assert_eq!(
            normalize_timestamp(&displayed).as_deref(),
            Some("2026-09-02T20:14:22")
        );
        assert_eq!(
            normalize_timestamp("2026-09-02T20:14:22.000").as_deref(),
            Some("2026-09-02T20:14:22"),
        );
        assert_eq!(
            normalize_timestamp("46267.843310185184").as_deref(),
            Some("2026-09-02T20:14:22"),
        );
        assert_eq!(normalize_timestamp("205").as_deref(), None);
    }

    #[test]
    fn parses_anonymous_alipay_refunds() {
        let rows = vec![
            vec![
                "交易创建时间".into(),
                "交易分类".into(),
                "交易对方".into(),
                "商品说明".into(),
                "收/支".into(),
                "金额（元）".into(),
                "交易状态".into(),
                "交易号".into(),
            ],
            vec![
                "2026/08/03 10:00".into(),
                "退款".into(),
                "匿名书店".into(),
                "图书退款".into(),
                "收入".into(),
                "35.50".into(),
                "退款成功".into(),
                "ALI-ANON-001".into(),
            ],
        ];
        let records = parse_best_table(vec![rows], "alipay").expect("alipay fixture should parse");
        assert_eq!(records[0].kind, "refund");
        assert_eq!(records[0].amount_cents, 3550);
    }

    #[test]
    fn decodes_gbk_csv_text() {
        let source = "交易时间,金额（元）,交易状态\n2026-08-01 08:00:00,12.80,交易成功";
        let (encoded, _, _) = GBK.encode(source);
        assert_eq!(
            decode_bill_text(&encoded).expect("gbk should decode"),
            source
        );
    }

    #[test]
    fn parses_csv_with_bom_and_preamble_before_the_header() {
        let csv = "\u{feff}支付宝交易明细（匿名测试）\n导出时间,2026-08-31\n\n交易创建时间,交易分类,交易对方,商品说明,收/支,金额（元）,交易状态,交易号\n2026-08-03 10:00:00,商户消费,匿名书店,图书,支出,35.50,交易成功,ALI-ANON-CSV-001\n";
        let rows = parse_csv_table(csv.as_bytes()).expect("csv fixture should parse");
        let records = parse_best_table(vec![rows], "alipay").expect("preamble should be skipped");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].external_transaction_id, "ALI-ANON-CSV-001");
    }
}

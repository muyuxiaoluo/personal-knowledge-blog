use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::{header::HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use url::Url;

const SECRET_SERVICE: &str = "com.muyuxiaoluo.life-strategy-library";

fn secret_account(kind: &str) -> Option<&'static str> {
    match kind {
        "github_pat" => Some("github_pat"),
        "deepseek_api_key" => Some("deepseek_api_key"),
        "aliyun_access_key_id" => Some("aliyun_access_key_id"),
        "aliyun_access_key_secret" => Some("aliyun_access_key_secret"),
        "qwen_monitor_credential" => Some("qwen_monitor_credential"),
        _ => None,
    }
}

fn credential(kind: &str) -> Result<keyring::Entry, String> {
    let account = secret_account(kind).ok_or_else(|| "不支持的凭据类型".to_string())?;
    keyring::Entry::new(SECRET_SERVICE, account)
        .map_err(|error| format!("无法访问系统凭据管理器：{error}"))
}

fn read_secret(kind: &str) -> Result<String, String> {
    match credential(kind)?.get_password() {
        Ok(value) if !value.is_empty() => Ok(value),
        Ok(_) | Err(keyring::Error::NoEntry) => {
            Err("尚未配置这项凭据，请先查看页面中的获取说明。".into())
        }
        Err(error) => Err(format!(
            "无法从 Windows 系统凭据管理器读取这项配置：{error}"
        )),
    }
}

#[tauri::command]
pub async fn secret_status(kind: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || match credential(&kind)?.get_password() {
        Ok(value) => Ok(!value.is_empty()),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(format!("无法检查系统凭据：{error}")),
    })
    .await
    .map_err(|error| format!("检查凭据任务失败：{error}"))?
}

#[tauri::command]
pub async fn secret_set(kind: String, value: String) -> Result<(), String> {
    let normalized = value.trim().to_string();
    if normalized.is_empty() {
        return Err("凭据不能为空".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        credential(&kind)?
            .set_password(&normalized)
            .map_err(|error| format!("无法保存到系统凭据管理器：{error}"))
    })
    .await
    .map_err(|error| format!("保存凭据任务失败：{error}"))?
}

#[tauri::command]
pub async fn secret_delete(kind: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = credential(&kind)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("无法删除系统凭据：{error}")),
        }
    })
    .await
    .map_err(|error| format!("删除凭据任务失败：{error}"))?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubCommit {
    sha: String,
    message: String,
    author: String,
    committed_at: String,
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRelease {
    id: u64,
    name: String,
    tag_name: String,
    published_at: String,
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRepositorySnapshot {
    repository: String,
    url: String,
    commits: Vec<GitHubCommit>,
    releases: Vec<GitHubRelease>,
    fetched_at: String,
}

#[derive(Deserialize)]
struct GitHubApiCommit {
    sha: String,
    html_url: String,
    commit: GitHubCommitBody,
    author: Option<GitHubActor>,
}

#[derive(Deserialize)]
struct GitHubCommitBody {
    message: String,
    author: Option<GitHubCommitAuthor>,
}

#[derive(Deserialize)]
struct GitHubCommitAuthor {
    name: String,
    date: String,
}

#[derive(Deserialize)]
struct GitHubActor {
    login: String,
}

#[derive(Deserialize)]
struct GitHubApiRelease {
    id: u64,
    name: Option<String>,
    tag_name: String,
    published_at: Option<String>,
    html_url: String,
}

fn valid_github_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

#[tauri::command]
pub async fn github_fetch_repository(
    owner: String,
    name: String,
) -> Result<GitHubRepositorySnapshot, String> {
    if !valid_github_segment(&owner) || !valid_github_segment(&name) {
        return Err("GitHub 仓库名称格式不正确".into());
    }
    let token = read_secret("github_pat")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| format!("无法准备 GitHub 请求：{error}"))?;
    let base = format!("https://api.github.com/repos/{owner}/{name}");
    let commits_response = client
        .get(format!("{base}/commits?per_page=10"))
        .header("User-Agent", "life-strategy-library")
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|error| format!("无法连接 GitHub：{error}"))?;
    let commits: Vec<GitHubApiCommit> = decode_github_response(commits_response).await?;
    let releases_response = client
        .get(format!("{base}/releases?per_page=5"))
        .header("User-Agent", "life-strategy-library")
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|error| format!("无法读取 GitHub Release：{error}"))?;
    let releases: Vec<GitHubApiRelease> = decode_github_response(releases_response).await?;
    Ok(GitHubRepositorySnapshot {
        repository: format!("{owner}/{name}"),
        url: format!("https://github.com/{owner}/{name}"),
        commits: commits
            .into_iter()
            .map(|item| GitHubCommit {
                sha: item.sha,
                message: item
                    .commit
                    .message
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .to_string(),
                author: item
                    .author
                    .map(|author| author.login)
                    .or_else(|| {
                        item.commit
                            .author
                            .as_ref()
                            .map(|author| author.name.clone())
                    })
                    .unwrap_or_else(|| "未知作者".into()),
                committed_at: item
                    .commit
                    .author
                    .map(|author| author.date)
                    .unwrap_or_default(),
                url: item.html_url,
            })
            .collect(),
        releases: releases
            .into_iter()
            .map(|item| GitHubRelease {
                id: item.id,
                name: item
                    .name
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| item.tag_name.clone()),
                tag_name: item.tag_name,
                published_at: item.published_at.unwrap_or_default(),
                url: item.html_url,
            })
            .collect(),
        fetched_at: Utc::now().to_rfc3339(),
    })
}

async fn decode_github_response<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
) -> Result<T, String> {
    let status = response.status();
    if status.is_success() {
        return response
            .json::<T>()
            .await
            .map_err(|error| format!("GitHub 返回数据无法解析：{error}"));
    }
    let rate_limited = response
        .headers()
        .get("x-ratelimit-remaining")
        .and_then(|value| value.to_str().ok())
        == Some("0");
    let sso_required = response.headers().contains_key("x-github-sso");
    let message = response.text().await.unwrap_or_default();
    let hint = match status {
        StatusCode::UNAUTHORIZED => {
            "当前保存的 GitHub PAT 无效或已经过期，请在上方替换后重试"
        }
        StatusCode::FORBIDDEN if rate_limited => "GitHub API 请求已达到限额，请稍后再试",
        StatusCode::FORBIDDEN if sso_required => {
            "GitHub 组织要求 SSO 授权，请先在 GitHub 中授权这枚 PAT"
        }
        StatusCode::FORBIDDEN => "GitHub 拒绝访问，请检查 PAT 权限或组织审批状态",
        StatusCode::NOT_FOUND => "GitHub 返回 404：如果这是私有仓库，通常表示当前保存的 PAT 看不到这个仓库；请检查 Resource owner、已选仓库和 Contents: Read-only 权限",
        _ => "GitHub 请求失败",
    };
    Err(if message.is_empty() {
        format!("{hint}（HTTP {status}）")
    } else {
        format!("{hint}（HTTP {status}）")
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelBalance {
    provider: String,
    available: bool,
    amount: String,
    cash_amount: String,
    granted_amount: String,
    currency: String,
    fetched_at: String,
    message: String,
}

#[derive(Deserialize)]
struct DeepSeekBalanceResponse {
    is_available: bool,
    balance_infos: Vec<DeepSeekBalanceInfo>,
}

#[derive(Deserialize)]
struct DeepSeekBalanceInfo {
    currency: String,
    total_balance: String,
    granted_balance: String,
    topped_up_balance: String,
}

#[tauri::command]
pub async fn deepseek_fetch_balance() -> Result<ModelBalance, String> {
    let token = read_secret("deepseek_api_key")?;
    let response = reqwest::Client::new()
        .get("https://api.deepseek.com/user/balance")
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|error| format!("无法连接 DeepSeek 余额接口：{error}"))?;
    if !response.status().is_success() {
        return Err(match response.status() {
            StatusCode::UNAUTHORIZED => "DeepSeek API Key 无效或已经过期".into(),
            status => format!("DeepSeek 余额请求失败（HTTP {status}）"),
        });
    }
    let body = response
        .json::<DeepSeekBalanceResponse>()
        .await
        .map_err(|error| format!("DeepSeek 余额数据无法解析：{error}"))?;
    let balance = body.balance_infos.into_iter().next();
    Ok(ModelBalance {
        provider: "deepseek".into(),
        available: body.is_available,
        amount: balance
            .as_ref()
            .map(|value| value.total_balance.clone())
            .unwrap_or_default(),
        cash_amount: balance
            .as_ref()
            .map(|value| value.topped_up_balance.clone())
            .unwrap_or_default(),
        granted_amount: balance
            .as_ref()
            .map(|value| value.granted_balance.clone())
            .unwrap_or_default(),
        currency: balance
            .map(|value| value.currency)
            .unwrap_or_else(|| "CNY".into()),
        fetched_at: Utc::now().to_rfc3339(),
        message: String::new(),
    })
}

type HmacSha256 = Hmac<Sha256>;

fn sha256_hex(value: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(value.as_ref()))
}

fn hmac_hex(secret: &[u8], value: &str) -> Result<String, String> {
    let mut mac = HmacSha256::new_from_slice(secret)
        .map_err(|error| format!("无法准备阿里云签名：{error}"))?;
    mac.update(value.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

fn aliyun_headers(
    access_key_id: &str,
    access_key_secret: &str,
    date: &str,
    nonce: &str,
) -> Result<HeaderMap, String> {
    let payload_hash = sha256_hex("");
    let mut canonical_headers = BTreeMap::new();
    canonical_headers.insert(
        "content-type",
        "application/json; charset=utf-8".to_string(),
    );
    canonical_headers.insert("host", "business.aliyuncs.com".to_string());
    canonical_headers.insert("x-acs-action", "QueryAccountBalance".to_string());
    canonical_headers.insert("x-acs-content-sha256", payload_hash.clone());
    canonical_headers.insert("x-acs-date", date.to_string());
    canonical_headers.insert("x-acs-signature-nonce", nonce.to_string());
    canonical_headers.insert("x-acs-version", "2017-12-14".to_string());
    let signed_headers = canonical_headers
        .keys()
        .copied()
        .collect::<Vec<_>>()
        .join(";");
    let canonical_header_text = canonical_headers
        .iter()
        .map(|(key, value)| format!("{key}:{value}\n"))
        .collect::<String>();
    let canonical_request =
        format!("POST\n/\n\n{canonical_header_text}\n{signed_headers}\n{payload_hash}");
    let algorithm = "ACS3-HMAC-SHA256";
    let string_to_sign = format!("{algorithm}\n{}", sha256_hex(canonical_request));
    let signature = hmac_hex(access_key_secret.as_bytes(), &string_to_sign)?;
    let authorization = format!(
        "{algorithm} Credential={access_key_id},SignedHeaders={signed_headers},Signature={signature}"
    );
    let mut headers = HeaderMap::new();
    for (key, value) in canonical_headers {
        headers.insert(
            reqwest::header::HeaderName::from_bytes(key.as_bytes())
                .map_err(|error| error.to_string())?,
            value
                .parse()
                .map_err(|error: reqwest::header::InvalidHeaderValue| error.to_string())?,
        );
    }
    headers.insert(
        "authorization",
        authorization
            .parse()
            .map_err(|error: reqwest::header::InvalidHeaderValue| error.to_string())?,
    );
    Ok(headers)
}

#[tauri::command]
pub async fn qwen_fetch_balance() -> Result<ModelBalance, String> {
    let access_key_id = read_secret("aliyun_access_key_id")?;
    let access_key_secret = read_secret("aliyun_access_key_secret")?;
    let date = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let nonce = uuid::Uuid::new_v4().to_string();
    let headers = aliyun_headers(&access_key_id, &access_key_secret, &date, &nonce)?;
    let response = reqwest::Client::new()
        .post("https://business.aliyuncs.com/")
        .headers(headers)
        .body("")
        .send()
        .await
        .map_err(|error| format!("无法连接阿里云账户余额接口：{error}"))?;
    let status = response.status();
    let body = response
        .json::<Value>()
        .await
        .map_err(|error| format!("阿里云余额数据无法解析：{error}"))?;
    if !status.is_success() || body.get("Success").and_then(Value::as_bool) == Some(false) {
        let message = body
            .get("Message")
            .and_then(Value::as_str)
            .unwrap_or("请检查 AccessKey 和只读账单权限");
        return Err(format!("阿里云余额请求失败：{message}"));
    }
    let data = body.get("Data").unwrap_or(&Value::Null);
    let value = |key: &str| {
        data.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    Ok(ModelBalance {
        provider: "qwen".into(),
        available: true,
        amount: value("AvailableAmount"),
        cash_amount: value("AvailableCashAmount"),
        granted_amount: value("AvailableCredit"),
        currency: data
            .get("Currency")
            .and_then(Value::as_str)
            .unwrap_or("CNY")
            .to_string(),
        fetched_at: Utc::now().to_rfc3339(),
        message: "阿里云账户余额；并非 Qwen 独立钱包".into(),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QwenUsageRow {
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    total_tokens: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QwenUsageSnapshot {
    provider: String,
    rows: Vec<QwenUsageRow>,
    fetched_at: String,
    message: String,
}

#[derive(Debug, Deserialize)]
struct PrometheusResponse {
    status: String,
    data: Option<PrometheusData>,
    #[serde(default)]
    error: String,
}

#[derive(Debug, Deserialize)]
struct PrometheusData {
    #[serde(default)]
    result: Vec<PrometheusSeries>,
}

#[derive(Debug, Deserialize)]
struct PrometheusSeries {
    #[serde(default)]
    metric: HashMap<String, String>,
    #[serde(default)]
    values: Vec<(Value, Value)>,
}

#[derive(Default)]
struct UsageAccumulator {
    input: f64,
    output: f64,
    total: f64,
}

fn qwen_monitor_url(value: &str) -> Result<Url, String> {
    let mut url =
        Url::parse(value.trim()).map_err(|_| "Qwen 监控 HTTP API 地址格式不正确".to_string())?;
    let host = url
        .host_str()
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "Qwen 监控地址缺少域名".to_string())?;
    if url.scheme() != "https"
        || (!host.ends_with(".aliyuncs.com") && !host.ends_with(".aliyun.com"))
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("仅允许使用阿里云控制台提供的 HTTPS Prometheus 地址".into());
    }
    url.set_query(None);
    url.set_fragment(None);
    if !url
        .path()
        .trim_end_matches('/')
        .ends_with("/api/v1/query_range")
    {
        let path = format!("{}/api/v1/query_range", url.path().trim_end_matches('/'));
        url.set_path(&path);
    }
    Ok(url)
}

fn parse_monitor_range(start: &str, end: &str) -> Result<(String, String), String> {
    let start_value = chrono::DateTime::parse_from_rfc3339(start)
        .map_err(|_| "监控开始时间格式不正确".to_string())?;
    let end_value = chrono::DateTime::parse_from_rfc3339(end)
        .map_err(|_| "监控结束时间格式不正确".to_string())?;
    let duration = end_value.signed_duration_since(start_value);
    if duration <= chrono::Duration::zero() || duration > chrono::Duration::days(31) {
        return Err("Qwen 监控时间范围需要在 1 到 31 天内".into());
    }
    Ok((start_value.to_rfc3339(), end_value.to_rfc3339()))
}

fn prometheus_number(value: &Value) -> Option<f64> {
    value
        .as_str()
        .and_then(|text| text.parse::<f64>().ok())
        .or_else(|| value.as_f64())
        .filter(|number| number.is_finite() && *number >= 0.0)
}

fn as_token_count(value: f64) -> u64 {
    value.round().clamp(0.0, u64::MAX as f64) as u64
}

#[tauri::command]
pub async fn qwen_fetch_monitor_usage(
    start: String,
    end: String,
) -> Result<QwenUsageSnapshot, String> {
    let endpoint = qwen_monitor_url(&read_secret("qwen_monitor_credential")?)?;
    let (start, end) = parse_monitor_range(&start, &end)?;
    let access_key_id = read_secret("aliyun_access_key_id")?;
    let access_key_secret = read_secret("aliyun_access_key_secret")?;
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("无法准备 Qwen 监控请求：{error}"))?
        .get(endpoint)
        .basic_auth(access_key_id, Some(access_key_secret))
        .header("Accept", "application/json")
        .query(&[
            ("query", "model_usage"),
            ("start", start.as_str()),
            ("end", end.as_str()),
            ("step", "3600s"),
        ])
        .send()
        .await
        .map_err(|error| format!("无法连接 Qwen 高级监控：{error}"))?;
    let status = response.status();
    let body = response
        .json::<PrometheusResponse>()
        .await
        .map_err(|error| format!("Qwen 监控数据无法解析：{error}"))?;
    if !status.is_success() || body.status != "success" {
        let detail = if body.error.is_empty() {
            "请检查高级监控地址、AccessKey 权限与所属账号"
        } else {
            body.error.as_str()
        };
        return Err(format!("Qwen 高级监控请求失败：{detail}"));
    }

    let mut grouped = BTreeMap::<String, UsageAccumulator>::new();
    for series in body.data.map(|value| value.result).unwrap_or_default() {
        let model = series
            .metric
            .get("model")
            .filter(|value| !value.trim().is_empty())
            .cloned()
            .unwrap_or_else(|| "未命名模型".into());
        let usage_type = series
            .metric
            .get("usage_type")
            .map(String::as_str)
            .unwrap_or("total_tokens");
        let amount = series
            .values
            .iter()
            .filter_map(|(_, value)| prometheus_number(value))
            .sum::<f64>();
        let entry = grouped.entry(model).or_default();
        match usage_type {
            "input_tokens" => entry.input += amount,
            "output_tokens" => entry.output += amount,
            "total_tokens" => entry.total += amount,
            _ => {}
        }
    }
    let mut rows = grouped
        .into_iter()
        .map(|(model, value)| QwenUsageRow {
            model,
            input_tokens: as_token_count(value.input),
            output_tokens: as_token_count(value.output),
            total_tokens: as_token_count(if value.total > 0.0 {
                value.total
            } else {
                value.input + value.output
            }),
        })
        .filter(|row| row.total_tokens > 0)
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| right.total_tokens.cmp(&left.total_tokens));
    Ok(QwenUsageSnapshot {
        provider: "qwen".into(),
        message: if rows.is_empty() {
            "所选时间范围内没有可用的 Token 监控数据。".into()
        } else {
            "数据来自阿里云百炼高级监控。".into()
        },
        rows,
        fetched_at: Utc::now().to_rfc3339(),
    })
}

#[cfg(test)]
mod tests {
    use super::{aliyun_headers, parse_monitor_range, qwen_monitor_url, valid_github_segment};

    #[test]
    fn validates_repository_path_segments() {
        assert!(valid_github_segment("personal-knowledge_blog.rs"));
        assert!(!valid_github_segment("owner/name"));
        assert!(!valid_github_segment(""));
    }

    #[test]
    fn aliyun_signature_is_deterministic() {
        let first =
            aliyun_headers("test-id", "test-secret", "2026-08-21T00:00:00Z", "nonce").unwrap();
        let second =
            aliyun_headers("test-id", "test-secret", "2026-08-21T00:00:00Z", "nonce").unwrap();
        assert_eq!(first.get("authorization"), second.get("authorization"));
        assert!(first
            .get("authorization")
            .unwrap()
            .to_str()
            .unwrap()
            .contains("Credential=test-id"));
    }

    #[test]
    fn restricts_qwen_monitor_endpoint_and_range() {
        let url = qwen_monitor_url("https://cn-beijing.arms.aliyuncs.com/prom/abc").unwrap();
        assert!(url.path().ends_with("/api/v1/query_range"));
        assert!(qwen_monitor_url("https://example.com/prom/abc").is_err());
        assert!(parse_monitor_range("2026-08-01T00:00:00Z", "2026-08-21T23:59:59Z").is_ok());
        assert!(parse_monitor_range("2026-01-01T00:00:00Z", "2026-08-21T23:59:59Z").is_err());
    }
}

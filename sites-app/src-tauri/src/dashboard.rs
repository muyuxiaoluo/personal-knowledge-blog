use chrono::{NaiveDate, Utc};
use reqwest::{
    header::{ETAG, IF_NONE_MATCH},
    StatusCode,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
const AIHOT_HOME: &str = "https://aihot.news";
const OPEN_METEO_HOME: &str = "https://open-meteo.com";
const MORNING_BRIEF_HOME: &str = "https://60s-static-host.vercel.app";
const NOMINATIM_SEARCH: &str = "https://nominatim.openstreetmap.org/search";
const SEARCH_CACHE_AGE: Duration = Duration::from_secs(24 * 60 * 60);

static NOMINATIM_LAST_REQUEST: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
static NOMINATIM_CACHE: OnceLock<Mutex<HashMap<String, (Instant, Vec<CitySuggestion>)>>> =
    OnceLock::new();

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardFetchResult<T> {
    value: Option<T>,
    not_modified: bool,
    etag: String,
    fetched_at: String,
    max_age_seconds: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardLocation {
    name: String,
    admin1: String,
    #[serde(default)]
    admin2: String,
    #[serde(default)]
    admin3: String,
    #[serde(default)]
    admin4: String,
    country: String,
    latitude: f64,
    longitude: f64,
    timezone: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CitySuggestion {
    id: i64,
    name: String,
    admin1: String,
    admin2: String,
    admin3: String,
    admin4: String,
    country: String,
    latitude: f64,
    longitude: f64,
    timezone: String,
    feature_code: String,
    kind_label: String,
    provider_label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherCurrent {
    time: String,
    temperature: f64,
    apparent_temperature: f64,
    weather_code: i32,
    wind_speed: f64,
    is_day: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherHour {
    time: String,
    precipitation_probability: f64,
    precipitation: f64,
    rain: f64,
    showers: f64,
    weather_code: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherDay {
    date: String,
    weather_code: i32,
    temperature_max: f64,
    temperature_min: f64,
    precipitation_probability_max: f64,
    precipitation_sum: f64,
    sunrise: String,
    sunset: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherSnapshot {
    location: DashboardLocation,
    current: WeatherCurrent,
    hourly: Vec<WeatherHour>,
    daily: Vec<WeatherDay>,
    attribution: Attribution,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiBriefItem {
    id: String,
    title: String,
    summary: String,
    reason: String,
    source_name: String,
    category: String,
    published_at: String,
    score: f64,
    original_url: String,
    aihot_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiHotTopic {
    id: String,
    title: String,
    summary: String,
    score: f64,
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDailyBrief {
    date: String,
    lead: String,
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiBriefSnapshot {
    items: Vec<AiBriefItem>,
    topics: Vec<AiHotTopic>,
    daily: Option<AiDailyBrief>,
    attribution: Attribution,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MorningBriefSnapshot {
    date: String,
    news: Vec<String>,
    tip: String,
    source_url: String,
    image_url: String,
    published_at: String,
    attribution: Attribution,
}

#[derive(Debug, Serialize)]
struct Attribution {
    name: String,
    url: String,
}

#[derive(Debug, Deserialize)]
struct GeocodingResponse {
    #[serde(default)]
    results: Vec<GeocodingResult>,
}

#[derive(Debug, Deserialize)]
struct GeocodingResult {
    id: i64,
    name: String,
    latitude: f64,
    longitude: f64,
    timezone: String,
    #[serde(default)]
    country: String,
    #[serde(default)]
    admin1: String,
    #[serde(default)]
    admin2: String,
    #[serde(default)]
    admin3: String,
    #[serde(default)]
    admin4: String,
    #[serde(default)]
    feature_code: String,
    #[serde(default)]
    population: u64,
}

#[derive(Debug, Deserialize)]
struct NominatimResult {
    place_id: i64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    display_name: String,
    lat: String,
    lon: String,
    #[serde(default)]
    category: String,
    #[serde(default, rename = "type")]
    place_type: String,
    #[serde(default)]
    addresstype: String,
    #[serde(default)]
    address: Value,
}

#[derive(Debug, Deserialize)]
struct WeatherResponse {
    current: WeatherCurrentRaw,
    hourly: WeatherHourlyRaw,
    daily: WeatherDailyRaw,
}

#[derive(Debug, Deserialize)]
struct WeatherCurrentRaw {
    time: String,
    temperature_2m: f64,
    apparent_temperature: f64,
    weather_code: i32,
    wind_speed_10m: f64,
    is_day: i32,
}

#[derive(Debug, Deserialize)]
struct WeatherHourlyRaw {
    time: Vec<String>,
    precipitation_probability: Vec<f64>,
    precipitation: Vec<f64>,
    rain: Vec<f64>,
    showers: Vec<f64>,
    weather_code: Vec<i32>,
}

#[derive(Debug, Deserialize)]
struct WeatherDailyRaw {
    time: Vec<String>,
    weather_code: Vec<i32>,
    temperature_2m_max: Vec<f64>,
    temperature_2m_min: Vec<f64>,
    precipitation_probability_max: Vec<f64>,
    precipitation_sum: Vec<f64>,
    sunrise: Vec<String>,
    sunset: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct AiItemsResponse {
    #[serde(default)]
    items: Vec<AiItemRaw>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiItemRaw {
    id: String,
    title: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    published_at: String,
    #[serde(default)]
    score: f64,
    #[serde(default)]
    source: AiSourceRaw,
    #[serde(default)]
    links: AiLinksRaw,
}

#[derive(Debug, Default, Deserialize)]
struct AiSourceRaw {
    #[serde(default)]
    name: String,
}

#[derive(Debug, Default, Deserialize)]
struct AiLinksRaw {
    #[serde(default)]
    aihot: String,
    #[serde(default)]
    original: String,
}

#[derive(Debug, Deserialize)]
struct AiDailyResponse {
    report: AiDailyReportRaw,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiDailyReportRaw {
    date: String,
    #[serde(default)]
    lead: Option<AiDailyLeadRaw>,
    #[serde(default)]
    links: AiLinksRaw,
    #[serde(default)]
    sections: Vec<AiDailySectionRaw>,
}

#[derive(Debug, Deserialize)]
struct AiDailySectionRaw {
    #[serde(default)]
    items: Vec<AiDailyItemRaw>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum AiDailyLeadRaw {
    Text(String),
    Story {
        #[serde(rename = "leadParagraph")]
        paragraph: String,
    },
}

#[derive(Debug, Deserialize)]
struct AiDailyItemRaw {
    #[serde(default)]
    summary: String,
}

#[derive(Debug, Deserialize)]
struct MorningBriefRaw {
    date: String,
    news: Vec<String>,
    #[serde(default)]
    tip: String,
    #[serde(default)]
    image: String,
    #[serde(default)]
    link: String,
    #[serde(default)]
    updated: String,
}

struct JsonResponse<T> {
    value: Option<T>,
    not_modified: bool,
    etag: String,
}

#[tauri::command]
pub async fn dashboard_search_cities(query: String) -> Result<Vec<CitySuggestion>, String> {
    let normalized = query.trim();
    if normalized.is_empty() || normalized.chars().count() > 80 {
        return Err("请输入有效的城市名称".into());
    }
    let response: GeocodingResponse = request_json(
        client()?
            .get("https://geocoding-api.open-meteo.com/v1/search")
            .query(&[
                ("name", normalized),
                ("count", "20"),
                ("language", "zh"),
                ("format", "json"),
            ]),
        None,
        false,
    )
    .await?
    .value
    .ok_or_else(|| "城市查询没有返回数据".to_string())?;
    let open_meteo = normalize_city_results(normalized, response.results);
    if !open_meteo.is_empty() {
        return Ok(open_meteo);
    }
    search_nominatim(normalized).await
}

async fn search_nominatim(query: &str) -> Result<Vec<CitySuggestion>, String> {
    let cache_key = query.trim().to_lowercase();
    let cache = NOMINATIM_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((cached_at, value)) = cache.lock().await.get(&cache_key) {
        if cached_at.elapsed() < SEARCH_CACHE_AGE {
            return Ok(value.clone());
        }
    }

    let request_slot = NOMINATIM_LAST_REQUEST.get_or_init(|| Mutex::new(None));
    let mut last_request = request_slot.lock().await;
    if let Some(previous) = *last_request {
        let elapsed = previous.elapsed();
        if elapsed < Duration::from_secs(1) {
            tokio::time::sleep(Duration::from_secs(1) - elapsed).await;
        }
    }
    *last_request = Some(Instant::now());
    drop(last_request);

    let response: JsonResponse<Vec<NominatimResult>> = request_json(
        client()?.get(NOMINATIM_SEARCH).query(&[
            ("q", query),
            ("format", "jsonv2"),
            ("addressdetails", "1"),
            ("limit", "10"),
            ("accept-language", "zh-CN,zh,en"),
        ]),
        None,
        false,
    )
    .await?;
    let value = normalize_nominatim_results(
        response
            .value
            .ok_or_else(|| "区县查询没有返回数据".to_string())?,
    );
    let mut cache = cache.lock().await;
    cache.retain(|_, (cached_at, _)| cached_at.elapsed() < SEARCH_CACHE_AGE);
    if cache.len() >= 50 {
        cache.clear();
    }
    cache.insert(cache_key, (Instant::now(), value.clone()));
    Ok(value)
}

fn normalize_city_results(query: &str, results: Vec<GeocodingResult>) -> Vec<CitySuggestion> {
    let exact_name = query
        .split([',', '，'])
        .next()
        .unwrap_or(query)
        .trim()
        .to_lowercase();
    let mut ranked: Vec<_> = results
        .into_iter()
        .filter(|item| {
            !item.name.trim().is_empty()
                && item.latitude.is_finite()
                && item.longitude.is_finite()
                && valid_timezone(&item.timezone)
        })
        .map(|item| {
            let exact = u8::from(item.name.trim().to_lowercase() == exact_name);
            let rank = city_feature_rank(&item.feature_code);
            let population = item.population;
            let suggestion = CitySuggestion {
                id: item.id,
                name: item.name.trim().to_string(),
                admin1: item.admin1.trim().to_string(),
                admin2: item.admin2.trim().to_string(),
                admin3: item.admin3.trim().to_string(),
                admin4: item.admin4.trim().to_string(),
                country: item.country.trim().to_string(),
                latitude: item.latitude,
                longitude: item.longitude,
                timezone: item.timezone,
                feature_code: item.feature_code.clone(),
                kind_label: city_kind_label(&item.feature_code).to_string(),
                provider_label: "Open-Meteo / GeoNames".into(),
            };
            (exact, rank, population, suggestion)
        })
        .collect();
    ranked.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| right.1.cmp(&left.1))
            .then_with(|| right.2.cmp(&left.2))
            .then_with(|| left.3.name.cmp(&right.3.name))
    });

    let has_primary_exact = ranked
        .iter()
        .any(|(exact, rank, _, _)| *exact == 1 && *rank >= 86);
    let mut seen = HashSet::new();
    ranked
        .into_iter()
        .filter_map(|(exact, rank, _, suggestion)| {
            if has_primary_exact && exact == 1 && rank < 86 {
                return None;
            }
            let key = [
                suggestion.name.as_str(),
                suggestion.admin4.as_str(),
                suggestion.admin3.as_str(),
                suggestion.admin2.as_str(),
                suggestion.admin1.as_str(),
                suggestion.country.as_str(),
            ]
            .join("|")
            .to_lowercase();
            seen.insert(key).then_some(suggestion)
        })
        .take(10)
        .collect()
}

fn normalize_nominatim_results(results: Vec<NominatimResult>) -> Vec<CitySuggestion> {
    let mut seen = HashSet::new();
    results
        .into_iter()
        .filter_map(|item| {
            let latitude = item.lat.parse::<f64>().ok()?;
            let longitude = item.lon.parse::<f64>().ok()?;
            if !latitude.is_finite()
                || !longitude.is_finite()
                || !(-90.0..=90.0).contains(&latitude)
                || !(-180.0..=180.0).contains(&longitude)
            {
                return None;
            }
            let mut name = item.name.trim().to_string();
            if name.is_empty() {
                name = first_display_part(&item.display_name);
            }
            if name.is_empty() {
                return None;
            }
            let country = address_part(&item.address, &["country"]);
            let country_code = address_part(&item.address, &["country_code"]);
            let admin1 = address_part(&item.address, &["state", "province", "region"]);
            let mut admin2 =
                address_part(&item.address, &["municipality", "county", "city", "town"]);
            if admin2.eq_ignore_ascii_case(&name) {
                admin2.clear();
            }
            let admin3 = address_part(
                &item.address,
                &["city_district", "borough", "suburb", "district"],
            );
            let admin4 = address_part(&item.address, &["town", "village"]);
            if admin2.is_empty() {
                admin2 = display_admin_part(&item.display_name, &name, &admin1, &country);
            }
            let key = [
                name.as_str(),
                admin4.as_str(),
                admin3.as_str(),
                admin2.as_str(),
                admin1.as_str(),
                country.as_str(),
            ]
            .join("|")
            .to_lowercase();
            if !seen.insert(key) {
                return None;
            }
            Some(CitySuggestion {
                id: item.place_id,
                kind_label: nominatim_kind_label(
                    &name,
                    &item.category,
                    &item.place_type,
                    &item.addresstype,
                )
                .into(),
                feature_code: format!("OSM:{}", item.place_type),
                provider_label: "OpenStreetMap Nominatim".into(),
                name,
                admin1,
                admin2,
                admin3,
                admin4,
                country,
                latitude,
                longitude,
                timezone: if country_code.eq_ignore_ascii_case("cn") {
                    "Asia/Shanghai".into()
                } else {
                    "auto".into()
                },
            })
        })
        .take(10)
        .collect()
}

fn first_display_part(value: &str) -> String {
    value
        .split(',')
        .next()
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn address_part(address: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| address.get(*key).and_then(Value::as_str))
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn display_admin_part(display_name: &str, name: &str, admin1: &str, country: &str) -> String {
    display_name
        .split(',')
        .map(str::trim)
        .find(|part| {
            !part.is_empty()
                && !part.eq_ignore_ascii_case(name)
                && !part.eq_ignore_ascii_case(admin1)
                && !part.eq_ignore_ascii_case(country)
                && !part.chars().all(|character| character.is_ascii_digit())
        })
        .unwrap_or_default()
        .to_string()
}

fn nominatim_kind_label(
    name: &str,
    category: &str,
    place_type: &str,
    address_type: &str,
) -> &'static str {
    if name.ends_with('区') || name.ends_with('县') || name.ends_with('旗') {
        return "区县";
    }
    if name.ends_with('镇') || name.ends_with('乡') {
        return "乡镇";
    }
    if category == "boundary" && place_type == "administrative" {
        return "行政区域";
    }
    match address_type {
        "city" | "municipality" => "城市",
        "town" | "village" => "城镇地点",
        _ => "地点",
    }
}

fn city_feature_rank(value: &str) -> u8 {
    match value {
        "PPLC" => 100,
        "PPLA" => 98,
        "PPLA2" => 96,
        "ADM2" => 94,
        "PPLA3" => 92,
        "ADM3" => 90,
        "PPLA4" => 88,
        "ADM4" => 86,
        code if code.starts_with("PPL") => 70,
        code if code.starts_with("ADM") => 60,
        _ => 20,
    }
}

fn city_kind_label(value: &str) -> &'static str {
    match value {
        "PPLC" => "首都",
        "PPLA" => "省会城市",
        "PPLA2" => "地级城市",
        "ADM2" => "地级行政区",
        "PPLA3" => "区县驻地",
        "ADM3" => "区县",
        "PPLA4" => "乡镇驻地",
        "ADM4" => "乡镇",
        code if code.starts_with("PPL") => "城镇地点",
        code if code.starts_with("ADM") => "行政区域",
        _ => "地点",
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn dashboard_fetch_weather(
    location: DashboardLocation,
    etag: Option<String>,
) -> Result<DashboardFetchResult<WeatherSnapshot>, String> {
    validate_location(&location)?;
    let response: JsonResponse<WeatherResponse> = request_json(
        client()?.get("https://api.open-meteo.com/v1/forecast").query(&[
            ("latitude", location.latitude.to_string()),
            ("longitude", location.longitude.to_string()),
            ("current", "temperature_2m,apparent_temperature,is_day,weather_code,wind_speed_10m".into()),
            ("hourly", "precipitation_probability,precipitation,rain,showers,weather_code".into()),
            ("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset".into()),
            ("forecast_days", "3".into()),
            ("timezone", location.timezone.clone()),
        ]),
        etag.as_deref(),
        false,
    )
    .await?;
    let fetched_at = Utc::now().to_rfc3339();
    if response.not_modified {
        return Ok(DashboardFetchResult {
            value: None,
            not_modified: true,
            etag: response.etag,
            fetched_at,
            max_age_seconds: 2_700,
        });
    }
    let value = normalize_weather(
        location,
        response
            .value
            .ok_or_else(|| "天气服务没有返回数据".to_string())?,
    )?;
    Ok(DashboardFetchResult {
        value: Some(value),
        not_modified: false,
        etag: response.etag,
        fetched_at,
        max_age_seconds: 2_700,
    })
}

#[tauri::command]
pub async fn dashboard_fetch_ai_brief(
    etag: Option<String>,
) -> Result<DashboardFetchResult<AiBriefSnapshot>, String> {
    fetch_ai_brief(&client()?, AIHOT_HOME, etag.as_deref()).await
}

async fn fetch_ai_brief(
    client: &reqwest::Client,
    home: &str,
    etag: Option<&str>,
) -> Result<DashboardFetchResult<AiBriefSnapshot>, String> {
    let items_response: JsonResponse<AiItemsResponse> = request_json(
        client.get(format!("{home}/api/v1/items")).query(&[
            ("mode", "selected"),
            ("window", "24h"),
            ("limit", "20"),
        ]),
        etag,
        false,
    )
    .await?;
    let fetched_at = Utc::now().to_rfc3339();
    if items_response.not_modified {
        return Ok(DashboardFetchResult {
            value: None,
            not_modified: true,
            etag: items_response.etag,
            fetched_at,
            max_age_seconds: 1_800,
        });
    }
    let mut warnings = Vec::new();
    let topics_response: Option<Value> =
        request_json::<Value>(client.get(format!("{home}/api/v1/hot-topics")), None, false)
            .await
            .map_err(|error| warnings.push(format!("热点专题：{error}")))
            .ok()
            .and_then(|response| response.value);
    let daily_response: Option<AiDailyResponse> = request_json::<AiDailyResponse>(
        client.get(format!("{home}/api/v1/dailies/latest")),
        None,
        false,
    )
    .await
    .map_err(|error| warnings.push(format!("AI 日报：{error}")))
    .ok()
    .and_then(|response| response.value);
    let mut value = normalize_ai_brief(
        items_response
            .value
            .ok_or_else(|| "AIHOT 没有返回精选资讯".to_string())?,
        topics_response.as_ref(),
        daily_response,
    )?;
    value.warnings.extend(warnings);
    Ok(DashboardFetchResult {
        value: Some(value),
        not_modified: false,
        etag: items_response.etag,
        fetched_at,
        max_age_seconds: 1_800,
    })
}

#[tauri::command]
pub async fn dashboard_fetch_morning_brief(
    date: String,
    etag: Option<String>,
) -> Result<DashboardFetchResult<MorningBriefSnapshot>, String> {
    if NaiveDate::parse_from_str(&date, "%Y-%m-%d").is_err() {
        return Err("早报日期格式不正确".into());
    }
    let url = format!("https://60s-static.viki.moe/60s/{date}.json");
    let response: JsonResponse<MorningBriefRaw> =
        request_json(client()?.get(url), etag.as_deref(), true).await?;
    let fetched_at = Utc::now().to_rfc3339();
    if response.not_modified {
        return Ok(DashboardFetchResult {
            value: None,
            not_modified: true,
            etag: response.etag,
            fetched_at,
            max_age_seconds: 43_200,
        });
    }
    let Some(value) = response.value else {
        return Ok(DashboardFetchResult {
            value: None,
            not_modified: false,
            etag: response.etag,
            fetched_at,
            max_age_seconds: 3_600,
        });
    };
    let value = normalize_morning_brief(&date, value)?;
    Ok(DashboardFetchResult {
        value: Some(value),
        not_modified: false,
        etag: response.etag,
        fetched_at,
        max_age_seconds: 43_200,
    })
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(
            "life-strategy-library/0.7 (+https://github.com/muyuxiaoluo/personal-knowledge-blog)",
        )
        .build()
        .map_err(|error| format!("无法准备晨间数据请求：{error}"))
}

async fn request_json<T: DeserializeOwned>(
    mut request: reqwest::RequestBuilder,
    etag: Option<&str>,
    allow_not_found: bool,
) -> Result<JsonResponse<T>, String> {
    if let Some(value) = etag.filter(|value| !value.is_empty() && value.len() <= 200) {
        request = request.header(IF_NONE_MATCH, value);
    }
    let (client, request) = request.build_split();
    let request = request.map_err(|error| format!("无法准备晨间数据请求：{error}"))?;
    let source = format!(
        "{}{}",
        request.url().host_str().unwrap_or_default(),
        request.url().path()
    );
    let response = client
        .execute(request)
        .await
        .map_err(|error| format!("无法连接晨间数据源（{source}）：{error}"))?;
    let status = response.status();
    let response_etag = response
        .headers()
        .get(ETAG)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    if status == StatusCode::NOT_MODIFIED {
        return Ok(JsonResponse {
            value: None,
            not_modified: true,
            etag: response_etag,
        });
    }
    if allow_not_found && status == StatusCode::NOT_FOUND {
        return Ok(JsonResponse {
            value: None,
            not_modified: false,
            etag: response_etag,
        });
    }
    if !status.is_success() {
        return Err(format!("晨间数据源暂时不可用（{source}，HTTP {status}）"));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_JSON_BYTES as u64)
    {
        return Err("晨间数据源返回内容过大".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("无法读取晨间数据：{error}"))?;
    if bytes.len() > MAX_JSON_BYTES {
        return Err("晨间数据源返回内容过大".into());
    }
    let value = serde_json::from_slice::<T>(&bytes)
        .map_err(|error| format!("晨间数据格式无法解析（{source}）：{error}"))?;
    Ok(JsonResponse {
        value: Some(value),
        not_modified: false,
        etag: response_etag,
    })
}

fn normalize_weather(
    location: DashboardLocation,
    value: WeatherResponse,
) -> Result<WeatherSnapshot, String> {
    let hourly_lengths = [
        value.hourly.time.len(),
        value.hourly.precipitation_probability.len(),
        value.hourly.precipitation.len(),
        value.hourly.rain.len(),
        value.hourly.showers.len(),
        value.hourly.weather_code.len(),
    ];
    let daily_lengths = [
        value.daily.time.len(),
        value.daily.weather_code.len(),
        value.daily.temperature_2m_max.len(),
        value.daily.temperature_2m_min.len(),
        value.daily.precipitation_probability_max.len(),
        value.daily.precipitation_sum.len(),
        value.daily.sunrise.len(),
        value.daily.sunset.len(),
    ];
    if hourly_lengths
        .iter()
        .any(|length| *length != hourly_lengths[0])
        || hourly_lengths[0] == 0
    {
        return Err("天气逐小时数据不完整".into());
    }
    if daily_lengths
        .iter()
        .any(|length| *length != daily_lengths[0])
        || daily_lengths[0] < 3
    {
        return Err("天气三日预报数据不完整".into());
    }
    if value.current.is_day != 0 && value.current.is_day != 1
        || !value.current.temperature_2m.is_finite()
        || !value.current.apparent_temperature.is_finite()
        || !value.current.wind_speed_10m.is_finite()
        || value
            .hourly
            .precipitation_probability
            .iter()
            .chain(value.daily.precipitation_probability_max.iter())
            .any(|value| !value.is_finite() || !(0.0..=100.0).contains(value))
        || value
            .hourly
            .precipitation
            .iter()
            .chain(value.hourly.rain.iter())
            .chain(value.hourly.showers.iter())
            .chain(value.daily.precipitation_sum.iter())
            .any(|value| !value.is_finite() || *value < 0.0)
    {
        return Err("天气服务返回了错误字段".into());
    }
    let hourly = (0..hourly_lengths[0])
        .map(|index| WeatherHour {
            time: value.hourly.time[index].clone(),
            precipitation_probability: value.hourly.precipitation_probability[index],
            precipitation: value.hourly.precipitation[index],
            rain: value.hourly.rain[index],
            showers: value.hourly.showers[index],
            weather_code: value.hourly.weather_code[index],
        })
        .collect();
    let daily = (0..daily_lengths[0].min(3))
        .map(|index| WeatherDay {
            date: value.daily.time[index].clone(),
            weather_code: value.daily.weather_code[index],
            temperature_max: value.daily.temperature_2m_max[index],
            temperature_min: value.daily.temperature_2m_min[index],
            precipitation_probability_max: value.daily.precipitation_probability_max[index],
            precipitation_sum: value.daily.precipitation_sum[index],
            sunrise: value.daily.sunrise[index].clone(),
            sunset: value.daily.sunset[index].clone(),
        })
        .collect();
    Ok(WeatherSnapshot {
        location,
        current: WeatherCurrent {
            time: value.current.time,
            temperature: value.current.temperature_2m,
            apparent_temperature: value.current.apparent_temperature,
            weather_code: value.current.weather_code,
            wind_speed: value.current.wind_speed_10m,
            is_day: value.current.is_day == 1,
        },
        hourly,
        daily,
        attribution: Attribution {
            name: "Open-Meteo".into(),
            url: OPEN_METEO_HOME.into(),
        },
    })
}

fn map_ai_item(item: AiItemRaw) -> AiBriefItem {
    AiBriefItem {
        id: item.id,
        title: item.title,
        summary: item.summary,
        reason: item.reason,
        source_name: item.source.name,
        category: item.category,
        published_at: item.published_at,
        score: item.score,
        original_url: safe_https_url(&item.links.original).unwrap_or_default(),
        aihot_url: safe_aihot_url(&item.links.aihot).unwrap_or_else(|| AIHOT_HOME.into()),
    }
}

fn map_ai_topic(value: &Value) -> Option<AiHotTopic> {
    let title = value
        .get("title")
        .or_else(|| value.get("name"))?
        .as_str()?
        .trim();
    if title.is_empty() {
        return None;
    }
    let links = value.get("links");
    Some(AiHotTopic {
        id: value
            .get("id")
            .or_else(|| value.get("publicId"))
            .and_then(Value::as_str)
            .unwrap_or(title)
            .to_string(),
        title: title.to_string(),
        summary: value
            .get("summary")
            .or_else(|| value.get("description"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        score: value
            .get("score")
            .or_else(|| value.get("rankScore"))
            .and_then(Value::as_f64)
            .unwrap_or_default(),
        url: safe_aihot_url(
            links
                .and_then(|links| links.get("aihot"))
                .or_else(|| value.get("url"))
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .unwrap_or_else(|| AIHOT_HOME.into()),
    })
}

fn normalize_ai_brief(
    response: AiItemsResponse,
    topics_response: Option<&Value>,
    daily_response: Option<AiDailyResponse>,
) -> Result<AiBriefSnapshot, String> {
    let items: Vec<_> = response
        .items
        .into_iter()
        .filter(|item| !item.id.trim().is_empty() && !item.title.trim().is_empty())
        .map(map_ai_item)
        .collect();
    if items.is_empty() {
        return Err("AIHOT 没有返回可显示的精选资讯".into());
    }
    let topics = topics_response
        .and_then(|value| value.get("items"))
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(map_ai_topic).collect())
        .unwrap_or_default();
    let daily = daily_response.and_then(|value| {
        if NaiveDate::parse_from_str(&value.report.date, "%Y-%m-%d").is_err() {
            return None;
        }
        let fallback_lead = value
            .report
            .sections
            .iter()
            .flat_map(|section| section.items.iter())
            .find_map(|item| {
                (!item.summary.trim().is_empty()).then(|| item.summary.trim().to_string())
            })
            .unwrap_or_default();
        Some(AiDailyBrief {
            date: value.report.date,
            lead: value
                .report
                .lead
                .map(|lead| match lead {
                    AiDailyLeadRaw::Text(text) => text,
                    AiDailyLeadRaw::Story { paragraph } => paragraph,
                })
                .filter(|lead| !lead.trim().is_empty())
                .map(|lead| lead.trim().to_string())
                .unwrap_or(fallback_lead),
            url: safe_aihot_url(&value.report.links.aihot).unwrap_or_else(|| AIHOT_HOME.into()),
        })
    });
    Ok(AiBriefSnapshot {
        items,
        topics,
        daily,
        attribution: Attribution {
            name: "AIHOT".into(),
            url: AIHOT_HOME.into(),
        },
        warnings: Vec::new(),
    })
}

fn normalize_morning_brief(
    requested_date: &str,
    value: MorningBriefRaw,
) -> Result<MorningBriefSnapshot, String> {
    let news: Vec<_> = value
        .news
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect();
    if value.date != requested_date || news.is_empty() || news.len() > 30 {
        return Err("早报返回的数据不完整".into());
    }
    Ok(MorningBriefSnapshot {
        date: value.date,
        news: news.into_iter().take(15).collect(),
        tip: value.tip.trim().to_string(),
        source_url: safe_https_url(&value.link).unwrap_or_else(|| MORNING_BRIEF_HOME.into()),
        image_url: safe_https_url(&value.image).unwrap_or_default(),
        published_at: value.updated,
        attribution: Attribution {
            name: "每天 60 秒读懂世界".into(),
            url: MORNING_BRIEF_HOME.into(),
        },
    })
}

fn safe_https_url(value: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(value).ok()?;
    (parsed.scheme() == "https" && parsed.host_str().is_some()).then(|| parsed.to_string())
}

fn safe_aihot_url(value: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(value).ok()?;
    (parsed.scheme() == "https"
        && matches!(parsed.host_str(), Some("aihot.news" | "aihot.virxact.com")))
    .then(|| parsed.to_string())
}

fn validate_location(location: &DashboardLocation) -> Result<(), String> {
    if location.name.trim().is_empty()
        || !location.latitude.is_finite()
        || !location.longitude.is_finite()
        || !(-90.0..=90.0).contains(&location.latitude)
        || !(-180.0..=180.0).contains(&location.longitude)
        || !valid_timezone(&location.timezone)
    {
        return Err("天气城市信息不正确".into());
    }
    Ok(())
}

fn valid_timezone(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '/' | '_' | '-' | '+')
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn serve(responses: Vec<String>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let deadline = Instant::now() + Duration::from_secs(10);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline, "request did not arrive");
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    assert_eq!(stream.read(&mut byte).unwrap(), 1);
                    request.push(byte[0]);
                }
                requests.push(String::from_utf8(request).unwrap());
                stream.write_all(response.as_bytes()).unwrap();
            }
            requests
        });
        (address, handle)
    }

    fn json_response(body: &str) -> String {
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nETag: \"fixture\"\r\nConnection: close\r\n\r\n{body}", body.len())
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn follows_permanent_redirect_and_preserves_conditional_requests() {
        let (home, server) = serve(vec![
            "HTTP/1.1 301 Moved Permanently\r\nLocation: /moved\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
            json_response(r#"{"items":[]}"#),
            "HTTP/1.1 304 Not Modified\r\nETag: \"fixture\"\r\nConnection: close\r\n\r\n".into(),
        ]);
        runtime().block_on(async {
            let client = client().unwrap();
            let result = request_json::<Value>(client.get(&home), Some("\"old\""), false)
                .await
                .unwrap();
            assert_eq!(result.value.unwrap()["items"], serde_json::json!([]));
            assert_eq!(result.etag, "\"fixture\"");
            let result = request_json::<Value>(client.get(&home), Some("\"fixture\""), false)
                .await
                .unwrap();
            assert!(result.not_modified);
            assert!(result.value.is_none());
        });
        let requests = server.join().unwrap();
        assert!(requests[1].starts_with("GET /moved "));
        assert!(requests[1]
            .to_lowercase()
            .contains("if-none-match: \"old\""));
        assert!(requests[2]
            .to_lowercase()
            .contains("if-none-match: \"fixture\""));
    }

    #[test]
    fn limits_redirect_loops() {
        let (home, server) = serve(vec![
            "HTTP/1.1 301 Moved Permanently\r\nLocation: /loop\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(); 6
        ]);
        let error = runtime()
            .block_on(request_json::<Value>(
                client().unwrap().get(&home),
                None,
                false,
            ))
            .err()
            .unwrap();
        assert!(error.contains("无法连接晨间数据源"));
        assert_eq!(server.join().unwrap().len(), 6);
    }

    #[test]
    fn keeps_headlines_and_reports_optional_endpoint_failures() {
        let (home, server) = serve(vec![
            json_response(r#"{"items":[{"id":"1","title":"示例动态"}]}"#),
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .into(),
            json_response(r#"{"report":{"unexpected":true}}"#),
        ]);
        let result = runtime()
            .block_on(fetch_ai_brief(&client().unwrap(), &home, None))
            .unwrap();
        let snapshot = result.value.unwrap();
        assert_eq!(snapshot.items.len(), 1);
        assert!(snapshot.daily.is_none());
        assert_eq!(snapshot.warnings.len(), 2);
        assert!(snapshot.warnings[0].contains("/api/v1/hot-topics，HTTP 503"));
        assert!(snapshot.warnings[1].contains("AI 日报：晨间数据格式无法解析"));
        server.join().unwrap();
    }

    #[test]
    fn parses_daily_summary_items_without_headline_ids() {
        let (home, server) = serve(vec![
            json_response(
                r#"{"items":[{"id":"1","title":"示例动态","links":{"aihot":"https://aihot.news/items/1"}}]}"#,
            ),
            json_response(r#"{"items":[]}"#),
            json_response(
                r#"{"report":{"date":"2026-11-10","links":{"aihot":"https://aihot.news/daily/2026-11-10"},"sections":[{"items":[{"title":"日报条目","summary":"当天摘要"}]}]}}"#,
            ),
        ]);
        let result = runtime()
            .block_on(fetch_ai_brief(&client().unwrap(), &home, None))
            .unwrap();
        let snapshot = result.value.unwrap();
        assert_eq!(snapshot.items[0].aihot_url, "https://aihot.news/items/1");
        let daily = snapshot.daily.unwrap();
        assert_eq!(daily.lead, "当天摘要");
        assert_eq!(daily.url, "https://aihot.news/daily/2026-11-10");
        assert!(snapshot.warnings.is_empty());
        server.join().unwrap();
    }

    #[test]
    fn accepts_daily_lead_objects_text_and_summary_fallback() {
        for (lead, expected) in [
            (
                serde_json::json!({"title":"导语标题","leadParagraph":"对象导语"}),
                "对象导语",
            ),
            (serde_json::json!("文本导语"), "文本导语"),
            (Value::Null, "摘要兜底"),
        ] {
            let daily = serde_json::from_value(serde_json::json!({
                "report": {
                    "date": "2026-11-10", "lead": lead,
                    "sections": [{"items": [{"summary": "摘要兜底"}]}]
                }
            }))
            .unwrap();
            let items = serde_json::from_value(serde_json::json!({
                "items": [{"id":"1", "title":"示例动态"}]
            }))
            .unwrap();
            let result = normalize_ai_brief(items, None, Some(daily)).unwrap();
            assert_eq!(result.daily.unwrap().lead, expected);
        }
    }

    #[test]
    #[ignore = "访问真实公开数据源；手动执行 cargo test dashboard::tests::live_aihot_contract -- --ignored --nocapture"]
    fn live_aihot_contract() {
        let result = runtime().block_on(dashboard_fetch_ai_brief(None)).unwrap();
        let snapshot = result.value.unwrap();
        assert!(snapshot.warnings.is_empty(), "{:?}", snapshot.warnings);
        assert!(!snapshot.items.is_empty());
        let daily = snapshot.daily.expect("AIHOT 没有返回有效日报");
        assert!(daily.url.starts_with(AIHOT_HOME));
        assert!(snapshot
            .items
            .iter()
            .all(|item| item.aihot_url.starts_with(AIHOT_HOME)));
        println!(
            "AIHOT 可用：{} 条动态、{} 个专题，日报 {}（{}）",
            snapshot.items.len(),
            snapshot.topics.len(),
            daily.date,
            daily.url
        );
    }

    fn location() -> DashboardLocation {
        DashboardLocation {
            name: "上海".into(),
            admin1: "上海市".into(),
            admin2: String::new(),
            admin3: String::new(),
            admin4: String::new(),
            country: "中国".into(),
            latitude: 31.22,
            longitude: 121.45,
            timezone: "Asia/Shanghai".into(),
        }
    }

    fn weather_json() -> Value {
        serde_json::json!({
            "current": {
                "time": "2026-08-24T09:00", "temperature_2m": 29.1,
                "apparent_temperature": 31.0, "weather_code": 2,
                "wind_speed_10m": 8.0, "is_day": 1
            },
            "hourly": {
                "time": ["2026-08-24T09:00", "2026-08-24T10:00"],
                "precipitation_probability": [20, 60], "precipitation": [0, 0.2],
                "rain": [0, 0.2], "showers": [0, 0], "weather_code": [2, 61]
            },
            "daily": {
                "time": ["2026-08-24", "2026-08-25", "2026-08-26"],
                "weather_code": [2, 1, 61], "temperature_2m_max": [32, 33, 29],
                "temperature_2m_min": [25, 25, 23],
                "precipitation_probability_max": [60, 20, 80],
                "precipitation_sum": [0.2, 0, 4.1],
                "sunrise": ["2026-08-24T05:30", "2026-08-25T05:31", "2026-08-26T05:31"],
                "sunset": ["2026-08-24T18:25", "2026-08-25T18:24", "2026-08-26T18:22"]
            }
        })
    }

    fn geocoding_result(
        id: i64,
        name: &str,
        admin1: &str,
        admin2: &str,
        feature_code: &str,
        population: u64,
    ) -> GeocodingResult {
        GeocodingResult {
            id,
            name: name.into(),
            latitude: 30.67 + id as f64 / 10_000.0,
            longitude: 104.07,
            timezone: "Asia/Shanghai".into(),
            country: "中国".into(),
            admin1: admin1.into(),
            admin2: admin2.into(),
            admin3: String::new(),
            admin4: String::new(),
            feature_code: feature_code.into(),
            population,
        }
    }

    #[test]
    fn ranks_city_level_results_and_hides_unrelated_minor_same_name_places() {
        let results = normalize_city_results(
            "成都",
            vec![
                geocoding_result(2, "成都", "四川", "成都市", "PPL", 20_000),
                geocoding_result(4, "成都", "江西", "赣州市", "PPL", 2_000),
                geocoding_result(1, "成都", "四川", "成都市", "PPLA2", 20_000_000),
                geocoding_result(3, "武侯区", "四川", "成都市", "ADM3", 1_200_000),
            ],
        );
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].id, 1);
        assert_eq!(results[0].kind_label, "地级城市");
        assert!(results
            .iter()
            .any(|item| item.name == "武侯区" && item.admin2 == "成都市"));
        assert!(!results.iter().any(|item| item.admin1 == "江西"));
    }

    #[test]
    fn district_name_search_keeps_the_district_as_the_first_result() {
        let results = normalize_city_results(
            "武侯区",
            vec![
                geocoding_result(1, "成都", "四川", "成都市", "PPLA2", 20_000_000),
                geocoding_result(3, "武侯区", "四川", "成都市", "ADM3", 1_200_000),
            ],
        );
        assert_eq!(results[0].name, "武侯区");
        assert_eq!(results[0].kind_label, "区县");
    }

    #[test]
    fn maps_nominatim_district_results_with_the_parent_city_and_timezone() {
        let raw = serde_json::json!([{
            "place_id": 241451936,
            "name": "武侯区",
            "display_name": "武侯区, 成都市, 四川省, 中国",
            "lat": "30.6442131",
            "lon": "104.0406683",
            "category": "boundary",
            "type": "administrative",
            "addresstype": "city",
            "address": { "city": "武侯区", "state": "四川省", "country": "中国", "country_code": "cn" }
        }]);
        let results: Vec<NominatimResult> = serde_json::from_value(raw).unwrap();
        let normalized = normalize_nominatim_results(results);
        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0].name, "武侯区");
        assert_eq!(normalized[0].admin2, "成都市");
        assert_eq!(normalized[0].kind_label, "区县");
        assert_eq!(normalized[0].timezone, "Asia/Shanghai");
        assert_eq!(normalized[0].provider_label, "OpenStreetMap Nominatim");
    }

    #[test]
    fn validates_location_and_timezone_without_accepting_arbitrary_values() {
        let location = location();
        assert!(validate_location(&location).is_ok());
        assert!(!valid_timezone(
            "Asia/Shanghai?redirect=https://example.com"
        ));
    }

    #[test]
    fn maps_topic_from_the_supported_public_shape() {
        let value = serde_json::json!({
            "id": "topic-1",
            "title": "新的模型发布",
            "summary": "一条热点摘要",
            "score": 88,
            "links": { "aihot": "https://aihot.virxact.com/topics/topic-1" }
        });
        let topic = map_ai_topic(&value).unwrap();
        assert_eq!(topic.title, "新的模型发布");
        assert_eq!(topic.score, 88.0);
    }

    #[test]
    fn parses_weather_and_rejects_missing_wrong_or_empty_fields() {
        let response: WeatherResponse = serde_json::from_value(weather_json()).unwrap();
        let normalized = normalize_weather(location(), response).unwrap();
        assert_eq!(normalized.daily.len(), 3);
        assert_eq!(normalized.hourly.len(), 2);

        let mut missing = weather_json();
        missing.as_object_mut().unwrap().remove("current");
        assert!(serde_json::from_value::<WeatherResponse>(missing).is_err());

        let mut wrong = weather_json();
        wrong["current"]["temperature_2m"] = serde_json::json!("hot");
        assert!(serde_json::from_value::<WeatherResponse>(wrong).is_err());

        let mut empty = weather_json();
        empty["hourly"]["time"] = serde_json::json!([]);
        empty["hourly"]["precipitation_probability"] = serde_json::json!([]);
        empty["hourly"]["precipitation"] = serde_json::json!([]);
        empty["hourly"]["rain"] = serde_json::json!([]);
        empty["hourly"]["showers"] = serde_json::json!([]);
        empty["hourly"]["weather_code"] = serde_json::json!([]);
        let empty_response: WeatherResponse = serde_json::from_value(empty).unwrap();
        assert!(normalize_weather(location(), empty_response).is_err());
    }

    #[test]
    fn parses_aihot_and_rejects_missing_wrong_or_empty_items() {
        let normal = serde_json::json!({
            "items": [{
                "id": "item-1", "title": "新的模型发布", "summary": "摘要",
                "reason": "热度上升", "category": "模型", "publishedAt": "2026-08-24T01:00:00Z",
                "score": 91.5, "source": {"name": "示例来源"},
                "links": {"aihot": "https://aihot.virxact.com/item/item-1", "original": "https://example.com/story"}
            }]
        });
        let response: AiItemsResponse = serde_json::from_value(normal.clone()).unwrap();
        let normalized = normalize_ai_brief(response, None, None).unwrap();
        assert_eq!(normalized.items.len(), 1);
        assert_eq!(normalized.items[0].title, "新的模型发布");

        let mut missing = normal.clone();
        missing["items"][0].as_object_mut().unwrap().remove("title");
        assert!(serde_json::from_value::<AiItemsResponse>(missing).is_err());

        let mut wrong = normal;
        wrong["items"][0]["score"] = serde_json::json!("high");
        assert!(serde_json::from_value::<AiItemsResponse>(wrong).is_err());

        assert!(normalize_ai_brief(AiItemsResponse { items: vec![] }, None, None).is_err());
    }

    #[test]
    fn parses_morning_brief_and_limits_the_native_card_to_fifteen_items() {
        let news: Vec<String> = (1..=16).map(|index| format!("第 {index} 条新闻")).collect();
        let normal = serde_json::json!({
            "date": "2026-08-24", "news": news, "tip": "每日微语",
            "image": "https://example.com/card.png", "link": "https://example.com/brief",
            "updated": "2026-08-24T00:30:00Z"
        });
        let response: MorningBriefRaw = serde_json::from_value(normal.clone()).unwrap();
        let normalized = normalize_morning_brief("2026-08-24", response).unwrap();
        assert_eq!(normalized.news.len(), 15);

        let mut missing = normal.clone();
        missing.as_object_mut().unwrap().remove("news");
        assert!(serde_json::from_value::<MorningBriefRaw>(missing).is_err());

        let mut wrong = normal;
        wrong["news"] = serde_json::json!("not-a-list");
        assert!(serde_json::from_value::<MorningBriefRaw>(wrong).is_err());

        let empty = MorningBriefRaw {
            date: "2026-08-24".into(),
            news: vec![],
            tip: String::new(),
            image: String::new(),
            link: String::new(),
            updated: String::new(),
        };
        assert!(normalize_morning_brief("2026-08-24", empty).is_err());
    }

    #[test]
    fn only_keeps_safe_https_links_from_provider_content() {
        assert!(safe_https_url("https://example.com/story").is_some());
        assert!(safe_https_url("javascript:alert(1)").is_none());
        assert!(safe_aihot_url("https://aihot.virxact.com/item/1").is_some());
        assert!(safe_aihot_url("https://aihot.news/items/1").is_some());
        assert!(safe_aihot_url("https://aihot.news.evil.example/items/1").is_none());
        assert!(safe_aihot_url("https://example.com/item/1").is_none());
    }
}

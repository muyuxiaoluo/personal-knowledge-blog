use super::{update, Job};
use crate::deepseek_api::{
    api_client, deepseek_api_key, ensure_success, map_transport_error, summarize_asaba_research,
};
use reqwest::Client;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use url::Url;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Research {
    pub topic: String,
    pub queries: Vec<String>,
    pub model: String,
    pub background: Option<String>,
    searched: Vec<String>,
    sources: Vec<Source>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    id: String,
    url: String,
    title: String,
    excerpt: String,
    date: Option<String>,
    accessed_at: String,
    read_at: Option<String>,
    body: Option<String>,
    attempted: bool,
    #[serde(default)]
    official_rank: u8,
}

#[derive(Deserialize)]
struct Hit {
    url: String,
    title: String,
    snippet: Option<String>,
    summary: Option<String>,
    date: Option<String>,
    #[serde(default)]
    authority: Option<i32>,
}

#[derive(Deserialize)]
struct Search {
    results: Vec<Hit>,
}

#[derive(Deserialize)]
struct Page {
    content: String,
}

pub(super) fn validate(input: &Research) -> Result<(), String> {
    if input.topic.trim().is_empty()
        || input.topic.chars().count() > 400
        || input.queries.is_empty()
        || input.queries.len() > 4
        || input
            .queries
            .iter()
            .any(|q| q.trim().is_empty() || q.chars().count() > 128)
        || input.model.is_empty()
        || input.model.len() > 100
        || !input
            .model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || input
            .background
            .as_ref()
            .is_some_and(|text| text.chars().count() > 1500)
    {
        return Err("请检查公开检索关键词与研究整理模型。".into());
    }
    Ok(())
}

impl Research {
    pub(super) fn clear_checkpoint(&mut self) {
        self.searched.clear();
        self.sources.clear();
    }
}

fn public_url(value: &str) -> Option<String> {
    let mut url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    match url.host()? {
        url::Host::Domain(host)
            if host.contains('.') && !host.ends_with(".local") && !host.ends_with(".localhost") => {
        }
        _ => return None,
    }
    url.set_fragment(None);
    Some(url.into())
}

async fn request<T: DeserializeOwned>(
    client: &Client,
    key: &str,
    endpoint: &str,
    input: Value,
) -> Result<Option<T>, String> {
    let response = client
        .post(format!("https://api.deepseek.com/v1/tools/{endpoint}"))
        .bearer_auth(key)
        .json(&input)
        .send()
        .await
        .map_err(map_transport_error)?;
    let status = response.status();
    if endpoint == "fetch" && matches!(status.as_u16(), 403 | 404 | 408 | 504) {
        return Ok(None);
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(map_transport_error)? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return if endpoint == "fetch" {
                Ok(None)
            } else {
                Err("检索结果过长。".into())
            };
        }
        bytes.extend_from_slice(&chunk);
    }
    ensure_success(status, "联网调研", &String::from_utf8_lossy(&bytes))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "DeepSeek 返回的网页数据无法解析。".into())
}

fn checkpoint(
    app: &tauri::AppHandle,
    id: &str,
    data: &Research,
    progress: String,
) -> Result<(), String> {
    update(app, id, |job| {
        job.research = Some(data.clone());
        job.progress = Some(progress);
    })
}

pub(super) async fn run(app: &tauri::AppHandle, job: &Job) -> Result<Value, String> {
    let mut data = job.research.clone().ok_or("缺少调研范围")?;
    let client = api_client()?;
    let key = deepseek_api_key()?;
    for query in data.queries.clone() {
        if data.searched.contains(&query) {
            continue;
        }
        checkpoint(
            app,
            &job.id,
            &data,
            format!(
                "检索公开资料 · {}/{}",
                data.searched.len() + 1,
                data.queries.len()
            ),
        )?;
        let response: Search = request(&client, &key, "search", json!({"query":query,"count":8}))
            .await?
            .ok_or("未返回搜索数据")?;
        for hit in response.results {
            let Some(url) = public_url(&hit.url) else {
                continue;
            };
            if data.sources.len() == 20 || data.sources.iter().any(|source| source.url == url) {
                continue;
            }
            let official_rank = Url::parse(&url)
                .ok()
                .and_then(|parsed| parsed.host_str().map(str::to_owned))
                .map_or(0, |host| {
                    if host.ends_with(".gov.cn")
                        || host.ends_with(".edu.cn")
                        || host.starts_with("careers.")
                        || host.starts_with("jobs.")
                    {
                        2
                    } else {
                        0
                    }
                });
            data.sources.push(Source {
                id: format!("s{}", data.sources.len() + 1),
                url,
                title: super::clip(&hit.title, 160),
                excerpt: super::clip(hit.summary.or(hit.snippet).as_deref().unwrap_or(""), 380),
                date: hit
                    .date
                    .filter(|date| chrono::DateTime::parse_from_rfc3339(date).is_ok()),
                accessed_at: chrono::Utc::now().to_rfc3339(),
                read_at: None,
                body: None,
                attempted: false,
                official_rank: official_rank + u8::from(hit.authority.unwrap_or_default() >= 3),
            });
        }
        data.searched.push(query);
        checkpoint(
            app,
            &job.id,
            &data,
            format!("已取得 {} 条来源", data.sources.len()),
        )?;
    }
    if data.sources.is_empty() {
        return Ok(
            json!({"sources":[],"findings":[],"positions":[],"limitations":["没有找到可核对的公开来源"],"nextAction":""}),
        );
    }
    let mut fetch_order = (0..data.sources.len()).collect::<Vec<_>>();
    fetch_order.sort_by_key(|index| std::cmp::Reverse(data.sources[*index].official_rank));
    let fetch_count = fetch_order.len().min(10);
    for (ordinal, index) in fetch_order.into_iter().take(fetch_count).enumerate() {
        if data.sources[index].attempted {
            continue;
        }
        checkpoint(
            app,
            &job.id,
            &data,
            format!("读取正文 · {}/{}", ordinal + 1, fetch_count),
        )?;
        let url = &data.sources[index].url;
        let page: Option<Page> = request(&client, &key, "fetch", json!({"url":url})).await?;
        let source = &mut data.sources[index];
        source.attempted = true;
        source.body = page
            .filter(|page| !page.content.trim().is_empty())
            .map(|page| super::clip(&page.content, 950));
        source.read_at = source
            .body
            .as_ref()
            .map(|_| chrono::Utc::now().to_rfc3339());
        checkpoint(
            app,
            &job.id,
            &data,
            format!("已尝试读取 {} 条网页", ordinal + 1),
        )?;
    }
    checkpoint(app, &job.id, &data, "整理结论与出处".into())?;
    let mut report = summarize_asaba_research(data.model, json!({
        "topic": data.topic, "background":data.background,
        "sources": data.sources.iter().map(|source| json!({
            "id":source.id,"title":source.title,"excerpt":source.excerpt,"body":source.body,"date":source.date
        })).collect::<Vec<_>>()
    })).await?;
    validate_report(&report, &data.sources)?;
    report["sources"] = json!(data
        .sources
        .iter()
        .map(|source| json!({
            "id":source.id,"url":source.url,"title":source.title,"excerpt":source.excerpt,
            "date":source.date,"accessedAt":source.accessed_at,"readAt":source.read_at
        }))
        .collect::<Vec<_>>());
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_public_web_source_links() {
        assert_eq!(
            public_url("https://example.org/role#details").as_deref(),
            Some("https://example.org/role")
        );
        for value in [
            "file:///test.docx",
            "javascript:alert(1)",
            "http://127.0.0.1/",
            "https://user@example.org/",
            "https://project.local/",
        ] {
            assert!(public_url(value).is_none());
        }
    }

    #[test]
    fn verifies_source_references_and_keeps_checkpoints_on_deserialization() {
        let input: Research = serde_json::from_value(json!({
            "topic":"ROS2 岗位","queries":["ROS2 招聘"],"model":"deepseek-flash",
            "searched":["ROS2 招聘"],"sources":[{"id":"s1","url":"https://example.org/jobs","title":"招聘","excerpt":"ROS2",
            "date":null,"accessedAt":"2026-11-15T00:00:00Z","readAt":null,"body":null,"attempted":true}]
        })).unwrap();
        assert_eq!(input.searched, ["ROS2 招聘"]);
        assert!(input.sources[0].attempted);
        let mut report = json!({"findings":[{"text":"要求 ROS2","sourceIds":["s1"]}],"positions":[],"limitations":[],"nextAction":""});
        assert!(validate_report(&report, &input.sources).is_ok());
        report["findings"][0]["sourceIds"] = json!(["fabricated"]);
        assert!(validate_report(&report, &input.sources).is_err());
    }
}

fn validate_report(report: &Value, sources: &[Source]) -> Result<(), String> {
    let fail = || "调研报告含有不完整结论或无效来源，可复用已取得的资料重试。".to_owned();
    let known: HashSet<_> = sources.iter().map(|s| s.id.as_str()).collect();
    let valid_text = |value: &Value, max| {
        value
            .as_str()
            .is_some_and(|text| !text.trim().is_empty() && text.chars().count() <= max)
    };
    let valid_list = |value: &Value, max, size| {
        value.as_array().is_some_and(|items| {
            items.len() <= max && items.iter().all(|item| valid_text(item, size))
        })
    };
    let findings = report["findings"].as_array().ok_or_else(fail)?;
    let positions = report["positions"].as_array().ok_or_else(fail)?;
    if findings.len() > 8
        || positions.len() > 20
        || !valid_list(&report["limitations"], 8, 300)
        || report["nextAction"]
            .as_str()
            .is_none_or(|value| value.chars().count() > 200)
    {
        return Err(fail());
    }
    for item in findings {
        if !valid_text(&item["text"], 420)
            || !item["sourceIds"].as_array().is_some_and(|ids| {
                !ids.is_empty()
                    && ids.len() <= 20
                    && ids
                        .iter()
                        .all(|id| id.as_str().is_some_and(|id| known.contains(id)))
            })
        {
            return Err(fail());
        }
    }
    let mut positions_seen = HashSet::new();
    for item in positions {
        if !item["sourceId"]
            .as_str()
            .is_some_and(|id| known.contains(id) && positions_seen.insert(id))
            || !valid_text(&item["company"], 120)
            || !valid_text(&item["role"], 120)
            || !valid_list(&item["requirements"], 10, 220)
        {
            return Err(fail());
        }
    }
    Ok(())
}

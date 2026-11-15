use super::{research, update, Job};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Career {
    pub model: String,
    pub background: String,
    pub project_snapshot: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct CareerRequest {
    pub(super) research: research::Research,
    pub(super) plan: Career,
}

pub(super) fn validate(request: &CareerRequest) -> Result<(), String> {
    research::validate(&request.research)?;
    let plan = &request.plan;
    if request.research.background.is_some()
        || plan.background.chars().count() > 1500
        || plan.model.is_empty()
        || plan.model.len() > 100
        || !plan
            .model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        || plan
            .project_snapshot
            .as_ref()
            .is_some_and(|value| value.len() > 200_000)
    {
        return Err("调研范围或规划背景无效。".into());
    }
    Ok(())
}

pub(super) async fn run(app: &tauri::AppHandle, job: &Job) -> Result<Value, String> {
    let plan = job.career.as_ref().ok_or("缺少求职规划设置")?;
    let research = match &job.career_research {
        Some(report) => report.clone(),
        None => {
            let report = research::run(app, job).await?;
            update(app, &job.id, |job| {
                job.career_research = Some(report.clone())
            })?;
            report
        }
    };
    if !research["sources"]
        .as_array()
        .is_some_and(|items| !items.is_empty())
        || !research["positions"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
    {
        return Ok(json!({"research": research, "route": null}));
    }
    update(app, &job.id, |job| {
        job.progress = Some("调研完成 · 正在对照能力并拟定路线".into())
    })?;
    let route = crate::deepseek_api::plan_asaba_career(
        plan.model.clone(),
        job.description.clone(),
        &plan.background,
        &research,
    )
    .await?;
    Ok(json!({"research": research, "route": route}))
}

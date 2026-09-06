use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, time::Duration};

const API_ROOT: &str = "https://api.deepseek.com";
const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_OUTPUT_BYTES: usize = 128 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekApiModel {
    id: String,
    object: String,
    owned_by: String,
}

#[derive(Debug, Deserialize)]
struct ModelListResponse {
    #[serde(default)]
    data: Vec<ModelListItem>,
}

#[derive(Debug, Deserialize)]
struct ModelListItem {
    id: String,
    #[serde(default)]
    object: String,
    #[serde(default)]
    owned_by: String,
}

#[derive(Debug, Deserialize)]
struct ResponsesApiResponse {
    #[serde(default)]
    status: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    output: Vec<ResponseOutput>,
    #[serde(default)]
    output_text: String,
    #[serde(default)]
    error: Option<ResponseError>,
    #[serde(default)]
    incomplete_details: Option<IncompleteDetails>,
    #[serde(default)]
    usage: ResponsesUsage,
}

#[derive(Debug, Deserialize)]
struct ResponseOutput {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    content: Vec<ResponseContent>,
}

#[derive(Debug, Deserialize)]
struct ResponseContent {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    text: String,
}

#[derive(Debug, Deserialize)]
struct ResponseError {
    #[serde(default)]
    message: String,
}

#[derive(Debug, Deserialize)]
struct IncompleteDetails {
    #[serde(default)]
    reason: String,
}

#[derive(Debug, Default, Deserialize)]
struct ResponsesUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    total_tokens: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredApiResponse {
    pub(crate) content: Value,
    pub(crate) model: String,
    pub(crate) token_usage: TokenUsage,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TokenUsage {
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) total_tokens: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredProjectRequest {
    model: String,
    input: Value,
    #[serde(default)]
    allowed_milestone_ids: Vec<String>,
    #[serde(default)]
    allowed_task_ids: Vec<String>,
}

#[tauri::command]
pub async fn deepseek_api_list_models() -> Result<Vec<DeepSeekApiModel>, String> {
    let api_key = deepseek_api_key()?;
    let response = api_client()?
        .get(format!("{API_ROOT}/models"))
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(map_transport_error)?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("无法读取 DeepSeek 模型列表：{error}"))?;
    ensure_success(status, "读取模型列表", &body)?;
    let parsed: ModelListResponse = serde_json::from_str(&body)
        .map_err(|_| "DeepSeek 返回了无法识别的模型列表。".to_string())?;
    let mut models: Vec<DeepSeekApiModel> = parsed
        .data
        .into_iter()
        .filter(|item| valid_model(&item.id))
        .map(|item| DeepSeekApiModel {
            id: item.id,
            object: item.object,
            owned_by: item.owned_by,
        })
        .collect();
    models.sort_by(|left, right| left.id.cmp(&right.id));
    if models.is_empty() {
        return Err("DeepSeek 当前没有返回可用模型，请稍后手动重试。".into());
    }
    Ok(models)
}

#[tauri::command]
pub async fn deepseek_api_project_create(
    request: StructuredProjectRequest,
) -> Result<StructuredApiResponse, String> {
    generate_structured(
        request,
        "project_creation",
        "你是个人项目规划助手。只依据用户明确填写的事实判断它更适合作为独立行动还是项目；不要编造期限、导师要求或研究结论。默认独立行动或直接推进，不创建阶段；只有明确存在需要分别验收的结果或依赖时才建议阶段，最多三个。直接推进的 milestones 必须为空。滚动推进只细化当前检查点。把用户声明的投入约束和够用标准保留在 motivation 中，后续建议才能沿用。reason 简要说明最小路线与取舍。",
        project_creation_schema(),
    )
    .await
}

#[tauri::command]
pub async fn deepseek_api_project_replan(
    request: StructuredProjectRequest,
) -> Result<StructuredApiResponse, String> {
    generate_structured(
        request,
        "project_replan",
        "你是滚动项目校准助手。新事实优先于旧计划。不得建议硬删除历史，只能完成、推迟、取消、替换、新增或标记为被替代。仅可引用输入中提供的阶段和行动 ID。时间或精力减少时优先缩减范围、推迟或暂停，并在 summary 说明省略的内容与影响；不要把原有工作全部压进剩余时间。优先调整已有行动，最多新增一项行动和一个必要检查点；新增内容 selected 默认 false，未来路线只写在 summary 中供参考。",
        project_replan_schema(),
    )
    .await
}

#[tauri::command]
pub async fn deepseek_api_next_action(
    request: StructuredProjectRequest,
) -> Result<StructuredApiResponse, String> {
    generate_structured(
        request,
        "next_action",
        "你是下一行动助手。只返回一项现在即可开始、范围足够小且有清晰停止条件的行动。优先根据当前已有行动的起点帮助继续，避免重复创建同一件事。不得修改项目或生成一组待办，也不能把整套计划藏进一条行动的描述。若引用检查点，只能使用输入中提供的 ID。reason 说明最小路线、取舍及会影响路线的关键未知；details 中可用一两句保留未来参考，不能扩展为必做清单。信息不足时建议一个成本低的验证步骤，不编造用户的目标、基础、可用时间。",
        next_action_schema(),
    )
    .await
}

#[tauri::command]
pub async fn deepseek_api_health_advice(
    request: StructuredProjectRequest,
) -> Result<StructuredApiResponse, String> {
    generate_structured(
        request,
        "health_advice",
        "你是谨慎、务实的日常生活方式助手，请用简洁中文回答。只能依据用户手动提供的记录：明确区分记录事实、建议和数据限制，不推断缺失数据，不把食物名称换算成精确热量或营养素。过敏、忌口和健康备注优先级最高，不得推荐其中明确排除的食物或行为。不得诊断疾病、建议药物或替代医生意见，不得鼓励激进减重；如果用户未满 18 岁、目标体重明显不合理，或记录显示持续异常与明显不适，应温和建议咨询监护人或专业人士。睡眠与活动建议要小而可执行，下一餐必须给出三个可相互替换、符合偏好与限制的方案。不要制造恐慌。",
        health_advice_schema(),
    )
    .await
}

pub async fn generate_for_finance(
    model: &str,
    instructions: &str,
    input: &Value,
    schema: Value,
) -> Result<StructuredApiResponse, String> {
    generate_structured(
        StructuredProjectRequest {
            model: model.to_string(),
            input: input.clone(),
            allowed_milestone_ids: Vec::new(),
            allowed_task_ids: Vec::new(),
        },
        "finance_monthly_report",
        instructions,
        schema,
    )
    .await
}

const PRACTICAL_PLANNING_RULES: &str = "\n规划共同约束：帮助用户在愿意投入的时间和精力内达到其认可的结果，而不是追求全面、完美或最大产出。用户的够用标准、时间上限、不想做的事优先；没有声明时不得默认高分、系统掌握或全天投入。计算准备、切换和维护计划的负担，不只计算执行时间。每个行动写清本次范围、可观察的停止条件和必要的验证；停止条件是证据，不是单纯时间用完。默认省略非必要笔记整理、资料比较、完整课程与多轮复盘，但不得省略实现目标所必需的检查。不能承诺简化方案一定成功，要说明最关键的适用条件。只细化眼前一步，后续随事实展开。";

fn validate_planning_scope(schema_name: &str, content: &Value) -> Result<(), String> {
    let too_many = |field: &str, max: usize| {
        content[field]
            .as_array()
            .is_some_and(|items| items.len() > max)
    };
    if schema_name == "project_creation" {
        if too_many("milestones", 3)
            || ((content["planningMode"] == "direct"
                || content["classification"] == "standalone_action")
                && too_many("milestones", 0))
        {
            return Err("AI 草案拆分过多；直接推进不应创建阶段，请缩小范围后重试。".into());
        }
    } else if schema_name == "project_replan"
        && (too_many("newTasks", 1) || too_many("newMilestones", 1))
    {
        return Err("AI 草案新增工作过多；每次最多展开一项行动和一个必要检查点。".into());
    }
    Ok(())
}

async fn generate_structured(
    request: StructuredProjectRequest,
    schema_name: &str,
    instructions: &str,
    schema: Value,
) -> Result<StructuredApiResponse, String> {
    if !valid_model(&request.model) {
        return Err("选择的 DeepSeek 模型名称无效，请返回设置重新选择。".into());
    }
    let input_text = serde_json::to_string(&request.input)
        .map_err(|error| format!("无法准备发送内容：{error}"))?;
    if input_text.len() > MAX_INPUT_BYTES {
        return Err("发送给 DeepSeek 的请求内容超过 64 KiB，请减少旧记录后重试。".into());
    }
    let api_key = deepseek_api_key()?;
    let instructions = if matches!(
        schema_name,
        "project_creation" | "project_replan" | "next_action"
    ) {
        format!("{instructions}{PRACTICAL_PLANNING_RULES}")
    } else {
        instructions.to_string()
    };
    let max_output_tokens = if schema_name == "project_replan" {
        8000
    } else {
        5000
    };
    let body = json!({
        "model": request.model,
        "input": [
            { "role": "system", "content": [{ "type": "input_text", "text": instructions }] },
            { "role": "user", "content": [{ "type": "input_text", "text": input_text }] }
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": schema_name,
                "schema": schema
            }
        },
        "max_output_tokens": max_output_tokens,
        "reasoning": { "effort": "low" },
        "stream": false
    });
    let response = api_client()?
        .post(format!("{API_ROOT}/responses"))
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(map_transport_error)?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("无法读取 DeepSeek 响应：{error}"))?;
    ensure_success(status, "结构化规划", &body)?;
    let parsed: ResponsesApiResponse = serde_json::from_str(&body)
        .map_err(|_| "DeepSeek 返回了无法识别的响应，现有数据未改动。".to_string())?;
    let text = extract_output_text(&parsed)?;
    if text.len() > MAX_OUTPUT_BYTES {
        return Err("DeepSeek 返回内容过长，已拒绝使用。".into());
    }
    let content: Value = serde_json::from_str(&text)
        .map_err(|_| "DeepSeek 返回的结构不是有效 JSON，现有数据未改动。".to_string())?;
    validate_required_shape(schema_name, &content)?;
    validate_planning_scope(schema_name, &content)?;
    validate_references(
        schema_name,
        &content,
        &request.allowed_milestone_ids,
        &request.allowed_task_ids,
    )?;
    Ok(StructuredApiResponse {
        content,
        model: if parsed.model.trim().is_empty() {
            request.model
        } else {
            parsed.model
        },
        token_usage: TokenUsage {
            input_tokens: parsed.usage.input_tokens,
            output_tokens: parsed.usage.output_tokens,
            total_tokens: parsed.usage.total_tokens,
        },
    })
}

fn extract_output_text(response: &ResponsesApiResponse) -> Result<String, String> {
    if response.status == "failed" {
        let detail = response
            .error
            .as_ref()
            .map(|error| error.message.trim())
            .filter(|message| !message.is_empty())
            .unwrap_or("服务端没有提供具体原因");
        return Err(format!("DeepSeek 生成草案失败：{detail}。现有数据未改动。"));
    }
    if response.status == "incomplete" {
        let reason = response
            .incomplete_details
            .as_ref()
            .map(|details| details.reason.as_str())
            .unwrap_or_default();
        let detail = match reason {
            "max_output_tokens" => "生成内容超过长度上限",
            "content_filter" => "生成内容被安全策略中止",
            _ => "生成过程没有完整结束",
        };
        return Err(format!(
            "DeepSeek {detail}，请缩小本次调整范围后重试；现有数据未改动。"
        ));
    }

    if !response.output_text.trim().is_empty() {
        return Ok(response.output_text.trim().to_string());
    }

    // Thinking-mode responses place a reasoning item before the assistant message.
    // Only output_text from message items is user-visible structured output.
    let text = response
        .output
        .iter()
        .filter(|item| item.kind == "message" || item.kind.is_empty())
        .flat_map(|item| item.content.iter())
        .filter(|content| content.kind == "output_text" || content.kind.is_empty())
        .map(|content| content.text.as_str())
        .collect::<String>();
    if text.trim().is_empty() {
        return Err("DeepSeek 没有返回可用草案，现有数据未改动。".into());
    }
    Ok(text.trim().to_string())
}

fn validate_required_shape(schema_name: &str, content: &Value) -> Result<(), String> {
    match schema_name {
        "project_creation" => {
            exact_object(
                content,
                &[
                    "classification",
                    "reason",
                    "planningMode",
                    "project",
                    "milestones",
                    "firstAction",
                    "assumptions",
                    "risks",
                ],
            )?;
            exact_object(
                &content["project"],
                &[
                    "title",
                    "outcome",
                    "motivation",
                    "category",
                    "targetDate",
                    "reviewDate",
                ],
            )?;
            exact_object(
                &content["firstAction"],
                &[
                    "title",
                    "currentFocus",
                    "definitionOfDone",
                    "details",
                    "dueDate",
                    "direction",
                ],
            )?;
            exact_array_objects(
                &content["milestones"],
                &["clientId", "title", "definitionOfDone", "dueDate", "status"],
            )?;
        }
        "project_replan" => {
            exact_object(
                content,
                &[
                    "summary",
                    "projectPatch",
                    "milestoneChanges",
                    "newMilestones",
                    "taskChanges",
                    "newTasks",
                    "assumptions",
                    "risks",
                ],
            )?;
            exact_object(
                &content["projectPatch"],
                &["outcome", "targetDate", "reviewDate"],
            )?;
            exact_array_objects(
                &content["milestoneChanges"],
                &[
                    "id",
                    "action",
                    "title",
                    "definitionOfDone",
                    "dueDate",
                    "selected",
                ],
            )?;
            exact_array_objects(
                &content["newMilestones"],
                &[
                    "clientId",
                    "title",
                    "definitionOfDone",
                    "dueDate",
                    "status",
                    "selected",
                ],
            )?;
            exact_array_objects(
                &content["taskChanges"],
                &[
                    "id",
                    "action",
                    "title",
                    "currentFocus",
                    "definitionOfDone",
                    "dueDate",
                    "status",
                    "selected",
                ],
            )?;
            exact_array_objects(
                &content["newTasks"],
                &[
                    "clientId",
                    "milestoneId",
                    "title",
                    "currentFocus",
                    "definitionOfDone",
                    "details",
                    "dueDate",
                    "selected",
                ],
            )?;
        }
        "next_action" => {
            exact_object(content, &["reason", "action"])?;
            exact_object(
                &content["action"],
                &[
                    "milestoneId",
                    "title",
                    "currentFocus",
                    "definitionOfDone",
                    "details",
                    "dueDate",
                ],
            )?;
        }
        "finance_monthly_report" => {
            exact_object(
                content,
                &[
                    "overview",
                    "essentialStructure",
                    "pendingConfirmations",
                    "worthwhileSpending",
                    "opportunities",
                    "scenarios",
                    "nextActions",
                    "questions",
                ],
            )?;
        }
        "health_advice" => {
            exact_object(
                content,
                &[
                    "summary",
                    "facts",
                    "sleepAdvice",
                    "activityAdvice",
                    "nextMeal",
                    "attention",
                    "limitations",
                ],
            )?;
            exact_object(&content["nextMeal"], &["focus", "options"])?;
            exact_array_objects(
                &content["nextMeal"]["options"],
                &["title", "foods", "reason"],
            )?;
        }
        _ => return Err("未知的 DeepSeek 结构化输出类型。".into()),
    }
    Ok(())
}

fn exact_array_objects(value: &Value, keys: &[&str]) -> Result<(), String> {
    let values = value
        .as_array()
        .ok_or("DeepSeek 返回列表缺失或被截断，现有数据未改动。")?;
    for item in values {
        exact_object(item, keys)?;
    }
    Ok(())
}

fn exact_object(value: &Value, keys: &[&str]) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or("DeepSeek 返回对象缺失或被截断，现有数据未改动。")?;
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Err("DeepSeek 返回字段缺失、被截断或包含未知字段，现有数据未改动。".into());
    }
    Ok(())
}

fn validate_references(
    schema_name: &str,
    content: &Value,
    milestone_ids: &[String],
    task_ids: &[String],
) -> Result<(), String> {
    let allowed_milestones: HashSet<&str> = milestone_ids.iter().map(String::as_str).collect();
    let allowed_tasks: HashSet<&str> = task_ids.iter().map(String::as_str).collect();
    let mut seen = HashSet::new();
    if schema_name == "project_replan" {
        let new_milestones = content["newMilestones"]
            .as_array()
            .ok_or("AI 草案缺少新增节点列表。")?;
        let mut new_milestone_ids = HashSet::new();
        for item in new_milestones {
            let id = item["clientId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or("AI 草案包含无效的新增节点 ID。")?;
            if !new_milestone_ids.insert(id) {
                return Err("AI 草案包含重复的新增节点，已拒绝使用。".into());
            }
        }
        let mut new_task_ids = HashSet::new();
        for item in content["newTasks"]
            .as_array()
            .ok_or("AI 草案缺少新增行动列表。")?
        {
            let id = item["clientId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or("AI 草案包含无效的新增行动 ID。")?;
            if !new_task_ids.insert(id) {
                return Err("AI 草案包含重复的新增行动，已拒绝使用。".into());
            }
        }
        for change in content["milestoneChanges"]
            .as_array()
            .ok_or("AI 草案缺少阶段调整列表。")?
        {
            let id = change["id"].as_str().ok_or("AI 草案包含无效阶段 ID。")?;
            if !allowed_milestones.contains(id) || !seen.insert(format!("m:{id}")) {
                return Err("AI 草案试图修改当前项目之外或重复的阶段，已拒绝使用。".into());
            }
        }
        for change in content["taskChanges"]
            .as_array()
            .ok_or("AI 草案缺少行动调整列表。")?
        {
            let id = change["id"].as_str().ok_or("AI 草案包含无效行动 ID。")?;
            if !allowed_tasks.contains(id) || !seen.insert(format!("t:{id}")) {
                return Err("AI 草案试图修改当前项目之外或重复的行动，已拒绝使用。".into());
            }
        }
        for task in content["newTasks"]
            .as_array()
            .ok_or("AI 草案缺少新增行动列表。")?
        {
            if let Some(id) = task["milestoneId"].as_str() {
                if !allowed_milestones.contains(id) && !new_milestone_ids.contains(id) {
                    return Err("AI 草案把新行动关联到了当前项目之外，已拒绝使用。".into());
                }
            }
        }
    }
    if schema_name == "next_action" {
        if let Some(id) = content["action"]["milestoneId"].as_str() {
            if !allowed_milestones.contains(id) {
                return Err("AI 建议引用了当前项目之外的检查点，已拒绝使用。".into());
            }
        }
    }
    Ok(())
}

fn api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| format!("无法准备 DeepSeek 请求：{error}"))
}

fn deepseek_api_key() -> Result<String, String> {
    crate::integrations::read_secret("deepseek_api_key").map_err(|error| {
        if error.contains("尚未配置") {
            "尚未配置 DeepSeek API Key，请进入“设置 → AI 与模型”后重试。".into()
        } else {
            error
        }
    })
}

fn valid_model(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

fn map_transport_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "DeepSeek 请求超时，现有数据未改动，请手动重试。".into()
    } else {
        format!("无法连接 DeepSeek：{error}")
    }
}

fn ensure_success(status: StatusCode, operation: &str, body: &str) -> Result<(), String> {
    if status.is_success() {
        return Ok(());
    }
    let unavailable = status == StatusCode::NOT_FOUND
        || body.to_ascii_lowercase().contains("model") && body.to_ascii_lowercase().contains("not");
    Err(match status {
        StatusCode::UNAUTHORIZED => {
            "DeepSeek API Key 无效或已经过期，请进入 AI 与模型设置。".into()
        }
        StatusCode::PAYMENT_REQUIRED => "DeepSeek 账户余额不足，现有数据未改动。".into(),
        StatusCode::TOO_MANY_REQUESTS => "DeepSeek 当前请求过多，请稍后手动重试。".into(),
        _ if unavailable => "当前选择的 DeepSeek 模型不可用，请返回 AI 与模型设置重新选择。".into(),
        _ => format!("DeepSeek {operation}请求失败（HTTP {status}），现有数据未改动。"),
    })
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "additionalProperties": false, "properties": properties, "required": required })
}

fn string() -> Value {
    json!({ "type": "string" })
}
fn nullable_string() -> Value {
    json!({ "type": ["string", "null"] })
}
fn string_array() -> Value {
    json!({ "type": "array", "items": { "type": "string" }, "maxItems": 12 })
}

fn project_creation_schema() -> Value {
    let project = object(
        json!({
            "title": string(), "outcome": string(), "motivation": string(),
            "category": { "type": "string", "enum": ["learning", "health", "career", "finance", "relationships", "creative", "systems", "uncategorized"] },
            "targetDate": string(), "reviewDate": string()
        }),
        &[
            "title",
            "outcome",
            "motivation",
            "category",
            "targetDate",
            "reviewDate",
        ],
    );
    let milestone = object(
        json!({
            "clientId": string(), "title": string(), "definitionOfDone": string(), "dueDate": string(),
            "status": { "type": "string", "enum": ["current", "planned"] }
        }),
        &["clientId", "title", "definitionOfDone", "dueDate", "status"],
    );
    let action = object(
        json!({
            "title": string(), "currentFocus": string(), "definitionOfDone": string(), "details": string(), "dueDate": string(),
            "direction": { "type": "string", "enum": ["learning", "health", "career", "finance", "relationships", "creative", "systems", "uncategorized"] }
        }),
        &[
            "title",
            "currentFocus",
            "definitionOfDone",
            "details",
            "dueDate",
            "direction",
        ],
    );
    object(
        json!({
            "classification": { "type": "string", "enum": ["standalone_action", "project"] },
            "reason": string(),
            "planningMode": { "type": "string", "enum": ["direct", "staged", "adaptive"] },
            "project": project,
            "milestones": { "type": "array", "items": milestone, "maxItems": 3 },
            "firstAction": action,
            "assumptions": string_array(), "risks": string_array()
        }),
        &[
            "classification",
            "reason",
            "planningMode",
            "project",
            "milestones",
            "firstAction",
            "assumptions",
            "risks",
        ],
    )
}

fn project_replan_schema() -> Value {
    let project_patch = object(
        json!({ "outcome": nullable_string(), "targetDate": nullable_string(), "reviewDate": nullable_string() }),
        &["outcome", "targetDate", "reviewDate"],
    );
    let milestone_change = object(
        json!({
            "id": string(), "action": { "type": "string", "enum": ["complete", "postpone", "supersede", "replace"] },
            "title": nullable_string(), "definitionOfDone": nullable_string(), "dueDate": nullable_string(), "selected": { "type": "boolean" }
        }),
        &[
            "id",
            "action",
            "title",
            "definitionOfDone",
            "dueDate",
            "selected",
        ],
    );
    let new_milestone = object(
        json!({
            "clientId": string(), "title": string(), "definitionOfDone": string(), "dueDate": string(),
            "status": { "type": "string", "enum": ["current", "planned"] }, "selected": { "type": "boolean" }
        }),
        &[
            "clientId",
            "title",
            "definitionOfDone",
            "dueDate",
            "status",
            "selected",
        ],
    );
    let task_change = object(
        json!({
            "id": string(), "action": { "type": "string", "enum": ["complete", "postpone", "cancel", "replace"] },
            "title": nullable_string(), "currentFocus": nullable_string(), "definitionOfDone": nullable_string(), "dueDate": nullable_string(),
            "status": { "type": ["string", "null"], "enum": ["next", "later", "waiting", "done", "cancelled", null] }, "selected": { "type": "boolean" }
        }),
        &[
            "id",
            "action",
            "title",
            "currentFocus",
            "definitionOfDone",
            "dueDate",
            "status",
            "selected",
        ],
    );
    let new_task = object(
        json!({
            "clientId": string(), "milestoneId": nullable_string(), "title": string(), "currentFocus": string(),
            "definitionOfDone": string(), "details": string(), "dueDate": string(), "selected": { "type": "boolean" }
        }),
        &[
            "clientId",
            "milestoneId",
            "title",
            "currentFocus",
            "definitionOfDone",
            "details",
            "dueDate",
            "selected",
        ],
    );
    object(
        json!({
            "summary": string(), "projectPatch": project_patch,
            "milestoneChanges": { "type": "array", "items": milestone_change, "maxItems": 30 },
            "newMilestones": { "type": "array", "items": new_milestone, "maxItems": 1 },
            "taskChanges": { "type": "array", "items": task_change, "maxItems": 50 },
            "newTasks": { "type": "array", "items": new_task, "maxItems": 1 },
            "assumptions": string_array(), "risks": string_array()
        }),
        &[
            "summary",
            "projectPatch",
            "milestoneChanges",
            "newMilestones",
            "taskChanges",
            "newTasks",
            "assumptions",
            "risks",
        ],
    )
}

fn next_action_schema() -> Value {
    let action = object(
        json!({
            "milestoneId": nullable_string(), "title": string(), "currentFocus": string(),
            "definitionOfDone": string(), "details": string(), "dueDate": string()
        }),
        &[
            "milestoneId",
            "title",
            "currentFocus",
            "definitionOfDone",
            "details",
            "dueDate",
        ],
    );
    object(
        json!({ "reason": string(), "action": action }),
        &["reason", "action"],
    )
}

fn health_advice_schema() -> Value {
    let meal_option = object(
        json!({
            "title": string(),
            "foods": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 8 },
            "reason": string()
        }),
        &["title", "foods", "reason"],
    );
    let next_meal = object(
        json!({
            "focus": string(),
            "options": { "type": "array", "items": meal_option, "minItems": 3, "maxItems": 3 }
        }),
        &["focus", "options"],
    );
    object(
        json!({
            "summary": string(),
            "facts": { "type": "array", "items": { "type": "string" }, "maxItems": 12 },
            "sleepAdvice": { "type": "array", "items": { "type": "string" }, "maxItems": 8 },
            "activityAdvice": { "type": "array", "items": { "type": "string" }, "maxItems": 8 },
            "nextMeal": next_meal,
            "attention": { "type": "array", "items": { "type": "string" }, "maxItems": 8 },
            "limitations": { "type": "array", "items": { "type": "string" }, "maxItems": 8 }
        }),
        &[
            "summary",
            "facts",
            "sleepAdvice",
            "activityAdvice",
            "nextMeal",
            "attention",
            "limitations",
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::{
        extract_output_text, validate_planning_scope, validate_references, validate_required_shape,
        ResponsesApiResponse,
    };
    use serde_json::json;

    #[test]
    fn rejects_unnecessary_stages_and_expanding_replans() {
        assert!(validate_planning_scope(
            "project_creation",
            &json!({ "planningMode": "direct", "milestones": [{}] })
        )
        .is_err());
        assert!(validate_planning_scope("project_creation", &json!({ "classification": "standalone_action", "planningMode": "staged", "milestones": [{}] })).is_err());
        assert!(validate_planning_scope(
            "project_creation",
            &json!({ "planningMode": "direct", "milestones": [] })
        )
        .is_ok());
        assert!(validate_planning_scope(
            "project_replan",
            &json!({ "newTasks": [{}, {}], "newMilestones": [] })
        )
        .is_err());
        assert!(validate_planning_scope(
            "project_replan",
            &json!({ "newTasks": [{}], "newMilestones": [] })
        )
        .is_ok());
    }

    #[test]
    fn reads_structured_output_after_thinking_content() {
        let response: ResponsesApiResponse = serde_json::from_value(json!({
            "status": "completed",
            "model": "deepseek-v4-pro",
            "output": [
                { "type": "reasoning", "content": [{ "type": "reasoning_text", "text": "先分析变化" }] },
                { "type": "message", "content": [{ "type": "output_text", "text": "{\"summary\":\"已重排\"}" }] }
            ],
            "usage": {}
        })).unwrap();
        assert_eq!(
            extract_output_text(&response).unwrap(),
            "{\"summary\":\"已重排\"}"
        );
    }

    #[test]
    fn reports_incomplete_responses_instead_of_parsing_reasoning_as_json() {
        let response: ResponsesApiResponse = serde_json::from_value(json!({
            "status": "incomplete",
            "incomplete_details": { "reason": "max_output_tokens" },
            "output": [{ "type": "reasoning", "content": [{ "type": "reasoning_text", "text": "未完成的分析" }] }],
            "usage": {}
        })).unwrap();
        let error = extract_output_text(&response).unwrap_err();
        assert!(error.contains("超过长度上限"));
        assert!(!error.contains("有效 JSON"));
    }

    #[test]
    fn rejects_cross_project_ids() {
        let content = json!({
            "milestoneChanges": [{"id":"other","action":"supersede"}],
            "newMilestones": [], "taskChanges": [], "newTasks": []
        });
        assert!(validate_references("project_replan", &content, &["mine".into()], &[]).is_err());
    }

    #[test]
    fn accepts_known_replan_ids() {
        let content = json!({
            "milestoneChanges": [{"id":"m1","action":"postpone"}],
            "newMilestones": [], "taskChanges": [{"id":"t1","action":"cancel"}],
            "newTasks": [{"clientId":"new-t1","milestoneId":"m1"}]
        });
        assert!(
            validate_references("project_replan", &content, &["m1".into()], &["t1".into()]).is_ok()
        );
    }

    #[test]
    fn rejects_duplicate_new_item_ids() {
        let content = json!({
            "milestoneChanges": [],
            "newMilestones": [
                {"clientId":"new-m1"},
                {"clientId":"new-m1"}
            ],
            "taskChanges": [],
            "newTasks": []
        });
        assert!(validate_references("project_replan", &content, &[], &[]).is_err());
    }

    #[test]
    fn rejects_missing_or_unknown_structured_fields() {
        let valid = json!({
            "reason": "现在先确认答辩日期",
            "action": {
                "milestoneId": null,
                "title": "向导师确认答辩日期",
                "currentFocus": "发送一条确认消息",
                "definitionOfDone": "收到明确日期或确认对方已看到",
                "details": "",
                "dueDate": ""
            }
        });
        assert!(validate_required_shape("next_action", &valid).is_ok());

        let mut missing = valid.clone();
        missing["action"]
            .as_object_mut()
            .unwrap()
            .remove("definitionOfDone");
        assert!(validate_required_shape("next_action", &missing).is_err());

        let mut unknown = valid;
        unknown["action"]["projectId"] = json!("outside-project");
        assert!(validate_required_shape("next_action", &unknown).is_err());
    }

    #[test]
    fn validates_health_advice_nested_fields() {
        let valid = json!({
            "summary": "整体节奏平稳",
            "facts": ["记录了步数"],
            "sleepAdvice": [],
            "activityAdvice": [],
            "nextMeal": {
                "focus": "补充蔬菜",
                "options": [
                    {"title":"方案一","foods":["青菜"],"reason":"补充蔬菜"},
                    {"title":"方案二","foods":["番茄"],"reason":"便于准备"},
                    {"title":"方案三","foods":["菌菇"],"reason":"换一种口味"}
                ]
            },
            "attention": [],
            "limitations": ["没有份量信息"]
        });
        assert!(validate_required_shape("health_advice", &valid).is_ok());

        let mut unknown = valid;
        unknown["nextMeal"]["options"][0]["calories"] = json!(300);
        assert!(validate_required_shape("health_advice", &unknown).is_err());
    }
}

use super::{
    work_observer_analysis as analysis, work_observer_files as files,
    work_observer_screen as screen,
};
use analysis::{AnalysisCoverage, ContextRecord, FileMention, ObserverAnalysis};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};
use tauri::{Emitter, Manager};

const MAX_RECORDS: usize = 200;
const MODEL: &str = "qwen3.5:4b-q4_K_M";

pub(crate) fn recap_model(app: &tauri::AppHandle) -> Option<String> {
    let state = app.state::<ObserverState>();
    initialize(app, &state).ok()?;
    let model = state.inner.lock().ok()?.store.config.model.clone();
    (!model.trim().is_empty()).then_some(model)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ObserverConfig {
    pub roots: Vec<String>,
    pub screenshot: bool,
    pub analyze: bool,
    pub model: String,
    pub interval_seconds: u64,
    pub task_id: Option<String>,
    pub task_label: String,
}
impl Default for ObserverConfig {
    fn default() -> Self {
        Self {
            roots: Vec::new(),
            screenshot: true,
            analyze: true,
            model: MODEL.into(),
            interval_seconds: 300,
            task_id: None,
            task_label: String::new(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Observation {
    pub id: String,
    pub session_id: String,
    pub captured_at: String,
    pub trigger: String,
    pub task_id: Option<String>,
    pub task_label: String,
    pub window_title: String,
    pub application: String,
    pub screenshot: bool,
    pub file_changes: Vec<files::FileChange>,
    #[serde(default)]
    pub file_change_count: Option<usize>,
    pub notes: Vec<String>,
    pub analysis: Option<ObserverAnalysis>,
    pub analysis_error: Option<String>,
    pub model: String,
    pub elapsed_ms: u64,
    #[serde(default)]
    pub context: Vec<ContextRecord>,
    #[serde(default)]
    pub pending_mentions: Vec<FileMention>,
    #[serde(default)]
    pub analysis_coverage: Option<AnalysisCoverage>,
}
#[derive(Default, Serialize, Deserialize)]
struct Store {
    config: ObserverConfig,
    records: Vec<Observation>,
}
struct Inner {
    store: Store,
    loaded: bool,
    load_error: Option<String>,
    enabled: bool,
    busy: bool,
    baseline: Option<files::Snapshot>,
    generation: u64,
    session_id: String,
    last_record: Option<Instant>,
    last_screen_hash: String,
    next_due: Instant,
    status: String,
}
impl Default for Inner {
    fn default() -> Self {
        Self {
            store: Store::default(),
            loaded: false,
            load_error: None,
            enabled: false,
            busy: false,
            baseline: None,
            generation: 0,
            session_id: uuid::Uuid::new_v4().to_string(),
            last_record: None,
            last_screen_hash: String::new(),
            next_due: Instant::now(),
            status: "自动观察未开启".into(),
        }
    }
}
#[derive(Default)]
pub(crate) struct ObserverState {
    inner: Mutex<Inner>,
    gate: tokio::sync::Mutex<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObserverStatus {
    config: ObserverConfig,
    enabled: bool,
    busy: bool,
    status: String,
    records: Vec<Observation>,
    storage_path: String,
}

fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("work-observer"))
        .map_err(|error| error.to_string())
}
fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("工作记录仅供主窗口访问。".into());
    }
    Ok(())
}
fn initialize(app: &tauri::AppHandle, state: &ObserverState) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|_| "工作记录状态不可用")?;
    if inner.loaded {
        return inner.load_error.clone().map_or(Ok(()), Err);
    }
    let path = directory(app)?.join("records.json");
    match fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<Store>(&bytes) {
            Ok(store) => inner.store = store,
            Err(error) => {
                inner.load_error = Some(format!("工作记录文件无法读取，已保留原文件：{error}"))
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => inner.load_error = Some(format!("工作记录文件无法读取：{error}")),
    }
    inner.loaded = true;
    inner.load_error.clone().map_or(Ok(()), Err)
}
fn persist(app: &tauri::AppHandle, store: &Store) -> Result<(), String> {
    let directory = directory(app)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec(store).map_err(|error| error.to_string())?;
    let temporary = directory.join("records.tmp");
    fs::write(&temporary, bytes).map_err(|error| format!("工作记录写入失败：{error}"))?;
    fs::rename(&temporary, directory.join("records.json"))
        .map_err(|error| format!("工作记录保存失败：{error}"))
}
pub(crate) fn snapshot(
    app: &tauri::AppHandle,
    state: &ObserverState,
) -> Result<ObserverStatus, String> {
    initialize(app, state)?;
    let inner = state.inner.lock().map_err(|_| "工作记录状态不可用")?;
    Ok(ObserverStatus {
        config: inner.store.config.clone(),
        enabled: inner.enabled,
        busy: inner.busy,
        status: inner.status.clone(),
        records: inner.store.records.iter().rev().cloned().collect(),
        storage_path: directory(app)?.to_string_lossy().into_owned(),
    })
}
fn announce(app: &tauri::AppHandle) {
    let _ = app.emit("work-observer-changed", ());
}

#[tauri::command]
pub(crate) fn work_observer_status(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ObserverState>,
) -> Result<ObserverStatus, String> {
    main_window(&window)?;
    snapshot(&app, &state)
}

fn normalize_config(mut config: ObserverConfig) -> Result<ObserverConfig, String> {
    if !(60..=1800).contains(&config.interval_seconds) {
        return Err("观察间隔应为 1–30 分钟。".into());
    }
    if config.roots.len() > 3 {
        return Err("试用版最多选择 3 个工作文件夹。".into());
    }
    if !config.screenshot && config.roots.is_empty() {
        return Err("请选择工作文件夹，或开启整屏截图。".into());
    }
    if config.model.is_empty()
        || config.model.len() > 160
        || !config
            .model
            .chars()
            .all(|v| v.is_ascii_alphanumeric() || "._-:/".contains(v))
    {
        return Err("本地模型名称不正确。".into());
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    for root in &config.roots {
        let path = fs::canonicalize(root).map_err(|_| format!("文件夹不存在或无法读取：{root}"))?;
        if !path.is_dir() || path.parent().is_none() {
            return Err("请选择具体工作文件夹，不要选择整个磁盘。".into());
        }
        if roots.iter().any(|existing| path.starts_with(existing)) {
            continue;
        }
        roots.retain(|existing| !existing.starts_with(&path));
        roots.push(path);
    }
    config.roots = roots
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    config.task_label = config.task_label.chars().take(240).collect();
    config.task_id = config
        .task_id
        .filter(|id| !id.is_empty() && id.len() <= 128);
    Ok(config)
}

#[tauri::command]
pub(crate) fn work_observer_configure(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ObserverState>,
    config: ObserverConfig,
) -> Result<ObserverStatus, String> {
    main_window(&window)?;
    initialize(&app, &state)?;
    let config = normalize_config(config)?;
    {
        let mut inner = state.inner.lock().map_err(|_| "工作记录状态不可用")?;
        if inner.busy {
            return Err("请等当前观察保存后再修改采集范围。".into());
        }
        if inner.store.config.roots != config.roots {
            inner.baseline = None;
            inner.session_id = uuid::Uuid::new_v4().to_string();
        }
        if inner.store.config.task_id != config.task_id {
            inner.session_id = uuid::Uuid::new_v4().to_string();
        }
        let previous = std::mem::replace(&mut inner.store.config, config);
        if let Err(error) = persist(&app, &inner.store) {
            inner.store.config = previous;
            return Err(error);
        }
        inner.generation += 1;
        inner.next_due = Instant::now() + Duration::from_secs(inner.store.config.interval_seconds);
    }
    announce(&app);
    snapshot(&app, &state)
}

#[tauri::command]
pub(crate) fn work_observer_set_enabled(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ObserverState>,
    enabled: bool,
) -> Result<ObserverStatus, String> {
    main_window(&window)?;
    initialize(&app, &state)?;
    {
        let mut inner = state.inner.lock().map_err(|_| "工作记录状态不可用")?;
        if enabled {
            normalize_config(inner.store.config.clone())?;
            inner.session_id = uuid::Uuid::new_v4().to_string();
            inner.next_due = Instant::now();
        }
        inner.enabled = enabled;
        inner.status = if enabled {
            "自动观察已开启，等待下一次采集"
        } else {
            "自动观察已暂停"
        }
        .into();
    }
    announce(&app);
    snapshot(&app, &state)
}

pub(crate) fn pause(app: &tauri::AppHandle, state: &ObserverState) -> Result<(), String> {
    initialize(app, state)?;
    {
        let mut inner = state.inner.lock().map_err(|_| "工作记录状态不可用")?;
        inner.enabled = false;
        inner.status = "自动观察已暂停".into();
    }
    announce(app);
    Ok(())
}

#[tauri::command]
pub(crate) async fn work_observer_capture(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ObserverState>,
) -> Result<ObserverStatus, String> {
    main_window(&window)?;
    initialize(&app, &state)?;
    observe(&app, &state, false).await?;
    snapshot(&app, &state)
}

#[tauri::command]
pub(crate) fn work_observer_image(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ObserverState>,
    id: String,
) -> Result<Option<String>, String> {
    main_window(&window)?;
    initialize(&app, &state)?;
    let inner = state.inner.lock().map_err(|_| "工作记录状态不可用")?;
    if !inner
        .store
        .records
        .iter()
        .any(|record| record.id == id && record.screenshot)
    {
        return Err("截图记录不存在。".into());
    }
    let path = directory(&app)?
        .join("screenshots")
        .join(format!("{id}.png"));
    match fs::read(path) {
        Ok(bytes) => Ok(Some(format!(
            "data:image/png;base64,{}",
            STANDARD.encode(bytes)
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取原图：{error}")),
    }
}

pub(crate) fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let state = app.state::<ObserverState>();
            if initialize(&app, &state).is_err() {
                continue;
            }
            let due = state
                .inner
                .lock()
                .map(|inner| inner.enabled && !inner.busy && Instant::now() >= inner.next_due)
                .unwrap_or(false);
            if due {
                let _ = observe(&app, &state, true).await;
            }
        }
    });
}

async fn observe(
    app: &tauri::AppHandle,
    state: &ObserverState,
    automatic: bool,
) -> Result<(), String> {
    let _guard = state
        .gate
        .try_lock()
        .map_err(|_| "已有一次观察正在进行。")?;
    let (config, generation, mut session_id, baseline, previous_hash) = {
        let mut inner = state.inner.lock().map_err(|_| "工作记录状态不可用")?;
        inner.busy = true;
        inner.status = "正在采集，稍后保存工作记录".into();
        inner.next_due = Instant::now() + Duration::from_secs(inner.store.config.interval_seconds);
        if inner
            .last_record
            .is_some_and(|last| last.elapsed() > Duration::from_secs(1800))
        {
            inner.session_id = uuid::Uuid::new_v4().to_string();
        }
        (
            inner.store.config.clone(),
            inner.generation,
            inner.session_id.clone(),
            inner.baseline.clone(),
            inner.last_screen_hash.clone(),
        )
    };
    announce(app);
    if !automatic {
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    let started = Instant::now();
    let result = collect(
        app,
        &config,
        automatic,
        baseline,
        &previous_hash,
        &mut session_id,
    )
    .await;
    let mut analyze_record = None;
    {
        let mut inner = state.inner.lock().map_err(|_| "工作记录状态不可用")?;
        match result {
            Ok(Some((mut record, baseline, hash, image))) => {
                analysis::enrich(&mut record, &inner.store.records, config.analyze);
                let previous_records = inner.store.records.clone();
                // Commit evidence before asking the model; an unavailable model or app exit
                // must not discard the work that was already collected.
                inner.store.records.push(record.clone());
                let extra = inner.store.records.len().saturating_sub(MAX_RECORDS);
                if extra > 0 {
                    inner.store.records.drain(..extra);
                }
                if let Err(error) = persist(app, &inner.store) {
                    inner.store.records = previous_records;
                    inner.status = error.clone();
                    inner.busy = false;
                    drop(inner);
                    announce(app);
                    return Err(error);
                }
                if inner.generation == generation {
                    inner.baseline = Some(baseline);
                    inner.last_screen_hash = hash;
                }
                inner.last_record = Some(Instant::now());
                inner.status = if inner.enabled {
                    "自动观察已开启；最近一次记录已保存"
                } else {
                    "最近一次记录已保存；自动观察未开启"
                }
                .into();
                if config.analyze {
                    analyze_record = Some((record, image));
                    inner.status = "采集证据已保存，正在用本地 AI 整理".into();
                }
                prune_screenshots(app, &inner.store.records);
            }
            Ok(None) => {
                inner.status = if inner.enabled {
                    "自动观察已开启；锁屏、空闲或画面未变时跳过"
                } else {
                    "本次没有可保存的新内容"
                }
                .into()
            }
            Err(error) => {
                inner.status = error.clone();
                inner.busy = false;
                drop(inner);
                announce(app);
                return Err(error);
            }
        }
        if analyze_record.is_none() {
            inner.busy = false;
        }
    }
    announce(app);
    if let Some((mut record, image)) = analyze_record {
        if image
            .as_ref()
            .is_some_and(|bytes| bytes.len() > 20 * 1024 * 1024)
        {
            record.analysis_error = Some("原图超过 20 MB，已保存证据并跳过 AI 分析。".into());
        } else {
            match analyze(app, &record, image.as_deref()).await {
                Ok(analysis) => record.analysis = Some(analysis),
                Err(error) => record.analysis_error = Some(error),
            }
        }
        record.elapsed_ms = started.elapsed().as_millis() as u64;
        let mut inner = state.inner.lock().map_err(|_| "工作记录状态不可用")?;
        if let Some(saved) = inner
            .store
            .records
            .iter_mut()
            .find(|saved| saved.id == record.id)
        {
            *saved = record;
        }
        inner.busy = false;
        inner.status = if inner.enabled {
            "自动观察已开启；最近一次记录已保存"
        } else {
            "最近一次记录已保存；自动观察未开启"
        }
        .into();
        if let Err(error) = persist(app, &inner.store) {
            inner.status = format!("采集证据已保存，但 AI 草稿保存失败：{error}");
        }
        drop(inner);
        announce(app);
    }
    Ok(())
}

async fn collect(
    app: &tauri::AppHandle,
    config: &ObserverConfig,
    automatic: bool,
    baseline: Option<files::Snapshot>,
    previous_hash: &str,
    session_id: &mut String,
) -> Result<Option<(Observation, files::Snapshot, String, Option<Vec<u8>>)>, String> {
    let start = Instant::now();
    let config_capture = config.clone();
    let sampled = tauri::async_runtime::spawn_blocking(move || {
        let activity = screen::activity();
        if !activity.available || (automatic && activity.idle_seconds >= 180) {
            return Ok(None);
        }
        let scan = files::scan(&config_capture.roots);
        let activity = screen::activity();
        if !activity.available {
            return Ok(None);
        }
        let own_window = activity
            .application
            .eq_ignore_ascii_case("life-strategy-library.exe");
        let codex_window = activity.application.eq_ignore_ascii_case("codex.exe");
        let screenshot =
            if config_capture.screenshot && !(automatic && (own_window || codex_window)) {
                Some(screen::capture())
            } else {
                None
            };
        Ok::<_, String>(Some((activity, scan, screenshot)))
    })
    .await
    .map_err(|error| error.to_string())??;
    let Some((activity, mut scan, screenshot)) = sampled else {
        if automatic {
            return Ok(None);
        }
        return Err("当前桌面已锁定或无法读取，请解锁后再观察。".into());
    };
    let mut changes = baseline
        .as_ref()
        .map(|before| files::changes(before, &scan.files, scan.complete))
        .unwrap_or_default();
    if baseline.is_none() && !config.roots.is_empty() {
        scan.notes.push(format!(
            "首次建立文件基线（{} 个文件），不把已有文件算成新增。",
            scan.files.len()
        ));
    }
    if !scan.complete {
        if let Some(before) = baseline {
            for (path, file) in before {
                scan.files.entry(path).or_insert(file);
            }
        }
    }
    let file_change_count = changes.len();
    if changes.len() > 40 {
        scan.notes.push(format!(
            "发现 {} 个文件变化，本条展示前 40 个。",
            changes.len()
        ));
        changes.truncate(40);
    }
    let image = match screenshot {
        Some(Ok(bytes)) => Some(bytes),
        Some(Err(error)) => {
            scan.notes.push(error);
            None
        }
        None => None,
    };
    let hash = image
        .as_ref()
        .map(|bytes| hex::encode(Sha256::digest(bytes)))
        .unwrap_or_default();
    if automatic && changes.is_empty() && !hash.is_empty() && hash == previous_hash {
        return Ok(None);
    }
    if image.is_none() && changes.is_empty() && automatic && scan.notes.is_empty() {
        return Ok(None);
    }
    let id = uuid::Uuid::new_v4().to_string();
    if let Some(bytes) = &image {
        let directory = directory(app)?.join("screenshots");
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        fs::write(directory.join(format!("{id}.png")), bytes)
            .map_err(|error| format!("截图保存失败：{error}"))?;
    }
    let record = Observation {
        id,
        session_id: session_id.clone(),
        captured_at: Utc::now().to_rfc3339(),
        trigger: if automatic { "automatic" } else { "manual" }.into(),
        task_id: config.task_id.clone(),
        task_label: config.task_label.clone(),
        window_title: activity.title,
        application: activity.application,
        screenshot: image.is_some(),
        file_changes: changes,
        file_change_count: Some(file_change_count),
        notes: scan.notes,
        analysis: None,
        analysis_error: None,
        model: config.model.clone(),
        elapsed_ms: 0,
        context: Vec::new(),
        pending_mentions: Vec::new(),
        analysis_coverage: None,
    };
    let record = Observation {
        elapsed_ms: start.elapsed().as_millis() as u64,
        ..record
    };
    Ok(Some((record, scan.files, hash, image)))
}

async fn analyze(
    _app: &tauri::AppHandle,
    record: &Observation,
    image: Option<&[u8]>,
) -> Result<ObserverAnalysis, String> {
    #[cfg(windows)]
    _app.state::<super::ollama_runtime::OllamaRuntime>()
        .ensure_ready()
        .await?;
    let prepared = analysis::prepare(record);
    let mut message = json!({"role":"user","content":serde_json::to_string(&prepared.content).map_err(|error| error.to_string())?});
    if let Some(bytes) = image {
        message["images"] = json!([STANDARD.encode(bytes)]);
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())?;
    let response = client.post("http://127.0.0.1:11434/api/chat").json(&json!({
        "model":record.model,"stream":false,"think":false,"keep_alive":"2m","format":analysis::schema(),"options":{"temperature":0,"num_ctx":8192,"num_predict":950},
        "messages":[{"role":"system","content":analysis::SYSTEM_PROMPT},message]
    })).send().await.map_err(|error| format!("本地模型暂时不可用，原始记录已保存：{error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.json::<Value>().await.unwrap_or_default();
        let detail: String = body["error"]
            .as_str()
            .unwrap_or("请检查 Ollama 的运行状态和模型能力")
            .chars()
            .take(240)
            .collect();
        return Err(format!(
            "本地模型请求失败（{status}）：{detail}。原始记录已保存。"
        ));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > 128 * 1024 {
        return Err("AI 返回过长，已保留原始记录。".into());
    }
    let envelope: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if envelope["done_reason"] == "length" {
        return Err("AI 输出被截断，已保留原始记录。".into());
    }
    let content = envelope["message"]["content"]
        .as_str()
        .ok_or("AI 没有返回有效草稿。")?;
    analysis::validate(
        serde_json::from_str::<Value>(content).map_err(|_| "AI 草稿无法解析，原始记录已保存。")?,
        record,
        &prepared,
    )
}

fn prune_screenshots(app: &tauri::AppHandle, records: &[Observation]) {
    let Ok(directory) = directory(app).map(|v| v.join("screenshots")) else {
        return;
    };
    let Ok(entries) = fs::read_dir(&directory) else {
        return;
    };
    let mut files: Vec<_> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(".png")?;
            uuid::Uuid::parse_str(id).ok()?;
            let metadata = entry.metadata().ok()?;
            Some((
                entry.path(),
                metadata.len(),
                metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                records.iter().any(|r| r.id == id),
            ))
        })
        .collect();
    files.sort_by_key(|entry| std::cmp::Reverse(entry.2));
    let mut total = 0;
    for (path, size, modified, referenced) in files {
        total += size;
        if !referenced
            || modified.elapsed().unwrap_or_default() > Duration::from_secs(7 * 86400)
            || total > 250 * 1024 * 1024
        {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_records_remain_readable() {
        let old = json!({"id":"old","sessionId":"session","capturedAt":"2026-10-03T00:00:00Z","trigger":"manual","taskId":null,"taskLabel":"","windowTitle":"editor","application":"editor.exe","screenshot":false,"fileChanges":[],"notes":[],"analysis":{"observations":[],"resumeHint":null,"uncertainties":[]},"analysisError":null,"model":"local","elapsedMs":10});
        let record: Observation = serde_json::from_value(old).unwrap();
        assert_eq!(record.analysis.unwrap().version, 1);
        assert!(record.context.is_empty());
        assert!(record.analysis_coverage.is_none());
    }
    #[test]
    fn no_evidence_and_extreme_intervals_are_rejected() {
        let mut config = ObserverConfig::default();
        config.screenshot = false;
        assert!(normalize_config(config).is_err());
        let mut config = ObserverConfig::default();
        config.interval_seconds = 1;
        assert!(normalize_config(config).is_err());
    }
    #[test]
    fn automatic_collection_is_disabled_on_restart() {
        assert!(!Inner::default().enabled);
    }
}

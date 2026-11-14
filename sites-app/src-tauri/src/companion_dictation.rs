use std::{
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::Emitter;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

#[derive(Default)]
pub(crate) struct Dictation(Mutex<Option<Arc<AtomicBool>>>);
impl Dictation {
    pub(crate) fn stop(&self) {
        if let Ok(current) = self.0.lock() {
            if let Some(cancel) = current.as_ref() {
                cancel.store(true, Ordering::SeqCst);
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn asaba_dictation(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Dictation>,
    operation: String,
    request_id: Option<String>,
) -> Result<String, String> {
    super::asaba::pet_window(&window)?;
    if operation == "stop" {
        state.stop();
        return Ok(String::new());
    }
    if operation != "listen" {
        return Err("无法识别听写操作。".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut current = state.0.lock().map_err(|_| "听写状态不可用")?;
        if current.is_some() {
            return Err("上次听写正在收尾。".into());
        }
        *current = Some(cancel.clone());
    }
    let result = listen(&window, request_id.unwrap_or_default(), cancel).await;
    if let Ok(mut current) = state.0.lock() {
        *current = None;
    }
    result
}

async fn listen(
    window: &tauri::WebviewWindow,
    id: String,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {
    let root = std::env::var_os("WORKBENCH_ASR_ROOT")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("PersonalWorkbench/asr"))
        })
        .ok_or("找不到本机听写目录")?;
    let bytes = tokio::fs::read(root.join("runtime.json"))
        .await
        .map_err(|_| "请先运行 install-asaba-asr.ps1 安装本机中文听写。")?;
    let config: serde_json::Value =
        serde_json::from_slice(bytes.strip_prefix(&[239, 187, 191]).unwrap_or(&bytes))
            .map_err(|_| "听写配置无法读取")?;
    let python = config["python"].as_str().ok_or("听写 Python 未配置")?;
    let model = config["model"].as_str().ok_or("中文识别模型未配置")?;
    let mut command = Command::new(python);
    command
        .args([
            "-u",
            "-c",
            include_str!("../../scripts/asaba-asr.py"),
            "--model",
            model,
        ])
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动本机听写：{e}"))?;
    let mut input = child.stdin.take().ok_or("无法停止听写")?;
    let mut lines = BufReader::new(child.stdout.take().ok_or("无法读取听写")?).lines();
    let mut stopping = false;
    let mut latest = String::new();
    let started = std::time::Instant::now();
    let mut stop_at: Option<std::time::Instant> = None;
    loop {
        if cancel.load(Ordering::SeqCst) && !stopping {
            input
                .write_all(b"stop\n")
                .await
                .map_err(|e| e.to_string())?;
            stopping = true;
            stop_at = Some(std::time::Instant::now());
        }
        if started.elapsed() > Duration::from_secs(150)
            || stop_at.is_some_and(|t| t.elapsed() > Duration::from_secs(10))
        {
            return Err("本机听写响应超时，已释放麦克风。预览文字仍可复制。".into());
        }
        let line = match tokio::time::timeout(Duration::from_millis(100), lines.next_line()).await {
            Err(_) => continue,
            Ok(result) => result.map_err(|e| e.to_string())?,
        };
        let Some(line) = line else {
            break;
        };
        let Ok(mut event) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(error) = event["error"].as_str() {
            return Err(format!("本机听写失败：{error}"));
        }
        if let Some(text) = event["text"].as_str() {
            latest = text.to_owned();
        }
        event["id"] = serde_json::json!(id);
        let _ = window.emit("asaba-dictation-text", &event);
        if event["final"] == true {
            let _ = child.wait().await;
            return Ok(latest);
        }
    }
    Err("本机听写意外结束，预览文字仍可复制。".into())
}

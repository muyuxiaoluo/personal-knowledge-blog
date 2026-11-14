use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use tauri::Emitter;

const SPEECH: &str = "http://127.0.0.1:8768";
const CONTROL: &str = "http://127.0.0.1:8769/v1/services/tts";
// Qianyu-TTS allows 180 seconds for model loading, plus the first synthesis.
const COLD_TIMEOUT: Duration = Duration::from_secs(205);
const WARM_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Default)]
pub(crate) struct QianyuVoice {
    startup: tokio::sync::Mutex<()>,
    process: tokio::sync::Mutex<Option<tokio::process::Child>>,
}

#[tauri::command]
pub(crate) async fn asaba_synthesize(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, QianyuVoice>,
    text: String,
) -> Result<tauri::ipc::Response, String> {
    super::asaba::pet_window(&window)?;
    let text = text.trim();
    if text.is_empty()
        || text.chars().count() > 60
        || ["http://", "https://", "<", ">"]
            .iter()
            .any(|part| text.contains(part))
    {
        return Err("这段台词无法合成，请检查正文。".into());
    }
    let root = std::env::var_os("WORKBENCH_QIANYU_TTS_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"D:\AI voice\Qianyu-TTS"));
    let token = tokio::fs::read_to_string(root.join("token.txt"))
        .await
        .map_err(|_| "找不到 Qianyu-TTS 的本机凭据。")?;
    let token = token.trim_start_matches('\u{feff}').trim();
    if !(32..=256).contains(&token.len()) || token.chars().any(char::is_whitespace) {
        return Err("Qianyu-TTS 的本机凭据格式无效。".into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(WARM_TIMEOUT)
        .build()
        .map_err(|_| "无法连接本机语音服务。")?;
    let mut service = ready(&client, token, &state, &root).await?;
    if service["busy"].as_bool() == Some(true) {
        let _ = window.emit("asaba-tts-phase", "正在等语音服务空闲");
        let deadline = tokio::time::Instant::now() + COLD_TIMEOUT;
        while service["busy"].as_bool() == Some(true) {
            if tokio::time::Instant::now() >= deadline {
                return Err("语音服务仍在处理上一句，请稍后从当前句继续。".into());
            }
            tokio::time::sleep(Duration::from_millis(750)).await;
            service = health(&client, token)
                .await?
                .ok_or("浅羽音色服务已关闭。")?;
        }
    }
    let cold = service["model_state"].as_str() != Some("loaded");
    let _ = window.emit(
        "asaba-tts-phase",
        if cold {
            "正在加载浅羽音色，首次可能需要几分钟"
        } else {
            "正在合成语音"
        },
    );
    let response = client
        .post(format!("{SPEECH}/v1/tts"))
        .timeout(if cold { COLD_TIMEOUT } else { WARM_TIMEOUT })
        .bearer_auth(token)
        .json(&json!({ "text": text }))
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() && cold {
                "浅羽音色加载未完成，请检查本机语音服务后重试。"
            } else if error.is_timeout() {
                "浅羽这句话合成超时，可以从当前句继续。"
            } else {
                "浅羽语音服务连接中断，可以从当前句继续。"
            }
        })?;
    match response.status().as_u16() {
        200 => {}
        429 => return Err("浅羽正在为另一条消息配音，稍后再试。".into()),
        401 => return Err("Qianyu-TTS 的本机凭据不匹配。".into()),
        503 if cold => {
            return Err("本机音色加载或合成失败，可在 Qianyu-TTS 日志中查看原因。".into())
        }
        _ => return Err("Qianyu-TTS 没有合成这段台词。".into()),
    }
    if !response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("audio/wav"))
        || response
            .content_length()
            .is_none_or(|len| !(44..=1_100_000).contains(&len))
    {
        return Err("本机语音返回的音频格式异常。".into());
    }
    let bytes = response.bytes().await.map_err(|_| "无法读取浅羽音频。")?;
    if bytes.get(..4) != Some(b"RIFF") || bytes.get(8..12) != Some(b"WAVE") {
        return Err("本机语音返回的音频格式异常。".into());
    }
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

async fn health(client: &reqwest::Client, token: &str) -> Result<Option<Value>, String> {
    let response = match client
        .get(format!("{SPEECH}/health"))
        .bearer_auth(token)
        .timeout(Duration::from_secs(2))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) if error.is_connect() || error.is_timeout() => return Ok(None),
        Err(_) => return Err("无法读取 Qianyu-TTS 状态。".into()),
    };
    if response.status().as_u16() == 401 {
        return Err("Qianyu-TTS 的本机凭据不匹配。".into());
    }
    let health: Value = response
        .error_for_status()
        .map_err(|_| "本机语音端口返回了意外响应。")?
        .json()
        .await
        .map_err(|_| "本机语音端口返回了意外响应。")?;
    if health["model"].as_str() != Some("v5turbo") {
        return Err("本机语音端口当前未运行浅羽的 V5 Turbo 音色。".into());
    }
    Ok(
        (health["ready"].as_bool() == Some(true) && health["accepting"].as_bool() != Some(false))
            .then_some(health),
    )
}

async fn ready(
    client: &reqwest::Client,
    token: &str,
    state: &QianyuVoice,
    root: &std::path::Path,
) -> Result<Value, String> {
    if let Some(service) = health(client, token).await? {
        return Ok(service);
    }
    let _lock = state.startup.lock().await;
    if let Some(service) = health(client, token).await? {
        return Ok(service);
    }
    match client
        .post(CONTROL)
        .bearer_auth(token)
        .json(&json!({"enabled":true}))
        .timeout(Duration::from_secs(8))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() || response.status().as_u16() == 409 => {}
        Err(error) if error.is_timeout() => {}
        #[cfg(windows)]
        Err(error) if error.is_connect() => start_installed_service(root, state).await?,
        _ => return Err("浅羽音色离线。请在机器人「本机语音与唱歌」中开启语音服务。".into()),
    }
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(50) {
        tokio::time::sleep(Duration::from_millis(650)).await;
        if let Some(service) = health(client, token).await? {
            return Ok(service);
        }
    }
    Err("浅羽音色仍在预热，请稍后再试。".into())
}

#[cfg(windows)]
async fn start_installed_service(
    root: &std::path::Path,
    state: &QianyuVoice,
) -> Result<(), String> {
    let directory = std::path::Path::new(r"D:\bot-qy");
    let python = root.join("engine").join("runtime").join("python.exe");
    let config = directory.join("config").join("tts.json");
    let unavailable = "浅羽音色离线，请先开启 Qianyu-TTS。";
    let content = tokio::fs::read_to_string(&config)
        .await
        .map_err(|_| unavailable)?;
    let settings: Value =
        serde_json::from_str(content.trim_start_matches('\u{feff}')).map_err(|_| unavailable)?;
    let configured = settings["root"].as_str().ok_or(unavailable)?;
    let path = config.parent().ok_or(unavailable)?.join(configured);
    if tokio::fs::canonicalize(path).await.ok().as_ref()
        != Some(
            &tokio::fs::canonicalize(root)
                .await
                .map_err(|_| unavailable)?,
        )
        || !python.is_file()
    {
        return Err(unavailable.into());
    }
    let mut process = state.process.lock().await;
    if let Some(child) = process.as_mut() {
        if child.try_wait().map_err(|_| unavailable)?.is_none() {
            return Ok(());
        }
    }
    let mut command = tokio::process::Command::new(python);
    command
        .args(["-B", "-u", "-m", "services.qy_tts", "serve", "--config"])
        .arg(config)
        .current_dir(directory)
        .env("PYTHONPATH", directory)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .creation_flags(0x08000000)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    *process = Some(
        command
            .spawn()
            .map_err(|_| "无法启动已安装的 Qianyu-TTS，请在机器人管理页检查语音服务。")?,
    );
    Ok(())
}

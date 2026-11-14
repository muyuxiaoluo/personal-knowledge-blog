use crate::xiaomi_protocol::{self as protocol, Session, ACCOUNT, HEALTH, SID};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::{Duration as Days, FixedOffset, Utc};
use md5::Md5;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::State;
use tokio::sync::Mutex;

const SECRET_SERVICE: &str = "com.muyuxiaoluo.life-strategy-library";
const SECRET_ACCOUNT: &str = "xiaomi_health_session";

#[derive(Default)]
pub struct XiaomiHealthState {
    pending: Mutex<Option<Pending>>,
    pending_qr: Mutex<Option<QrLoginJob>>,
    operation: Mutex<()>,
}
struct PendingQr {
    id: String,
    created: Instant,
    lifetime: Duration,
    polling_url: String,
    session: Session,
}

enum QrOutcome {
    Waiting,
    Ready(Credentials),
    Failed(String),
}
struct QrProgress {
    outcome: QrOutcome,
    trace: Vec<protocol::LoginTrace>,
}
struct QrLoginJob {
    id: String,
    progress: Arc<Mutex<QrProgress>>,
    task: tauri::async_runtime::JoinHandle<()>,
}
impl Drop for QrLoginJob {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn start_qr_job(mut pending: PendingQr) -> QrLoginJob {
    let progress = Arc::new(Mutex::new(QrProgress {
        outcome: QrOutcome::Waiting,
        trace: pending.session.trace.clone(),
    }));
    let result = progress.clone();
    let id = pending.id.clone();
    // Keep one server request alive for the QR lifetime. UI status checks only
    // inspect progress; they never open another long-poll or reset its session.
    let task = tauri::async_runtime::spawn(async move {
        let completion = finish_qr_login(&mut pending).await;
        let mut result = result.lock().await;
        result.trace = pending.session.trace.clone();
        result.outcome = match completion {
            Ok(Some(credentials)) => QrOutcome::Ready(credentials),
            Ok(None) => QrOutcome::Failed("二维码已过期，请刷新二维码".into()),
            Err(message) => QrOutcome::Failed(message),
        };
    });
    QrLoginJob { id, progress, task }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrLoginReply {
    stage: String,
    login_id: String,
    image_data_url: Option<String>,
    expires_at: Option<String>,
}

async fn begin_qr_login(mut session: Session) -> Result<(PendingQr, QrLoginReply), String> {
    // The same miothealth service supports Xiaomi's account QR login flow.
    // Protocol reference: lzghzr/ha_miband, cloud.py QrCodeXiaomiCloudConnector.
    let value = session
        .json(
            Method::GET,
            &format!("{ACCOUNT}/longPolling/loginUrl"),
            &[
                ("_qrsize", "240".into()),
                ("qs", "%3Fsid%3Dmiothealth%26_json%3Dtrue".into()),
                (
                    "callback",
                    "https://sts-hlth.io.mi.com/healthapp/sts".into(),
                ),
                ("_hasLogo", "false".into()),
                ("sid", SID.into()),
                ("serviceParam", "".into()),
                ("_locale", "zh_CN".into()),
                ("_dc", Utc::now().timestamp_millis().to_string()),
            ],
            true,
            false,
        )
        .await?;
    if value["code"].as_i64() != Some(0) {
        return Err("小米暂未生成登录二维码，请稍后重试".into());
    }
    #[cfg(test)]
    if std::env::var("XIAOMI_ANONYMOUS_PROBE").as_deref() == Ok("1") {
        // Routing metadata only. Never print QR tickets or full returned URLs.
        for field in ["qr", "lp"] {
            if let Ok(url) = url::Url::parse(&text(&value, field)) {
                println!(
                    "anonymous QR {field} host={:?} path={}",
                    url.host_str(),
                    url.path()
                );
            }
        }
    }
    let polling_url = text(&value, "lp");
    protocol::qr_poll_url(&polling_url)?;
    let image_url = protocol::allowed_url(&text(&value, "qr"))?;
    if image_url.host_str() != Some("account.xiaomi.com") {
        return Err("小米二维码图片地址无效".into());
    }
    let seconds = value["timeout"]
        .as_u64()
        .filter(|seconds| (1..=600).contains(seconds))
        .ok_or("小米二维码有效期无效")?;
    let image = session
        .request(Method::GET, image_url.as_str(), &[], false, true, false)
        .await?;
    if image.len() > 1_000_000 || !image.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("小米未返回有效的二维码图片".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let reply = QrLoginReply {
        stage: "qrcode".into(),
        login_id: id.clone(),
        image_data_url: Some(format!("data:image/png;base64,{}", B64.encode(image))),
        expires_at: Some((Utc::now() + chrono::Duration::seconds(seconds as i64)).to_rfc3339()),
    };
    Ok((
        PendingQr {
            id,
            created: Instant::now(),
            lifetime: Duration::from_secs(seconds),
            polling_url,
            session,
        },
        reply,
    ))
}

async fn finish_qr_login(pending: &mut PendingQr) -> Result<Option<Credentials>, String> {
    if pending.created.elapsed() >= pending.lifetime {
        return Err("二维码已过期，请刷新二维码".into());
    }
    let remaining = pending.lifetime.saturating_sub(pending.created.elapsed());
    let Some(value) = pending
        .session
        .poll_qr(&pending.polling_url, remaining)
        .await?
    else {
        return Ok(None);
    };
    if value["code"].as_i64() != Some(0) || text(&value, "ssecurity").is_empty() {
        let code = value["code"]
            .as_i64()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "未提供".into());
        return Err(format!("扫码确认未完成（错误码 {code}），请刷新二维码"));
    }
    let credentials = complete(&mut pending.session, &value, None).await?;
    if !credentials.missing_fields().is_empty() {
        return Err("扫码后未取得完整健康登录状态，请重新连接".into());
    }
    Ok(Some(credentials))
}

#[tauri::command]
pub async fn xiaomi_health_qr_start(
    state: State<'_, XiaomiHealthState>,
) -> Result<QrLoginReply, String> {
    let _operation = state.operation.lock().await;
    *state.pending.lock().await = None;
    *state.pending_qr.lock().await = None;
    let (pending, reply) = begin_qr_login(Session::new()?).await?;
    *state.pending_qr.lock().await = Some(start_qr_job(pending));
    Ok(reply)
}

#[tauri::command]
pub async fn xiaomi_health_qr_poll(
    state: State<'_, XiaomiHealthState>,
    login_id: String,
) -> Result<QrLoginReply, String> {
    let _operation = state.operation.lock().await;
    let mut slot = state.pending_qr.lock().await;
    let job = slot
        .as_ref()
        .filter(|pending| pending.id == login_id)
        .ok_or("扫码登录已取消，请重新连接")?;
    let progress = job.progress.lock().await;
    let stage = match &progress.outcome {
        QrOutcome::Waiting => "waiting",
        QrOutcome::Failed(message) => return Err(message.clone()),
        QrOutcome::Ready(credentials) => {
            persist(credentials)?;
            "connected"
        }
    };
    drop(progress);
    if stage == "connected" {
        *slot = None;
    }
    Ok(QrLoginReply {
        stage: stage.into(),
        login_id,
        image_data_url: None,
        expires_at: None,
    })
}
struct Pending {
    id: String,
    created: Instant,
    username: String,
    // Credential-equivalent hash, memory-only for this one challenged login.
    password_hash: String,
    session: Session,
    verification: Option<(String, i64)>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Credentials {
    security: String,
    service_token: String,
    cuser_id: String,
    user_id: String,
    pass_token: String,
}
impl Credentials {
    fn account_key(&self) -> String {
        hex::encode(Sha256::digest(self.user_id.as_bytes()))
    }

    fn missing_fields(&self) -> Vec<&'static str> {
        [
            (&self.security, "登录密钥"),
            (&self.service_token, "健康令牌"),
            (&self.cuser_id, "用户标识"),
            (&self.user_id, "账号标识"),
            (&self.pass_token, "续期凭据"),
        ]
        .into_iter()
        .filter_map(|(value, name)| value.is_empty().then_some(name))
        .collect()
    }
}
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SECRET_SERVICE, SECRET_ACCOUNT).map_err(|_| "无法访问系统凭据管理器".into())
}
fn stored() -> Result<Option<Credentials>, String> {
    match entry()?.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| "小米登录状态损坏，请重新连接".into()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("无法读取系统中保存的小米登录状态".into()),
    }
}
fn persist(credentials: &Credentials) -> Result<(), String> {
    let missing = credentials.missing_fields();
    if !missing.is_empty() {
        return Err(format!(
            "小米未返回完整登录状态（缺少{}），请重新连接",
            missing.join("、")
        ));
    }
    entry()?
        .set_password(&serde_json::to_string(credentials).map_err(|_| "无法整理小米登录状态")?)
        .map_err(|_| "无法将小米登录状态保存到系统凭据管理器".into())
}
fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .filter(|v| !v.is_null())
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| v.to_string())
        })
        .unwrap_or_default()
}
fn account_fields() -> Vec<(&'static str, String)> {
    vec![("sid", SID.into()), ("_json", "true".into())]
}
fn absolute(location: &str) -> Result<String, String> {
    let url = protocol::allowed_url(ACCOUNT)?
        .join(location)
        .map_err(|_| "小米登录跳转地址无效")?;
    protocol::allowed_url(url.as_str())?;
    Ok(url.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XiaomiConnection {
    connected: bool,
    account_key: Option<String>,
    terminal_login_available: bool,
}
#[tauri::command]
pub async fn xiaomi_health_status() -> Result<XiaomiConnection, String> {
    let credentials = stored()?;
    Ok(XiaomiConnection {
        connected: credentials.is_some(),
        account_key: credentials.map(|c| c.account_key()),
        terminal_login_available: terminal_login_script().is_some(),
    })
}

fn terminal_login_script() -> Option<std::path::PathBuf> {
    // Development bridge to the already verified local tool. Release builds
    // must not depend on a source checkout or the developer's Python runtime.
    if !cfg!(all(windows, debug_assertions)) {
        return None;
    }
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tools/xiaomi-health-check/run.ps1");
    script.canonicalize().ok().filter(|path| path.is_file())
}

#[cfg(windows)]
fn launch_login_terminal(parameters: &str, visible: bool) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::{
        Shell::ShellExecuteW,
        WindowsAndMessaging::{SW_HIDE, SW_SHOWNORMAL},
    };
    let executable =
        std::path::PathBuf::from(std::env::var_os("SystemRoot").ok_or("无法找到 Windows 终端")?)
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let file = executable
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let arguments = parameters.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let operation = "open\0".encode_utf16().collect::<Vec<_>>();
    // Shell launch gives the interactive window its own standard handles.
    // Command::spawn + CREATE_NEW_CONSOLE can still inherit the Tauri runner's
    // redirected streams, leaving the new window blank and input elsewhere.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            arguments.as_ptr(),
            std::ptr::null(),
            if visible { SW_SHOWNORMAL } else { SW_HIDE },
        )
    };
    if result as isize <= 32 {
        return Err("无法打开本机登录窗口，请从工具目录运行 connect-desktop.cmd".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn xiaomi_health_terminal_login(
    state: State<'_, XiaomiHealthState>,
) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    if stored()?.is_some() {
        return Err("账号已经连接，请先断开连接后再更换账号".into());
    }
    let script = terminal_login_script().ok_or("当前版本没有本机终端登录工具")?;
    #[cfg(windows)]
    {
        // This is an interactive login window: credentials are entered there,
        // never passed through command arguments, files or environment vars.
        // Canonical Windows paths may have a verbatim prefix that powershell's
        // -File parser does not accept. It is not needed for this local script.
        let script = script.to_string_lossy();
        let script = script.strip_prefix(r"\\?\").unwrap_or(&script);
        launch_login_terminal(&format!("-NoLogo -NoExit -NoProfile -ExecutionPolicy Bypass -File \"{script}\" -ConnectDesktop"), true)?;
        *state.pending.lock().await = None;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = script;
        Err("本机终端登录工具仅支持 Windows".into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginReply {
    stage: String,
    login_id: Option<String>,
    captcha_data_url: Option<String>,
    method: Option<String>,
}
fn connected_reply() -> LoginReply {
    LoginReply {
        stage: "connected".into(),
        login_id: None,
        captcha_data_url: None,
        method: None,
    }
}

async fn complete(
    session: &mut Session,
    response: &Value,
    previous: Option<&Credentials>,
) -> Result<Credentials, String> {
    let location = text(response, "location");
    if !location.is_empty() {
        session
            .request(Method::GET, &absolute(&location)?, &[], false, true, false)
            .await?;
    }
    let credentials = credentials_from_session(session, response, previous);
    if previous.is_some_and(|c| c.user_id != credentials.user_id) {
        return Err("小米续期返回了不同的账号，请重新连接".into());
    }
    Ok(credentials)
}

fn credentials_from_session(
    session: &Session,
    response: &Value,
    previous: Option<&Credentials>,
) -> Credentials {
    Credentials {
        security: {
            let value = text(response, "ssecurity");
            if value.is_empty() {
                session.login.security.clone()
            } else {
                value
            }
        },
        service_token: session.login.health_token.clone(),
        cuser_id: {
            let id = text(response, "cUserId");
            if id.is_empty() {
                (!session.login.cuser_id.is_empty())
                    .then(|| session.login.cuser_id.clone())
                    .or_else(|| session.account_cookie("cUserId"))
                    .or_else(|| previous.map(|c| c.cuser_id.clone()))
                    .unwrap_or_default()
            } else {
                id
            }
        },
        user_id: {
            let id = text(response, "userId");
            if id.is_empty() {
                (!session.login.user_id.is_empty())
                    .then(|| session.login.user_id.clone())
                    .or_else(|| session.account_cookie("userId"))
                    .or_else(|| previous.map(|c| c.user_id.clone()))
                    .unwrap_or_default()
            } else {
                id
            }
        },
        pass_token: {
            let value = text(response, "passToken");
            if value.is_empty() {
                (!session.login.pass_token.is_empty())
                    .then(|| session.login.pass_token.clone())
                    .or_else(|| session.account_cookie("passToken"))
                    .or_else(|| previous.map(|c| c.pass_token.clone()))
                    .unwrap_or_default()
            } else {
                value
            }
        },
    }
}

async fn begin_verification(session: &mut Session, address: &str) -> Result<(String, i64), String> {
    let address = absolute(address)?;
    let url = protocol::allowed_url(&address)?;
    let parameters = url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    let context = parameters
        .get("context")
        .map(|s| s.to_string())
        .ok_or("小米验证缺少会话信息")?;
    session
        .request(Method::GET, &address, &[], false, true, true)
        .await?;
    session.user = parameters
        .get("userId")
        .map(|s| s.to_string())
        .unwrap_or_default();
    let listing = session
        .json(
            Method::GET,
            &format!("{ACCOUNT}/identity/list"),
            &[
                ("sid", SID.into()),
                ("supportedMask", "0".into()),
                ("_locale", "zh_CN".into()),
                ("context", context.clone()),
            ],
            true,
            true,
        )
        .await?;
    let flag = listing["flag"]
        .as_i64()
        .ok_or("小米要求其他验证方式，请在官方应用完成验证后重试")?;
    let method = match flag {
        4 => "Phone",
        8 => "Email",
        _ => return Err("小米要求其他验证方式，请在官方应用完成验证后重试".into()),
    };
    session
        .request(
            Method::GET,
            &format!("{ACCOUNT}/identity/auth/verify{method}"),
            &[("_flag", flag.to_string()), ("_json", "true".into())],
            true,
            true,
            true,
        )
        .await?;
    if flag == 4 {
        let bytes = session
            .request(
                Method::POST,
                &format!("{ACCOUNT}/identity/auth/sendPhoneTicket"),
                &[
                    ("retry", "0".into()),
                    ("icode", "".into()),
                    ("_json", "true".into()),
                ],
                false,
                true,
                true,
            )
            .await?;
        let value = protocol::json_body(&bytes)?;
        if value
            .get("code")
            .and_then(Value::as_i64)
            .is_some_and(|code| code != 0)
        {
            return Err("小米未发送验证码，请稍后重试".into());
        }
    }
    Ok((context, flag))
}

#[tauri::command]
pub async fn xiaomi_health_login(
    state: State<'_, XiaomiHealthState>,
    username: String,
    password: String,
    login_id: Option<String>,
    captcha: Option<String>,
) -> Result<LoginReply, String> {
    let _operation = state.operation.lock().await;
    if username.trim().is_empty()
        || username.len() > 200
        || password.is_empty()
        || password.len() > 500
    {
        return Err("请填写小米账号和密码".into());
    }
    let mut slot = state.pending.lock().await;
    let mut pending = if let Some(id) = login_id {
        let item = slot
            .take()
            .filter(|p| {
                p.id == id
                    && p.username == username
                    && p.created.elapsed() < Duration::from_secs(600)
                    && p.verification.is_none()
            })
            .ok_or("登录步骤已过期，请重新开始")?;
        item
    } else {
        Pending {
            id: uuid::Uuid::new_v4().to_string(),
            created: Instant::now(),
            username: username.clone(),
            password_hash: String::new(),
            session: Session::new()?,
            verification: None,
        }
    };
    pending.session.login_user_hint = Some(username.clone());
    let initial = pending
        .session
        .json(
            Method::GET,
            &format!("{ACCOUNT}/pass/serviceLogin"),
            &account_fields(),
            true,
            false,
        )
        .await?;
    if text(&initial, "_sign").is_empty() {
        return Err("小米登录入口未返回登录信息，请稍后重试".into());
    }
    let hash = hex::encode_upper(Md5::digest(password.as_bytes()));
    pending.password_hash = hash.clone();
    drop(password);
    let mut fields = password_fields(&username, &hash, &initial);
    if let Some(code) = captcha {
        fields.push(("captCode", code));
    }
    let bytes = pending
        .session
        .request(
            Method::POST,
            &format!("{ACCOUNT}/pass/serviceLoginAuth2"),
            &fields,
            true,
            false,
            false,
        )
        .await?;
    let response = protocol::json_body(&bytes)?;
    let captcha_url = text(&response, "captchaUrl");
    if !captcha_url.is_empty() {
        let image = pending
            .session
            .request(
                Method::GET,
                &absolute(&captcha_url)?,
                &[],
                false,
                true,
                false,
            )
            .await?;
        if image.len() > 1_000_000 {
            return Err("小米验证码图片过大".into());
        }
        let reply = LoginReply {
            stage: "captcha".into(),
            login_id: Some(pending.id.clone()),
            captcha_data_url: Some(format!("data:image/jpeg;base64,{}", B64.encode(image))),
            method: None,
        };
        *slot = Some(pending);
        return Ok(reply);
    }
    let notification = text(&response, "notificationUrl");
    if !notification.is_empty() && text(&response, "ssecurity").is_empty() {
        let context = begin_verification(&mut pending.session, &notification).await?;
        let method = if context.1 == 8 { "邮箱" } else { "短信" }.into();
        pending.verification = Some(context);
        let reply = LoginReply {
            stage: "verification".into(),
            login_id: Some(pending.id.clone()),
            captcha_data_url: None,
            method: Some(method),
        };
        *slot = Some(pending);
        return Ok(reply);
    }
    if text(&response, "ssecurity").is_empty() {
        return Err("小米账号登录未完成，请核对账号密码或稍后重试".into());
    }
    persist(&complete(&mut pending.session, &response, None).await?)?;
    Ok(connected_reply())
}

#[tauri::command]
pub async fn xiaomi_health_verify(
    state: State<'_, XiaomiHealthState>,
    login_id: String,
    code: String,
) -> Result<LoginReply, String> {
    let _operation = state.operation.lock().await;
    let mut slot = state.pending.lock().await;
    let pending = slot
        .as_mut()
        .filter(|p| p.id == login_id && p.created.elapsed() < Duration::from_secs(600))
        .ok_or("验证步骤已过期，请重新开始")?;
    let (context, flag) = pending
        .verification
        .clone()
        .ok_or("当前没有待完成的验证码验证")?;
    if code.trim().is_empty() || code.len() > 30 {
        return Err("请输入小米验证码".into());
    }
    let method = if flag == 8 { "Email" } else { "Phone" };
    let address = format!("{ACCOUNT}/identity/auth/verify{method}?_dc={}&_flag={flag}&_json=true&sid={SID}&context={}", Utc::now().timestamp_millis(), url::form_urlencoded::byte_serialize(context.as_bytes()).collect::<String>());
    let reply = pending
        .session
        .request_response(
            Method::POST,
            &address,
            &[
                ("_flag", flag.to_string()),
                ("ticket", code.trim().into()),
                ("trust", "false".into()),
                ("_json", "true".into()),
            ],
            false,
            false,
            true,
        )
        .await
        .map_err(|message| format!("验证码提交失败：{message}"))?;
    let location = verification_location(&reply.body, reply.location.as_deref())?;
    pending
        .session
        .request(Method::GET, &absolute(&location)?, &[], false, true, false)
        .await
        .map_err(|message| format!("验证码确认跳转失败：{message}"))?;
    let credentials = resolve_verified_session(
        &mut pending.session,
        Some((&pending.username, &pending.password_hash)),
    )
    .await?;
    persist(&credentials)?;
    *slot = None;
    Ok(connected_reply())
}

fn password_fields(username: &str, hash: &str, initial: &Value) -> Vec<(&'static str, String)> {
    vec![
        ("user", username.into()),
        ("hash", hash.into()),
        ("sid", SID.into()),
        ("_json", "true".into()),
        ("_sign", text(initial, "_sign")),
        ("qs", text(initial, "qs")),
        ("callback", text(initial, "callback")),
        ("locale", "zh_CN".into()),
    ]
}

async fn resolve_verified_session(
    session: &mut Session,
    authentication: Option<(&str, &str)>,
) -> Result<Credentials, String> {
    let available = credentials_from_session(session, &Value::Null, None);
    if available.missing_fields().is_empty() {
        return Ok(available);
    }
    // This is still the first login: preserve the identity verification cookies
    // and device context instead of creating a separate token-refresh session.
    for (name, value) in [
        ("userId", &available.user_id),
        ("cUserId", &available.cuser_id),
        ("passToken", &available.pass_token),
    ] {
        if !value.is_empty() {
            session.set_account_cookie(name, value);
        }
    }
    let mut response = session
        .json(
            Method::GET,
            &format!("{ACCOUNT}/pass/serviceLogin"),
            &account_fields(),
            true,
            false,
        )
        .await?;
    if response["code"].as_i64() == Some(70016) {
        if let Some((username, hash)) = authentication.filter(|(_, hash)| !hash.is_empty()) {
            if text(&response, "_sign").is_empty() {
                return Err("小米验证后未返回账号认证参数，请重新开始登录".into());
            }
            // Identity verification is not always the final password-auth step.
            // Re-submit the same credentials once, in the verified session.
            response = protocol::json_body(
                &session
                    .request(
                        Method::POST,
                        &format!("{ACCOUNT}/pass/serviceLoginAuth2"),
                        &password_fields(username, hash, &response),
                        true,
                        false,
                        false,
                    )
                    .await?,
            )?;
            if !text(&response, "captchaUrl").is_empty() {
                return Err("小米在验证后要求新的图片验证，请重新开始登录".into());
            }
            if !text(&response, "notificationUrl").is_empty()
                && text(&response, "ssecurity").is_empty()
            {
                return Err("小米在验证后仍要求身份确认，本次账号认证未完成".into());
            }
        }
    }
    let collected = credentials_from_session(session, &response, None);
    if response["code"].as_i64() != Some(0) || collected.security.is_empty() {
        let code = response["code"]
            .as_i64()
            .map(|n| n.to_string())
            .unwrap_or_else(|| "未提供".into());
        return Err(format!(
            "小米首次服务登录未完成（错误码 {code}；缺少{}），请重新开始登录",
            collected.missing_fields().join("、")
        ));
    }
    complete(
        session,
        &response,
        (!available.user_id.is_empty()).then_some(&available),
    )
    .await
}

#[tauri::command]
pub async fn xiaomi_health_diagnostics(
    state: State<'_, XiaomiHealthState>,
) -> Result<Vec<protocol::LoginTrace>, String> {
    if let Some(job) = state.pending_qr.lock().await.as_ref() {
        return Ok(job.progress.lock().await.trace.clone());
    }
    Ok(state
        .pending
        .lock()
        .await
        .as_ref()
        .map(|pending| pending.session.trace.clone())
        .unwrap_or_default())
}

fn verification_location(body: &[u8], header: Option<&str>) -> Result<String, String> {
    let response = protocol::json_body(body).unwrap_or(Value::Null);
    let location = text(&response, "location");
    let location = if location.is_empty() {
        header.unwrap_or("").to_owned()
    } else {
        location
    };
    if !location.is_empty() {
        return absolute(&location);
    }
    let code = response["code"]
        .as_i64()
        .map(|n| n.to_string())
        .unwrap_or_else(|| "未提供".into());
    Err(format!(
        "小米验证码校验未完成（错误码 {code}），请检查验证码后重试"
    ))
}

#[tauri::command]
pub async fn xiaomi_health_disconnect(state: State<'_, XiaomiHealthState>) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    *state.pending.lock().await = None;
    *state.pending_qr.lock().await = None;
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法删除系统中保存的小米登录状态".into()),
    }
}

async fn refresh(previous: &Credentials) -> Result<Credentials, String> {
    let mut session = Session::new()?;
    session.clear_device_cookies();
    for (key, value) in [
        ("passToken", &previous.pass_token),
        ("cUserId", &previous.cuser_id),
        ("userId", &previous.user_id),
    ] {
        session.set_account_cookie(key, value);
    }
    let response = session
        .json(
            Method::GET,
            &format!("{ACCOUNT}/pass/serviceLogin"),
            &account_fields(),
            true,
            false,
        )
        .await?;
    if response["code"].as_i64() != Some(0) || text(&response, "location").is_empty() {
        let code = response["code"]
            .as_i64()
            .map(|n| n.to_string())
            .unwrap_or_else(|| "未提供".into());
        return Err(format!(
            "小米登录续期被拒绝（错误码 {code}），请重新连接账号"
        ));
    }
    complete(&mut session, &response, Some(previous)).await
}

enum FetchError {
    Auth,
    Other(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "anonymous QR endpoint probe, never submits account data"]
    fn xiaomi_qr_anonymous_handshake_returns_image_and_waits_for_confirmation() {
        let mut session = Session::new().unwrap();
        session.enable_anonymous_probe();
        let (pending, reply) = tauri::async_runtime::block_on(begin_qr_login(session)).unwrap();
        assert_eq!(reply.stage, "qrcode");
        assert!(reply
            .image_data_url
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert!(reply.expires_at.is_some());
        let job = start_qr_job(pending);
        tauri::async_runtime::block_on(async {
            tokio::time::sleep(Duration::from_secs(7)).await;
            let progress = job.progress.lock().await;
            match &progress.outcome {
                QrOutcome::Waiting => {}
                QrOutcome::Failed(message) => panic!("anonymous waiting failed: {message}"),
                QrOutcome::Ready(_) => panic!("anonymous probe unexpectedly authenticated"),
            }
        });
        // Dropping the fixture aborts its single pending network request.
        drop(job);
    }

    #[test]
    fn xiaomi_qr_ui_status_checks_share_one_server_wait_request() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static REQUESTS: AtomicUsize = AtomicUsize::new(0);
        REQUESTS.store(0, Ordering::SeqCst);
        let mut session = Session::new().unwrap();
        session.test_transport = Some(|current, _, address, _, _| {
            if address.contains("/lp/s?") {
                REQUESTS.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(30));
                Ok(protocol::AccountReply { body: br#"{"code":0,"ssecurity":"qr-security","userId":"qr-user","cUserId":"qr-cuser","passToken":"qr-pass","location":"https://sts-hlth.io.mi.com/healthapp/sts"}"#.to_vec(), location: None })
            } else {
                assert_eq!(address, "https://sts-hlth.io.mi.com/healthapp/sts");
                current.login.health_token = "qr-token".into();
                Ok(protocol::AccountReply {
                    body: Vec::new(),
                    location: None,
                })
            }
        });
        let job = start_qr_job(PendingQr {
            id: "test-login".into(),
            created: Instant::now(),
            lifetime: Duration::from_secs(300),
            polling_url: "https://ak.lp.account.xiaomi.com/lp/s?ticket=private-ticket".into(),
            session,
        });
        tauri::async_runtime::block_on(async {
            for _ in 0..100 {
                let progress = job.progress.lock().await;
                if let QrOutcome::Ready(credentials) = &progress.outcome {
                    assert!(credentials.missing_fields().is_empty());
                    assert_eq!(REQUESTS.load(Ordering::SeqCst), 1);
                    return;
                }
                drop(progress);
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            panic!("QR result was not delivered");
        });
    }

    #[test]
    fn xiaomi_qr_confirmation_uses_the_matching_health_callback_without_password_auth() {
        let mut session = Session::new().unwrap();
        session.test_transport = Some(|current, method, address, fields, query| {
            assert_eq!(method, Method::GET);
            if address.ends_with("/longPolling/loginUrl") {
                assert!(query);
                assert!(fields
                    .iter()
                    .any(|(name, value)| *name == "sid" && value == SID));
                Ok(protocol::AccountReply { body: br#"{"code":0,"qr":"https://account.xiaomi.com/pass/getCode?ticket=private-qr-ticket","lp":"https://ak.lp.account.xiaomi.com/lp/s?ticket=private-poll-ticket","timeout":300}"#.to_vec(), location: None })
            } else if address.contains("/pass/getCode") {
                Ok(protocol::AccountReply {
                    body: b"\x89PNG\r\n\x1a\nfake-image".to_vec(),
                    location: None,
                })
            } else if address.contains("/lp/s?") {
                Ok(protocol::AccountReply { body: br#"{"code":0,"ssecurity":"qr-security","userId":"qr-user","cUserId":"qr-cuser","passToken":"qr-pass","location":"https://sts-hlth.io.mi.com/healthapp/sts?ticket=private-sts-ticket"}"#.to_vec(), location: None })
            } else if address.contains("/healthapp/sts?") {
                current.login.health_token = "qr-health-token".into();
                Ok(protocol::AccountReply {
                    body: Vec::new(),
                    location: None,
                })
            } else {
                panic!("QR flow attempted an unexpected request");
            }
        });
        let (mut pending, reply) = tauri::async_runtime::block_on(begin_qr_login(session)).unwrap();
        let serialized = serde_json::to_string(&reply).unwrap();
        assert!(!serialized.contains("private-"));
        let credentials = tauri::async_runtime::block_on(finish_qr_login(&mut pending))
            .unwrap()
            .unwrap();
        assert!(credentials.missing_fields().is_empty());
        assert_eq!(credentials.security, "qr-security");
        assert_eq!(credentials.service_token, "qr-health-token");
        assert_eq!(credentials.user_id, "qr-user");
    }

    #[test]
    fn xiaomi_qr_expiry_stops_before_another_request() {
        let mut pending = PendingQr {
            id: "local-id".into(),
            created: Instant::now() - Duration::from_secs(301),
            lifetime: Duration::from_secs(300),
            polling_url: "https://ak.lp.account.xiaomi.com/longPolling/login?ticket=private-ticket"
                .into(),
            session: Session::new().unwrap(),
        };
        let error = tauri::async_runtime::block_on(finish_qr_login(&mut pending))
            .err()
            .unwrap();
        assert!(error.contains("过期"));
        assert!(!error.contains("private-ticket"));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "opens an isolated hidden console; requires local Python"]
    fn xiaomi_terminal_startup_has_its_own_prompt_and_interactive_streams() {
        let python =
            std::env::var_os("XIAOMI_TEST_PYTHON").expect("set XIAOMI_TEST_PYTHON for this check");
        let tool = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tools/xiaomi-health-check");
        let probe = tool
            .join("terminal_startup_probe.py")
            .canonicalize()
            .unwrap();
        let directory = tool
            .join(".local")
            .join(format!("terminal-launch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let report = directory.join("report.json");
        let script = directory.join("probe.ps1");
        let ps_quote = |path: &std::path::Path| {
            let text = path.to_string_lossy();
            format!(
                "'{}'",
                text.strip_prefix(r"\\?\")
                    .unwrap_or(&text)
                    .replace('\'', "''")
            )
        };
        std::fs::write(
            &script,
            format!(
                "& {} {} {}\r\nexit $LASTEXITCODE\r\n",
                ps_quote(std::path::Path::new(&python)),
                ps_quote(&probe),
                ps_quote(&report)
            ),
        )
        .unwrap();
        let parameters = format!(
            "-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
            script.display()
        );
        let launched = launch_login_terminal(&parameters, false);
        let mut observed = None;
        if launched.is_ok() {
            for _ in 0..100 {
                if let Ok(text) = std::fs::read_to_string(&report) {
                    if let Ok(value) = serde_json::from_str::<Value>(&text) {
                        observed = Some(value);
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        // Remove only this check's three exact, newly generated paths.
        let _ = std::fs::remove_file(&report);
        let _ = std::fs::remove_file(&script);
        let _ = std::fs::remove_dir(&directory);
        launched.unwrap();
        let observed = observed.expect("terminal startup probe did not finish");
        for field in [
            "stdinReady",
            "stdoutReady",
            "stderrReady",
            "hiddenPasswordReader",
            "promptInOwnWindow",
        ] {
            assert_eq!(observed[field], true, "terminal startup check: {field}");
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires a local Python runtime and the Windows credential vault"]
    fn xiaomi_terminal_credentials_are_readable_by_native_keyring() {
        use std::os::windows::process::CommandExt;
        let python =
            std::env::var_os("XIAOMI_TEST_PYTHON").expect("set XIAOMI_TEST_PYTHON for this check");
        let service = format!("xiaomi-handoff-test-{}", uuid::Uuid::new_v4());
        let credential = keyring::Entry::new(&service, "fixture").unwrap();
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tools/xiaomi-health-check");
        let code = "import json,sys; sys.path.insert(0,sys.argv[1]); import desktop_connection as d; d._write_password(sys.argv[2], 'fixture', json.dumps(d.desktop_credentials({'ssecurity':'fake-security','service_token':'fake-token','cuser_id':'fake-cuser','user_id':'fake-user','pass_token':'fake-pass'})))";
        let process = std::process::Command::new(python)
            .args(["-c", code])
            .arg(source)
            .arg(&service)
            .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
            .output()
            .unwrap();
        let read = credential.get_password();
        // Delete only this freshly generated fixture, including on assertion failure.
        let cleanup = credential.delete_credential();
        assert!(
            process.status.success(),
            "local credential fixture writer failed"
        );
        let decoded: Credentials = serde_json::from_str(&read.unwrap()).unwrap();
        assert!(decoded.missing_fields().is_empty());
        assert_eq!(decoded.security, "fake-security");
        assert_eq!(decoded.user_id, "fake-user");
        cleanup.unwrap();
    }

    #[test]
    fn first_service_login_keeps_the_just_verified_identity_session() {
        let mut session = Session::new().unwrap();
        session.set_account_cookie("identity_session", "verified-context");
        session.login.user_id = "test-user".into();
        session.login.cuser_id = "test-cuser".into();
        session.login.pass_token = "new-pass-token".into();
        session.test_transport = Some(|current, method, address, _, _| {
            assert_eq!(method, Method::GET);
            assert_eq!(address, "https://account.xiaomi.com/pass/serviceLogin");
            assert_eq!(
                current.account_cookie("identity_session").as_deref(),
                Some("verified-context")
            );
            assert_eq!(
                current.account_cookie("passToken").as_deref(),
                Some("new-pass-token")
            );
            current.login.health_token = "new-health-token".into();
            Ok(protocol::AccountReply { body: br#"{"code":0,"ssecurity":"new-security","userId":"test-user","cUserId":"test-cuser","passToken":"new-pass-token"}"#.to_vec(), location: None })
        });
        // The previous implementation created a fresh Session here and lost
        // this verified context and transport, so this regression fails offline.
        let credentials =
            tauri::async_runtime::block_on(resolve_verified_session(&mut session, None)).unwrap();
        assert!(credentials.missing_fields().is_empty());
        assert_eq!(credentials.security, "new-security");
        assert_eq!(credentials.service_token, "new-health-token");
    }

    #[test]
    fn rejected_first_login_is_not_reported_as_an_expired_session() {
        let mut session = Session::new().unwrap();
        session.login.user_id = "test-user".into();
        session.login.pass_token = "new-pass-token".into();
        session.test_transport = Some(|_, _, _, _, _| {
            Ok(protocol::AccountReply {
                body: br#"{"code":70016,"desc":"sensitive response"}"#.to_vec(),
                location: None,
            })
        });
        let error = tauri::async_runtime::block_on(resolve_verified_session(&mut session, None))
            .err()
            .unwrap();
        assert!(error.contains("首次服务登录"));
        assert!(error.contains("70016"));
        assert!(!error.contains("过期"));
        assert!(!error.contains("sensitive response"));
        assert!(!error.contains("new-pass-token"));
    }

    #[test]
    fn completed_verification_does_not_require_another_service_login() {
        let mut session = Session::new().unwrap();
        session.login = protocol::LoginArtifacts {
            security: "test-security".into(),
            health_token: "test-health-token".into(),
            user_id: "test-user".into(),
            cuser_id: "test-cuser".into(),
            pass_token: "test-pass-token".into(),
        };
        // Session forbids network in unit tests. The old extra guest lookup
        // would fail here, despite a successful verification redirect.
        let credentials =
            tauri::async_runtime::block_on(resolve_verified_session(&mut session, None)).unwrap();
        assert!(credentials.missing_fields().is_empty());
        assert_eq!(credentials.security, "test-security");
        assert_eq!(credentials.service_token, "test-health-token");
    }

    #[test]
    fn verified_identity_finishes_password_auth_once_with_fresh_service_parameters() {
        let mut session = Session::new().unwrap();
        session.set_account_cookie("identity_session", "verified-context");
        session.login.user_id = "test-user".into();
        session.login.cuser_id = "test-cuser".into();
        session.login.pass_token = "test-pass-token".into();
        session.test_transport = Some(|current, method, address, fields, query| {
            assert_eq!(
                current.account_cookie("identity_session").as_deref(),
                Some("verified-context")
            );
            assert_eq!(query, current.trace.len() < 2);
            match current.trace.len() {
                0 => {
                    assert_eq!(method, Method::GET);
                    assert_eq!(address, "https://account.xiaomi.com/pass/serviceLogin");
                    Ok(protocol::AccountReply { body: br#"{"code":70016,"_sign":"fresh-sign","qs":"fresh-qs","callback":"fresh-callback"}"#.to_vec(), location: None })
                }
                1 => {
                    assert_eq!(method, Method::POST);
                    assert_eq!(address, "https://account.xiaomi.com/pass/serviceLoginAuth2");
                    for (key, expected) in [
                        ("user", "test-user"),
                        ("hash", "test-password-hash"),
                        ("sid", SID),
                        ("_sign", "fresh-sign"),
                        ("qs", "fresh-qs"),
                        ("callback", "fresh-callback"),
                    ] {
                        assert_eq!(
                            fields
                                .iter()
                                .find(|(name, _)| *name == key)
                                .map(|(_, value)| value.as_str()),
                            Some(expected)
                        );
                    }
                    Ok(protocol::AccountReply { body: br#"{"code":0,"ssecurity":"new-security","location":"https://sts-hlth.io.mi.com/healthapp/sts"}"#.to_vec(), location: None })
                }
                2 => {
                    assert_eq!(method, Method::GET);
                    assert_eq!(address, "https://sts-hlth.io.mi.com/healthapp/sts");
                    current.login.health_token = "new-health-token".into();
                    Ok(protocol::AccountReply {
                        body: Vec::new(),
                        location: None,
                    })
                }
                _ => panic!("unexpected extra authentication request"),
            }
        });
        let credentials = tauri::async_runtime::block_on(resolve_verified_session(
            &mut session,
            Some(("test-user", "test-password-hash")),
        ))
        .unwrap();
        assert!(credentials.missing_fields().is_empty());
        assert_eq!(credentials.security, "new-security");
        assert_eq!(credentials.service_token, "new-health-token");
        assert_eq!(session.trace.len(), 3);
    }

    #[test]
    fn rejected_post_verification_authentication_stops_without_looping() {
        let mut session = Session::new().unwrap();
        session.test_transport = Some(|current, method, _, _, _| {
            assert!(current.trace.len() < 2);
            assert_eq!(
                method,
                if current.trace.is_empty() {
                    Method::GET
                } else {
                    Method::POST
                }
            );
            Ok(protocol::AccountReply {
                body: br#"{"code":70016,"_sign":"fresh-sign","desc":"private-account-data"}"#
                    .to_vec(),
                location: None,
            })
        });
        let error = tauri::async_runtime::block_on(resolve_verified_session(
            &mut session,
            Some(("test-user", "test-password-hash")),
        ))
        .err()
        .unwrap();
        assert_eq!(session.trace.len(), 2);
        assert!(error.contains("70016"));
        for private in [
            "test-user",
            "test-password-hash",
            "private-account-data",
            "fresh-sign",
        ] {
            assert!(!error.contains(private));
        }
    }

    #[test]
    fn a_new_login_never_reuses_the_previous_sessions_security_key() {
        let old = Credentials {
            security: "old-security".into(),
            service_token: "old-token".into(),
            user_id: "test-user".into(),
            cuser_id: "test-cuser".into(),
            pass_token: "test-pass".into(),
        };
        let session = Session::new().unwrap();
        let next = credentials_from_session(&session, &Value::Null, Some(&old));
        assert!(next.security.is_empty());
        assert!(next.service_token.is_empty());
        assert_eq!(next.pass_token, old.pass_token);
    }

    #[test]
    fn verification_supports_json_and_http_redirect_locations() {
        assert_eq!(
            verification_location(
                b"&&&START&&&{\"code\":0,\"location\":\"/identity/confirmed\"}",
                None
            )
            .unwrap(),
            "https://account.xiaomi.com/identity/confirmed"
        );
        assert_eq!(
            verification_location(b"", Some("/identity/confirmed")).unwrap(),
            "https://account.xiaomi.com/identity/confirmed"
        );
        assert!(verification_location(b"", Some("https://untrusted.example/redirect")).is_err());
        let error =
            verification_location(b"{\"code\":70012,\"desc\":\"PRIVATE_DATA\"}", None).unwrap_err();
        assert!(error.contains("70012"));
        assert!(!error.contains("PRIVATE_DATA"));
    }
}
impl From<String> for FetchError {
    fn from(value: String) -> Self {
        Self::Other(value)
    }
}
async fn read_records(
    credentials: &Credentials,
    key: &str,
    start: i64,
    end: i64,
) -> Result<Vec<Value>, FetchError> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|_| "无法连接小米健康服务".to_string())?;
    let path = "/app/v1/data/get_fitness_data_by_time";
    let mut cursor: Option<String> = None;
    let mut seen = HashSet::new();
    let mut records = Vec::new();
    for _ in 0..60 {
        let nonce = protocol::nonce();
        let data = json!({"key":key,"startTime":start.max(end - 86_400_000),"endTime":end,"reverse":true,"next_key":cursor});
        let query = protocol::encrypted_query(path, &data, &nonce, &credentials.security)?;
        let response = client
            .get(format!("{HEALTH}{path}"))
            .query(&query)
            .header(
                reqwest::header::COOKIE,
                format!(
                    "cUserId={}; serviceToken={}; locale=zh_cn",
                    credentials.cuser_id, credentials.service_token
                ),
            )
            .send()
            .await
            .map_err(|_| "小米健康连接失败，请稍后重试".to_string())?;
        if matches!(response.status().as_u16(), 401 | 403) {
            return Err(FetchError::Auth);
        }
        if !response.status().is_success() {
            return Err(FetchError::Other(format!(
                "小米健康请求未完成（HTTP {}）",
                response.status().as_u16()
            )));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| "无法读取小米健康数据".to_string())?;
        if bytes.len() > 8_000_000 {
            return Err(FetchError::Other("小米健康响应超过读取上限".into()));
        }
        let value = protocol::decode_health(&bytes, &nonce, &credentials.security)?;
        if value["code"].as_i64() == Some(2)
            || (value["code"].as_i64().is_some()
                && value["message"]
                    .as_str()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains("auth"))
        {
            return Err(FetchError::Auth);
        }
        if value["code"].as_i64() != Some(0) {
            return Err(FetchError::Other("小米健康接口未成功返回数据".into()));
        }
        let result = &value["result"];
        let rows = result["data_list"]
            .as_array()
            .ok_or("小米健康记录格式尚未识别".to_string())?;
        let mut latest = 0i64;
        for row in rows {
            let time = row["time"]
                .as_i64()
                .filter(|v| (946684800..=4102444800).contains(v))
                .ok_or("小米健康时间字段无效".to_string())?
                * 1000;
            latest = latest.max(time);
            if time >= start && time < end {
                records.push(row.clone());
            }
        }
        if result["has_more"].as_bool() != Some(true) || (!rows.is_empty() && latest < start) {
            return Ok(records);
        }
        let next = result["next_key"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("小米健康分页缺少游标".to_string())?
            .to_owned();
        if !seen.insert(next.clone()) {
            return Err(FetchError::Other("小米健康分页没有前进，请稍后重试".into()));
        }
        cursor = Some(next);
        tokio::time::sleep(Duration::from_millis(600)).await;
    }
    Err(FetchError::Other(
        "本次健康记录超过分页上限，尚未完成同步".into(),
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthSnapshot {
    account_key: String,
    from_date: String,
    to_date: String,
    fetched_at: String,
    steps: Vec<Value>,
    sleep: Vec<Value>,
}
#[tauri::command]
pub async fn xiaomi_health_fetch(
    state: State<'_, XiaomiHealthState>,
) -> Result<HealthSnapshot, String> {
    let _operation = state.operation.lock().await;
    let mut credentials = stored()?.ok_or("请先连接小米账号")?;
    let now = Utc::now();
    let offset = FixedOffset::east_opt(8 * 3600).unwrap();
    let today = now.with_timezone(&offset).date_naive();
    let start = (today - Days::days(6))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_local_timezone(offset)
        .unwrap()
        .timestamp_millis();
    // Include today's partial steps and completed sleep, plus a boundary sleep day.
    let end = now.timestamp_millis() + 1;
    let mut steps = None;
    let mut sleep = None;
    for attempt in 0..2 {
        let fetched = async {
            let steps = read_records(&credentials, "steps", start, end).await?;
            let sleep = read_records(&credentials, "sleep", start - 86_400_000, end).await?;
            Ok::<_, FetchError>((steps, sleep))
        }
        .await;
        match fetched {
            Ok((a, b)) => {
                steps = Some(a);
                sleep = Some(b);
                break;
            }
            Err(FetchError::Auth) if attempt == 0 => {
                credentials = refresh(&credentials).await?;
                persist(&credentials)?;
            }
            Err(FetchError::Auth) => return Err("小米登录已过期，请重新连接账号".into()),
            Err(FetchError::Other(message)) => return Err(message),
        }
    }
    Ok(HealthSnapshot {
        account_key: credentials.account_key(),
        from_date: (today - Days::days(6)).to_string(),
        to_date: today.to_string(),
        fetched_at: now.to_rfc3339(),
        steps: steps.ok_or("未取得步数记录")?,
        sleep: sleep.ok_or("未取得睡眠记录")?,
    })
}

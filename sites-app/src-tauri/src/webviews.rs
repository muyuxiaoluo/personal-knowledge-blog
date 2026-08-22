use chrono::Utc;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    net::IpAddr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;
use url::Url;

const TOOL_WINDOW_LABEL: &str = "tool-browser";
const ENTERTAINMENT_WINDOW_LABEL: &str = "entertainment";

#[derive(Default)]
pub struct ToolWindowState {
    allow_insecure_http: AtomicBool,
}

fn is_private_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return true;
    }
    host.parse::<IpAddr>().is_ok_and(|address| match address {
        IpAddr::V4(value) => value.is_private() || value.is_loopback() || value.is_link_local(),
        IpAddr::V6(value) => value.is_loopback() || value.is_unique_local(),
    })
}

fn allowed_tool_url(url: &Url, allow_insecure_http: bool) -> bool {
    match url.scheme() {
        "https" => true,
        "http" => allow_insecure_http && url.host_str().is_some_and(is_private_host),
        _ => false,
    }
}

fn allowed_entertainment_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some_and(|host| {
            host == "bilibili.com"
                || host.ends_with(".bilibili.com")
                || host == "douyin.com"
                || host.ends_with(".douyin.com")
                || host == "bytedance.com"
                || host.ends_with(".bytedance.com")
        })
}

fn build_tool_menu(app: &tauri::AppHandle) -> Result<Menu<tauri::Wry>, String> {
    let back = MenuItem::with_id(app, "tool-back", "← 后退", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let forward = MenuItem::with_id(app, "tool-forward", "前进 →", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let reload = MenuItem::with_id(app, "tool-reload", "刷新", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let external = MenuItem::with_id(app, "tool-external", "在系统浏览器打开", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let close = MenuItem::with_id(app, "tool-close", "关闭", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    Menu::with_items(app, &[&back, &forward, &reload, &external, &close])
        .map_err(|error| error.to_string())
}

fn create_tool_window(app: &tauri::AppHandle, url: Url) -> Result<WebviewWindow, String> {
    let profile = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法准备工具浏览器目录：{error}"))?
        .join("webview-profiles")
        .join("tools");
    let navigation_app = app.clone();
    let popup_app = app.clone();
    let menu_app = app.clone();
    WebviewWindowBuilder::new(app, TOOL_WINDOW_LABEL, WebviewUrl::External(url))
        .title("工具浏览器")
        .inner_size(1180.0, 800.0)
        .min_inner_size(760.0, 520.0)
        .center()
        .resizable(true)
        .data_directory(profile)
        .menu(build_tool_menu(app)?)
        .on_navigation(move |target| {
            let state = navigation_app.state::<ToolWindowState>();
            allowed_tool_url(target, state.allow_insecure_http.load(Ordering::SeqCst))
        })
        .on_new_window(move |target, _| {
            if allowed_tool_url(&target, false) {
                let _ = popup_app
                    .opener()
                    .open_url(target.to_string(), None::<&str>);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_document_title_changed(|window, title| {
            let title = if title.trim().is_empty() {
                "工具浏览器"
            } else {
                &title
            };
            let _ = window.set_title(&format!("{title} · 工具浏览器"));
        })
        .on_menu_event(move |_window, event| match event.id().as_ref() {
            "tool-back" => {
                if let Some(webview) = menu_app.get_webview_window(TOOL_WINDOW_LABEL) {
                    let _ = webview.eval("history.back()");
                }
            }
            "tool-forward" => {
                if let Some(webview) = menu_app.get_webview_window(TOOL_WINDOW_LABEL) {
                    let _ = webview.eval("history.forward()");
                }
            }
            "tool-reload" => {
                if let Some(webview) = menu_app.get_webview_window(TOOL_WINDOW_LABEL) {
                    let _ = webview.reload();
                }
            }
            "tool-external" => {
                if let Some(webview) = menu_app.get_webview_window(TOOL_WINDOW_LABEL) {
                    if let Ok(url) = webview.url() {
                        let _ = menu_app.opener().open_url(url.to_string(), None::<&str>);
                    }
                }
            }
            "tool-close" => {
                if let Some(webview) = menu_app.get_webview_window(TOOL_WINDOW_LABEL) {
                    let _ = webview.destroy();
                }
            }
            _ => {}
        })
        .build()
        .map_err(|error| format!("无法创建工具浏览器：{error}"))
}

fn open_tool_window(
    app: &tauri::AppHandle,
    url: Url,
    allow_insecure_http: bool,
) -> Result<(), String> {
    if !allowed_tool_url(&url, allow_insecure_http) {
        return Err("内置浏览器仅允许 HTTPS；HTTP 仅可用于明确允许的本机或局域网地址".into());
    }
    let state = app.state::<ToolWindowState>();
    state
        .allow_insecure_http
        .store(allow_insecure_http, Ordering::SeqCst);
    let window = if let Some(window) = app.get_webview_window(TOOL_WINDOW_LABEL) {
        window
            .navigate(url)
            .map_err(|error| format!("无法打开网页：{error}"))?;
        window
    } else {
        create_tool_window(app, url)?
    };
    window
        .show()
        .map_err(|error| format!("无法显示工具浏览器：{error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("无法聚焦工具浏览器：{error}"))
}

#[tauri::command]
pub async fn tool_browser_open(
    app: tauri::AppHandle,
    url: String,
    allow_insecure_http: bool,
) -> Result<(), String> {
    let url = url
        .parse::<Url>()
        .map_err(|_| "网址格式不正确".to_string())?;
    open_tool_window(&app, url, allow_insecure_http)
}

#[tauri::command]
pub async fn entertainment_open(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let url = url
        .parse::<Url>()
        .map_err(|_| "娱乐网站地址格式不正确".to_string())?;
    if !allowed_entertainment_url(&url) {
        return Err("娱乐窗口目前只允许哔哩哔哩和抖音官方域名".into());
    }
    if let Some(window) = app.get_webview_window(ENTERTAINMENT_WINDOW_LABEL) {
        window
            .navigate(url)
            .map_err(|error| format!("无法切换娱乐网站：{error}"))?;
        window
            .show()
            .map_err(|error| format!("无法显示娱乐窗口：{error}"))?;
        return window
            .set_focus()
            .map_err(|error| format!("无法聚焦娱乐窗口：{error}"));
    }
    let profile = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法准备娱乐窗口目录：{error}"))?
        .join("webview-profiles")
        .join("entertainment");
    let popup_app = app.clone();
    WebviewWindowBuilder::new(&app, ENTERTAINMENT_WINDOW_LABEL, WebviewUrl::External(url))
        .title("娱乐窗口")
        .inner_size(1180.0, 800.0)
        .min_inner_size(760.0, 520.0)
        .center()
        .resizable(true)
        .data_directory(profile)
        .on_navigation(allowed_entertainment_url)
        .on_new_window(move |target, _| {
            if target.scheme() == "https" {
                let _ = popup_app
                    .opener()
                    .open_url(target.to_string(), None::<&str>);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
        .map_err(|error| format!("无法创建娱乐窗口：{error}"))?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageRow {
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    total_tokens: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageConsoleSnapshot {
    provider: String,
    rows: Vec<ModelUsageRow>,
    fetched_at: String,
    message: String,
}

async fn eval_json<T: DeserializeOwned>(window: &WebviewWindow, script: &str) -> Result<T, String> {
    let (sender, receiver) = oneshot::channel::<String>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    window
        .eval_with_callback(script, move |result| {
            if let Some(sender) = sender.lock().ok().and_then(|mut value| value.take()) {
                let _ = sender.send(result);
            }
        })
        .map_err(|error| format!("无法读取控制台页面：{error}"))?;
    let raw = tokio::time::timeout(Duration::from_secs(5), receiver)
        .await
        .map_err(|_| "等待控制台页面响应超时".to_string())?
        .map_err(|_| "控制台页面响应已中断".to_string())?;
    serde_json::from_str(&raw).map_err(|error| format!("控制台返回数据无法解析：{error}"))
}

#[tauri::command]
pub async fn usage_console_open(app: tauri::AppHandle, provider: String) -> Result<(), String> {
    let target = match provider.as_str() {
        "deepseek" => "https://platform.deepseek.com/usage",
        "qwen" => "https://bailian.console.aliyun.com/",
        _ => return Err("不支持的模型账户".into()),
    };
    open_tool_window(&app, target.parse().unwrap(), false)
}

#[tauri::command]
pub async fn usage_console_snapshot(
    app: tauri::AppHandle,
    provider: String,
) -> Result<UsageConsoleSnapshot, String> {
    if provider != "deepseek" && provider != "qwen" {
        return Err("不支持的模型账户".into());
    }
    let window = app
        .get_webview_window(TOOL_WINDOW_LABEL)
        .ok_or_else(|| "请先打开对应的官方用量控制台并完成登录".to_string())?;
    let script = r#"
(() => {
  const number = (value) => Number(String(value || '').replace(/[^0-9.]/g, '')) || 0;
  const rows = [];
  for (const table of document.querySelectorAll('table')) {
    const headers = Array.from(table.querySelectorAll('thead th')).map((cell) => (cell.innerText || '').trim().toLowerCase());
    for (const row of table.querySelectorAll('tbody tr')) {
      const cells = Array.from(row.querySelectorAll('td')).map((cell) => (cell.innerText || '').trim());
      if (!cells.length) continue;
      const find = (patterns) => {
        const index = headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
        return index >= 0 ? number(cells[index]) : 0;
      };
      const model = cells.find((cell) => /deepseek|qwen|通义|模型/i.test(cell) && cell.length < 100) || cells[0] || '未命名模型';
      const inputTokens = find([/input/, /输入/, /prompt/]);
      const outputTokens = find([/output/, /输出/, /completion/]);
      const totalTokens = find([/total/, /总.*token/, /tokens?$/]) || inputTokens + outputTokens;
      if (totalTokens > 0 || /deepseek|qwen|通义/i.test(model)) rows.push({ model, inputTokens, outputTokens, totalTokens });
    }
  }
  return { rows, message: rows.length ? '' : '当前页面没有识别到 Token 表格；请确认已登录并打开用量明细页。' };
})()
"#;
    #[derive(Deserialize)]
    struct Extracted {
        rows: Vec<ModelUsageRow>,
        message: String,
    }
    let extracted: Extracted = eval_json(&window, script).await?;
    Ok(UsageConsoleSnapshot {
        provider,
        rows: extracted.rows,
        fetched_at: Utc::now().to_rfc3339(),
        message: extracted.message,
    })
}

#[cfg(test)]
mod tests {
    use super::{allowed_entertainment_url, allowed_tool_url};

    #[test]
    fn rejects_dangerous_browser_protocols() {
        assert!(allowed_tool_url(
            &"https://github.com".parse().unwrap(),
            false
        ));
        assert!(!allowed_tool_url(
            &"javascript:alert(1)".parse().unwrap(),
            true
        ));
        assert!(!allowed_tool_url(
            &"http://example.com".parse().unwrap(),
            true
        ));
        assert!(allowed_tool_url(
            &"http://192.168.1.10".parse().unwrap(),
            true
        ));
    }

    #[test]
    fn entertainment_window_is_domain_limited() {
        assert!(allowed_entertainment_url(
            &"https://www.bilibili.com/video/1".parse().unwrap()
        ));
        assert!(allowed_entertainment_url(
            &"https://www.douyin.com".parse().unwrap()
        ));
        assert!(!allowed_entertainment_url(
            &"https://example.com".parse().unwrap()
        ));
    }
}

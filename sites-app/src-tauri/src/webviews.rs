use chrono::Utc;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    net::IpAddr,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem, Submenu},
    webview::{NewWindowFeatures, NewWindowResponse},
    Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;
use url::Url;
use uuid::Uuid;

const TOOL_WINDOW_LABEL: &str = "tool-browser";
const ENTERTAINMENT_WINDOW_LABEL: &str = "entertainment";
const ENTERTAINMENT_POPUP_PREFIX: &str = "entertainment-popup-";
const ENTERTAINMENT_CAPTURE_WINDOW_LABEL: &str = "entertainment-capture";
static NEXT_ENTERTAINMENT_POPUP_ID: AtomicU64 = AtomicU64::new(1);

const ENTERTAINMENT_INITIALIZATION_SCRIPT: &str = r#"
(() => {
  if (window.__personalEntertainmentNavigationInstalled) return;
  window.__personalEntertainmentNavigationInstalled = true;

  const isOfficialEntertainmentUrl = (value) => {
    try {
      const target = new URL(String(value || ''), location.href);
      if (target.protocol !== 'https:') return false;
      const host = target.hostname.toLowerCase();
      return host === 'bilibili.com'
        || host.endsWith('.bilibili.com')
        || host === 'b23.tv'
        || host.endsWith('.b23.tv')
        || host === 'douyin.com'
        || host.endsWith('.douyin.com')
        || host === 'bytedance.com'
        || host.endsWith('.bytedance.com');
    } catch (_) {
      return false;
    }
  };

  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (anchor && String(anchor.target || '').toLowerCase() === '_blank' && isOfficialEntertainmentUrl(anchor.href)) {
      anchor.target = '_self';
    }
  }, true);

  document.addEventListener('submit', (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (form && String(form.target || '').toLowerCase() === '_blank' && isOfficialEntertainmentUrl(form.action)) {
      form.target = '_self';
    }
  }, true);

  const nativeOpen = window.open.bind(window);
  window.open = (url, target, features) => {
    if (url && isOfficialEntertainmentUrl(url) && (!target || target === '_blank' || target === '_self')) {
      location.assign(new URL(String(url), location.href).href);
      return window;
    }
    return nativeOpen(url, target, features);
  };
})();
"#;

#[derive(Default)]
pub struct ToolWindowState {
    allow_insecure_http: AtomicBool,
}

#[derive(Default)]
pub struct EntertainmentCaptureState {
    pending: Mutex<Option<PendingEntertainmentCapture>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum EntertainmentCaptureMode {
    Explore,
    Thought,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntertainmentCaptureSnapshot {
    request_id: String,
    provider: String,
    canonical_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_id: Option<String>,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thumbnail_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    playback_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    selected_text: Option<String>,
    captured_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntertainmentCaptureView {
    mode: EntertainmentCaptureMode,
    snapshot: EntertainmentCaptureSnapshot,
    requires_confirmation: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EntertainmentCaptureRequest {
    mode: EntertainmentCaptureMode,
    snapshot: EntertainmentCaptureSnapshot,
    thought: String,
    quote: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEntertainmentCapture {
    provider: String,
    canonical_url: String,
    content_id: Option<String>,
    title: String,
    author: Option<String>,
    description: Option<String>,
    thumbnail_url: Option<String>,
    playback_seconds: Option<f64>,
    selected_text: Option<String>,
    is_specific_content: bool,
    resume_playback: bool,
}

struct PendingEntertainmentCapture {
    mode: EntertainmentCaptureMode,
    snapshot: EntertainmentCaptureSnapshot,
    source_window_label: String,
    requires_confirmation: bool,
    resume_playback: bool,
    submitted: bool,
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
                || host == "b23.tv"
                || host.ends_with(".b23.tv")
                || host == "douyin.com"
                || host.ends_with(".douyin.com")
                || host == "bytedance.com"
                || host.ends_with(".bytedance.com")
        })
}

fn allowed_entertainment_popup_url(url: &Url) -> bool {
    url.as_str() == "about:blank" || allowed_entertainment_url(url)
}

fn entertainment_home_url(url: &Url) -> Url {
    let target = url.host_str().map_or("", |host| host);
    let home = if target == "douyin.com"
        || target.ends_with(".douyin.com")
        || target == "bytedance.com"
        || target.ends_with(".bytedance.com")
    {
        "https://www.douyin.com"
    } else {
        "https://www.bilibili.com"
    };
    home.parse().expect("entertainment home URL is valid")
}

const ENTERTAINMENT_CAPTURE_SCRIPT: &str = r#"
(pauseForThought) => {
  const clean = (value, limit) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const meta = (...selectors) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const value = element?.getAttribute?.('content') || element?.getAttribute?.('href') || element?.textContent;
      if (value && clean(value, 4000)) return clean(value, 4000);
    }
    return '';
  };
  const current = new URL(location.href);
  const host = current.hostname.toLowerCase();
  const provider = host === 'douyin.com' || host.endsWith('.douyin.com') || host === 'bytedance.com' || host.endsWith('.bytedance.com')
    ? 'douyin'
    : 'bilibili';
  let contentId = '';
  let isSpecificContent = false;
  let canonicalUrl = `${current.origin}${current.pathname}`;

  if (provider === 'bilibili') {
    const videoMatch = current.pathname.match(/\/video\/((?:BV)[0-9A-Za-z]+|av\d+)/i);
    const bangumiMatch = current.pathname.match(/\/bangumi\/play\/((?:ep|ss)\d+)/i);
    if (videoMatch) {
      contentId = videoMatch[1];
      canonicalUrl = `${current.origin}/video/${contentId}`;
      const part = current.searchParams.get('p');
      if (part && /^\d+$/.test(part) && part !== '1') canonicalUrl += `?p=${part}`;
      isSpecificContent = true;
    } else if (bangumiMatch) {
      contentId = bangumiMatch[1];
      canonicalUrl = `${current.origin}/bangumi/play/${contentId}`;
      isSpecificContent = true;
    }
  } else {
    const videoMatch = current.pathname.match(/\/(?:video|note)\/(\d+)/i);
    const modalId = current.searchParams.get('modal_id') || current.searchParams.get('aweme_id');
    const resolvedId = videoMatch?.[1] || (modalId && /^\d+$/.test(modalId) ? modalId : '');
    if (resolvedId) {
      contentId = resolvedId;
      canonicalUrl = `https://www.douyin.com/video/${resolvedId}`;
      isSpecificContent = true;
    }
  }

  const candidates = Array.from(document.querySelectorAll('video')).map((video) => {
    const rect = video.getBoundingClientRect();
    const visibleWidth = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    const visibleHeight = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    return { video, score: visibleWidth * visibleHeight };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score);
  const activeVideo = candidates[0]?.video || null;
  const resumePlayback = Boolean(activeVideo && !activeVideo.paused && !activeVideo.ended);
  if (pauseForThought && resumePlayback) {
    window.__personalWorkbenchCaptureVideo = activeVideo;
    activeVideo.pause();
  }

  let thumbnailUrl = meta('meta[property="og:image"]', 'meta[name="twitter:image"]');
  try { if (thumbnailUrl) thumbnailUrl = new URL(thumbnailUrl, location.href).href; } catch (_) { thumbnailUrl = ''; }
  const rawTitle = meta('meta[property="og:title"]', 'meta[name="twitter:title"]') || document.title;
  const title = clean(rawTitle.replace(/[-_ ]+(哔哩哔哩|bilibili|抖音).*$/i, ''), 240) || (provider === 'bilibili' ? '哔哩哔哩内容' : '抖音内容');
  const author = meta('meta[name="author"]', 'meta[property="article:author"]', '[itemprop="author"] [itemprop="name"]');
  const description = meta('meta[property="og:description"]', 'meta[name="description"]', 'meta[name="twitter:description"]');
  const selectedText = clean(window.getSelection?.()?.toString?.(), 1000);
  const playbackSeconds = activeVideo && Number.isFinite(activeVideo.currentTime)
    ? Math.max(0, Math.min(activeVideo.currentTime, 86400))
    : null;

  return {
    provider,
    canonicalUrl,
    contentId: contentId || null,
    title,
    author: clean(author, 160) || null,
    description: clean(description, 4000) || null,
    thumbnailUrl: clean(thumbnailUrl, 2048) || null,
    playbackSeconds,
    selectedText: selectedText || null,
    isSpecificContent,
    resumePlayback,
  };
}
"#;

fn build_entertainment_menu(app: &tauri::AppHandle) -> Result<Menu<tauri::Wry>, String> {
    let collect = MenuItem::with_id(
        app,
        "entertainment-capture-explore",
        "收进探索库",
        true,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let thought = MenuItem::with_id(
        app,
        "entertainment-capture-thought",
        "记录此刻",
        true,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let back = MenuItem::with_id(app, "entertainment-back", "← 后退", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let forward = MenuItem::with_id(app, "entertainment-forward", "前进 →", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let reload = MenuItem::with_id(app, "entertainment-reload", "刷新", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let home = MenuItem::with_id(
        app,
        "entertainment-home",
        "返回平台首页",
        true,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let external = MenuItem::with_id(
        app,
        "entertainment-external",
        "在系统浏览器打开",
        true,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let close = MenuItem::with_id(app, "entertainment-close", "关闭并释放", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let page = Submenu::with_items(
        app,
        "页面",
        true,
        &[&back, &forward, &reload, &home, &external],
    )
    .map_err(|error| error.to_string())?;
    Menu::with_items(app, &[&collect, &thought, &page, &close]).map_err(|error| error.to_string())
}

fn handle_entertainment_menu(app: &tauri::AppHandle, window: &tauri::Window, event_id: &str) {
    let Some(webview) = app.get_webview_window(window.label()) else {
        return;
    };
    match event_id {
        "entertainment-capture-explore" | "entertainment-capture-thought" => {
            let capture_app = app.clone();
            let label = window.label().to_string();
            let mode = if event_id == "entertainment-capture-thought" {
                EntertainmentCaptureMode::Thought
            } else {
                EntertainmentCaptureMode::Explore
            };
            tauri::async_runtime::spawn(async move {
                if let Err(error) = begin_entertainment_capture(&capture_app, &label, mode).await {
                    show_entertainment_toast(&capture_app, &label, &error, true);
                }
            });
        }
        "entertainment-back" => {
            let _ = webview.eval("history.back()");
        }
        "entertainment-forward" => {
            let _ = webview.eval("history.forward()");
        }
        "entertainment-reload" => {
            let _ = webview.reload();
        }
        "entertainment-home" => {
            if let Ok(current) = webview.url() {
                let _ = webview.navigate(entertainment_home_url(&current));
            }
        }
        "entertainment-external" => {
            if let Ok(url) = webview.url() {
                let _ = app.opener().open_url(url.to_string(), None::<&str>);
            }
        }
        "entertainment-close" => {
            let _ = webview.destroy();
        }
        _ => {}
    }
}

async fn begin_entertainment_capture(
    app: &tauri::AppHandle,
    source_window_label: &str,
    mode: EntertainmentCaptureMode,
) -> Result<(), String> {
    let state = app.state::<EntertainmentCaptureState>();
    if state
        .pending
        .lock()
        .map_err(|_| "收集状态暂时不可用".to_string())?
        .is_some()
    {
        if let Some(panel) = app.get_webview_window(ENTERTAINMENT_CAPTURE_WINDOW_LABEL) {
            let _ = panel.show();
            let _ = panel.set_focus();
        }
        return Err("请先完成或取消当前记录".into());
    }

    let source = app
        .get_webview_window(source_window_label)
        .ok_or_else(|| "当前娱乐页面已经关闭".to_string())?;
    let pause_for_thought = mode == EntertainmentCaptureMode::Thought;
    let script = format!(
        "({ENTERTAINMENT_CAPTURE_SCRIPT})({})",
        if pause_for_thought { "true" } else { "false" }
    );
    let raw: RawEntertainmentCapture = eval_json(&source, &script)
        .await
        .map_err(|error| format!("没有读取到当前页面：{error}"))?;
    let current_url = source
        .url()
        .map_err(|error| format!("无法确认当前页面地址：{error}"))?;
    let validated = validate_entertainment_capture(raw, &current_url);
    let (snapshot, requires_confirmation, resume_playback) = match validated {
        Ok(value) => value,
        Err(error) => {
            resume_entertainment_playback(&source);
            return Err(error);
        }
    };
    let request = PendingEntertainmentCapture {
        mode,
        snapshot: snapshot.clone(),
        source_window_label: source_window_label.to_string(),
        requires_confirmation,
        resume_playback,
        submitted: false,
    };
    *state
        .pending
        .lock()
        .map_err(|_| "收集状态暂时不可用".to_string())? = Some(request);

    if mode == EntertainmentCaptureMode::Thought || requires_confirmation {
        if let Err(error) = open_entertainment_capture_panel(app, &source) {
            discard_pending_capture(app, Some(&snapshot.request_id));
            return Err(error);
        }
        return Ok(());
    }

    submit_pending_capture(app, "", "")
}

fn validate_entertainment_capture(
    raw: RawEntertainmentCapture,
    current_url: &Url,
) -> Result<(EntertainmentCaptureSnapshot, bool, bool), String> {
    if !allowed_entertainment_url(current_url) {
        return Err("当前页面不是允许收集的 B站或抖音页面".into());
    }
    let canonical = raw
        .canonical_url
        .parse::<Url>()
        .map_err(|_| "页面返回的网址格式不正确".to_string())?;
    if !allowed_entertainment_url(&canonical) {
        return Err("页面返回的网址不属于 B站或抖音官方域名".into());
    }
    let provider = match raw.provider.as_str() {
        "bilibili" => "bilibili",
        "douyin" => "douyin",
        _ => return Err("没有识别到当前娱乐平台".into()),
    };
    let current_is_douyin = current_url.host_str().is_some_and(|host| {
        host == "douyin.com"
            || host.ends_with(".douyin.com")
            || host == "bytedance.com"
            || host.ends_with(".bytedance.com")
    });
    if (provider == "douyin") != current_is_douyin {
        return Err("页面平台与当前网址不一致".into());
    }
    let title = trim_capture_text(&raw.title, 240);
    if title.is_empty() {
        return Err("当前页面没有可保存的标题".into());
    }
    let thumbnail_url = raw.thumbnail_url.and_then(|value| {
        let value = trim_capture_text(&value, 2_048);
        value
            .parse::<Url>()
            .ok()
            .filter(|url| url.scheme() == "https")
            .map(|url| url.to_string())
    });
    let playback_seconds = raw
        .playback_seconds
        .filter(|value| value.is_finite() && *value >= 0.0 && *value <= 86_400.0);
    let snapshot = EntertainmentCaptureSnapshot {
        request_id: Uuid::new_v4().to_string(),
        provider: provider.to_string(),
        canonical_url: canonical.to_string(),
        content_id: limited_optional(raw.content_id, 120),
        title,
        author: limited_optional(raw.author, 160),
        description: limited_optional(raw.description, 4_000),
        thumbnail_url,
        playback_seconds,
        selected_text: limited_optional(raw.selected_text, 1_000),
        captured_at: Utc::now().to_rfc3339(),
    };
    Ok((snapshot, !raw.is_specific_content, raw.resume_playback))
}

fn open_entertainment_capture_panel(
    app: &tauri::AppHandle,
    source: &WebviewWindow,
) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window(ENTERTAINMENT_CAPTURE_WINDOW_LABEL) {
        panel
            .show()
            .and_then(|_| panel.set_focus())
            .map_err(|error| format!("无法显示记录窗口：{error}"))?;
        return Ok(());
    }
    let cleanup_app = app.clone();
    let mut builder = WebviewWindowBuilder::new(
        app,
        ENTERTAINMENT_CAPTURE_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("记录当前内容")
    .inner_size(560.0, 580.0)
    .min_inner_size(480.0, 460.0)
    .center()
    .resizable(false)
    .skip_taskbar(true);
    builder = builder
        .owner(source)
        .map_err(|error| format!("无法关联记录窗口：{error}"))?;
    let panel = builder
        .build()
        .map_err(|error| format!("无法打开记录窗口：{error}"))?;
    panel.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            discard_pending_capture(&cleanup_app, None);
        }
    });
    Ok(())
}

fn submit_pending_capture(
    app: &tauri::AppHandle,
    thought: &str,
    quote: &str,
) -> Result<(), String> {
    let state = app.state::<EntertainmentCaptureState>();
    let request = {
        let mut guard = state
            .pending
            .lock()
            .map_err(|_| "收集状态暂时不可用".to_string())?;
        let pending = guard
            .as_mut()
            .ok_or_else(|| "当前没有等待保存的内容".to_string())?;
        if pending.submitted {
            return Err("这条内容正在保存，请稍候".into());
        }
        let thought = trim_capture_text(thought, 4_000);
        if pending.mode == EntertainmentCaptureMode::Thought && thought.is_empty() {
            return Err("请先写下这一刻想记录的内容".into());
        }
        pending.submitted = true;
        EntertainmentCaptureRequest {
            mode: pending.mode,
            snapshot: pending.snapshot.clone(),
            thought,
            quote: trim_capture_text(quote, 1_000),
        }
    };
    if let Err(error) = app.emit_to("main", "entertainment-capture-request", request) {
        if let Ok(mut guard) = state.pending.lock() {
            if let Some(pending) = guard.as_mut() {
                pending.submitted = false;
            }
        }
        return Err(format!("无法把内容交给主工作台：{error}"));
    }
    Ok(())
}

fn discard_pending_capture(app: &tauri::AppHandle, request_id: Option<&str>) {
    let state = app.state::<EntertainmentCaptureState>();
    let pending = state.pending.lock().ok().and_then(|mut guard| {
        let matches = guard.as_ref().is_some_and(|pending| {
            request_id.is_none_or(|request_id| pending.snapshot.request_id == request_id)
        });
        if matches {
            guard.take()
        } else {
            None
        }
    });
    if let Some(pending) = pending {
        restore_pending_playback(app, &pending);
    }
}

fn restore_pending_playback(app: &tauri::AppHandle, pending: &PendingEntertainmentCapture) {
    if !pending.resume_playback {
        return;
    }
    if let Some(source) = app.get_webview_window(&pending.source_window_label) {
        resume_entertainment_playback(&source);
    }
}

fn resume_entertainment_playback(source: &WebviewWindow) {
    let _ = source.eval(
        "(() => { const video = window.__personalWorkbenchCaptureVideo; window.__personalWorkbenchCaptureVideo = null; if (video?.play) video.play().catch(() => {}); })()",
    );
}

fn show_entertainment_toast(
    app: &tauri::AppHandle,
    source_window_label: &str,
    message: &str,
    warning: bool,
) {
    let Some(source) = app.get_webview_window(source_window_label) else {
        return;
    };
    let message = serde_json::to_string(&trim_capture_text(message, 240))
        .unwrap_or_else(|_| "\"操作没有完成\"".into());
    let tone = if warning { "#b85c51" } else { "#4f6fbe" };
    let script = format!(
        r#"(() => {{
          document.getElementById('__personal-workbench-toast')?.remove();
          const host = document.createElement('div');
          host.id = '__personal-workbench-toast';
          host.style.cssText = 'position:fixed;left:50%;top:72px;transform:translateX(-50%);z-index:2147483647;pointer-events:none';
          const shadow = host.attachShadow({{mode:'closed'}});
          const toast = document.createElement('div');
          toast.textContent = {message};
          toast.style.cssText = 'max-width:520px;padding:12px 18px;border-radius:14px;background:{tone};color:white;font:600 14px/1.5 system-ui,sans-serif;box-shadow:0 14px 35px rgba(30,37,64,.24)';
          shadow.appendChild(toast); document.documentElement.appendChild(host);
          setTimeout(() => host.remove(), 2600);
        }})()"#
    );
    let _ = source.eval(script);
}

fn trim_capture_text(value: &str, maximum: usize) -> String {
    value.trim().chars().take(maximum).collect()
}

fn limited_optional(value: Option<String>, maximum: usize) -> Option<String> {
    value
        .map(|value| trim_capture_text(&value, maximum))
        .filter(|value| !value.is_empty())
}

#[tauri::command]
pub fn entertainment_capture_get_pending(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<EntertainmentCaptureView, String> {
    if window.label() != ENTERTAINMENT_CAPTURE_WINDOW_LABEL {
        return Err("只有记录窗口可以读取当前收集内容".into());
    }
    let state = app.state::<EntertainmentCaptureState>();
    let guard = state
        .pending
        .lock()
        .map_err(|_| "收集状态暂时不可用".to_string())?;
    let pending = guard
        .as_ref()
        .ok_or_else(|| "当前没有等待记录的内容".to_string())?;
    Ok(EntertainmentCaptureView {
        mode: pending.mode,
        snapshot: pending.snapshot.clone(),
        requires_confirmation: pending.requires_confirmation,
    })
}

#[tauri::command]
pub fn entertainment_capture_submit(
    window: WebviewWindow,
    app: tauri::AppHandle,
    thought: String,
    quote: String,
) -> Result<(), String> {
    if window.label() != ENTERTAINMENT_CAPTURE_WINDOW_LABEL {
        return Err("只有记录窗口可以提交当前内容".into());
    }
    submit_pending_capture(&app, &thought, &quote)
}

#[tauri::command]
pub fn entertainment_capture_cancel(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if window.label() != ENTERTAINMENT_CAPTURE_WINDOW_LABEL {
        return Err("只有记录窗口可以取消当前内容".into());
    }
    discard_pending_capture(&app, None);
    window
        .destroy()
        .map_err(|error| format!("无法关闭记录窗口：{error}"))
}

#[tauri::command]
pub fn entertainment_capture_complete(
    window: WebviewWindow,
    app: tauri::AppHandle,
    request_id: String,
    success: bool,
    message: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只有主工作台可以确认保存结果".into());
    }
    let state = app.state::<EntertainmentCaptureState>();
    let mut guard = state
        .pending
        .lock()
        .map_err(|_| "收集状态暂时不可用".to_string())?;
    let pending = guard
        .as_mut()
        .filter(|pending| pending.snapshot.request_id == request_id)
        .ok_or_else(|| "这次收集已经结束或结果已过期".to_string())?;
    let source_window_label = pending.source_window_label.clone();
    if !success {
        pending.submitted = false;
        drop(guard);
        if let Some(panel) = app.get_webview_window(ENTERTAINMENT_CAPTURE_WINDOW_LABEL) {
            let detail = serde_json::to_string(&message).unwrap_or_else(|_| "\"保存失败\"".into());
            let _ = panel.eval(format!(
                "window.dispatchEvent(new CustomEvent('entertainment-capture-error', {{ detail: {detail} }}))"
            ));
        } else {
            show_entertainment_toast(&app, &source_window_label, &message, true);
            discard_pending_capture(&app, Some(&request_id));
        }
        return Ok(());
    }
    let pending = guard.take().expect("pending capture exists");
    drop(guard);
    restore_pending_playback(&app, &pending);
    show_entertainment_toast(&app, &source_window_label, &message, false);
    if let Some(panel) = app.get_webview_window(ENTERTAINMENT_CAPTURE_WINDOW_LABEL) {
        let _ = panel.destroy();
    }
    Ok(())
}

fn destroy_entertainment_popups(app: &tauri::AppHandle, except_label: Option<&str>) {
    for (label, window) in app.webview_windows() {
        if label.starts_with(ENTERTAINMENT_POPUP_PREFIX) && Some(label.as_str()) != except_label {
            let _ = window.destroy();
        }
    }
}

fn create_entertainment_popup(
    app: &tauri::AppHandle,
    features: NewWindowFeatures,
) -> Result<WebviewWindow, String> {
    let label = format!(
        "{ENTERTAINMENT_POPUP_PREFIX}{}",
        NEXT_ENTERTAINMENT_POPUP_ID.fetch_add(1, Ordering::Relaxed)
    );
    let nested_app = app.clone();
    let menu_app = app.clone();
    let window = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::External("about:blank".parse().expect("about:blank is valid")),
    )
    .title("娱乐内容")
    .inner_size(1180.0, 800.0)
    .min_inner_size(760.0, 520.0)
    .center()
    .resizable(true)
    .window_features(features)
    .initialization_script(ENTERTAINMENT_INITIALIZATION_SCRIPT)
    .menu(build_entertainment_menu(app)?)
    .on_navigation(allowed_entertainment_popup_url)
    .on_new_window(move |target, popup_features| {
        entertainment_new_window_response(&nested_app, target, popup_features)
    })
    .on_document_title_changed(|window, title| {
        let title = if title.trim().is_empty() {
            "娱乐内容"
        } else {
            &title
        };
        let _ = window.set_title(&format!("{title} · 娱乐窗口"));
    })
    .on_menu_event(move |window, event| {
        handle_entertainment_menu(&menu_app, window, event.id().as_ref())
    })
    .build()
    .map_err(|error| format!("无法创建娱乐辅助窗口：{error}"))?;

    let cleanup_app = app.clone();
    let current_label = label.clone();
    tauri::async_runtime::spawn(async move {
        tokio::task::yield_now().await;
        destroy_entertainment_popups(&cleanup_app, Some(&current_label));
    });
    Ok(window)
}

fn entertainment_new_window_response(
    app: &tauri::AppHandle,
    target: Url,
    features: NewWindowFeatures,
) -> NewWindowResponse<tauri::Wry> {
    if !allowed_entertainment_popup_url(&target) {
        return NewWindowResponse::Deny;
    }
    match create_entertainment_popup(app, features) {
        Ok(window) => NewWindowResponse::Create { window },
        Err(_) => NewWindowResponse::Deny,
    }
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
    let menu_app = app.clone();
    let window =
        WebviewWindowBuilder::new(&app, ENTERTAINMENT_WINDOW_LABEL, WebviewUrl::External(url))
            .title("娱乐窗口")
            .inner_size(1180.0, 800.0)
            .min_inner_size(760.0, 520.0)
            .center()
            .resizable(true)
            .data_directory(profile)
            .initialization_script(ENTERTAINMENT_INITIALIZATION_SCRIPT)
            .menu(build_entertainment_menu(&app)?)
            .on_navigation(allowed_entertainment_url)
            .on_new_window(move |target, features| {
                entertainment_new_window_response(&popup_app, target, features)
            })
            .on_document_title_changed(|window, title| {
                let title = if title.trim().is_empty() {
                    "娱乐窗口"
                } else {
                    &title
                };
                let _ = window.set_title(&format!("{title} · 娱乐窗口"));
            })
            .on_menu_event(move |window, event| {
                handle_entertainment_menu(&menu_app, window, event.id().as_ref())
            })
            .build()
            .map_err(|error| format!("无法创建娱乐窗口：{error}"))?;
    let cleanup_app = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            destroy_entertainment_popups(&cleanup_app, None);
        }
    });
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
    use super::{
        allowed_entertainment_popup_url, allowed_entertainment_url, allowed_tool_url,
        entertainment_home_url, validate_entertainment_capture, RawEntertainmentCapture,
        ENTERTAINMENT_CAPTURE_SCRIPT, ENTERTAINMENT_INITIALIZATION_SCRIPT,
    };

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
            &"https://search.bilibili.com/all?keyword=tauri"
                .parse()
                .unwrap()
        ));
        assert!(allowed_entertainment_url(
            &"https://b23.tv/example".parse().unwrap()
        ));
        assert!(allowed_entertainment_url(
            &"https://www.douyin.com".parse().unwrap()
        ));
        assert!(!allowed_entertainment_url(
            &"https://example.com".parse().unwrap()
        ));
        assert!(!allowed_entertainment_url(
            &"javascript:alert(1)".parse().unwrap()
        ));
    }

    #[test]
    fn entertainment_popups_only_use_blank_bootstrap_or_official_pages() {
        assert!(allowed_entertainment_popup_url(
            &"about:blank".parse().unwrap()
        ));
        assert!(allowed_entertainment_popup_url(
            &"https://space.bilibili.com/1".parse().unwrap()
        ));
        assert!(!allowed_entertainment_popup_url(
            &"data:text/html,hello".parse().unwrap()
        ));
        assert!(!allowed_entertainment_popup_url(
            &"https://example.com/ad".parse().unwrap()
        ));
    }

    #[test]
    fn entertainment_navigation_script_keeps_official_blank_links_in_app() {
        assert!(ENTERTAINMENT_INITIALIZATION_SCRIPT.contains("anchor.target = '_self'"));
        assert!(ENTERTAINMENT_INITIALIZATION_SCRIPT.contains("form.target = '_self'"));
        assert!(ENTERTAINMENT_INITIALIZATION_SCRIPT.contains("location.assign"));
    }

    #[test]
    fn entertainment_home_follows_the_active_platform() {
        assert_eq!(
            entertainment_home_url(&"https://search.bilibili.com/all".parse().unwrap()).as_str(),
            "https://www.bilibili.com/"
        );
        assert_eq!(
            entertainment_home_url(&"https://www.douyin.com/video/1".parse().unwrap()).as_str(),
            "https://www.douyin.com/"
        );
    }

    #[test]
    fn capture_script_supports_video_parts_and_visible_douyin_items() {
        assert!(ENTERTAINMENT_CAPTURE_SCRIPT.contains("searchParams.get('p')"));
        assert!(ENTERTAINMENT_CAPTURE_SCRIPT.contains("modal_id"));
        assert!(ENTERTAINMENT_CAPTURE_SCRIPT.contains("getSelection"));
        assert!(ENTERTAINMENT_CAPTURE_SCRIPT.contains("activeVideo.pause"));
    }

    #[test]
    fn validates_and_limits_capture_payloads() {
        let raw = RawEntertainmentCapture {
            provider: "bilibili".into(),
            canonical_url: "https://www.bilibili.com/video/BV1test?p=2".into(),
            content_id: Some("BV1test".into()),
            title: "课程标题".repeat(100),
            author: Some("作者".into()),
            description: Some("简介".into()),
            thumbnail_url: Some("javascript:alert(1)".into()),
            playback_seconds: Some(120.5),
            selected_text: Some("引用".into()),
            is_specific_content: true,
            resume_playback: true,
        };
        let (snapshot, confirmation, resume) = validate_entertainment_capture(
            raw,
            &"https://www.bilibili.com/video/BV1test?p=2"
                .parse()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(snapshot.title.chars().count(), 240);
        assert!(snapshot.thumbnail_url.is_none());
        assert_eq!(snapshot.playback_seconds, Some(120.5));
        assert!(!confirmation);
        assert!(resume);
    }

    #[test]
    fn rejects_spoofed_capture_platform_and_domain() {
        let raw = RawEntertainmentCapture {
            provider: "douyin".into(),
            canonical_url: "https://www.douyin.com/video/123".into(),
            content_id: Some("123".into()),
            title: "测试".into(),
            author: None,
            description: None,
            thumbnail_url: None,
            playback_seconds: None,
            selected_text: None,
            is_specific_content: true,
            resume_playback: false,
        };
        assert!(validate_entertainment_capture(
            raw,
            &"https://www.bilibili.com/video/BV1test".parse().unwrap(),
        )
        .is_err());
    }
}

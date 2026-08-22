use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;
use url::Url;

const WINDOW_LABEL: &str = "deepseek-bridge";
const ADAPTER_VERSION: u8 = 2;
const IDLE_SECONDS: u64 = 15 * 60;

pub struct DeepSeekBridgeState {
    lifecycle_generation: AtomicU64,
}

impl Default for DeepSeekBridgeState {
    fn default() -> Self {
        Self {
            lifecycle_generation: AtomicU64::new(0),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekSnapshot {
    status: String,
    ready: bool,
    generating: bool,
    #[serde(default)]
    text: String,
    #[serde(default)]
    conversation_ref: String,
    #[serde(default)]
    error: String,
    adapter_version: u8,
}

impl DeepSeekSnapshot {
    fn preparing() -> Self {
        Self {
            status: "preparing".into(),
            ready: false,
            generating: false,
            text: String::new(),
            conversation_ref: String::new(),
            error: String::new(),
            adapter_version: ADAPTER_VERSION,
        }
    }
}

const ADAPTER_SCRIPT: &str = r#"
(() => {
  if (!/(^|\.)deepseek\.com$/i.test(location.hostname)) return;
  const VERSION = 2;
  const text = (node) => (node?.innerText || node?.textContent || '').trim();
  const markdownText = (node) => {
    const renderChildren = (parent, context = {}) => Array.from(parent?.childNodes || []).map((child) => render(child, context)).join('');
    const compactInline = (value) => value.replace(/[\t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').trim();
    const renderList = (list, ordered, depth) => {
      const items = Array.from(list.children).filter((child) => child.tagName === 'LI');
      const result = items.map((item, index) => {
        const parts = Array.from(item.childNodes).map((child) => {
          if (child.nodeType === Node.ELEMENT_NODE && /^(UL|OL)$/.test(child.tagName)) {
            return `\n${renderList(child, child.tagName === 'OL', depth + 1).trimEnd()}`;
          }
          return render(child, { listDepth: depth });
        }).join('').trim().replace(/\n{3,}/g, '\n\n');
        const prefix = ordered ? `${index + 1}. ` : '- ';
        const indent = '  '.repeat(depth);
        return parts.split('\n').map((line, lineIndex) => `${indent}${lineIndex === 0 ? prefix : '  '}${line}`).join('\n');
      }).join('\n');
      return `${result}\n\n`;
    };
    const renderTable = (table) => {
      const rows = Array.from(table.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tr'));
      if (!rows.length) return '';
      const cells = rows.map((row) => Array.from(row.children).filter((cell) => /^(TH|TD)$/.test(cell.tagName)).map((cell) => compactInline(renderChildren(cell)).replace(/\|/g, '\\|')));
      const width = Math.max(...cells.map((row) => row.length));
      const header = cells[0];
      while (header.length < width) header.push('');
      const separator = Array.from({ length: width }, () => '---');
      return `${[header, separator, ...cells.slice(1)].map((row) => `| ${[...row, ...Array(Math.max(0, width - row.length)).fill('')].join(' | ')} |`).join('\n')}\n\n`;
    };
    const render = (current, context = {}) => {
      if (!current) return '';
      if (current.nodeType === Node.TEXT_NODE) return current.nodeValue || '';
      if (current.nodeType !== Node.ELEMENT_NODE) return '';
      const tag = current.tagName;
      if (/^(BUTTON|SVG|PATH|SCRIPT|STYLE|NOSCRIPT)$/.test(tag) || current.getAttribute('aria-hidden') === 'true') return '';
      if (tag === 'BR') return '\n';
      if (/^H[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${compactInline(renderChildren(current))}\n\n`;
      if (tag === 'P') return `${renderChildren(current).trim()}\n\n`;
      if (tag === 'STRONG' || tag === 'B') return `&#8203;**${renderChildren(current).trim()}**&#8203;`;
      if (tag === 'EM' || tag === 'I') return `*${renderChildren(current).trim()}*`;
      if (tag === 'DEL' || tag === 'S') return `~~${renderChildren(current).trim()}~~`;
      if (tag === 'A') {
        const label = renderChildren(current).trim();
        const href = current.getAttribute('href') || '';
        return href && label ? `[${label}](${href})` : label;
      }
      if (tag === 'IMG') {
        const alt = current.getAttribute('alt') || '';
        const src = current.getAttribute('src') || '';
        return src ? `![${alt}](${src})` : alt;
      }
      if (tag === 'CODE' && current.parentElement?.tagName !== 'PRE') {
        const value = current.textContent || '';
        const fence = value.includes('`') ? '``' : '`';
        return `${fence}${value}${fence}`;
      }
      if (tag === 'PRE') {
        const code = current.querySelector('code') || current;
        const language = Array.from(code.classList || []).map((name) => name.match(/(?:language-|lang-)([\w+-]+)/)?.[1]).find(Boolean) || '';
        return `\`\`\`${language}\n${(code.textContent || '').replace(/\n$/, '')}\n\`\`\`\n\n`;
      }
      if (tag === 'UL' || tag === 'OL') return renderList(current, tag === 'OL', Number(context.listDepth || 0));
      if (tag === 'BLOCKQUOTE') return `${renderChildren(current).trim().split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
      if (tag === 'HR') return '---\n\n';
      if (tag === 'TABLE') return renderTable(current);
      const content = renderChildren(current, context);
      return /^(DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER)$/.test(tag) ? `${content}\n` : content;
    };
    return render(node)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };
  const visible = (node) => !!node && node.getClientRects().length > 0;
  const buttons = () => Array.from(document.querySelectorAll('button')).filter(visible);
  const findButton = (patterns) => buttons().find((button) => {
    const label = `${text(button)} ${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`;
    return patterns.some((pattern) => pattern.test(label));
  });
  const editor = () => Array.from(document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]')).find(visible) || null;
  const stopButton = () => findButton([/停止|终止|stop generating|stop response|stop$/i]);
  const sendButton = () => findButton([/发送|send|提交/i]);
  const newButton = () => findButton([/新建对话|新对话|开启新对话|new chat|new conversation/i]);
  const assistantText = () => {
    const selectors = [
      '.ds-assistant-message-main-content',
      '[class*="assistant"] [class*="markdown"]',
      '.ds-markdown',
      '.markdown-body'
    ];
    const candidates = [...new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(visible))];
    const outermost = candidates.filter((candidate) => !candidates.some((other) => other !== candidate && other.contains(candidate)));
    const values = (outermost.length ? outermost : candidates).map((node) => ({ node, value: markdownText(node) })).filter((item) => item.value);
    if (values.length) {
      values.sort((left, right) => {
        const position = left.node.compareDocumentPosition(right.node);
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });
      return values.at(-1)?.value || '';
    }
    const messageContainers = Array.from(document.querySelectorAll('[data-message-role="assistant"], [data-role="assistant"]')).filter(visible);
    return messageContainers.length ? markdownText(messageContainers.at(-1)) : '';
  };
  const currentConversationRow = () => {
    const currentPath = location.pathname.replace(/\/$/, '');
    const anchors = Array.from(document.querySelectorAll('a[href]')).filter(visible);
    const activeLink = anchors.find((anchor) => {
      try { return new URL(anchor.href, location.href).pathname.replace(/\/$/, '') === currentPath; }
      catch { return false; }
    });
    if (activeLink) {
      let node = activeLink;
      for (let depth = 0; depth < 7 && node; depth += 1, node = node.parentElement) {
        if (node.querySelectorAll?.('button').length) return node;
      }
    }
    return document.querySelector('[aria-current="page"], [data-state="active"], [class*="active"][class*="chat"], [class*="selected"][class*="chat"]');
  };
  const exactAction = (patterns) => {
    const candidates = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="option"]')).filter(visible);
    return candidates.find((node) => patterns.some((pattern) => pattern.test(text(node))));
  };
  const loginRequired = () => {
    const body = text(document.body).slice(0, 4000);
    const hasLoginCopy = /扫码登录|密码登录|手机号登录|登录 DeepSeek|sign in|log in/i.test(body);
    return !editor() && hasLoginCopy;
  };
  const snapshot = () => {
    if (document.readyState !== 'complete' && document.readyState !== 'interactive') {
      return { status: 'preparing', ready: false, generating: false, text: '', conversationRef: '', error: '', adapterVersion: VERSION };
    }
    if (loginRequired()) {
      return { status: 'login_required', ready: false, generating: false, text: assistantText(), conversationRef: location.href, error: '', adapterVersion: VERSION };
    }
    const input = editor();
    if (!input) {
      return { status: 'adapter_error', ready: false, generating: false, text: assistantText(), conversationRef: location.href, error: '没有识别到 DeepSeek 输入框，网页结构可能已经变化。', adapterVersion: VERSION };
    }
    const generating = !!stopButton();
    return { status: generating ? 'generating' : 'ready', ready: true, generating, text: assistantText(), conversationRef: location.href, error: '', adapterVersion: VERSION };
  };
  const setInput = (input, prompt) => {
    input.focus();
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
      descriptor?.set?.call(input, prompt);
    } else {
      input.textContent = '';
      document.execCommand('insertText', false, prompt);
      if (!text(input)) input.textContent = prompt;
    }
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  window.__personalDeepSeekBridge = {
    version: VERSION,
    snapshot,
    send(prompt) {
      try {
        const input = editor();
        if (!input) return { ...snapshot(), status: 'adapter_error', error: '没有识别到输入框。' };
        setInput(input, String(prompt || ''));
        const button = sendButton();
        if (button && !button.disabled) button.click();
        else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        return snapshot();
      } catch (error) {
        return { ...snapshot(), status: 'adapter_error', error: String(error?.message || error) };
      }
    },
    stop() { stopButton()?.click(); return snapshot(); },
    newConversation() {
      const button = newButton();
      if (!button) return { ...snapshot(), status: 'adapter_error', error: '没有识别到“新对话”按钮。' };
      button.click();
      return snapshot();
    },
    openDeleteMenu() {
      const row = currentConversationRow();
      if (!row) return { ok: false, error: '没有在官网侧栏中识别到当前会话。' };
      row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      const rowButtons = Array.from(row.querySelectorAll('button')).filter(visible);
      const more = rowButtons.find((button) => /更多|more|操作|\.\.\./i.test(`${text(button)} ${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`)) || rowButtons.at(-1);
      if (!more) return { ok: false, error: '没有识别到官网会话菜单。' };
      more.click();
      return { ok: true, error: '' };
    },
    clickDeleteAction() {
      const action = exactAction([/^删除$/i, /^delete$/i, /删除对话/i, /delete chat/i]);
      if (!action) return { ok: false, error: '没有识别到官网的删除操作。' };
      action.click();
      return { ok: true, error: '' };
    }
  };
})();
"#;

fn deepseek_url() -> Result<Url, String> {
    "https://chat.deepseek.com"
        .parse()
        .map_err(|error| format!("DeepSeek 地址无效：{error}"))
}

fn allowed_deepseek_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| host == "deepseek.com" || host.ends_with(".deepseek.com"))
}

fn ensure_window(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        return Ok(window);
    }
    let data_directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法准备 DeepSeek 登录目录：{error}"))?
        .join("webview-profiles")
        .join("deepseek");
    let mut builder =
        WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(deepseek_url()?))
            .title("DeepSeek · AI 助手连接")
            .inner_size(1080.0, 760.0)
            .min_inner_size(760.0, 560.0)
            .center()
            .visible(false)
            .skip_taskbar(true)
            .resizable(true)
            .data_directory(data_directory)
            .initialization_script(ADAPTER_SCRIPT)
            .on_navigation(allowed_deepseek_url)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    if let Some(main) = app.get_webview_window("main") {
        builder = builder
            .owner(&main)
            .map_err(|error| format!("无法关联 DeepSeek 窗口：{error}"))?;
    }
    builder
        .build()
        .map_err(|error| format!("无法打开 DeepSeek 页面：{error}"))
}

async fn eval_json<T: DeserializeOwned>(
    window: &WebviewWindow,
    script: String,
) -> Result<T, String> {
    let (sender, receiver) = oneshot::channel::<String>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    window
        .eval_with_callback(script, move |result| {
            if let Some(sender) = sender.lock().ok().and_then(|mut value| value.take()) {
                let _ = sender.send(result);
            }
        })
        .map_err(|error| format!("无法读取 DeepSeek 页面：{error}"))?;
    let raw = tokio::time::timeout(Duration::from_secs(5), receiver)
        .await
        .map_err(|_| "等待 DeepSeek 页面响应超时".to_string())?
        .map_err(|_| "DeepSeek 页面响应已中断".to_string())?;
    serde_json::from_str(&raw)
        .map_err(|error| format!("DeepSeek 页面返回了无法识别的数据：{error}"))
}

async fn snapshot(window: &WebviewWindow) -> Result<DeepSeekSnapshot, String> {
    eval_json(
        window,
        format!(
            "window.__personalDeepSeekBridge?.snapshot?.() ?? {{status:'preparing',ready:false,generating:false,text:'',conversationRef:location.href,error:'',adapterVersion:{ADAPTER_VERSION}}}"
        ),
    )
    .await
}

#[tauri::command]
pub async fn deepseek_prepare(
    app: tauri::AppHandle,
    state: State<'_, DeepSeekBridgeState>,
) -> Result<DeepSeekSnapshot, String> {
    state.lifecycle_generation.fetch_add(1, Ordering::SeqCst);
    let window = ensure_window(&app)?;
    snapshot(&window)
        .await
        .or_else(|_| Ok(DeepSeekSnapshot::preparing()))
}

#[tauri::command]
pub async fn deepseek_get_status(app: tauri::AppHandle) -> Result<DeepSeekSnapshot, String> {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return Ok(DeepSeekSnapshot::preparing());
    };
    snapshot(&window).await
}

#[tauri::command]
pub async fn deepseek_send_message(
    app: tauri::AppHandle,
    prompt: String,
    state: State<'_, DeepSeekBridgeState>,
) -> Result<DeepSeekSnapshot, String> {
    if prompt.trim().is_empty() {
        return Err("问题不能为空".into());
    }
    state.lifecycle_generation.fetch_add(1, Ordering::SeqCst);
    let window = ensure_window(&app)?;
    let prompt =
        serde_json::to_string(prompt.trim()).map_err(|error| format!("无法准备问题：{error}"))?;
    eval_json(
        &window,
        format!("window.__personalDeepSeekBridge?.send?.({prompt}) ?? {{status:'preparing',ready:false,generating:false,text:'',conversationRef:location.href,error:'页面尚未准备完成',adapterVersion:{ADAPTER_VERSION}}}"),
    )
    .await
}

#[tauri::command]
pub async fn deepseek_stop_generation(app: tauri::AppHandle) -> Result<DeepSeekSnapshot, String> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| "DeepSeek 页面尚未打开".to_string())?;
    eval_json(
        &window,
        format!("window.__personalDeepSeekBridge?.stop?.() ?? {{status:'preparing',ready:false,generating:false,text:'',conversationRef:location.href,error:'页面尚未准备完成',adapterVersion:{ADAPTER_VERSION}}}"),
    )
    .await
}

#[tauri::command]
pub async fn deepseek_new_conversation(app: tauri::AppHandle) -> Result<DeepSeekSnapshot, String> {
    let window = ensure_window(&app)?;
    eval_json(
        &window,
        format!("window.__personalDeepSeekBridge?.newConversation?.() ?? {{status:'preparing',ready:false,generating:false,text:'',conversationRef:location.href,error:'页面尚未准备完成',adapterVersion:{ADAPTER_VERSION}}}"),
    )
    .await
}

#[tauri::command]
pub async fn deepseek_restore_conversation(
    app: tauri::AppHandle,
    conversation_ref: String,
) -> Result<DeepSeekSnapshot, String> {
    let url = conversation_ref
        .parse::<Url>()
        .map_err(|_| "保存的 DeepSeek 会话地址无效".to_string())?;
    if !allowed_deepseek_url(&url) {
        return Err("只能恢复 DeepSeek 官方会话".into());
    }
    let window = ensure_window(&app)?;
    window
        .navigate(url)
        .map_err(|error| format!("无法恢复 DeepSeek 会话：{error}"))?;
    Ok(DeepSeekSnapshot::preparing())
}

#[derive(Deserialize)]
struct DeepSeekActionResult {
    ok: bool,
    #[serde(default)]
    error: String,
}

async fn bridge_action(
    window: &WebviewWindow,
    action: &str,
) -> Result<DeepSeekActionResult, String> {
    eval_json(
        window,
        format!(
            "window.__personalDeepSeekBridge?.{action}?.() ?? {{ok:false,error:'DeepSeek 页面尚未准备完成'}}"
        ),
    )
    .await
}

#[tauri::command]
pub async fn deepseek_delete_conversation(
    app: tauri::AppHandle,
    conversation_ref: String,
) -> Result<(), String> {
    let url = conversation_ref
        .parse::<Url>()
        .map_err(|_| "保存的 DeepSeek 会话地址无效".to_string())?;
    if !allowed_deepseek_url(&url) || url.path() == "/" {
        return Err("这个本地记录还没有可同步删除的官网会话".into());
    }
    let window = ensure_window(&app)?;
    if window
        .url()
        .map_err(|error| format!("无法读取 DeepSeek 当前地址：{error}"))?
        != url
    {
        window
            .navigate(url.clone())
            .map_err(|error| format!("无法打开要删除的 DeepSeek 会话：{error}"))?;
        tokio::time::sleep(Duration::from_millis(900)).await;
    }
    let mut menu_result = None;
    for _ in 0..12 {
        if let Ok(result) = bridge_action(&window, "openDeleteMenu").await {
            if result.ok {
                menu_result = Some(result);
                break;
            }
            menu_result = Some(result);
        }
        tokio::time::sleep(Duration::from_millis(350)).await;
    }
    let menu = menu_result.ok_or_else(|| "官网会话尚未加载完成".to_string())?;
    if !menu.ok {
        return Err(if menu.error.is_empty() {
            "没有识别到官网会话菜单".into()
        } else {
            menu.error
        });
    }
    tokio::time::sleep(Duration::from_millis(250)).await;
    let delete = bridge_action(&window, "clickDeleteAction").await?;
    if !delete.ok {
        return Err(if delete.error.is_empty() {
            "没有识别到官网删除操作".into()
        } else {
            delete.error
        });
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    if let Ok(confirm) = bridge_action(&window, "clickDeleteAction").await {
        if confirm.ok {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
    for _ in 0..10 {
        let current = window
            .url()
            .map_err(|error| format!("无法确认官网删除结果：{error}"))?;
        if current.path().trim_end_matches('/') != url.path().trim_end_matches('/') {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(
        "未能确认官网会话已经删除；为避免数据不一致，本地记录已保留。请打开官网检查页面结构。"
            .into(),
    )
}

#[tauri::command]
pub async fn deepseek_show_official(
    app: tauri::AppHandle,
    state: State<'_, DeepSeekBridgeState>,
) -> Result<(), String> {
    state.lifecycle_generation.fetch_add(1, Ordering::SeqCst);
    let window = ensure_window(&app)?;
    window
        .set_skip_taskbar(false)
        .map_err(|error| format!("无法显示 DeepSeek 窗口：{error}"))?;
    window
        .show()
        .map_err(|error| format!("无法显示 DeepSeek 窗口：{error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("无法聚焦 DeepSeek 窗口：{error}"))
}

#[tauri::command]
pub async fn deepseek_release(
    app: tauri::AppHandle,
    state: State<'_, DeepSeekBridgeState>,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.hide();
        let _ = window.set_skip_taskbar(true);
    }
    let generation = state.lifecycle_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let state_generation = generation;
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(IDLE_SECONDS)).await;
        let current = app_handle.state::<DeepSeekBridgeState>();
        if current.lifecycle_generation.load(Ordering::SeqCst) == state_generation {
            if let Some(window) = app_handle.get_webview_window(WINDOW_LABEL) {
                let _ = window.destroy();
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::allowed_deepseek_url;

    #[test]
    fn limits_bridge_navigation_to_deepseek_https() {
        assert!(allowed_deepseek_url(
            &"https://chat.deepseek.com/a/chat/s/1".parse().unwrap()
        ));
        assert!(allowed_deepseek_url(
            &"https://platform.deepseek.com".parse().unwrap()
        ));
        assert!(!allowed_deepseek_url(
            &"http://chat.deepseek.com".parse().unwrap()
        ));
        assert!(!allowed_deepseek_url(
            &"https://deepseek.com.example.org".parse().unwrap()
        ));
    }
}

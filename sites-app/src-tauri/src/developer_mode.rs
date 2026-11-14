mod windows;

use std::path::PathBuf;
use tauri::{Manager, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

fn enabled() -> bool {
    cfg!(debug_assertions) && std::env::var("WORKBENCH_DEVELOPER_MODE").as_deref() == Ok("1")
}

pub(super) fn record(name: &str) {
    if enabled() {
        eprintln!("[workbench pid={}] {name}", std::process::id());
    }
}

fn log_directory(window: &WebviewWindow) -> Result<PathBuf, String> {
    if window.label() != "main" {
        return Err("请在工作台主窗口查看开发者模式。".into());
    }
    window
        .path()
        .app_local_data_dir()
        .map(|path| path.join("developer-logs"))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(super) fn developer_mode_active(window: WebviewWindow) -> Result<bool, String> {
    log_directory(&window)?;
    Ok(enabled())
}

#[tauri::command]
pub(super) async fn developer_mode_crashes(
    window: WebviewWindow,
) -> Result<Vec<windows::Crash>, String> {
    log_directory(&window)?;
    tauri::async_runtime::spawn_blocking(windows::recent_crashes)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(super) async fn developer_mode_open_logs(window: WebviewWindow) -> Result<(), String> {
    let directory = log_directory(&window)?;
    if !directory.is_dir() {
        return Err("运行一次「启动开发调试」后就会创建日志目录。".into());
    }
    window
        .opener()
        .open_path(directory.to_string_lossy(), None::<&str>)
        .map_err(|error| error.to_string())
}

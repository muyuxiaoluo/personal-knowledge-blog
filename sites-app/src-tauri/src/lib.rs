use serde::Serialize;
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupPath {
    path: String,
}

#[tauri::command]
fn reserve_backup_path(app: tauri::AppHandle) -> Result<BackupPath, String> {
    let backup_dir = app
        .path()
        .document_dir()
        .map(|path| path.join("人生攻略库备份"))
        .unwrap_or_else(|_| fallback_backup_dir(&app));

    fs::create_dir_all(&backup_dir).map_err(|error| format!("无法创建备份目录：{error}"))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("无法生成备份时间：{error}"))?
        .as_secs();
    let target = backup_dir.join(format!("mind-garden-{timestamp}.sqlite3"));
    if target.exists() {
        return Err("备份文件已经存在，请稍后再试。".into());
    }

    Ok(BackupPath {
        path: target.to_string_lossy().into_owned(),
    })
}

fn fallback_backup_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("backups")
}

fn reveal_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "未找到主窗口".to_string())?;
    window
        .unminimize()
        .map_err(|error| format!("无法恢复主窗口：{error}"))?;
    window
        .show()
        .map_err(|error| format!("无法显示主窗口：{error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("无法聚焦主窗口：{error}"))?;
    Ok(())
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    reveal_main_window(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri::{
                    menu::{Menu, MenuItem},
                    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
                };

                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new().build(),
                )?;

                let show_item = MenuItem::with_id(
                    app,
                    "show",
                    "打开人生攻略库",
                    true,
                    None::<&str>,
                )?;
                let capture_item = MenuItem::with_id(
                    app,
                    "capture",
                    "快速记录",
                    true,
                    None::<&str>,
                )?;
                let quit_item =
                    MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_item, &capture_item, &quit_item])?;

                let mut tray = TrayIconBuilder::new()
                    .tooltip("人生攻略库")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => {
                            let _ = reveal_main_window(app);
                        }
                        "capture" => {
                            let _ = reveal_main_window(app);
                            let _ = app.emit("open-quick-capture", ());
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let _ = reveal_main_window(tray.app_handle());
                        }
                    });
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.build(app)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            reserve_backup_path,
            show_main_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running the life strategy library");
}

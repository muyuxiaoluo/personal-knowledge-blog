use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Connection, Executor, SqliteConnection};
use std::{
    fs::{self, File},
    io::Read,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupPath {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SqliteStatement {
    sql: String,
    #[serde(default)]
    bind_values: Vec<Value>,
}

#[tauri::command]
async fn execute_sqlite_transaction(
    app: tauri::AppHandle,
    statements: Vec<SqliteStatement>,
) -> Result<(), String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位资料库：{error}"))?
        .join("mind-garden.db");
    let url = format!("sqlite:{}", path.to_string_lossy().replace('\\', "/"));
    let mut connection = SqliteConnection::connect(&url)
        .await
        .map_err(|error| format!("无法打开事务连接：{error}"))?;
    connection
        .execute("BEGIN IMMEDIATE")
        .await
        .map_err(|error| format!("无法开始事务：{error}"))?;

    for statement in statements {
        let mut query = sqlx::query(&statement.sql);
        for value in statement.bind_values {
            query = match value {
                Value::Null => query.bind(Option::<String>::None),
                Value::Bool(value) => query.bind(if value { 1_i64 } else { 0_i64 }),
                Value::Number(value) if value.is_i64() => {
                    query.bind(value.as_i64().unwrap_or_default())
                }
                Value::Number(value) if value.is_u64() => {
                    query.bind(value.as_u64().unwrap_or_default() as i64)
                }
                Value::Number(value) => query.bind(value.as_f64().unwrap_or_default()),
                Value::String(value) => query.bind(value),
                _ => {
                    let _ = connection.execute("ROLLBACK").await;
                    return Err("事务参数包含不支持的数据类型。".into());
                }
            };
        }
        if let Err(error) = query.execute(&mut connection).await {
            let _ = connection.execute("ROLLBACK").await;
            return Err(format!("事务写入失败，原数据已保留：{error}"));
        }
    }

    connection
        .execute("COMMIT")
        .await
        .map_err(|error| format!("无法提交事务：{error}"))?;
    Ok(())
}

fn backup_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .document_dir()
        .map(|path| path.join("人生攻略库备份"))
        .unwrap_or_else(|_| fallback_backup_dir(app))
}

#[tauri::command]
fn reserve_backup_path(app: tauri::AppHandle) -> Result<BackupPath, String> {
    let backup_dir = backup_dir(&app);

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

#[tauri::command]
fn latest_backup_path(app: tauri::AppHandle) -> Result<Option<BackupPath>, String> {
    let directory = backup_dir(&app);
    if !directory.exists() {
        return Ok(None);
    }
    let mut candidates = fs::read_dir(&directory)
        .map_err(|error| format!("无法读取备份目录：{error}"))?
        .filter_map(Result::ok)
        .filter(|entry| is_primary_backup_name(&entry.file_name().to_string_lossy()))
        .collect::<Vec<_>>();
    candidates.sort_by_key(|entry| {
        entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH)
    });
    Ok(candidates.last().map(|entry| BackupPath {
        path: entry.path().to_string_lossy().into_owned(),
    }))
}

fn is_primary_backup_name(name: &str) -> bool {
    name.strip_prefix("mind-garden-")
        .and_then(|value| value.strip_suffix(".sqlite3"))
        .is_some_and(|timestamp| {
            !timestamp.is_empty() && timestamp.chars().all(|value| value.is_ascii_digit())
        })
}

#[tauri::command]
fn restore_backup(app: tauri::AppHandle, source_path: String) -> Result<(), String> {
    let source = PathBuf::from(&source_path);
    let allowed_dir = backup_dir(&app)
        .canonicalize()
        .map_err(|error| format!("无法定位备份目录：{error}"))?;
    let canonical_source = source
        .canonicalize()
        .map_err(|error| format!("无法读取备份文件：{error}"))?;
    if !canonical_source.starts_with(&allowed_dir) {
        return Err("只能恢复人生攻略库备份目录中的文件。".into());
    }
    let mut header = [0_u8; 16];
    File::open(&canonical_source)
        .and_then(|mut file| file.read_exact(&mut header))
        .map_err(|error| format!("无法检查备份文件：{error}"))?;
    if &header != b"SQLite format 3\0" {
        return Err("所选文件不是有效的 SQLite 备份。".into());
    }

    let database = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位资料库：{error}"))?
        .join("mind-garden.db");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("无法生成安全备份时间：{error}"))?
        .as_secs();
    let safety_copy = allowed_dir.join(format!("mind-garden-before-restore-{timestamp}.sqlite3"));
    let temporary = database.with_extension("restore.tmp");
    fs::copy(&canonical_source, &temporary)
        .map_err(|error| format!("无法准备恢复文件：{error}"))?;
    if database.exists() {
        fs::rename(&database, &safety_copy)
            .map_err(|error| format!("无法创建恢复前安全副本：{error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, &database) {
        if safety_copy.exists() {
            let _ = fs::rename(&safety_copy, &database);
        }
        return Err(format!("无法启用恢复文件，当前资料库已保留：{error}"));
    }
    Ok(())
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

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
                app.handle()
                    .plugin(tauri_plugin_global_shortcut::Builder::new().build())?;

                let show_item =
                    MenuItem::with_id(app, "show", "打开人生攻略库", true, None::<&str>)?;
                let capture_item =
                    MenuItem::with_id(app, "capture", "快速记录", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
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
                        "quit" => {
                            let _ = app.emit("request-app-quit", ());
                        }
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
            latest_backup_path,
            restore_backup,
            execute_sqlite_transaction,
            show_main_window,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running the life strategy library");
}

#[cfg(test)]
mod tests {
    use super::is_primary_backup_name;

    #[test]
    fn selects_only_regular_timestamped_backups() {
        assert!(is_primary_backup_name("mind-garden-1786800000.sqlite3"));
        assert!(!is_primary_backup_name(
            "mind-garden-before-restore-1786800000.sqlite3"
        ));
        assert!(!is_primary_backup_name("mind-garden-latest.sqlite3"));
        assert!(!is_primary_backup_name("mind-garden-1786800000.db"));
    }
}

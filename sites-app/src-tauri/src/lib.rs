use serde::Serialize;
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![reserve_backup_path])
        .run(tauri::generate_context!())
        .expect("error while running the life strategy library");
}

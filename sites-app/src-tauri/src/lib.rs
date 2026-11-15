use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Connection, Executor, SqliteConnection};
#[cfg(desktop)]
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
#[cfg(desktop)]
use tauri::Emitter;
use tauri::Manager;

#[cfg(desktop)]
mod asaba;
#[cfg(desktop)]
mod attachments;
#[cfg(desktop)]
mod backup;
#[cfg(desktop)]
mod companion;
#[cfg(windows)]
mod companion_capture;
#[cfg(desktop)]
mod companion_codex;
#[cfg(desktop)]
mod companion_dictation;
#[cfg(desktop)]
mod companion_stage;
#[cfg(desktop)]
mod companion_tts;
#[cfg(desktop)]
mod companion_worker;
#[cfg(desktop)]
mod dashboard;
#[cfg(desktop)]
mod deepseek;
#[cfg(desktop)]
mod deepseek_api;
#[cfg(windows)]
mod developer_mode;
#[cfg(desktop)]
mod finance;
#[cfg(desktop)]
mod focus_reminders;
#[cfg(desktop)]
mod integrations;
#[cfg(windows)]
mod ollama_runtime;
#[cfg(desktop)]
mod reminders;
#[cfg(desktop)]
mod webviews;
#[cfg(windows)]
mod windows_focus_notification;
#[cfg(desktop)]
mod work_observer;
#[cfg(desktop)]
mod work_observer_analysis;
#[cfg(desktop)]
mod work_observer_files;
#[cfg(desktop)]
mod work_observer_screen;
#[cfg(desktop)]
mod xiaomi_health;
#[cfg(desktop)]
mod xiaomi_protocol;

#[cfg(desktop)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupPath {
    pub(crate) path: String,
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

#[cfg(desktop)]
pub(crate) fn backup_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .document_dir()
        .map(|path| path.join("个人工作台备份"))
        .unwrap_or_else(|_| fallback_backup_dir(app))
}

#[cfg(desktop)]
fn legacy_backup_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .document_dir()
        .ok()
        .map(|path| path.join("人生攻略库备份"))
}

#[tauri::command]
#[cfg(desktop)]
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
#[cfg(desktop)]
fn latest_backup_path(app: tauri::AppHandle) -> Result<Option<BackupPath>, String> {
    let mut directories = vec![backup_dir(&app)];
    if let Some(legacy) = legacy_backup_dir(&app) {
        directories.push(legacy);
    }
    let mut candidates = Vec::new();
    for directory in directories
        .into_iter()
        .filter(|directory| directory.exists())
    {
        candidates.extend(
            fs::read_dir(&directory)
                .map_err(|error| format!("无法读取备份目录：{error}"))?
                .filter_map(Result::ok)
                .filter(|entry| is_primary_backup_name(&entry.file_name().to_string_lossy())),
        );
    }
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

#[cfg(desktop)]
fn is_primary_backup_name(name: &str) -> bool {
    name.strip_prefix("mind-garden-")
        .and_then(|value| {
            value
                .strip_suffix(".mgbak")
                .or_else(|| value.strip_suffix(".sqlite3"))
        })
        .is_some_and(|timestamp| {
            !timestamp.is_empty() && timestamp.chars().all(|value| value.is_ascii_digit())
        })
}

#[tauri::command]
#[cfg(desktop)]
async fn restore_backup(app: tauri::AppHandle, source_path: String) -> Result<(), String> {
    let source = PathBuf::from(&source_path);
    let canonical_source = source
        .canonicalize()
        .map_err(|error| format!("无法读取备份文件：{error}"))?;
    let mut allowed_dirs = vec![backup_dir(&app)];
    if let Some(legacy) = legacy_backup_dir(&app) {
        allowed_dirs.push(legacy);
    }
    let allowed = allowed_dirs
        .iter()
        .filter(|directory| directory.exists())
        .filter_map(|directory| directory.canonicalize().ok())
        .any(|directory| canonical_source.starts_with(directory));
    if !allowed {
        return Err("只能恢复个人工作台备份目录中的文件。".into());
    }
    backup::restore_backup_file(&app, &canonical_source).await
}

#[cfg(desktop)]
fn fallback_backup_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("backups")
}

#[cfg(desktop)]
fn reveal_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "未找到主窗口".to_string())?;
    #[cfg(windows)]
    developer_mode::record("main_restore_requested");
    window
        .unminimize()
        .map_err(|error| format!("无法恢复主窗口：{error}"))?;
    window
        .show()
        .map_err(|error| format!("无法显示主窗口：{error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("无法聚焦主窗口：{error}"))?;
    #[cfg(windows)]
    developer_mode::record("main_restore_completed");
    Ok(())
}

#[tauri::command]
#[cfg(desktop)]
fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    reveal_main_window(&app)
}

#[tauri::command]
#[cfg(desktop)]
fn quit_app(app: tauri::AppHandle) {
    #[cfg(windows)]
    developer_mode::record("app_quit_requested");
    app.exit(0);
}

#[cfg(desktop)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(windows)]
    let builder = builder.manage(ollama_runtime::OllamaRuntime::default());
    builder
        .plugin(tauri_plugin_companion_secrets::init())
        .manage(deepseek::DeepSeekBridgeState::default())
        .manage(xiaomi_health::XiaomiHealthState::default())
        .manage(webviews::ToolWindowState::default())
        .manage(webviews::EntertainmentCaptureState::default())
        .manage(work_observer::ObserverState::default())
        .manage(companion::CompanionState::default())
        .manage(asaba::AsabaObserver::default())
        .manage(companion_worker::AsabaWorkers::default())
        .manage(companion_tts::QianyuVoice::default())
        .manage(companion_stage::PetStage::default())
        .manage(companion_dictation::Dictation::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
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
                app.handle().plugin(tauri_plugin_autostart::init(
                    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                    Some(vec!["--hidden"]),
                ))?;
                // 开机自启动会附带 --hidden 参数：此时隐藏主窗口，仅保留托盘图标，
                // 用户可以从托盘菜单“打开个人工作台”随时唤出界面。
                if std::env::args().any(|arg| arg == "--hidden") {
                    if let Some(window) = app.get_webview_window("main") {
                        window.hide()?;
                    }
                }

                let show_item =
                    MenuItem::with_id(app, "show", "打开个人工作台", true, None::<&str>)?;
                let capture_item =
                    MenuItem::with_id(app, "capture", "快速记录", true, None::<&str>)?;
                let health_item =
                    MenuItem::with_id(app, "health", "记录今日健康", true, None::<&str>)?;
                let expense_item =
                    MenuItem::with_id(app, "expense", "补记一笔消费", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
                let menu = Menu::with_items(
                    app,
                    &[
                        &show_item,
                        &capture_item,
                        &health_item,
                        &expense_item,
                        &quit_item,
                    ],
                )?;

                let mut tray = TrayIconBuilder::new()
                    .tooltip("个人工作台")
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
                        "health" => {
                            let _ = reveal_main_window(app);
                            let _ = app.emit("open-health-record", ());
                        }
                        "expense" => {
                            let _ = reveal_main_window(app);
                            let _ = app.emit("open-expense-capture", ());
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
                #[cfg(windows)]
                developer_mode::record("app_setup_completed");
                reminders::start_health_reminder_monitor(app.handle().clone());
                focus_reminders::start_focus_reminder_monitor(app.handle().clone());
                work_observer::start(app.handle().clone());
                companion::start(app.handle().clone());
                companion_stage::start(app.handle().clone());
                asaba::start(app.handle().clone());
                companion_worker::recover(app.handle().clone());
                companion::register_voice_shortcut(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            #[cfg(windows)]
            developer_mode::developer_mode_active,
            #[cfg(windows)]
            developer_mode::developer_mode_crashes,
            #[cfg(windows)]
            developer_mode::developer_mode_open_logs,
            companion::companion_status,
            companion::companion_update_context,
            companion::companion_set_enabled,
            companion::companion_pause_all,
            companion::companion_refresh,
            companion::companion_ask,
            companion::companion_action,
            companion::companion_window,
            companion_tts::asaba_synthesize,
            companion_stage::asaba_stage,
            companion_dictation::asaba_dictation,
            companion::asaba_recap,
            companion::asaba_cancel_recap,
            asaba::asaba_observation,
            asaba::asaba_activity,
            asaba::asaba_shot,
            asaba::asaba_restore_source,
            companion_worker::asaba_jobs,
            companion_worker::asaba_attention_jobs,
            companion_worker::asaba_repository,
            companion_worker::asaba_repository_status,
            companion_worker::asaba_polish_delegation,
            companion_worker::asaba_bind_repository,
            companion_worker::asaba_delegate,
            companion_worker::asaba_research,
            companion_worker::asaba_check_document,
            companion_worker::asaba_mark_archived,
            companion_worker::asaba_job_action,
            work_observer::work_observer_status,
            work_observer::work_observer_configure,
            work_observer::work_observer_set_enabled,
            work_observer::work_observer_capture,
            work_observer::work_observer_image,
            attachments::attachment_store_blob,
            attachments::attachment_read_blob,
            attachments::attachment_blob_exists,
            attachments::attachment_delete_blob,
            attachments::attachment_upload_blob,
            attachments::attachment_download_blob,
            backup::create_backup_bundle,
            reserve_backup_path,
            latest_backup_path,
            restore_backup,
            reminders::test_health_reminder,
            focus_reminders::acknowledge_focus_reminder,
            focus_reminders::pending_focus_reminder,
            focus_reminders::test_focus_reminder,
            reminders::take_pending_health_reminder,
            execute_sqlite_transaction,
            show_main_window,
            quit_app,
            deepseek::deepseek_prepare,
            deepseek::deepseek_get_status,
            deepseek::deepseek_configure_modes,
            deepseek::deepseek_attach_image,
            deepseek::deepseek_remove_attachment,
            deepseek::deepseek_send_message,
            deepseek::deepseek_stop_generation,
            deepseek::deepseek_new_conversation,
            deepseek::deepseek_restore_conversation,
            deepseek::deepseek_delete_conversation,
            deepseek::deepseek_show_official,
            deepseek::deepseek_release,
            deepseek_api::deepseek_api_list_models,
            deepseek_api::deepseek_api_project_create,
            deepseek_api::deepseek_api_asaba_plan,
            deepseek_api::deepseek_api_asaba_progress,
            deepseek_api::deepseek_api_project_week,
            deepseek_api::deepseek_api_week_change,
            deepseek_api::deepseek_api_project_replan,
            deepseek_api::deepseek_api_project_route,
            deepseek_api::deepseek_api_next_action,
            deepseek_api::deepseek_api_global_planning,
            deepseek_api::deepseek_api_estimate_action_days,
            deepseek_api::deepseek_api_health_advice,
            deepseek_api::deepseek_api_recognize_meal,
            finance::finance_preview_import,
            xiaomi_health::xiaomi_health_status,
            xiaomi_health::xiaomi_health_qr_start,
            xiaomi_health::xiaomi_health_qr_poll,
            xiaomi_health::xiaomi_health_terminal_login,
            xiaomi_health::xiaomi_health_login,
            xiaomi_health::xiaomi_health_verify,
            xiaomi_health::xiaomi_health_diagnostics,
            xiaomi_health::xiaomi_health_fetch,
            xiaomi_health::xiaomi_health_disconnect,
            finance::finance_generate_monthly_report,
            dashboard::dashboard_search_cities,
            dashboard::dashboard_fetch_weather,
            dashboard::dashboard_fetch_ai_brief,
            dashboard::dashboard_fetch_morning_brief,
            integrations::secret_status,
            integrations::secret_set,
            integrations::secret_delete,
            integrations::sync_refresh_session_store,
            integrations::sync_refresh_session_load,
            integrations::sync_refresh_session_delete,
            integrations::github_fetch_repository,
            integrations::deepseek_fetch_balance,
            integrations::qwen_fetch_balance,
            integrations::qwen_fetch_monitor_usage,
            webviews::tool_browser_open,
            webviews::entertainment_open,
            webviews::entertainment_capture_get_pending,
            webviews::entertainment_capture_submit,
            webviews::entertainment_capture_cancel,
            webviews::entertainment_capture_complete,
            webviews::usage_console_open,
            webviews::usage_console_snapshot
        ])
        .build(tauri::generate_context!())
        .expect("error while building the life strategy library")
        .run(|app, event| {
            #[cfg(windows)]
            if matches!(event, tauri::RunEvent::Exit) {
                developer_mode::record("app_exit");
                app.state::<ollama_runtime::OllamaRuntime>().stop();
                companion::stop(app);
            }
            #[cfg(not(windows))]
            let _ = (app, event);
        });
}

#[cfg(all(test, desktop))]
mod tests {
    use super::is_primary_backup_name;

    #[test]
    fn selects_only_regular_timestamped_backups() {
        assert!(is_primary_backup_name("mind-garden-1786800000.sqlite3"));
        assert!(is_primary_backup_name("mind-garden-1786800000123.mgbak"));
        assert!(!is_primary_backup_name(
            "mind-garden-before-restore-1786800000.sqlite3"
        ));
        assert!(!is_primary_backup_name("mind-garden-latest.sqlite3"));
        assert!(!is_primary_backup_name("mind-garden-1786800000.db"));
    }
}

#[cfg(target_os = "android")]
#[tauri::mobile_entry_point]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_companion_secrets::init())
        .plugin(tauri_plugin_companion_finance::init())
        .invoke_handler(tauri::generate_handler![execute_sqlite_transaction])
        .run(tauri::generate_context!())
        .expect("unable to start companion");
}

use tauri::{plugin::{Builder, PluginHandle, TauriPlugin}, Manager, Runtime};

struct Finance<R: Runtime>(PluginHandle<R>);

fn call<R: Runtime>(app: &tauri::AppHandle<R>, method: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    app.state::<Finance<R>>().0.run_mobile_plugin(method, args).map_err(|_| "交易通知服务操作未完成，请重试".into())
}
#[tauri::command]
async fn initialize<R: Runtime>(app: tauri::AppHandle<R>) -> Result<serde_json::Value, String> {
    let path = app.path().app_config_dir().map_err(|_| "无法定位本机资料库")?.join("mind-garden.db");
    call(&app, "initialize", serde_json::json!({"path":path.to_string_lossy()}))
}
#[tauri::command]
async fn status<R: Runtime>(app: tauri::AppHandle<R>) -> Result<serde_json::Value, String> { call(&app, "status", serde_json::json!({})) }
#[tauri::command]
async fn configure<R: Runtime>(app: tauri::AppHandle<R>, enabled: bool, instant: bool) -> Result<serde_json::Value, String> {
    call(&app, "configure", serde_json::json!({"enabled":enabled,"instant":instant}))
}
#[tauri::command]
async fn open_access_settings<R: Runtime>(app: tauri::AppHandle<R>) -> Result<serde_json::Value, String> { call(&app, "openAccessSettings", serde_json::json!({})) }
#[tauri::command]
async fn request_notifications<R: Runtime>(app: tauri::AppHandle<R>) -> Result<serde_json::Value, String> { call(&app, "requestNotifications", serde_json::json!({})) }
#[tauri::command]
async fn test_reminder<R: Runtime>(app: tauri::AppHandle<R>) -> Result<serde_json::Value, String> { call(&app, "testReminder", serde_json::json!({})) }
#[tauri::command]
async fn open_reminder_settings<R: Runtime>(app: tauri::AppHandle<R>) -> Result<serde_json::Value, String> { call(&app, "openReminderSettings", serde_json::json!({})) }
#[tauri::command]
async fn take_open_request<R: Runtime>(app: tauri::AppHandle<R>) -> Result<serde_json::Value, String> { call(&app, "takeOpenRequest", serde_json::json!({})) }

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("companion-finance")
        .invoke_handler(tauri::generate_handler![initialize, status, configure, open_access_settings, request_notifications, test_reminder, open_reminder_settings, take_open_request])
        .setup(|app, api| {
            app.manage(Finance(api.register_android_plugin("com.muyuxiaoluo.companionfinance", "FinancePlugin")?));
            Ok(())
        }).build()
}

use tauri::{plugin::{Builder, TauriPlugin}, Runtime};
#[cfg(target_os = "android")]
use tauri::{plugin::PluginHandle, Manager};

fn validate(key: &str) -> Result<(), String> {
    if key == "companion_session" || (key.len() == 72 && key.starts_with("private_") && key[8..].bytes().all(|b| b.is_ascii_hexdigit())) { Ok(()) } else { Err("不支持的安全存储项".into()) }
}
#[cfg(not(target_os = "android"))]
fn credential(key: &str) -> Result<keyring::Entry, String> {
    validate(key)?;
    keyring::Entry::new("com.muyuxiaoluo.life-strategy-library", key).map_err(|_| "无法打开系统凭据存储".into())
}
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn get(key: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || match credential(&key)?.get_password() {
        Ok(value) => Ok(Some(value)), Err(keyring::Error::NoEntry) => Ok(None), Err(_) => Err("无法读取系统凭据".into())
    }).await.map_err(|_| "安全存储任务失败".to_string())?
}
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn set(key: String, value: String) -> Result<(), String> {
    if value.is_empty() || value.len() > 8192 { return Err("安全存储值无效".into()); }
    tauri::async_runtime::spawn_blocking(move || credential(&key)?.set_password(&value).map_err(|_| "无法保存系统凭据".into())).await.map_err(|_| "安全存储任务失败".to_string())?
}
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn remove(key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || match credential(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()), Err(_) => Err("无法删除系统凭据".into())
    }).await.map_err(|_| "安全存储任务失败".to_string())?
}
#[cfg(target_os = "android")]
struct AndroidStore<R: Runtime>(PluginHandle<R>);
#[cfg(target_os = "android")]
#[tauri::command]
async fn get<R: Runtime>(app: tauri::AppHandle<R>, key: String) -> Result<Option<String>, String> {
    validate(&key)?;
    let value: serde_json::Value = app.state::<AndroidStore<R>>().0.run_mobile_plugin("get", serde_json::json!({"key":key})).map_err(|_| "无法读取系统凭据".to_string())?;
    Ok(value.get("value").and_then(|v| v.as_str()).map(String::from))
}
#[cfg(target_os = "android")]
#[tauri::command]
async fn set<R: Runtime>(app: tauri::AppHandle<R>, key: String, value: String) -> Result<(), String> {
    validate(&key)?;
    if value.is_empty() || value.len() > 8192 { return Err("安全存储值无效".into()); }
    app.state::<AndroidStore<R>>().0.run_mobile_plugin::<serde_json::Value>("set", serde_json::json!({"key":key,"value":value})).map_err(|_| "无法保存系统凭据".to_string())?;
    Ok(())
}
#[cfg(target_os = "android")]
#[tauri::command]
async fn remove<R: Runtime>(app: tauri::AppHandle<R>, key: String) -> Result<(), String> {
    validate(&key)?;
    app.state::<AndroidStore<R>>().0.run_mobile_plugin::<serde_json::Value>("remove", serde_json::json!({"key":key})).map_err(|_| "无法删除系统凭据".to_string())?;
    Ok(())
}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("companion-secrets").invoke_handler(tauri::generate_handler![get, set, remove]).setup(|_app, _api| {
        #[cfg(target_os = "android")]
        _app.manage(AndroidStore(_api.register_android_plugin("com.muyuxiaoluo.companionsecrets", "SecretStorePlugin")?));
        Ok(())
    }).build()
}

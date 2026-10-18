use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{Emitter, Manager};
use windows::{
    core::{IInspectable, Interface, HSTRING},
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    UI::Notifications::{
        NotificationSetting, ToastActivatedEventArgs, ToastNotification, ToastNotificationManager,
    },
};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyW, RegSetValueExW, HKEY_CURRENT_USER, REG_SZ,
};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, WPARAM},
    UI::{
        Controls::{
            TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TDF_ALLOW_DIALOG_CANCELLATION,
            TDN_CREATED,
        },
        WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE},
    },
};

// Keep the WinRT objects alive while Windows owns their action buttons.
static ACTIVE_TOASTS: Mutex<BTreeMap<&'static str, ToastNotification>> =
    Mutex::new(BTreeMap::new());
static DIALOG_OPEN: AtomicBool = AtomicBool::new(false);

struct DialogGuard;
impl Drop for DialogGuard {
    fn drop(&mut self) {
        DIALOG_OPEN.store(false, Ordering::Release);
    }
}

unsafe extern "system" fn dialog_callback(
    hwnd: HWND,
    message: u32,
    _: WPARAM,
    _: LPARAM,
    _: isize,
) -> i32 {
    if message == TDN_CREATED as u32 {
        // Only the independent reminder becomes visible; the main workbench remains minimized.
        unsafe {
            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
        }
    }
    0
}

fn show_dialog(app: &tauri::AppHandle, body: &str, session_id: Option<&str>) -> Result<(), String> {
    if DIALOG_OPEN
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(());
    }
    let app = app.clone();
    let body = body.to_owned();
    let session_id = session_id.map(str::to_owned);
    let spawned = std::thread::Builder::new()
        .name("focus-reminder-dialog".into())
        .spawn(move || {
            let _guard = DialogGuard;
            let title = wide("投入提醒 · 个人工作台");
            let instruction = wide(if session_id.is_some() {
                "还在投入吗？"
            } else {
                "Windows 投入提醒测试"
            });
            let body = wide(&body);
            let labels = if session_id.is_some() {
                vec![wide("继续投入"), wide("现在暂停"), wide("刚才已结束")]
            } else {
                vec![wide("知道了")]
            };
            let buttons = labels
                .iter()
                .enumerate()
                .map(|(index, label)| TASKDIALOG_BUTTON {
                    nButtonID: 100 + index as i32,
                    pszButtonText: label.as_ptr(),
                })
                .collect::<Vec<_>>();
            let config = TASKDIALOGCONFIG {
                cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
                dwFlags: TDF_ALLOW_DIALOG_CANCELLATION,
                pszWindowTitle: title.as_ptr(),
                pszMainInstruction: instruction.as_ptr(),
                pszContent: body.as_ptr(),
                cButtons: buttons.len() as u32,
                pButtons: buttons.as_ptr(),
                nDefaultButton: 100,
                pfCallback: Some(dialog_callback),
                ..Default::default()
            };
            let mut clicked = 0;
            // All UTF-16 text and button storage stays alive until this synchronous Windows call returns.
            let status = unsafe {
                TaskDialogIndirect(
                    &config,
                    &mut clicked,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            if status < 0 {
                let _ = app.emit(
                    "focus-reminder-error",
                    format!("无法打开 Windows 投入提醒弹窗：0x{:08X}", status as u32),
                );
                return;
            }
            if session_id.is_some() {
                let action = match clicked {
                    100 => "continue",
                    101 => "pause",
                    102 => "correct",
                    _ => "dismiss",
                };
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = crate::focus_reminders::handle_notification_action(
                        &app,
                        session_id.as_deref(),
                        action,
                    )
                    .await
                    {
                        let _ = app.emit("focus-reminder-error", error);
                    }
                });
            }
        });
    if let Err(error) = spawned {
        DIALOG_OPEN.store(false, Ordering::Release);
        return Err(format!("无法创建投入提醒弹窗：{error}"));
    }
    Ok(())
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn register_identity(app: &tauri::AppHandle) -> Result<(), String> {
    let id = &app.config().identifier;
    let name = app.config().product_name.as_deref().unwrap_or("个人工作台");
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let icon = directory.join("notification-icon.png");
    if !icon.exists() {
        std::fs::write(&icon, include_bytes!("../icons/128x128.png"))
            .map_err(|error| error.to_string())?;
    }
    let path = wide(&format!(r"Software\Classes\AppUserModelId\{id}"));
    let mut key = std::ptr::null_mut();
    // Register only this application's identity, leaving Windows notification preferences intact.
    let status = unsafe { RegCreateKeyW(HKEY_CURRENT_USER, path.as_ptr(), &mut key) };
    if status != 0 {
        return Err(format!(
            "无法注册工作台通知身份：{}",
            std::io::Error::from_raw_os_error(status as i32)
        ));
    }
    let result = (|| {
        for (property, value) in [
            ("DisplayName", name.to_string()),
            ("IconUri", icon.to_string_lossy().into_owned()),
            ("IconBackgroundColor", "0".into()),
        ] {
            let property = wide(property);
            let value = wide(&value);
            let status = unsafe {
                RegSetValueExW(
                    key,
                    property.as_ptr(),
                    0,
                    REG_SZ,
                    value.as_ptr().cast(),
                    (value.len() * 2) as u32,
                )
            };
            if status != 0 {
                return Err(format!(
                    "无法保存工作台通知身份：{}",
                    std::io::Error::from_raw_os_error(status as i32)
                ));
            }
        }
        Ok(())
    })();
    unsafe {
        RegCloseKey(key);
    }
    result
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn toast_xml(body: &str, actionable: bool) -> String {
    let buttons = if actionable {
        "<action content=\"继续投入\" arguments=\"continue\"/><action content=\"现在暂停\" arguments=\"pause\"/><action content=\"刚才已结束\" arguments=\"correct\"/>"
    } else {
        "<action content=\"知道了\" arguments=\"dismiss\"/>"
    };
    format!("<toast scenario=\"reminder\" launch=\"open\"><visual><binding template=\"ToastGeneric\"><text>投入提醒</text><text>{}</text></binding></visual><audio src=\"ms-winsoundevent:Notification.Reminder\"/><actions>{buttons}</actions></toast>", escape_xml(body))
}

pub(crate) fn show(
    app: &tauri::AppHandle,
    body: &str,
    session_id: Option<&str>,
) -> Result<&'static str, String> {
    register_identity(app)?;
    let id = HSTRING::from(&app.config().identifier);
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&id)
        .map_err(|error| error.to_string())?;
    let setting = notifier.Setting().map_err(|error| error.to_string())?;
    if setting != NotificationSetting::Enabled {
        show_dialog(app, body, session_id)?;
        return Ok("dialog");
    }
    let xml = XmlDocument::new().map_err(|error| error.to_string())?;
    xml.LoadXml(&HSTRING::from(toast_xml(body, session_id.is_some())))
        .map_err(|error| error.to_string())?;
    let toast =
        ToastNotification::CreateToastNotification(&xml).map_err(|error| error.to_string())?;
    let tag = if session_id.is_some() {
        "focus"
    } else {
        "focus-test"
    };
    toast
        .SetTag(&HSTRING::from(tag))
        .map_err(|error| error.to_string())?;
    toast
        .SetGroup(&HSTRING::from("focus-reminders"))
        .map_err(|error| error.to_string())?;
    let action_app = app.clone();
    let action_session_id = session_id.map(str::to_owned);
    toast
        .Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
            move |_, arguments| {
                let action = arguments
                    .as_ref()
                    .and_then(|arguments| arguments.cast::<ToastActivatedEventArgs>().ok())
                    .and_then(|arguments| arguments.Arguments().ok())
                    .map(|arguments| arguments.to_string())
                    .unwrap_or_else(|| "open".into());
                let app = action_app.clone();
                let session_id = action_session_id.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = crate::focus_reminders::handle_notification_action(
                        &app,
                        session_id.as_deref(),
                        &action,
                    )
                    .await
                    {
                        eprintln!("[focus-reminder-action] {error}");
                        let _ = app.emit("focus-reminder-error", error);
                    }
                });
                Ok(())
            },
        ))
        .map_err(|error| error.to_string())?;
    let error_app = app.clone();
    toast
        .Failed(&TypedEventHandler::new(move |_, _| {
            let _ = error_app.emit(
                "focus-reminder-error",
                "Windows 未能显示投入提醒，请使用测试提醒检查通知设置。",
            );
            Ok(())
        }))
        .map_err(|error| error.to_string())?;
    if let Err(error) = notifier.Show(&toast) {
        eprintln!("[focus-reminder-toast] {error}; using native dialog");
        show_dialog(app, body, session_id)?;
        return Ok("dialog");
    }
    ACTIVE_TOASTS
        .lock()
        .map_err(|error| error.to_string())?
        .insert(tag, toast);
    Ok("notification")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toast_content_escapes_action_names_and_keeps_test_non_mutating() {
        let xml = toast_xml("整理 <实验> & \"笔记\"", true);
        assert!(xml.contains("&lt;实验&gt; &amp; &quot;笔记&quot;"));
        assert!(xml.contains("scenario=\"reminder\""));
        assert!(xml.contains("arguments=\"pause\""));
        assert!(!toast_xml("测试", false).contains("arguments=\"pause\""));
    }
}

use chrono::Local;
use serde::{Deserialize, Serialize};
use sqlx::{Connection, Row, SqliteConnection};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

const HEALTH_REMINDER_KEY: &str = "workspace_health_reminder_v1";
const HEALTH_REMINDER_LAST_DATE_KEY: &str = "workspace_health_reminder_last_date_v3";
const HEALTH_REMINDER_PENDING_KEY: &str = "workspace_health_reminder_pending_v1";

#[derive(Deserialize)]
struct HealthReminderPreferences {
    #[serde(default)]
    enabled: bool,
    #[serde(default = "default_reminder_time")]
    time: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HealthReminderPayload {
    body: String,
}

#[derive(Deserialize, Serialize)]
struct PendingHealthReminder {
    date: String,
    body: String,
}

pub(crate) fn start_health_reminder_monitor(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // The frontend creates and migrates the local database during startup.
        tokio::time::sleep(Duration::from_secs(10)).await;
        loop {
            if let Err(error) = check_health_reminder(&app).await {
                eprintln!("[health-reminder] {error}");
            }
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
}

async fn check_health_reminder(app: &tauri::AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位提醒资料库：{error}"))?
        .join("mind-garden.db");
    if !path.exists() {
        return Ok(());
    }
    let url = format!("sqlite:{}", path.to_string_lossy().replace('\\', "/"));
    let mut connection = SqliteConnection::connect(&url)
        .await
        .map_err(|error| format!("无法读取提醒资料库：{error}"))?;
    let preference_json = sqlx::query("SELECT value FROM app_meta WHERE key = ? LIMIT 1")
        .bind(HEALTH_REMINDER_KEY)
        .fetch_optional(&mut connection)
        .await
        .map_err(|error| format!("无法读取提醒设置：{error}"))?
        .and_then(|row| row.try_get::<String, _>("value").ok());
    let Some(preference_json) = preference_json else {
        return Ok(());
    };
    let preferences = serde_json::from_str::<HealthReminderPreferences>(&preference_json)
        .unwrap_or_else(|_| HealthReminderPreferences {
            enabled: false,
            time: default_reminder_time(),
        });
    if !preferences.enabled || !valid_reminder_time(&preferences.time) {
        return Ok(());
    }

    let now = Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    if now.format("%H:%M").to_string() < preferences.time {
        return Ok(());
    }
    let last_date = sqlx::query("SELECT value FROM app_meta WHERE key = ? LIMIT 1")
        .bind(HEALTH_REMINDER_LAST_DATE_KEY)
        .fetch_optional(&mut connection)
        .await
        .map_err(|error| format!("无法读取提醒状态：{error}"))?
        .and_then(|row| row.try_get::<String, _>("value").ok());
    if last_date.as_deref() == Some(today.as_str()) {
        return Ok(());
    }

    let row = sqlx::query(
        "SELECT sleep_minutes, sleep_start, sleep_end, steps, activity_minutes, activity_note \
         FROM health_daily_logs WHERE log_date = ? LIMIT 1",
    )
    .bind(&today)
    .fetch_optional(&mut connection)
    .await
    .map_err(|error| format!("无法读取今日健康记录：{error}"))?;
    let (sleep_missing, activity_missing) = missing_items(row.as_ref());

    if !sleep_missing && !activity_missing {
        clear_pending_reminder(&mut connection).await?;
        save_last_reminder_date(&mut connection, &today).await?;
        return Ok(());
    }
    let body = reminder_body(sleep_missing, activity_missing);
    save_pending_reminder(&mut connection, &today, body).await?;
    dispatch_health_reminder(app, body)?;
    save_last_reminder_date(&mut connection, &today).await?;
    Ok(())
}

async fn save_pending_reminder(
    connection: &mut SqliteConnection,
    today: &str,
    body: &str,
) -> Result<(), String> {
    let value = serde_json::to_string(&PendingHealthReminder {
        date: today.to_string(),
        body: body.to_string(),
    })
    .map_err(|error| format!("无法准备健康提醒：{error}"))?;
    sqlx::query(
        "INSERT INTO app_meta(key, value) VALUES(?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(HEALTH_REMINDER_PENDING_KEY)
    .bind(value)
    .execute(connection)
    .await
    .map_err(|error| format!("无法保存待显示的健康提醒：{error}"))?;
    Ok(())
}

async fn clear_pending_reminder(connection: &mut SqliteConnection) -> Result<(), String> {
    sqlx::query("DELETE FROM app_meta WHERE key = ?")
        .bind(HEALTH_REMINDER_PENDING_KEY)
        .execute(connection)
        .await
        .map_err(|error| format!("无法清理待显示的健康提醒：{error}"))?;
    Ok(())
}

async fn save_last_reminder_date(
    connection: &mut SqliteConnection,
    today: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO app_meta(key, value) VALUES(?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(HEALTH_REMINDER_LAST_DATE_KEY)
    .bind(today)
    .execute(connection)
    .await
    .map_err(|error| format!("无法保存提醒状态：{error}"))?;
    Ok(())
}

fn dispatch_health_reminder(app: &tauri::AppHandle, body: &str) -> Result<(), String> {
    // Windows development builds and disabled OS notification centers can silently
    // discard a native toast. Always pair it with an actionable in-app prompt.
    #[cfg(windows)]
    crate::developer_mode::record("health_reminder");
    crate::reveal_main_window(app)?;
    app.emit(
        "health-reminder-due",
        HealthReminderPayload {
            body: body.to_string(),
        },
    )
    .map_err(|error| format!("无法显示应用内健康提醒：{error}"))?;
    let notification = app
        .notification()
        .builder()
        .title("今晚的健康记录")
        .body(body)
        .show();
    #[cfg(windows)]
    crate::developer_mode::record(
        if notification.is_ok() { "notification_queued" } else { "notification_request_failed" },
    );
    #[cfg(not(windows))]
    let _ = notification;
    Ok(())
}

#[tauri::command]
pub(crate) fn test_health_reminder(app: tauri::AppHandle) -> Result<(), String> {
    dispatch_health_reminder(
        &app,
        "测试提醒已送达。正式提醒只会在睡眠或活动数据缺失时出现。",
    )
}

#[tauri::command]
pub(crate) async fn take_pending_health_reminder(
    app: tauri::AppHandle,
) -> Result<Option<HealthReminderPayload>, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位提醒资料库：{error}"))?
        .join("mind-garden.db");
    if !path.exists() {
        return Ok(None);
    }
    let url = format!("sqlite:{}", path.to_string_lossy().replace('\\', "/"));
    let mut connection = SqliteConnection::connect(&url)
        .await
        .map_err(|error| format!("无法读取提醒资料库：{error}"))?;
    let pending_json = sqlx::query("SELECT value FROM app_meta WHERE key = ? LIMIT 1")
        .bind(HEALTH_REMINDER_PENDING_KEY)
        .fetch_optional(&mut connection)
        .await
        .map_err(|error| format!("无法读取待显示的健康提醒：{error}"))?
        .and_then(|row| row.try_get::<String, _>("value").ok());
    let Some(pending_json) = pending_json else {
        return Ok(None);
    };
    clear_pending_reminder(&mut connection).await?;
    let pending = serde_json::from_str::<PendingHealthReminder>(&pending_json)
        .map_err(|error| format!("无法解析待显示的健康提醒：{error}"))?;
    let today = Local::now().format("%Y-%m-%d").to_string();
    if pending.date != today {
        return Ok(None);
    }
    let row = sqlx::query(
        "SELECT sleep_minutes, sleep_start, sleep_end, steps, activity_minutes, activity_note \
         FROM health_daily_logs WHERE log_date = ? LIMIT 1",
    )
    .bind(&today)
    .fetch_optional(&mut connection)
    .await
    .map_err(|error| format!("无法复核今日健康记录：{error}"))?;
    let (sleep_missing, activity_missing) = missing_items(row.as_ref());
    if !sleep_missing && !activity_missing {
        return Ok(None);
    }
    Ok(Some(HealthReminderPayload { body: pending.body }))
}

fn missing_items(row: Option<&sqlx::sqlite::SqliteRow>) -> (bool, bool) {
    let Some(row) = row else {
        return (true, true);
    };
    let sleep_minutes = row
        .try_get::<Option<i64>, _>("sleep_minutes")
        .ok()
        .flatten();
    let sleep_start = row.try_get::<String, _>("sleep_start").unwrap_or_default();
    let sleep_end = row.try_get::<String, _>("sleep_end").unwrap_or_default();
    let steps = row.try_get::<Option<i64>, _>("steps").ok().flatten();
    let activity_minutes = row
        .try_get::<Option<i64>, _>("activity_minutes")
        .ok()
        .flatten();
    let activity_note = row
        .try_get::<String, _>("activity_note")
        .unwrap_or_default();
    (
        sleep_minutes.is_none() && (sleep_start.is_empty() || sleep_end.is_empty()),
        steps.is_none() && activity_minutes.is_none() && activity_note.trim().is_empty(),
    )
}

fn reminder_body(sleep_missing: bool, activity_missing: bool) -> &'static str {
    match (sleep_missing, activity_missing) {
        (true, true) => "今天的睡眠和活动还没补全。现在花一分钟记录一下吧。",
        (true, false) => "今天的睡眠信息还没补全。现在花一分钟记录一下吧。",
        (false, true) => "今天的步数或运动量还没记录。现在花一分钟补上吧。",
        (false, false) => "今天的健康记录已经完成。",
    }
}

fn valid_reminder_time(value: &str) -> bool {
    let mut parts = value.split(':');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(hour), Some(minute), None)
            if hour.len() == 2
                && minute.len() == 2
                && hour.parse::<u8>().is_ok_and(|value| value < 24)
                && minute.parse::<u8>().is_ok_and(|value| value < 60)
    )
}

fn default_reminder_time() -> String {
    "22:00".into()
}

#[cfg(test)]
mod tests {
    use super::{reminder_body, valid_reminder_time};

    #[test]
    fn validates_twenty_four_hour_times() {
        assert!(valid_reminder_time("22:00"));
        assert!(valid_reminder_time("00:05"));
        assert!(!valid_reminder_time("24:00"));
        assert!(!valid_reminder_time("9:30"));
    }

    #[test]
    fn describes_only_missing_health_items() {
        assert!(reminder_body(true, true).contains("睡眠和活动"));
        assert!(reminder_body(true, false).contains("睡眠信息"));
        assert!(reminder_body(false, true).contains("步数或运动量"));
    }
}

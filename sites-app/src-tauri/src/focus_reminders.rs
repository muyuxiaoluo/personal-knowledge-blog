use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Connection, Row, SqliteConnection};
use std::time::Duration;
use tauri::{Emitter, Manager};
#[cfg(not(windows))]
use tauri_plugin_notification::NotificationExt;

const INTERVAL_KEY: &str = "workspace_focus_reminder_minutes_v1";
const LAST_KEY: &str = "workspace_focus_reminder_last_v1";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LastReminder {
    session_id: String,
    reminded_at: i64,
    #[serde(default)]
    pending: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FocusReminderPayload {
    session_id: String,
    body: String,
}

pub(crate) fn start_focus_reminder_monitor(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        loop {
            if let Err(error) = check_focus_reminder(&app).await {
                eprintln!("[focus-reminder] {error}");
            }
            tokio::time::sleep(Duration::from_secs(15)).await;
        }
    });
}

async fn connect(app: &tauri::AppHandle) -> Result<Option<SqliteConnection>, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("mind-garden.db");
    if !path.exists() {
        return Ok(None);
    }
    SqliteConnection::connect(&format!(
        "sqlite:{}",
        path.to_string_lossy().replace('\\', "/")
    ))
    .await
    .map(Some)
    .map_err(|e| e.to_string())
}

fn reminder_due(
    started_at: i64,
    last: Option<&LastReminder>,
    session_id: &str,
    minutes: i64,
    now: i64,
) -> bool {
    if minutes == 0 {
        return false;
    }
    let reference = last
        .filter(|last| last.session_id == session_id)
        .map(|last| last.reminded_at.max(started_at))
        .unwrap_or(started_at);
    now - reference >= minutes * 60
}

async fn save_last(
    connection: &mut SqliteConnection,
    session_id: String,
    now: i64,
    pending: bool,
) -> Result<(), String> {
    let value = serde_json::to_string(&LastReminder {
        session_id,
        reminded_at: now,
        pending,
    })
    .map_err(|e| e.to_string())?;
    sqlx::query("INSERT INTO app_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(LAST_KEY).bind(value).execute(connection).await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn check_focus_reminder(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(mut connection) = connect(app).await? else {
        return Ok(());
    };
    let row = sqlx::query("SELECT id, label, started_at FROM focus_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1")
        .fetch_optional(&mut connection).await.map_err(|e| e.to_string())?;
    let Some(row) = row else {
        return Ok(());
    };
    let session_id: String = row.try_get("id").map_err(|e| e.to_string())?;
    let label: String = row.try_get("label").map_err(|e| e.to_string())?;
    let started_at: String = row.try_get("started_at").map_err(|e| e.to_string())?;
    let started_at = DateTime::parse_from_rfc3339(&started_at)
        .map_err(|e| e.to_string())?
        .timestamp();
    let values = sqlx::query("SELECT key, value FROM app_meta WHERE key IN (?, ?)")
        .bind(INTERVAL_KEY)
        .bind(LAST_KEY)
        .fetch_all(&mut connection)
        .await
        .map_err(|e| e.to_string())?;
    let mut minutes = 45;
    let mut last = None;
    for row in values {
        let key: String = row.try_get("key").map_err(|e| e.to_string())?;
        let value: String = row.try_get("value").map_err(|e| e.to_string())?;
        if key == INTERVAL_KEY {
            minutes = value
                .parse::<i64>()
                .ok()
                .filter(|v| [0, 15, 30, 45, 60, 90].contains(v))
                .unwrap_or(45);
        } else {
            last = serde_json::from_str::<LastReminder>(&value).ok();
        }
    }
    let now = Utc::now().timestamp();
    if !reminder_due(started_at, last.as_ref(), &session_id, minutes, now) {
        return Ok(());
    }
    // Persist the schedule before dispatch so restarting or a hidden window does not repeat a toast.
    save_last(&mut connection, session_id.clone(), now, true).await?;
    let body = format!(
        "你仍在投入「{}」，已持续 {} 分钟。可以直接继续或暂停；忘记暂停时请选择「刚才已结束」。",
        label,
        (now - started_at).max(0) / 60
    );
    app.emit(
        "focus-reminder-due",
        FocusReminderPayload {
            session_id: session_id.clone(),
            body: body.clone(),
        },
    )
    .map_err(|e| e.to_string())?;
    let result = dispatch_system_reminder(app, &body, Some(&session_id));
    if let Err(error) = &result {
        let _ = app.emit("focus-reminder-error", error.clone());
    }
    result.map(|_| ())
}

fn dispatch_system_reminder(
    app: &tauri::AppHandle,
    body: &str,
    session_id: Option<&str>,
) -> Result<&'static str, String> {
    #[cfg(windows)]
    {
        crate::windows_focus_notification::show(app, body, session_id)
    }
    #[cfg(not(windows))]
    {
        let _ = session_id;
        app.notification()
            .builder()
            .title("投入提醒")
            .body(body)
            .show()
            .map_err(|error| error.to_string())
            .map(|_| "notification")
    }
}

#[tauri::command]
pub(crate) async fn test_focus_reminder(app: tauri::AppHandle) -> Result<String, String> {
    // Allow the user to switch away or minimize the workbench before the test arrives.
    tokio::time::sleep(Duration::from_secs(5)).await;
    dispatch_system_reminder(
        &app,
        "这是 Windows 投入提醒测试。工作台最小化或收起到托盘时，也能收到这样的提醒。",
        None,
    )
    .map(str::to_owned)
}

async fn pause_session(
    connection: &mut SqliteConnection,
    session_id: &str,
    now: DateTime<Utc>,
) -> Result<bool, String> {
    let mut transaction = connection
        .begin()
        .await
        .map_err(|error| error.to_string())?;
    let row =
        sqlx::query("SELECT started_at FROM focus_sessions WHERE id = ? AND ended_at IS NULL")
            .bind(session_id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|error| error.to_string())?;
    let Some(row) = row else {
        return Ok(false);
    };
    let started_at: String = row
        .try_get("started_at")
        .map_err(|error| error.to_string())?;
    let start = DateTime::parse_from_rfc3339(&started_at).map_err(|error| error.to_string())?;
    let milliseconds = now.signed_duration_since(start).num_milliseconds();
    if milliseconds < 0 {
        return Err("当前时间早于投入开始时间，请在应用内核对记录。".into());
    }
    let seconds = ((milliseconds + 500) / 1000).max(1);
    let result = sqlx::query("UPDATE focus_sessions SET ended_at = ?, duration_seconds = ? WHERE id = ? AND ended_at IS NULL")
        .bind(now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)).bind(seconds).bind(session_id)
        .execute(&mut *transaction).await.map_err(|error| error.to_string())?;
    transaction
        .commit()
        .await
        .map_err(|error| error.to_string())?;
    Ok(result.rows_affected() > 0)
}

pub(crate) async fn handle_notification_action(
    app: &tauri::AppHandle,
    session_id: Option<&str>,
    action: &str,
) -> Result<(), String> {
    if action == "dismiss" {
        return Ok(());
    }
    let Some(session_id) = session_id else {
        return crate::reveal_main_window(app);
    };
    let Some(mut connection) = connect(app).await? else {
        return Ok(());
    };
    let active = sqlx::query("SELECT id FROM focus_sessions WHERE id = ? AND ended_at IS NULL")
        .bind(session_id)
        .fetch_optional(&mut connection)
        .await
        .map_err(|error| error.to_string())?;
    // An old Windows notification must never pause a later session.
    if active.is_none() {
        return Ok(());
    }
    match action {
        "continue" => {
            save_last(
                &mut connection,
                session_id.into(),
                Utc::now().timestamp(),
                false,
            )
            .await?;
            app.emit("focus-reminder-acknowledged", session_id)
                .map_err(|error| error.to_string())?;
        }
        "pause" => {
            if pause_session(&mut connection, session_id, Utc::now()).await? {
                app.emit("focus-session-changed", session_id)
                    .map_err(|error| error.to_string())?;
            }
        }
        "correct" => {
            save_last(
                &mut connection,
                session_id.into(),
                Utc::now().timestamp(),
                false,
            )
            .await?;
            app.emit("focus-reminder-correct", session_id)
                .map_err(|error| error.to_string())?;
            crate::reveal_main_window(app)?;
        }
        _ => {
            crate::reveal_main_window(app)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn acknowledge_focus_reminder(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<(), String> {
    let Some(mut connection) = connect(&app).await? else {
        return Ok(());
    };
    let active = sqlx::query("SELECT id FROM focus_sessions WHERE id = ? AND ended_at IS NULL")
        .bind(&session_id)
        .fetch_optional(&mut connection)
        .await
        .map_err(|e| e.to_string())?;
    if active.is_some() {
        save_last(&mut connection, session_id, Utc::now().timestamp(), false).await?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn pending_focus_reminder(
    app: tauri::AppHandle,
) -> Result<Option<FocusReminderPayload>, String> {
    let Some(mut connection) = connect(&app).await? else {
        return Ok(None);
    };
    let value = sqlx::query("SELECT value FROM app_meta WHERE key = ?")
        .bind(LAST_KEY)
        .fetch_optional(&mut connection)
        .await
        .map_err(|e| e.to_string())?
        .and_then(|row| row.try_get::<String, _>("value").ok());
    let Some(last) = value
        .and_then(|value| serde_json::from_str::<LastReminder>(&value).ok())
        .filter(|last| last.pending)
    else {
        return Ok(None);
    };
    let disabled = sqlx::query("SELECT value FROM app_meta WHERE key = ?")
        .bind(INTERVAL_KEY)
        .fetch_optional(&mut connection)
        .await
        .map_err(|e| e.to_string())?
        .and_then(|row| row.try_get::<String, _>("value").ok())
        .as_deref()
        == Some("0");
    if disabled {
        return Ok(None);
    }
    let row = sqlx::query("SELECT label FROM focus_sessions WHERE id = ? AND ended_at IS NULL")
        .bind(&last.session_id)
        .fetch_optional(&mut connection)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.map(|row| FocusReminderPayload {
        session_id: last.session_id,
        body: format!(
            "「{}」仍在记录投入，请确认是否继续，或修正实际结束时间。",
            row.try_get::<String, _>("label").unwrap_or_default()
        ),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedules_reminders_from_start_or_last_acknowledgement() {
        assert!(!reminder_due(100, None, "a", 45, 2799));
        assert!(reminder_due(100, None, "a", 45, 2800));
        let last = LastReminder {
            session_id: "a".into(),
            reminded_at: 3000,
            pending: false,
        };
        assert!(!reminder_due(100, Some(&last), "a", 45, 5699));
        assert!(reminder_due(100, Some(&last), "a", 45, 5700));
        assert!(reminder_due(100, Some(&last), "b", 45, 2800));
        assert!(!reminder_due(100, None, "a", 0, 999999));
    }

    #[test]
    fn windows_pause_records_duration_without_affecting_later_sessions() {
        tauri::async_runtime::block_on(async {
            let mut connection = SqliteConnection::connect(":memory:").await.unwrap();
            sqlx::query("CREATE TABLE focus_sessions(id TEXT PRIMARY KEY, started_at TEXT, ended_at TEXT, duration_seconds INTEGER)")
            .execute(&mut connection).await.unwrap();
            sqlx::query(
                "INSERT INTO focus_sessions VALUES('old', '2026-10-04T01:00:00.000Z', NULL, 0)",
            )
            .execute(&mut connection)
            .await
            .unwrap();
            let now = DateTime::parse_from_rfc3339("2026-10-04T01:30:00.000Z")
                .unwrap()
                .with_timezone(&Utc);
            assert!(pause_session(&mut connection, "old", now).await.unwrap());
            let row = sqlx::query(
                "SELECT duration_seconds, ended_at FROM focus_sessions WHERE id = 'old'",
            )
            .fetch_one(&mut connection)
            .await
            .unwrap();
            assert_eq!(row.get::<i64, _>("duration_seconds"), 1800);
            assert_eq!(row.get::<String, _>("ended_at"), "2026-10-04T01:30:00.000Z");
            sqlx::query(
                "INSERT INTO focus_sessions VALUES('new', '2026-10-04T01:30:00.000Z', NULL, 0)",
            )
            .execute(&mut connection)
            .await
            .unwrap();
            assert!(!pause_session(&mut connection, "old", now).await.unwrap());
            assert!(!pause_session(&mut connection, "missing", now)
                .await
                .unwrap());
            let row = sqlx::query("SELECT ended_at FROM focus_sessions WHERE id = 'new'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert!(row.get::<Option<String>, _>("ended_at").is_none());
        });
    }
}

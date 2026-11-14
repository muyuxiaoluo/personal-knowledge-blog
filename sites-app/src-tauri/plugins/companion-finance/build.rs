fn main() {
    tauri_plugin::Builder::new(&["initialize", "status", "configure", "open_access_settings", "request_notifications", "test_reminder", "open_reminder_settings", "take_open_request"])
        .android_path("android").build();
}

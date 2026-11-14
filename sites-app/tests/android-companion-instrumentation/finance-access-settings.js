// Opens the real system page from the release APK; inspect its resumed Activity
// and target component with adb metadata after this check. Does not grant access.
const invoke = window.__TAURI_INTERNALS__.invoke;
await invoke('plugin:companion-finance|open_access_settings');
return { permissionPageRequested:true };

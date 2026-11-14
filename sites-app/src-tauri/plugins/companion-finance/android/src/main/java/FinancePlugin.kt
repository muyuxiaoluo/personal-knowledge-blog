package com.muyuxiaoluo.companionfinance

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.ComponentName
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.provider.Settings
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg class InitializeArgs { lateinit var path: String }
@InvokeArg class ConfigureArgs { var enabled: Boolean = false; var instant: Boolean = true }

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")])
class FinancePlugin(private val activity: Activity) : Plugin(activity) {
    override fun onResume() {
        super.onResume()
        FinanceListener.requestConnection(activity)
    }
    @Command fun initialize(invoke: Invoke) {
        try {
            val path = invoke.parseArgs(InitializeArgs::class.java).path
            require(path.startsWith(activity.applicationInfo.dataDir + "/"))
            FinanceStore.prefs(activity).edit().putString("database", path).commit()
            FinanceStore.open(activity).use { db -> db.rawQuery("SELECT id FROM finance_capture_events LIMIT 1", null).close() }
            FinanceStore.prefs(activity).edit().remove("last_error").apply()
            FinanceReminder.schedule(activity); FinanceReminder.check(activity); FinanceListener.requestConnection(activity); status(invoke)
        } catch (error: Exception) {
            FinanceStore.prefs(activity).edit().putString("last_error", "交易记录初始化未完成（${error.javaClass.simpleName}）").apply()
            invoke.reject("交易记录初始化未完成")
        }
    }
    @Command fun status(invoke: Invoke) {
        // Status is refreshed while the settings page is visible. Retry a
        // dropped binding here too; requestConnection throttles pending retries
        // and does nothing when capture is off, access is denied or connected.
        FinanceListener.requestConnection(activity)
        FinanceReminder.ensureChannels(activity)
        val prefs = FinanceStore.prefs(activity)
        val manager = activity.getSystemService(NotificationManager::class.java)
        val access = manager.isNotificationListenerAccessGranted(ComponentName(activity, FinanceListener::class.java))
        val value = JSObject().apply {
            put("enabled", prefs.getBoolean("enabled", false)); put("instant", prefs.getBoolean("instant", true))
            put("access", access); put("connected", FinanceListener.connected)
            put("notifications", manager.areNotificationsEnabled())
            put("instantImportance", manager.getNotificationChannel("finance_capture")?.importance ?: -1)
            put("lastSeenAt", prefs.getLong("last_seen_at", 0)); put("lastCaptureAt", prefs.getLong("last_capture_at", 0))
            put("lastReminderAt", prefs.getLong("last_reminder_at", 0)); put("lastOutcome", prefs.getString("last_outcome", ""))
            put("lastProbeToken", prefs.getString("last_probe_token", "")); put("lastProbeAt", prefs.getLong("last_probe_at", 0))
            put("error", prefs.getString("last_error", ""))
        }
        invoke.resolve(value)
    }
    @Command fun configure(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ConfigureArgs::class.java)
            val prefs = FinanceStore.prefs(activity)
            FinanceStore.open(activity).close()
            val editor = prefs.edit().putBoolean("enabled", args.enabled).putBoolean("instant", args.instant)
            if (args.enabled && !prefs.getBoolean("enabled", false)) editor.putLong("enabled_at", System.currentTimeMillis())
            check(editor.commit())
            FinanceReminder.schedule(activity)
            FinanceListener.requestConnection(activity)
            if (!args.enabled) activity.getSystemService(NotificationManager::class.java).cancel(41001)
            status(invoke)
        } catch (_: Exception) { invoke.reject("交易采集设置保存失败") }
    }
    @Command fun openAccessSettings(invoke: Invoke) {
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                activity.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                    .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
                        ComponentName(activity, FinanceListener::class.java).flattenToString()))
                invoke.resolve(JSObject()); return
            } catch (_: ActivityNotFoundException) { /* Some system settings apps only expose the listener list. */ }
        }
        activity.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)); invoke.resolve(JSObject())
    }
    @Command fun requestNotifications(invoke: Invoke) {
        if (Build.VERSION.SDK_INT >= 33) requestPermissionForAlias("notifications", invoke, "notificationsResult") else status(invoke)
    }
    @PermissionCallback private fun notificationsResult(invoke: Invoke) { status(invoke) }
    @Command fun testReminder(invoke: Invoke) {
        FinanceListener.requestConnection(activity)
        val token = FinanceReminder.test(activity)
        invoke.resolve(JSObject().apply { put("posted", token != null); put("probeToken", token ?: "") })
    }
    @Command fun openReminderSettings(invoke: Invoke) {
        FinanceReminder.ensureChannels(activity)
        activity.startActivity(Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
            .putExtra(Settings.EXTRA_CHANNEL_ID, "finance_capture"))
        invoke.resolve(JSObject())
    }
    @Command fun takeOpenRequest(invoke: Invoke) {
        val open = activity.intent?.getBooleanExtra("finance_capture_open", false) ?: false
        activity.intent?.removeExtra("finance_capture_open")
        if (runCatching { FinanceStore.pending(activity) }.getOrDefault(-1) == 0) activity.getSystemService(NotificationManager::class.java).cancel(41001)
        invoke.resolve(JSObject().apply { put("open", open) })
    }
}

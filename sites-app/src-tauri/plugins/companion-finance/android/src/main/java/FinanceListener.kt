package com.muyuxiaoluo.companionfinance

import android.app.Notification
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import java.security.MessageDigest
import java.util.concurrent.Executors

class FinanceListener : NotificationListenerService() {
    companion object {
        const val PROBE_EXTRA = "finance_listener_probe"
        @Volatile var connected = false
        private var lastRebindAt = 0L
        fun requestConnection(context: Context) {
            if (connected || !FinanceStore.prefs(context).getBoolean("enabled", false)) return
            val component = ComponentName(context, FinanceListener::class.java)
            if (!context.getSystemService(NotificationManager::class.java).isNotificationListenerAccessGranted(component)) return
            val now = SystemClock.elapsedRealtime()
            if (lastRebindAt != 0L && now - lastRebindAt < 15_000L) return
            lastRebindAt = now
            requestRebind(component)
        }
    }
    private val executor = Executors.newSingleThreadExecutor()
    override fun onListenerConnected() {
        connected = true
        lastRebindAt = 0L
        activeNotifications?.forEach { accept(it) }
    }
    override fun onListenerDisconnected() { connected = false; requestConnection(this) }
    override fun onDestroy() { connected = false; executor.shutdown(); super.onDestroy() }
    override fun onNotificationPosted(sbn: StatusBarNotification) { accept(sbn) }
    private fun accept(sbn: StatusBarNotification) {
        val preferences = FinanceStore.prefs(this)
        // A self-test only acknowledges our own random marker; it never enters
        // the transaction parser or retains any notification text.
        if (sbn.packageName == packageName && sbn.id == 41004) {
            val token = sbn.notification.extras.getString(PROBE_EXTRA)
            if (token != null && token == preferences.getString("probe_expected", null)) {
                preferences.edit().putString("last_probe_token", token).putLong("last_probe_at", System.currentTimeMillis()).apply()
            }
            return
        }
        if (!preferences.getBoolean("enabled", false) || sbn.packageName !in setOf("com.tencent.mm", "cmb.pb")) return
        // Only processing times and a fixed outcome code are retained for diagnostics.
        // Titles, notification text and chat senders are never written to preferences.
        preferences.edit().putLong("last_seen_at", System.currentTimeMillis()).apply()
        if (sbn.postTime < preferences.getLong("enabled_at", Long.MAX_VALUE)) {
            preferences.edit().putString("last_outcome", "before_enable").apply(); return
        }
        val n = sbn.notification
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) {
            preferences.edit().putString("last_outcome", "group_summary").apply(); return
        }
        val title = n.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val messages = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)?.messages
        val items = if (!messages.isNullOrEmpty()) messages.map { message ->
            Triple(message.person?.name?.toString() ?: title, message.text?.toString().orEmpty(), message.timestamp)
        } else listOf(Triple(title, n.extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
            ?: n.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty(), n.`when`.takeIf { it > 0 } ?: sbn.postTime))
        var matched = false
        for ((sender, body, time) in items) {
            // Plain notifications have already passed the system postTime gate above.
            // Their display time (Notification.when) may belong to an older card.
            // Keep that value in the existing fingerprint so upgrades do not replay
            // previously captured notifications. MessagingStyle timestamps identify
            // individual historical messages and still need their own age check.
            if (!messages.isNullOrEmpty() && time < preferences.getLong("enabled_at", Long.MAX_VALUE)) continue
            val parsed = FinanceNotificationParser.parse(sbn.packageName, sender, body) ?: continue
            matched = true
            val identity = "${sbn.packageName}|${sbn.key}|$time|$sender|$body"
            val key = MessageDigest.getInstance("SHA-256").digest(identity.toByteArray()).joinToString("") { "%02x".format(it) }
            executor.execute {
                try {
                    if (FinanceStore.insert(this, parsed, key, sbn.postTime)) {
                        preferences.edit().remove("last_error").putLong("last_capture_at", System.currentTimeMillis()).putString("last_outcome", "saved").apply()
                        if (preferences.getBoolean("instant", true)) {
                            if (FinanceReminder.show(this, "检测到 ¥${"%.2f".format(parsed.amount / 100.0)} 的交易", false)) {
                                preferences.edit().putLong("last_reminder_at", System.currentTimeMillis()).apply()
                            } else preferences.edit().putString("last_outcome", "reminder_blocked").apply()
                        } else preferences.edit().putString("last_outcome", "instant_off").apply()
                    } else preferences.edit().putString("last_outcome", "duplicate").apply()
                } catch (_: Exception) { preferences.edit().putString("last_error", "有交易通知保存失败，请打开应用检查资料库").putString("last_outcome", "storage_error").apply() }
            }
        }
        if (!matched) preferences.edit().putString("last_outcome", "not_recognized").apply()
    }
}

package com.muyuxiaoluo.companionfinance

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.UUID

class FinanceReminder : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == "finance.capture.snooze") {
            context.getSystemService(NotificationManager::class.java).cancel(41001); return
        }
        val pending = goAsync()
        Thread {
            try { schedule(context); check(context) }
            catch (_: Exception) { FinanceStore.prefs(context).edit().putString("last_error", "交易补全提醒未完成，请打开应用检查").apply() }
            finally { pending.finish() }
        }.start()
    }
    companion object {
        fun ensureChannels(context: Context) {
            context.getSystemService(NotificationManager::class.java).createNotificationChannels(listOf(
                NotificationChannel("finance_capture", "新交易补全", NotificationManager.IMPORTANCE_HIGH),
                NotificationChannel("finance_evening", "晚间交易补全", NotificationManager.IMPORTANCE_DEFAULT)
            ))
        }
        fun test(context: Context): String? {
            ensureChannels(context)
            val manager = context.getSystemService(NotificationManager::class.java)
            if (!manager.areNotificationsEnabled() || manager.getNotificationChannel("finance_capture")?.importance == NotificationManager.IMPORTANCE_NONE) return null
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
            val token = UUID.randomUUID().toString()
            FinanceStore.prefs(context).edit().putString("probe_expected", token).apply()
            val open = PendingIntent.getActivity(context, 41004, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val notification = Notification.Builder(context, "finance_capture").setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("交易补全提醒测试").setContentText("这是一条测试提醒，不会新增交易记录。")
                .addExtras(Bundle().apply { putString(FinanceListener.PROBE_EXTRA, token) })
                .setContentIntent(open).setAutoCancel(true).setOnlyAlertOnce(false).build()
            manager.notify(41004, notification)
            return token
        }
        fun schedule(context: Context) {
            val pi = PendingIntent.getBroadcast(context, 41002, Intent(context, FinanceReminder::class.java).setAction("finance.capture.evening"), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val alarms = context.getSystemService(AlarmManager::class.java)
            if (!FinanceStore.prefs(context).getBoolean("enabled", false)) { alarms.cancel(pi); return }
            val next = Calendar.getInstance().apply {
                set(Calendar.HOUR_OF_DAY, 22); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
                if (timeInMillis <= System.currentTimeMillis()) add(Calendar.DAY_OF_YEAR, 1)
            }
            // User-facing check around 22:00; Doze may defer it. No exact-alarm privilege is requested.
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next.timeInMillis, pi)
        }
        fun check(context: Context) {
            val prefs = FinanceStore.prefs(context)
            if (!prefs.getBoolean("enabled", false) || Calendar.getInstance().get(Calendar.HOUR_OF_DAY) < 22) return
            val date = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
            if (prefs.getString("last_evening", "") == date) return
            val count = FinanceStore.pending(context)
            if (count == 0 || show(context, "今晚还有 $count 条交易待确认或补全", true)) prefs.edit().putString("last_evening", date).apply()
        }
        fun show(context: Context, title: String, evening: Boolean): Boolean {
            val manager = context.getSystemService(NotificationManager::class.java)
            if (!manager.areNotificationsEnabled()) return false
            val channel = if (evening) "finance_evening" else "finance_capture"
            ensureChannels(context)
            if (manager.getNotificationChannel(channel)?.importance == NotificationManager.IMPORTANCE_NONE) return false
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return false
            launch.putExtra("finance_capture_open", true).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            val open = PendingIntent.getActivity(context, 41001, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val later = PendingIntent.getBroadcast(context, 41003, Intent(context, FinanceReminder::class.java).setAction("finance.capture.snooze"), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val count = FinanceStore.pending(context)
            if (count == 0) { manager.cancel(41001); return false }
            val n = Notification.Builder(context, channel).setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title).setContentText("$count 条待处理，点击补全；稍后处理会保留记录")
                // Each newly captured transaction should be allowed to alert, even while
                // the shared reminder card from the preceding transaction remains visible.
                .setContentIntent(open).setAutoCancel(true).setOnlyAlertOnce(false).setVisibility(Notification.VISIBILITY_PRIVATE)
                .addAction(Notification.Action.Builder(null, "立即补全", open).build())
                .addAction(Notification.Action.Builder(null, "稍后处理", later).build()).build()
            manager.notify(41001, n)
            return true
        }
    }
}

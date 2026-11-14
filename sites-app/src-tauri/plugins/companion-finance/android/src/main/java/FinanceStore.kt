package com.muyuxiaoluo.companionfinance

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

object FinanceStore {
    fun prefs(context: Context) = context.getSharedPreferences("finance_capture", Context.MODE_PRIVATE)
    fun open(context: Context): SQLiteDatabase {
        val path = prefs(context).getString("database", null) ?: error("未初始化")
        require(path.startsWith(context.applicationInfo.dataDir + "/"))
        return SQLiteDatabase.openDatabase(path, null, SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.NO_LOCALIZED_COLLATORS).apply {
            rawQuery("PRAGMA busy_timeout=5000", null).use { it.moveToFirst() }
        }
    }
    fun stamp(time: Long) = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).format(Date(time))
    fun pending(context: Context): Int = open(context).use { db ->
        db.rawQuery("SELECT COUNT(*) FROM finance_capture_events WHERE state='pending'", null).use { it.moveToFirst(); it.getInt(0) }
    }
    fun insert(context: Context, parsed: ParsedFinance, eventKey: String, time: Long): Boolean = open(context).use { db ->
        val value = android.content.ContentValues().apply {
            put("id", UUID.randomUUID().toString()); put("event_key", eventKey); put("source", parsed.source)
            put("amount_cents", parsed.amount); put("received_at", stamp(time)); put("kind", parsed.kind)
            put("state", "pending"); put("description", ""); put("category", "other"); put("updated_at", stamp(System.currentTimeMillis()))
        }
        // A replay never overwrites completed content or creates another journal mutation.
        db.insertWithOnConflict("finance_capture_events", null, value, SQLiteDatabase.CONFLICT_IGNORE) != -1L
    }
}

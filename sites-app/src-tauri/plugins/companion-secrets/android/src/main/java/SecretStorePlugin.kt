package com.muyuxiaoluo.companionsecrets

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class SecretArgs { lateinit var key: String; var value: String? = null }

/** Preferences contain ciphertext only; the wrapping key never leaves AndroidKeyStore. */
@TauriPlugin
class SecretStorePlugin(private val activity: Activity) : Plugin(activity) {
    private val alias = "workbench.companion.secrets.v1"
    private val prefs by lazy { activity.getSharedPreferences("companion_secrets", Context.MODE_PRIVATE) }
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!store.containsAlias(alias)) {
            val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            generator.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build())
            generator.generateKey()
        }
        return store.getKey(alias, null) as SecretKey
    }
    private fun args(invoke: Invoke): SecretArgs {
        val a = invoke.parseArgs(SecretArgs::class.java)
        require(a.key == "companion_session" || Regex("private_[a-f0-9]{64}").matches(a.key))
        return a
    }
    @Command
    @Synchronized
    fun get(invoke: Invoke) {
        try {
            val a = args(invoke)
            val encoded = prefs.getString(a.key, null)
            val result = JSObject()
            if (encoded != null) {
                val data = Base64.decode(encoded, Base64.NO_WRAP)
                require(data.size >= 28)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, data.copyOfRange(0, 12)))
                cipher.updateAAD(a.key.toByteArray(Charsets.UTF_8))
                result.put("value", String(cipher.doFinal(data.copyOfRange(12, data.size)), Charsets.UTF_8))
            }
            invoke.resolve(result)
        } catch (_: Exception) { invoke.reject("系统安全存储读取失败") }
    }
    @Command
    @Synchronized
    fun set(invoke: Invoke) {
        try {
            val a = args(invoke)
            val value = requireNotNull(a.value)
            require(value.isNotEmpty() && value.length <= 8192)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key())
            cipher.updateAAD(a.key.toByteArray(Charsets.UTF_8))
            val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            require(prefs.edit().putString(a.key, Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP)).commit())
            invoke.resolve(JSObject())
        } catch (_: Exception) { invoke.reject("系统安全存储保存失败") }
    }
    @Command
    @Synchronized
    fun remove(invoke: Invoke) {
        try { require(prefs.edit().remove(args(invoke).key).commit()); invoke.resolve(JSObject()) }
        catch (_: Exception) { invoke.reject("系统安全存储删除失败") }
    }
}

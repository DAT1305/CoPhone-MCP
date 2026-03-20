package com.cophone.bridge.bridge

import android.content.Context
import android.provider.Settings
import java.util.UUID

class BridgeConfigStore(context: Context) {
    companion object {
        const val STATUS_IDLE = "idle"
        const val STATUS_CONNECTING = "connecting"
        const val STATUS_CONNECTED = "connected"
        const val STATUS_RETRYING = "retrying"
        const val STATUS_ERROR = "error"
        const val STATUS_STOPPED = "stopped"
    }

    private val prefs = context.getSharedPreferences("cophone-bridge", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString("serverUrl", "ws://192.168.1.10:8787") ?: "ws://192.168.1.10:8787"
        set(value) = prefs.edit().putString("serverUrl", value).apply()

    var pairingToken: String
        get() = prefs.getString("pairingToken", "dev-token") ?: "dev-token"
        set(value) = prefs.edit().putString("pairingToken", value).apply()

    var bridgeStatus: String
        get() = prefs.getString("bridgeStatus", STATUS_IDLE) ?: STATUS_IDLE
        set(value) = prefs.edit().putString("bridgeStatus", value).apply()

    var bridgeStatusDetail: String
        get() = prefs.getString("bridgeStatusDetail", "") ?: ""
        set(value) = prefs.edit().putString("bridgeStatusDetail", value).apply()

    val deviceId: String
        get() {
            val existing = prefs.getString("deviceId", null)
            if (existing != null) {
                return existing
            }
            val created = UUID.randomUUID().toString()
            prefs.edit().putString("deviceId", created).apply()
            return created
        }

    fun deviceName(): String {
        return "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}"
    }

    fun androidId(context: Context): String {
        return Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: "unknown"
    }

    fun updateBridgeState(status: String, detail: String = "") {
        prefs.edit()
            .putString("bridgeStatus", status)
            .putString("bridgeStatusDetail", detail)
            .apply()
    }
}

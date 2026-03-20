package com.cophone.bridge.bridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Point
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import com.cophone.bridge.MainActivity
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

class BridgeForegroundService : Service(), BridgeClient.Listener {
    companion object {
        const val ACTION_CONNECT = "com.cophone.bridge.CONNECT"
        const val ACTION_DISCONNECT = "com.cophone.bridge.DISCONNECT"
        private const val CHANNEL_ID = "cophone-bridge"
        private const val NOTIFICATION_ID = 1001
        private const val TAG = "BridgeForeground"
    }

    private val executor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var store: BridgeConfigStore
    private var client: BridgeClient? = null
    private var shouldReconnect = false
    private var reconnectAttempt = 0

    private val heartbeat = object : Runnable {
        override fun run() {
            sendDeviceState()
            mainHandler.postDelayed(this, 10_000)
        }
    }

    private val reconnect = object : Runnable {
        override fun run() {
            if (!shouldReconnect || client != null) {
                return
            }
            connect()
        }
    }

    override fun onCreate() {
        super.onCreate()
        store = BridgeConfigStore(this)
        createNotificationChannel()
        store.updateBridgeState(BridgeConfigStore.STATUS_IDLE, "Bridge is idle.")
        startForeground(NOTIFICATION_ID, buildNotification("Idle"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_CONNECT -> {
                shouldReconnect = true
                reconnectAttempt = 0
                connect()
            }
            ACTION_DISCONNECT -> {
                shouldReconnect = false
                disconnect()
                stopSelf()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        disconnect()
        executor.shutdownNow()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onOpen() {
        reconnectAttempt = 0
        updateBridgeState(BridgeConfigStore.STATUS_CONNECTED, "Connected to ${store.serverUrl}")
        updateNotification("Connected to ${store.serverUrl}")
        sendHello()
        sendDeviceState()
        mainHandler.removeCallbacks(heartbeat)
        mainHandler.postDelayed(heartbeat, 10_000)
    }

    override fun onClosed() {
        client = null
        mainHandler.removeCallbacks(heartbeat)
        if (shouldReconnect) {
            scheduleReconnect("Connection closed.")
        } else {
            updateBridgeState(BridgeConfigStore.STATUS_STOPPED, "Bridge stopped.")
            updateNotification("Disconnected")
        }
    }

    override fun onMessage(message: JSONObject) {
        if (message.optString("type") != "command") {
            return
        }
        client?.send(JSONObject()
            .put("type", "ack")
            .put("requestId", message.optString("requestId")))

        executor.execute {
            handleCommand(message)
        }
    }

    override fun onFailure(t: Throwable) {
        client = null
        mainHandler.removeCallbacks(heartbeat)
        val message = t.message ?: "unknown"
        Log.w(TAG, "Bridge connection failure: $message", t)
        if (shouldReconnect) {
            scheduleReconnect("Error: $message")
        } else {
            updateBridgeState(BridgeConfigStore.STATUS_ERROR, message)
            updateNotification("Error: $message")
        }
    }

    private fun connect() {
        mainHandler.removeCallbacks(reconnect)
        if (client != null) {
            return
        }
        updateBridgeState(
            BridgeConfigStore.STATUS_CONNECTING,
            if (reconnectAttempt > 0) "Retrying connection to ${store.serverUrl}" else "Connecting to ${store.serverUrl}",
        )
        client = BridgeClient(store.serverUrl, this).also { it.connect() }
        updateNotification("Connecting to ${store.serverUrl}")
    }

    private fun disconnect() {
        mainHandler.removeCallbacks(heartbeat)
        mainHandler.removeCallbacks(reconnect)
        client?.close()
        client = null
        updateBridgeState(BridgeConfigStore.STATUS_STOPPED, "Bridge stopped.")
        updateNotification("Stopped")
    }

    private fun scheduleReconnect(reason: String) {
        reconnectAttempt += 1
        val delayMs = minOf(30_000L, 1_000L shl minOf(reconnectAttempt - 1, 5))
        val detail = "Retrying in ${delayMs / 1000}s. $reason"
        updateBridgeState(BridgeConfigStore.STATUS_RETRYING, detail)
        updateNotification(detail)
        mainHandler.removeCallbacks(reconnect)
        mainHandler.postDelayed(reconnect, delayMs)
    }

    private fun updateBridgeState(status: String, detail: String) {
        store.updateBridgeState(status, detail)
    }

    private fun sendHello() {
        val size = deviceSize()
        client?.send(JSONObject()
            .put("type", "hello")
            .put("deviceId", store.deviceId)
            .put("deviceName", store.deviceName())
            .put("pairingToken", store.pairingToken)
            .put("androidVersion", Build.VERSION.RELEASE)
            .put("screenSize", JSONObject().put("width", size.x).put("height", size.y))
            .put("capabilities", JSONArray()
                .put("tap")
                .put("swipe")
                .put("type_text")
                .put("type_into_actionable_element")
                .put("press_key")
                .put("perform_actionable_element")
                .put("get_accessibility_snapshot")
                .put("get_actionable_elements")
                .put("get_visible_text")
                .put("get_ui_tree")
                .put("find_element")
                .put("wait_for_actionable_element")
                .put("tap_element")
                .put("wait_for_ui")
                .put("launch_app")
                .put("open_deeplink")))
    }

    private fun sendDeviceState() {
        val accessibility = PhoneAccessibilityService.instance
        client?.send(JSONObject()
            .put("type", "device_state")
            .put("deviceId", store.deviceId)
            .put("accessibilityReady", accessibility != null)
            .put("currentPackage", accessibility?.rootInActiveWindow?.packageName?.toString()))
    }

    private fun handleCommand(message: JSONObject) {
        val requestId = message.optString("requestId")
        val commandName = message.optString("commandName")
        val args = message.optJSONObject("args") ?: JSONObject()

        val response = try {
            val payload = when (commandName) {
                "get_accessibility_snapshot" -> JSONObject().put(
                    "snapshot",
                    requireAccessibility().exportAccessibilitySnapshot(args.optInt("max_nodes", 120)),
                )
                "get_actionable_elements" -> JSONObject().put(
                    "snapshot",
                    requireAccessibility().exportActionableElements(args.optInt("max_elements", 40)),
                )
                "get_visible_text" -> JSONObject().put("snapshot", requireAccessibility().exportVisibleText())
                "get_ui_tree" -> JSONObject().put("root", requireAccessibility().exportUiTree())
                "find_element" -> {
                    val service = requireAccessibility()
                    val node = service.findElement(args.optJSONObject("selector") ?: JSONObject())
                    JSONObject().put("element", node?.let(service::serializeFoundElement))
                }
                "wait_for_actionable_element" -> JSONObject().put(
                    "element",
                    requireAccessibility().waitForActionableElement(
                        args.optJSONObject("selector") ?: JSONObject(),
                        args.optLong("timeout_ms", 15_000),
                    ),
                )
                "wait_for_ui" -> {
                    val node = requireAccessibility().waitForUi(
                        args.optJSONObject("selector") ?: JSONObject(),
                        args.optLong("timeout_ms", 15_000),
                    )
                    JSONObject().put("element", node)
                }
                "tap_element" -> JSONObject().put("ok", requireAccessibility().tapElement(args.optJSONObject("selector") ?: JSONObject()))
                "tap" -> JSONObject().put("ok", requireAccessibility().tap(args.optDouble("x").toFloat(), args.optDouble("y").toFloat()))
                "swipe" -> JSONObject().put(
                    "ok",
                    requireAccessibility().swipe(
                        args.optDouble("x1").toFloat(),
                        args.optDouble("y1").toFloat(),
                        args.optDouble("x2").toFloat(),
                        args.optDouble("y2").toFloat(),
                        args.optLong("duration_ms", 300),
                    ),
                )
                "type_text" -> JSONObject().put("ok", requireAccessibility().typeText(args.optString("text")))
                "type_into_actionable_element" -> JSONObject().put(
                    "ok",
                    requireAccessibility().typeIntoActionableElement(
                        args.optString("element_ref"),
                        args.optString("text"),
                    ),
                )
                "press_key" -> JSONObject().put("ok", requireAccessibility().pressKey(args.optString("key")))
                "perform_actionable_element" -> JSONObject().put(
                    "ok",
                    requireAccessibility().performActionableElement(
                        args.optString("element_ref"),
                        args.optString("action", "click"),
                    ),
                )
                "launch_app" -> JSONObject().put("ok", launchApp(args.optString("packageName")))
                "open_deeplink" -> JSONObject().put("ok", openDeeplink(args.optString("url")))
                "capture_screen" -> unsupported("capture_screen is fallback-only and still requires MediaProjection wiring.")
                "get_notifications" -> unsupported("get_notifications is not implemented in v1 bridge.")
                else -> unsupported("Unknown command: $commandName")
            }

            JSONObject()
                .put("type", "command_result")
                .put("requestId", requestId)
                .put("ok", true)
                .put("result", payload)
        } catch (t: Throwable) {
            JSONObject()
                .put("type", "command_result")
                .put("requestId", requestId)
                .put("ok", false)
                .put("error", t.message ?: "Command failed")
        }

        client?.send(response)
    }

    private fun requireAccessibility(): PhoneAccessibilityService {
        val deadline = SystemClock.uptimeMillis() + 5_000
        while (SystemClock.uptimeMillis() < deadline) {
            val accessibility = PhoneAccessibilityService.instance
            if (accessibility != null) {
                return accessibility
            }
            SystemClock.sleep(100)
        }
        Log.w(TAG, "Accessibility service not ready after wait window")
        throw IllegalStateException("Accessibility service is not enabled.")
    }

    private fun launchApp(packageName: String): Boolean {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName) ?: return false
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(launchIntent)
        return true
    }

    private fun openDeeplink(url: String): Boolean {
        if (url.isBlank()) {
            return false
        }
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        startActivity(intent)
        return true
    }

    private fun unsupported(message: String): JSONObject {
        return JSONObject().put("unsupported", true).put("message", message)
    }

    private fun deviceSize(): Point {
        val windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val metrics = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            windowManager.currentWindowMetrics.bounds
        } else {
            @Suppress("DEPRECATION")
            android.graphics.Rect().also { windowManager.defaultDisplay.getRectSize(it) }
        }
        return Point(metrics.width(), metrics.height())
    }

    private fun buildNotification(status: String): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("CoPhone Bridge")
            .setContentText(status)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(status: String) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, buildNotification(status))
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "CoPhone Bridge",
                NotificationManager.IMPORTANCE_LOW,
            )
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }
}

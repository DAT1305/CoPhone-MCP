package com.cophone.bridge

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.cophone.bridge.bridge.BridgeConfigStore
import com.cophone.bridge.bridge.BridgeForegroundService

class MainActivity : AppCompatActivity() {
    private lateinit var store: BridgeConfigStore
    private lateinit var serverUrlInput: EditText
    private lateinit var pairingTokenInput: EditText
    private lateinit var statusText: TextView
    private lateinit var startButton: Button
    private lateinit var stopButton: Button
    private val mainHandler = Handler(Looper.getMainLooper())

    private val refreshStatus = object : Runnable {
        override fun run() {
            renderStatus()
            mainHandler.postDelayed(this, 1_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        store = BridgeConfigStore(this)

        serverUrlInput = EditText(this).apply {
            hint = "ws://192.168.1.10:8787"
            setText(store.serverUrl)
            inputType = InputType.TYPE_CLASS_TEXT
        }

        pairingTokenInput = EditText(this).apply {
            hint = "Pairing token"
            setText(store.pairingToken)
            inputType = InputType.TYPE_CLASS_TEXT
        }

        statusText = TextView(this).apply {
            text = ""
        }

        startButton = Button(this).apply {
            text = "Start Bridge"
            setOnClickListener {
                store.serverUrl = serverUrlInput.text.toString().trim()
                store.pairingToken = pairingTokenInput.text.toString().trim()
                renderStatus("Starting bridge...")
                ContextCompat.startForegroundService(this@MainActivity, Intent(this@MainActivity, BridgeForegroundService::class.java).apply {
                    action = BridgeForegroundService.ACTION_CONNECT
                })
            }
        }

        stopButton = Button(this).apply {
            text = "Stop Bridge"
            setOnClickListener {
                startService(Intent(this@MainActivity, BridgeForegroundService::class.java).apply {
                    action = BridgeForegroundService.ACTION_DISCONNECT
                })
                renderStatus("Stopping bridge...")
            }
        }

        val accessibilityButton = Button(this).apply {
            text = "Open Accessibility Settings"
            setOnClickListener {
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val padding = (16 * resources.displayMetrics.density).toInt()
            setPadding(padding, padding, padding, padding)
            addView(statusText)
            addView(serverUrlInput)
            addView(pairingTokenInput)
            addView(startButton)
            addView(stopButton)
            addView(accessibilityButton)
        }

        setContentView(root)
        renderStatus()
    }

    override fun onResume() {
        super.onResume()
        mainHandler.removeCallbacks(refreshStatus)
        mainHandler.post(refreshStatus)
    }

    override fun onPause() {
        mainHandler.removeCallbacks(refreshStatus)
        super.onPause()
    }

    private fun renderStatus(overrideDetail: String? = null) {
        val accessibilityLabel = if (isAccessibilityEnabled()) "Enabled" else "Disabled"
        val bridgeStatus = store.bridgeStatus
        val bridgeDetail = overrideDetail ?: store.bridgeStatusDetail

        statusText.text = buildString {
            append("Accessibility: ")
            append(accessibilityLabel)
            append('\n')
            append("Bridge: ")
            append(bridgeStatus.replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() })
            if (bridgeDetail.isNotBlank()) {
                append('\n')
                append(bridgeDetail)
            }
            append("\n\n1. Enable Accessibility service")
            append("\n2. Confirm server URL and pairing token")
            append("\n3. Tap Start Bridge and wait for Connected or Retrying")
        }

        startButton.text = when (bridgeStatus) {
            BridgeConfigStore.STATUS_CONNECTING -> "Connecting..."
            BridgeConfigStore.STATUS_CONNECTED -> "Reconnect Bridge"
            BridgeConfigStore.STATUS_RETRYING -> "Retrying Bridge..."
            else -> "Start Bridge"
        }
        stopButton.isEnabled = bridgeStatus != BridgeConfigStore.STATUS_STOPPED && bridgeStatus != BridgeConfigStore.STATUS_IDLE
    }

    private fun isAccessibilityEnabled(): Boolean {
        val enabled = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
        return enabled.contains("${packageName}/${com.cophone.bridge.bridge.PhoneAccessibilityService::class.java.name}")
    }
}

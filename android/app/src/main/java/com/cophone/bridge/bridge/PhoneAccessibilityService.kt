package com.cophone.bridge.bridge

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

class PhoneAccessibilityService : AccessibilityService() {
    companion object {
        private const val TAG = "PhoneAccessibility"

        @Volatile
        var instance: PhoneAccessibilityService? = null
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        Log.d(TAG, "onCreate")
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.d(TAG, "onServiceConnected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        Log.d(TAG, "onDestroy")
        instance = null
        super.onDestroy()
    }

    fun exportUiTree(): JSONObject {
        val root = rootInActiveWindow ?: return JSONObject().put("error", "no_active_window")
        return serializeNode(root)
    }

    fun exportAccessibilitySnapshot(maxNodes: Int): JSONObject {
        val root = rootInActiveWindow ?: return JSONObject().put("error", "no_active_window")
        val nodes = JSONArray()
        flattenNodes(root, nodes, maxNodes.coerceAtLeast(1), intArrayOf(0))
        return JSONObject()
            .put("package_name", root.packageName?.toString())
            .put("node_count", nodes.length())
            .put("nodes", nodes)
    }

    fun exportActionableElements(maxElements: Int): JSONObject {
        val root = rootInActiveWindow ?: return JSONObject().put("error", "no_active_window")
        val elements = JSONArray()
        flattenActionableNodes(root, elements, maxElements.coerceAtLeast(1), intArrayOf(0), "0")
        return JSONObject()
            .put("package_name", root.packageName?.toString())
            .put("element_count", elements.length())
            .put("elements", elements)
    }

    fun exportVisibleText(): JSONObject {
        val root = rootInActiveWindow ?: return JSONObject().put("error", "no_active_window")
        val lines = linkedSetOf<String>()
        collectVisibleText(root, lines)
        return JSONObject()
            .put("package_name", root.packageName?.toString())
            .put("line_count", lines.size)
            .put("lines", JSONArray(lines.toList()))
            .put("text", lines.joinToString("\n"))
    }

    fun serializeFoundElement(node: AccessibilityNodeInfo): JSONObject {
        return serializeNode(node)
    }

    fun findElement(selector: JSONObject): AccessibilityNodeInfo? {
        val root = rootInActiveWindow ?: return null
        return findMatchingNode(root, selector)
    }

    fun tapElement(selector: JSONObject): Boolean {
        val node = findElement(selector) ?: return false
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        return tap(bounds.centerX().toFloat(), bounds.centerY().toFloat())
    }

    fun tap(x: Float, y: Float): Boolean {
        val path = Path().apply { moveTo(x, y) }
        val stroke = GestureDescription.StrokeDescription(path, 0, 50)
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        return dispatchGesture(gesture, null, null)
    }

    fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long): Boolean {
        val path = Path().apply {
            moveTo(x1, y1)
            lineTo(x2, y2)
        }
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs.coerceAtLeast(100))
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        return dispatchGesture(gesture, null, null)
    }

    fun pressKey(key: String): Boolean {
        return when (key.lowercase()) {
            "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
            "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
            "recent", "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            "notifications" -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
            "quick_settings" -> performGlobalAction(GLOBAL_ACTION_QUICK_SETTINGS)
            else -> false
        }
    }

    fun typeText(text: String): Boolean {
        val focused = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        val target = focused ?: findEditableNode(rootInActiveWindow)
        val bundle = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return target?.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle) == true
    }

    fun waitForUi(selector: JSONObject, timeoutMs: Long): JSONObject? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val node = findElement(selector)
            if (node != null) {
                return serializeNode(node)
            }
            Thread.sleep(250)
        }
        return null
    }

    fun waitForActionableElement(selector: JSONObject, timeoutMs: Long): JSONObject? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val root = rootInActiveWindow
            if (root != null) {
                val match = findMatchingActionableNode(root, selector, "0", intArrayOf(0))
                if (match != null) {
                    return match
                }
            }
            Thread.sleep(250)
        }
        return null
    }

    fun performActionableElement(elementRef: String, action: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val node = findNodeByPath(root, elementRef) ?: return false
        return performNodeAction(node, action)
    }

    fun typeIntoActionableElement(elementRef: String, text: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val node = findNodeByPath(root, elementRef) ?: return false
        val target = when {
            node.isEditable -> node
            else -> findEditableNode(node)
        }

        if (target != null) {
            val bundle = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            }
            target.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            return target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle)
        }

        return tapNodeCenter(node) && typeText(text)
    }

    private fun findEditableNode(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (node == null) {
            return null
        }
        if (node.isEditable) {
            return node
        }
        for (index in 0 until node.childCount) {
            val found = findEditableNode(node.getChild(index))
            if (found != null) {
                return found
            }
        }
        return null
    }

    private fun findMatchingNode(node: AccessibilityNodeInfo, selector: JSONObject): AccessibilityNodeInfo? {
        if (matches(node, selector)) {
            return node
        }
        for (index in 0 until node.childCount) {
            val child = node.getChild(index) ?: continue
            val match = findMatchingNode(child, selector)
            if (match != null) {
                return match
            }
        }
        return null
    }

    private fun matches(node: AccessibilityNodeInfo, selector: JSONObject): Boolean {
        val text = selector.optString("text")
        val contentDescription = selector.optString("content_description")
        val resourceId = selector.optString("resource_id")
        val packageName = selector.optString("package_name")
        val className = selector.optString("class_name")

        return (text.isEmpty() || node.text?.toString()?.contains(text, ignoreCase = true) == true) &&
            (contentDescription.isEmpty() || node.contentDescription?.toString()?.contains(contentDescription, ignoreCase = true) == true) &&
            (resourceId.isEmpty() || node.viewIdResourceName == resourceId) &&
            (packageName.isEmpty() || node.packageName?.toString() == packageName) &&
            (className.isEmpty() || node.className?.toString() == className)
    }

    private fun flattenNodes(node: AccessibilityNodeInfo, nodes: JSONArray, maxNodes: Int, seen: IntArray) {
        if (seen[0] >= maxNodes) {
            return
        }

        seen[0] += 1
        nodes.put(summarizeNode(node))

        for (index in 0 until node.childCount) {
            val child = node.getChild(index) ?: continue
            flattenNodes(child, nodes, maxNodes, seen)
            if (seen[0] >= maxNodes) {
                return
            }
        }
    }

    private fun flattenActionableNodes(
        node: AccessibilityNodeInfo,
        elements: JSONArray,
        maxElements: Int,
        seen: IntArray,
        path: String,
    ) {
        if (seen[0] >= maxElements) {
            return
        }

        if (isActionable(node)) {
            elements.put(summarizeActionableNode(node, path, seen[0]))
            seen[0] += 1
            if (seen[0] >= maxElements) {
                return
            }
        }

        for (index in 0 until node.childCount) {
            val child = node.getChild(index) ?: continue
            flattenActionableNodes(child, elements, maxElements, seen, "$path.$index")
            if (seen[0] >= maxElements) {
                return
            }
        }
    }

    private fun findMatchingActionableNode(
        node: AccessibilityNodeInfo,
        selector: JSONObject,
        path: String,
        actionableIndex: IntArray,
    ): JSONObject? {
        if (isActionable(node)) {
            val summary = summarizeActionableNode(node, path, actionableIndex[0])
            actionableIndex[0] += 1
            if (matchesActionableSelector(summary, selector)) {
                return summary
            }
        }

        for (index in 0 until node.childCount) {
            val child = node.getChild(index) ?: continue
            val match = findMatchingActionableNode(child, selector, "$path.$index", actionableIndex)
            if (match != null) {
                return match
            }
        }

        return null
    }

    private fun collectVisibleText(node: AccessibilityNodeInfo, lines: LinkedHashSet<String>) {
        listOfNotNull(
            node.text?.toString(),
            node.contentDescription?.toString(),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) node.hintText?.toString() else null,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) node.paneTitle?.toString() else null,
        )
            .map(String::trim)
            .filter(String::isNotEmpty)
            .forEach(lines::add)

        for (index in 0 until node.childCount) {
            val child = node.getChild(index) ?: continue
            collectVisibleText(child, lines)
        }
    }

    private fun isActionable(node: AccessibilityNodeInfo): Boolean {
        if (!node.isVisibleToUser || !node.isEnabled) {
            return false
        }

        return node.isClickable ||
            node.isEditable ||
            node.isCheckable ||
            node.isScrollable ||
            node.isLongClickable
    }

    private fun matchesActionableSelector(summary: JSONObject, selector: JSONObject): Boolean {
        val label = selector.optString("label")
        val text = selector.optString("text")
        val resourceId = selector.optString("resource_id")
        val className = selector.optString("class_name")
        val editable = selector.opt("editable")?.toString()?.lowercase().orEmpty()
        val clickable = selector.opt("clickable")?.toString()?.lowercase().orEmpty()

        return (label.isEmpty() || summary.optString("label").contains(label, ignoreCase = true)) &&
            (text.isEmpty() || summary.optString("text").contains(text, ignoreCase = true)) &&
            (resourceId.isEmpty() || summary.optString("resource_id") == resourceId) &&
            (className.isEmpty() || summary.optString("class_name") == className) &&
            (editable.isEmpty() || summary.optBoolean("editable") == editable.toBooleanStrict()) &&
            (clickable.isEmpty() || summary.optBoolean("clickable") == clickable.toBooleanStrict())
    }

    private fun summarizeActionableNode(node: AccessibilityNodeInfo, path: String, index: Int): JSONObject {
        val summary = summarizeNode(node)
        val bounds = summary.getJSONObject("bounds")
        val label = listOfNotNull(
            node.text?.toString(),
            node.contentDescription?.toString(),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) node.hintText?.toString() else null,
            node.viewIdResourceName,
        )
            .map(String::trim)
            .firstOrNull { it.isNotEmpty() }

        return summary
            .put("element_ref", path)
            .put("element_index", index)
            .put("label", label)
            .put("long_clickable", node.isLongClickable)
            .put("scrollable", node.isScrollable)
            .put("visible", node.isVisibleToUser)
            .put("preferred_action", preferredActionFor(node))
            .put("center", JSONObject()
                .put("x", (bounds.getInt("left") + bounds.getInt("right")) / 2)
                .put("y", (bounds.getInt("top") + bounds.getInt("bottom")) / 2))
    }

    private fun preferredActionFor(node: AccessibilityNodeInfo): String {
        return when {
            node.isEditable -> "focus"
            node.isLongClickable -> "click"
            node.isClickable -> "click"
            node.isCheckable -> "click"
            node.isScrollable -> "focus"
            else -> "click"
        }
    }

    private fun findNodeByPath(root: AccessibilityNodeInfo, path: String): AccessibilityNodeInfo? {
        val segments = path.split(".")
        if (segments.isEmpty() || segments[0] != "0") {
            return null
        }

        var current: AccessibilityNodeInfo? = root
        for (segment in segments.drop(1)) {
            val index = segment.toIntOrNull() ?: return null
            current = current?.getChild(index) ?: return null
        }
        return current
    }

    private fun performNodeAction(node: AccessibilityNodeInfo, action: String): Boolean {
        return when (action.lowercase()) {
            "focus" -> {
                node.performAction(AccessibilityNodeInfo.ACTION_FOCUS) ||
                    node.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS) ||
                    tapNodeCenter(node)
            }
            "long_click" -> {
                node.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK) ||
                    longPressNodeCenter(node)
            }
            "click", "" -> {
                node.performAction(AccessibilityNodeInfo.ACTION_CLICK) ||
                    tapNodeCenter(node)
            }
            else -> false
        }
    }

    private fun tapNodeCenter(node: AccessibilityNodeInfo): Boolean {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        return tap(bounds.centerX().toFloat(), bounds.centerY().toFloat())
    }

    private fun longPressNodeCenter(node: AccessibilityNodeInfo): Boolean {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        val path = Path().apply { moveTo(bounds.centerX().toFloat(), bounds.centerY().toFloat()) }
        val stroke = GestureDescription.StrokeDescription(path, 0, 500)
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        return dispatchGesture(gesture, null, null)
    }

    private fun summarizeNode(node: AccessibilityNodeInfo): JSONObject {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        val summary = JSONObject()
            .put("text", node.text?.toString())
            .put("content_description", node.contentDescription?.toString())
            .put("resource_id", node.viewIdResourceName)
            .put("package_name", node.packageName?.toString())
            .put("class_name", node.className?.toString())
            .put("clickable", node.isClickable)
            .put("editable", node.isEditable)
            .put("checkable", node.isCheckable)
            .put("checked", node.isChecked)
            .put("enabled", node.isEnabled)
            .put("focused", node.isFocused)
            .put("selected", node.isSelected)
            .put("bounds", JSONObject()
                .put("left", bounds.left)
                .put("top", bounds.top)
                .put("right", bounds.right)
                .put("bottom", bounds.bottom))

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            summary.put("hint_text", node.hintText?.toString())
        }

        return summary
    }

    private fun serializeNode(node: AccessibilityNodeInfo): JSONObject {
        val children = JSONArray()
        for (index in 0 until node.childCount) {
            val child = node.getChild(index) ?: continue
            children.put(serializeNode(child))
        }

        return summarizeNode(node)
            .put("children", children)
    }
}

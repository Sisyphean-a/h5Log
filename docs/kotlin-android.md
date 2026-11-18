# Android 原生 Kotlin 接入 H5 Log

本指南用于在 **Debug 或内部测试版** Android 应用中，把主动选取的 Kotlin 日志发送到 H5 Log 工作台。原生端走 HTTP，不安装 `@h5-log/sdk`；WebView 里的网页日志仍由 [H5 SDK](../packages/sdk/README.md) 单独采集。此接入不会自动读取 Logcat、捕获崩溃或采集网络请求。

## 1. 配置上报地址和网络权限

- 使用手机能访问的 **完整 HTTPS 上报地址**（`POST /api/logs`），例如 `https://logs.example.com/api/logs`，或带部署前缀的 `https://logs.example.com/h5-log/api/logs`。已有 H5 接入时，可使用同一个 `endpoint`。手机上的 `localhost` 指手机自己，不是开发电脑。
- 在 Android 应用的 `AndroidManifest.xml` 中确认 `<manifest>` 下已有 `<uses-permission android:name="android.permission.INTERNET" />`。内网或自定义 CA 环境应按项目规则配置证书信任，不要关闭 TLS 校验。
- 仅向受控的测试环境发送脱敏日志。工作台页面的访问密钥不保护上报接口；若部署在有认证的反向代理后，使用项目已批准的认证方式。

## 2. 发一条测试日志

将下面的类放进应用模块的 Kotlin 源集，加上项目自己的 `package` 声明。示例使用 Android 自带的 `HttpURLConnection` 和 `org.json`，不需要增加 Gradle 依赖。`send()` 是同步方法，**只在后台线程调用**。

```kotlin
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

class H5LogReporter(
    private val endpoint: String,
    private val appId: String,
    private val environment: String,
    private val deviceId: String,
) {
    private val sessionId = UUID.randomUUID().toString()

    fun send(message: String, level: String = "info"): Int {
        val event = JSONObject()
            .put("appId", appId)
            .put("environment", environment)
            .put("deviceId", deviceId)
            .put("sessionId", sessionId)
            .put("eventId", UUID.randomUUID().toString())
            .put("timestamp", System.currentTimeMillis())
            .put("level", level)
            .put("source", "custom")
            .put("args", JSONArray().put(message))
            .put("deviceName", "")
            .put("userAgent", "")
            .put("pageUrl", "")
        val payload = JSONObject().put("events", JSONArray().put(event))
            .toString().toByteArray(Charsets.UTF_8)

        val connection = URL(endpoint).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 5_000
            connection.readTimeout = 5_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.setFixedLengthStreamingMode(payload.size)
            connection.outputStream.use { it.write(payload) }

            val status = connection.responseCode
            if (status != 202) throw IOException("H5 Log 上报失败：HTTP $status")
            val response = connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            return JSONObject(response).getInt("accepted")
        } finally {
            connection.disconnect()
        }
    }
}
```

通过项目已有的 Debug / 内测开关，在测试入口调用以下函数一次。把 `appId` 改为项目标识，`endpoint` 使用第 1 步的配置。

```kotlin
import android.content.Context
import android.util.Log
import java.util.UUID

fun verifyH5Log(context: Context, endpoint: String) {
    val prefs = context.getSharedPreferences("h5_log", Context.MODE_PRIVATE)
    val deviceId = prefs.getString("device_id", null) ?: UUID.randomUUID().toString().also {
        prefs.edit().putString("device_id", it).apply()
    }
    val reporter = H5LogReporter(endpoint, "my-android-app", "test", deviceId)
    Thread {
        try {
            Log.i("H5Log", "accepted=${reporter.send("Kotlin 接入测试")}")
        } catch (error: Exception) {
            Log.w("H5Log", "测试上报失败", error)
        }
    }.start()
}
```

**验收：** Logcat 显示 `accepted=1`，并且在同一部署的工作台打开「选择设备」，选中标签包含 `my-android-app/test` 的设备，再搜索 `Kotlin 接入测试`。如果应用标识已改，按实际值查找。

## 3. 接到项目的日志入口

- 在测试进程里复用一个 `H5LogReporter`，保持 `sessionId` 不变；`deviceId` 用本地保存的随机 UUID，不用 IMEI、手机号或用户 ID。已有统一日志封装（如 Timber）时，只转发选定的日志；上报器自身的失败日志留在本地，避免递归上报。
- 一次性验收用的 `Thread` 不适合每条日志都启动。日常接入用项目已有的后台执行机制；高频日志先用有界队列合批，避免网络不可用时拖累应用。发送前剔除令牌、Cookie、账号和其他敏感数据。
- 如果需要让 H5 和 Kotlin 日志出现在工作台的**同一个客户端**下，两端需共享 `appId`、`environment`、`deviceId`，而不是各自生成设备 ID。要进一步归为同一个会话，还需共享 `sessionId`。上面的最小示例默认单独归组。

## 接口约束与排查

- 请求体是 `{"events":[...]}`，每批 **1–50 条**，JSON 请求体最大 **1 MiB**，单条日志最大 **128 KiB**。`timestamp` 是 Unix 毫秒，`args` 是 JSON 数组，`level` 可用 `debug`、`info`、`log`、`warn`、`error`。`deviceName`、`userAgent`、`pageUrl` 没有值时传空字符串，不要省略。
- 成功返回 `202` 和 `{"accepted":1}`（单条新日志）。`accepted` 是本批新增数；服务端按 `appId`、`environment`、`deviceId`、`sessionId`、`eventId` 在保留范围内去重。如果实现重试，重发同一事件时复用原始事件及其 `eventId`。示例没有队列或重试。
- `400`：核对 JSON 和必填字段；`413`：缩小单条或批次；`415`：确认发送的是 `application/json`。`3xx` 或 `404`：核对完整地址和部署前缀；连接、超时或证书报错：从手机侧检查网络可达性和证书信任。

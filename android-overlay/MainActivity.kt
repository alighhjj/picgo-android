package com.alighhjj.picgo

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import androidx.activity.enableEdgeToEdge
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 这个文件**覆盖** tauri android init 生成的 MainActivity.kt（见 scripts/patch-android.mjs）。
 *
 * 它只做一件事：把系统分享进来的图片拷进应用缓存，并把清单写进 `pending-share.json`。
 * 上传完全由 Rust 侧做，这里不碰网络。
 *
 * 注意：**不要给它加 `import ...TauriActivity`**。`TauriActivity` 声明在默认包（无名包）里，
 * 生成的模板也是这样直接继承的；加了 import 反而编译不过。
 */
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // 刻意在 super.onCreate 之前处理：WebView 是在 super 里创建的，等 JS 起来时
    // 分享文件必须已经在队列里了，否则冷启动这一路会静默丢掉分享内容。
    handleShareIntent(intent)
    super.onCreate(savedInstanceState)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    // 热启动时 JS 已经在跑，界面靠 tauri://focus 事件回来取队列；
    // 这里是主线程同步拷贝，一定早于 focus 事件。
    handleShareIntent(intent)
  }

  private fun handleShareIntent(intent: Intent?) {
    if (intent == null) return

    val uris: List<Uri> = when (intent.action) {
      Intent.ACTION_SEND -> listOfNotNull(sharedUri(intent))
      Intent.ACTION_SEND_MULTIPLE -> sharedUriList(intent)
      else -> return
    }
    if (uris.isEmpty()) return

    val fallbackMime = intent.type
    val files = JSONArray()

    for (uri in uris) {
      val copied = copyToCache(uri, fallbackMime) ?: continue
      files.put(copied)
    }

    if (files.length() == 0) {
      eprintln("[share] 分享进来的 ${uris.size} 个文件都没能拷进缓存")
      return
    }

    appendPending(files)
  }

  @Suppress("DEPRECATION")
  private fun sharedUri(intent: Intent): Uri? {
    return intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
  }

  @Suppress("DEPRECATION")
  private fun sharedUriList(intent: Intent): List<Uri> {
    // 部分分享方（例如某些相册）在 SEND_MULTIPLE 里塞的是 ArrayList<Uri>，
    // 也有塞 ArrayList<String> 的，两种都兜一下。
    val raw = intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
    if (raw != null) return raw.filterNotNull()

    val strings = intent.getStringArrayListExtra(Intent.EXTRA_STREAM) ?: return emptyList()
    return strings.mapNotNull { runCatching { Uri.parse(it) }.getOrNull() }
  }

  /** 把 content:// 变成应用私有缓存里的普通文件，返回给 Rust 用的描述对象。 */
  private fun copyToCache(uri: Uri, fallbackMime: String?): JSONObject? {
    val mime = contentResolver.getType(uri) ?: fallbackMime ?: "image/jpeg"
    if (!mime.startsWith("image/")) {
      eprintln("[share] 跳过非图片内容：$mime ($uri)")
      return null
    }

    val displayName = displayName(uri) ?: "shared-${System.currentTimeMillis()}${extensionFor(mime)}"
    val dir = File(cacheDir, "shared")
    if (!dir.exists() && !dir.mkdirs()) {
      eprintln("[share] 创建缓存目录失败：$dir")
      return null
    }

    // 加时间戳前缀避免同名覆盖；送给图床的文件名仍用 displayName（更可读）。
    val target = File(dir, "${System.currentTimeMillis()}-${sanitize(displayName)}")

    try {
      contentResolver.openInputStream(uri)?.use { input ->
        target.outputStream().use { output ->
          // 不用 kotlin.io.DEFAULT_BUFFER_SIZE —— 它是 internal，跨模块访问不到。
          val buffer = ByteArray(COPY_BUFFER_BYTES)
          var total = 0L
          while (true) {
            val read = input.read(buffer)
            if (read <= 0) break
            total += read
            if (total > MAX_FILE_BYTES) {
              // 边拷边判，避免为了一个超大文件先把磁盘写满。
              output.close()
              target.delete()
              eprintln("[share] 跳过大文件（>${MAX_FILE_BYTES / 1024 / 1024}MB）：$displayName")
              return null
            }
            output.write(buffer, 0, read)
          }
        }
      } ?: run {
        eprintln("[share] 打不开输入流：$uri")
        return null
      }
    } catch (error: Exception) {
      eprintln("[share] 拷贝失败（$uri）：$error")
      target.delete()
      return null
    }

    pruneOldCache(dir)

    return JSONObject().apply {
      put("path", target.absolutePath)
      put("name", displayName)
      put("mime", mime)
      put("size", target.length())
    }
  }

  /**
   * 合并写回，而不是覆盖。
   *
   * 用户可能连着分享两张图，也可能在上一张还没上传完时又分享一张 —— 覆盖会让第一张
   * 静默消失，所以这里读出来追加。
   */
  private fun appendPending(files: JSONArray) {
    val pending = File(cacheDir, PENDING_FILE_NAME)
    val merged = JSONArray()

    if (pending.exists()) {
      runCatching {
        val existing = JSONObject(pending.readText()).optJSONArray("files")
        if (existing != null) {
          for (index in 0 until existing.length()) merged.put(existing.get(index))
        }
      }.onFailure { eprintln("[share] 旧队列解析失败，按空队列处理：$it") }
    }

    for (index in 0 until files.length()) merged.put(files.get(index))

    runCatching {
      pending.writeText(JSONObject().put("files", merged).toString())
    }.onFailure { eprintln("[share] 写入分享队列失败：$it") }
  }

  private fun displayName(uri: Uri): String? {
    return runCatching {
      contentResolver.query(uri, null, null, null, null)?.use { cursor ->
        val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
      }
    }.getOrNull()
  }

  /** 只保留文件名里安全的字符，顺手挡掉 ../ 这类路径穿越。 */
  private fun sanitize(name: String): String {
    val cleaned = name.replace(Regex("[^A-Za-z0-9._\\u4e00-\\u9fa5-]"), "_").trim('.', '_')
    return if (cleaned.isEmpty()) "shared.jpg" else cleaned.take(80)
  }

  private fun extensionFor(mime: String): String = when (mime) {
    "image/png" -> ".png"
    "image/gif" -> ".gif"
    "image/webp" -> ".webp"
    "image/bmp" -> ".bmp"
    else -> ".jpg"
  }

  /** 缓存里超过一天的文件没人会再用，顺手清掉，免得越攒越多。 */
  private fun pruneOldCache(dir: File) {
    val cutoff = System.currentTimeMillis() - CACHE_TTL_MS
    runCatching {
      dir.listFiles()?.forEach { file ->
        if (file.isFile && file.lastModified() < cutoff) file.delete()
      }
    }.onFailure { eprintln("[share] 清理旧缓存失败：$it") }
  }

  private companion object {
    const val PENDING_FILE_NAME = "pending-share.json"
    const val MAX_FILE_BYTES = 50L * 1024 * 1024
    const val CACHE_TTL_MS = 24L * 60 * 60 * 1000
    const val COPY_BUFFER_BYTES = 8 * 1024
  }
}

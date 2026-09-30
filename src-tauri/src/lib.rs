//! PicGo Tutu —— 原生侧只做三件事：发 multipart、取分享队列、读写配置。
//!
//! 刻意的设计：**tutu 的业务逻辑一行都不在这里**。请求字段怎么拼、响应里哪一个是
//! 直链、错误码是什么意思，全部在 `dist/tutu.js` 里，因为那部分能在本机用 Node 测，
//! 而 Rust 只能在 CI 里编。这里只做一个哑传输层 + 文件读写。

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::Manager;

/// Kotlin 侧写入的分享队列文件名，双方都以此约定同一个目录（cacheDir）。
const PENDING_SHARE_FILE: &str = "pending-share.json";
const STATE_FILE: &str = "state.json";

/// 预览用的最大字节数。超过就不给缩略图，避免把几十 MB 的图 base64 进内存再塞给 WebView。
const MAX_PREVIEW_BYTES: usize = 12 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 传输层
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormField {
    name: String,
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileField {
    /// multipart 里的文件字段名（tutu 两个通道都叫 `source`）。
    name: String,
    /// 本地绝对路径。content:// 已由 Kotlin 拷进缓存，这里拿到的一定是普通文件路径。
    path: String,
    file_name: String,
    mime_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultipartRequest {
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    fields: Vec<FormField>,
    file: FileField,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultipartResponse {
    status: u16,
    raw_body: String,
}

/// 发一次 multipart/form-data 请求。
///
/// 为什么不用 WebView 的 fetch：tutu 不发 CORS 头，而且 `Cookie` 是浏览器的
/// forbidden header，网页层根本设不了。走原生没有这两个限制。
#[tauri::command]
async fn send_multipart(request: MultipartRequest) -> Result<MultipartResponse, String> {
    let path_for_read = request.file.path.clone();
    let path_for_error = request.file.path.clone();

    // 读文件是阻塞操作，丢给阻塞线程池，别占着异步运行时。
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(&path_for_read))
        .await
        .map_err(|e| format!("读取图片任务失败：{e}"))?
        .map_err(|e| format!("读取图片失败（{path_for_error}）：{e}"))?;

    let mime = request.file.mime_type.clone();
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(request.file.file_name.clone())
        .mime_str(&mime)
        .map_err(|e| format!("无效的 MIME 类型（{mime}）：{e}"))?;

    let mut form = reqwest::multipart::Form::new();
    for field in &request.fields {
        form = form.text(field.name.clone(), field.value.clone());
    }
    form = form.part(request.file.name.clone(), part);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(
            request.timeout_ms.unwrap_or(120_000),
        ))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败：{e}"))?;

    let mut builder = client.post(request.url.as_str()).multipart(form);
    for (name, value) in &request.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }

    let response = builder
        .send()
        .await
        .map_err(|e| format!("请求 {} 失败：{e}", request.url))?;

    // 这里**不**把 HTTP 错误状态当成 Rust 错误：tutu 的错误信息在响应体里，
    // 状态码和响应体要一起交给 JS 去解读（错误码映射都在那边）。
    let status = response.status().as_u16();
    let raw_body = response
        .text()
        .await
        .map_err(|e| format!("读取响应内容失败：{e}"))?;

    Ok(MultipartResponse { status, raw_body })
}

// ---------------------------------------------------------------------------
// 分享队列
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedFile {
    path: String,
    name: String,
    mime: String,
    size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct PendingShare {
    files: Vec<SharedFile>,
}

fn pending_share_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|dir| dir.join(PENDING_SHARE_FILE))
        .map_err(|e| format!("定位缓存目录失败：{e}"))
}

/// 取走待处理的分享内容，取完即清空（否则每次冷启动都会把同一张图重传一遍）。
///
/// 冷启动时 WebView 还没加载完，事件一定会丢，所以这里用**队列文件**而不是事件。
#[tauri::command]
fn take_pending_share(app: tauri::AppHandle) -> Result<Vec<SharedFile>, String> {
    let file = pending_share_path(&app)?;
    if !file.exists() {
        return Ok(Vec::new());
    }

    let text = std::fs::read_to_string(&file).map_err(|e| format!("读取分享内容失败：{e}"))?;
    // 先删再解析：解析失败也不该把这条无限重试下去。
    if let Err(error) = std::fs::remove_file(&file) {
        // 不用 log crate（不是直接依赖），eprintln 在 logcat 里同样能看到。
        eprintln!("删除分享队列文件失败：{error}");
    }

    let pending: PendingShare =
        serde_json::from_str(&text).map_err(|e| format!("解析分享内容失败：{e}"))?;
    Ok(pending.files)
}

/// 预览用：把本地图片读成 data URL。
///
/// 不用 `assetProtocol` 是因为那要同时改 Cargo feature、`app.security.assetProtocol`
/// 和 CSP 三处，任何一处漏了都是白屏；data URL 只多花一点内存，换掉三处易错配置。
#[tauri::command]
async fn read_file_data_url(path: String) -> Result<String, String> {
    let path_for_read = path.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(&path_for_read))
        .await
        .map_err(|e| format!("读取图片任务失败：{e}"))?
        .map_err(|e| format!("读取图片失败（{path}）：{e}"))?;

    if bytes.len() > MAX_PREVIEW_BYTES {
        return Err("图片太大，跳过预览".into());
    }

    let mime = match path.rsplit('.').next().map(str::to_ascii_lowercase) {
        Some(ext) if ext == "png" => "image/png",
        Some(ext) if ext == "gif" => "image/gif",
        Some(ext) if ext == "webp" => "image/webp",
        Some(ext) if ext == "bmp" => "image/bmp",
        _ => "image/jpeg",
    };

    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

// ---------------------------------------------------------------------------
// 配置与历史（一个 JSON 文件，不引 store 插件，省一套 ACL）
// ---------------------------------------------------------------------------

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(STATE_FILE))
        .map_err(|e| format!("定位数据目录失败：{e}"))
}

#[tauri::command]
fn read_state(app: tauri::AppHandle) -> Result<String, String> {
    let file = state_path(&app)?;
    if !file.exists() {
        // 首次启动不是错误，返回空串让前端用默认值。
        return Ok(String::new());
    }
    std::fs::read_to_string(&file).map_err(|e| format!("读取配置失败：{e}"))
}

#[tauri::command]
fn write_state(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let file = state_path(&app)?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败：{e}"))?;
    }
    std::fs::write(&file, json).map_err(|e| format!("保存配置失败：{e}"))
}

// ---------------------------------------------------------------------------
// 诊断
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PathsInfo {
    cache_dir: String,
    data_dir: String,
    pending_share_path: String,
    pending_share_exists: bool,
}

/// 本机没有真机可测，所以给界面留一个「诊断」出口：目录对不上时能一眼看出来。
#[tauri::command]
fn debug_paths(app: tauri::AppHandle) -> PathsInfo {
    let cache_dir = app.path().app_cache_dir();
    let data_dir = app.path().app_data_dir();
    let pending = pending_share_path(&app).ok();

    PathsInfo {
        cache_dir: cache_dir
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|e| format!("<err: {e}>")),
        data_dir: data_dir
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|e| format!("<err: {e}>")),
        pending_share_exists: pending.as_ref().map(|p| p.exists()).unwrap_or(false),
        pending_share_path: pending
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "<err>".into()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            send_multipart,
            take_pending_share,
            read_file_data_url,
            read_state,
            write_state,
            debug_paths
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

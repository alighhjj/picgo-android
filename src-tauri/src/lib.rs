//! PicGo Tutu —— 原生侧只做三件事：发 multipart、取分享队列、读写配置。
//!
//! 刻意的设计：**tutu 的业务逻辑一行都不在这里**。请求字段怎么拼、响应里哪一个是
//! 直链、错误码是什么意思，全部在 `dist/tutu.js` 里，因为那部分能在本机用 Node 测，
//! 而 Rust 只能在 CI 里编。这里只做一个哑传输层 + 文件读写。

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::time::Duration;
use tauri::Manager;

/// Kotlin 侧写入的分享队列文件名，双方都以此约定同一个目录（cacheDir）。
const PENDING_SHARE_FILE: &str = "pending-share.json";
const STATE_FILE: &str = "state.json";

/// 预览用的最大字节数。超过就不给缩略图，避免把几十 MB 的图 base64 进内存再塞给 WebView。
const MAX_PREVIEW_BYTES: usize = 12 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 错误描述
// ---------------------------------------------------------------------------

/// 把错误链展开成一句话。
///
/// 必须展开：reqwest 对传输层失败只会说
/// `error sending request for url (https://...)`，
/// 真正的原因（DNS 解析不了 / TLS 握手失败 / 连接被拒 / 超时）在 `source()` 链里。
/// 不展开就等于把唯一有用的信息丢掉 —— 真机上只能看到一句无用的话。
fn describe_error(error: &(dyn std::error::Error + 'static)) -> String {
    let mut parts = vec![error.to_string()];
    let mut current = error.source();

    while let Some(source) = current {
        let text = source.to_string();
        if !parts.contains(&text) {
            parts.push(text);
        }
        current = source.source();
    }

    parts.join(" ← ")
}

fn describe_reqwest(error: &reqwest::Error) -> String {
    let mut hints: Vec<&str> = Vec::new();
    if error.is_timeout() {
        hints.push("超时");
    }
    if error.is_connect() {
        hints.push("连接阶段失败");
    }
    if error.is_request() {
        hints.push("发送/接收请求失败");
    }
    if error.is_body() {
        hints.push("响应体读取失败");
    }
    if error.is_decode() {
        hints.push("响应解析失败");
    }

    let hint = if hints.is_empty() {
        String::new()
    } else {
        format!("［{}］", hints.join("、"))
    };
    format!("{hint}{}", describe_error(error))
}

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
        .timeout(Duration::from_millis(request.timeout_ms.unwrap_or(120_000)))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败：{}", describe_reqwest(&e)))?;

    let mut builder = client.post(request.url.as_str()).multipart(form);
    for (name, value) in &request.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }

    let response = builder
        .send()
        .await
        .map_err(|e| format!("请求 {} 失败：{}", request.url, describe_reqwest(&e)))?;

    // 这里**不**把 HTTP 错误状态当成 Rust 错误：tutu 的错误信息在响应体里，
    // 状态码和响应体要一起交给 JS 去解读（错误码映射都在那边）。
    let status = response.status().as_u16();
    let raw_body = response
        .text()
        .await
        .map_err(|e| format!("读取响应内容失败：{}", describe_reqwest(&e)))?;

    Ok(MultipartResponse { status, raw_body })
}

// ---------------------------------------------------------------------------
// 网络自检
// ---------------------------------------------------------------------------

// 真机出问题时最怕「只知道失败、不知道失败在哪一层」。DNS / TCP / HTTPS 分三步测，
// 每步各自报告结果，就能一次定位是解析不了、连不上，还是 TLS/HTTP 层的问题。

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeStep {
    name: String,
    ok: bool,
    detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    target: String,
    ok: bool,
    steps: Vec<ProbeStep>,
}

fn step(name: &str, result: Result<String, String>) -> ProbeStep {
    match result {
        Ok(detail) => ProbeStep {
            name: name.to_string(),
            ok: true,
            detail,
        },
        Err(detail) => ProbeStep {
            name: name.to_string(),
            ok: false,
            detail,
        },
    }
}

#[tauri::command]
async fn probe_host(url: String, timeout_ms: Option<u64>) -> Result<ProbeReport, String> {
    let parsed = url::Url::parse(&url).map_err(|e| format!("URL 无法解析（{url}）：{e}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| format!("URL 里没有主机名：{url}"))?
        .to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(20_000));

    let mut steps = Vec::new();

    // 1) 域名解析（阻塞调用，丢给阻塞线程池）
    let dns = {
        let host = host.clone();
        tauri::async_runtime::spawn_blocking(move || match (host.as_str(), port).to_socket_addrs() {
            Ok(addrs) => {
                let list: Vec<String> = addrs.map(|a| a.to_string()).collect();
                if list.is_empty() {
                    Err("没有解析到任何地址".to_string())
                } else {
                    Ok(list.join(", "))
                }
            }
            Err(e) => Err(describe_error(&e)),
        })
        .await
        .map_err(|e| format!("DNS 检查任务失败：{e}"))?
    };
    steps.push(step("1. 解析域名", dns));

    // 2) TCP 连接（五秒超时，不含 TLS，用来区分「网络不通」和「TLS/HTTP 有问题」）
    let tcp = {
        let host = host.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut addrs = (host.as_str(), port)
                .to_socket_addrs()
                .map_err(|e| format!("解析失败：{}", describe_error(&e)))?;
            let addr = addrs.next().ok_or_else(|| "没有可用地址".to_string())?;
            match TcpStream::connect_timeout(&addr, Duration::from_secs(5)) {
                Ok(_) => Ok(format!("已连通 {addr}")),
                Err(e) => Err(format!("连接 {addr} 失败：{}", describe_error(&e))),
            }
        })
        .await
        .map_err(|e| format!("TCP 检查任务失败：{e}"))?
    };
    steps.push(step("2. TCP 连接（端口直连，不含 TLS）", tcp));

    // 3) 完整 HTTPS 请求
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败：{}", describe_reqwest(&e)))?;

    let https = match client.get(parsed).send().await {
        Ok(response) => Ok(format!("HTTP {}", response.status().as_u16())),
        Err(e) => Err(describe_reqwest(&e)),
    };
    steps.push(step("3. HTTPS 请求", https));

    let ok = steps.iter().all(|s| s.ok);
    Ok(ProbeReport {
        target: url,
        ok,
        steps,
    })
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
            probe_host,
            take_pending_share,
            read_file_data_url,
            read_state,
            write_state,
            debug_paths
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

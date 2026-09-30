# PicGo Tutu

把它们从系统相册**分享**到这个应用，图片就会上传到 [TUTU 兔兔图床](https://tutu.to)，直链自动复制到剪贴板。

为 Android 做的极简上传客户端：没有首页、没有广告、不用登录 App 本身，分享即上传。

```
相册选图 → 分享 → PicGo Tutu → 直链已在剪贴板
```

---

## 下载安装

到 [**Releases**](https://github.com/alighhjj/picgo-android/releases/latest) 下载最新版 APK，文件名形如 `PicGoTutu-<版本号>.apk`。

当前最新为 **v0.2.3**（约 16.5 MB）：

- 直接下载：<https://github.com/alighhjj/picgo-android/releases/download/v0.2.3/PicGoTutu-0.2.3.apk>
- 文件大小：`17345572` 字节
- SHA-256：`c09d047581466e75e71b9086e6f4181ffecbae8a7b5d53f1c3824720a0c84e10`

每个 Release 都附带 `SHA256SUMS.txt`，下载后对一下哈希就知道有没有下全（网络不稳时很有用）。

**要求**：Android 7.0（API 24）及以上，arm64 或 armv7。

> 从旧版本升级直接覆盖安装即可，配置与历史都会保留。
> 例外：如果你装的是更早的 **debug** 包（`-debug.apk` 结尾），它与 release 包签名不同，**必须先卸载**才能装 release 包。

## 首次配置

装完先做一件事：打开应用 →「**设置**」→ 填凭据。不填的话分享过去只会提示未配置。

两种凭据任选其一：

| 凭据 | 优点 | 缺点 | 怎么获取 |
|---|---|---|---|
| **登录 Cookie（推荐）** | 上传到你的账号；可设为「不公开」 | 会过期，需要重取 | 浏览器登录 tutu.to → F12 → Application → Cookies → 复制 `KEEP_LOGIN` 的值 |
| **API Key** | 不过期 | 只能公开上传 | <https://tutu.to/settings?tab=api> |

填了 Cookie 就自动走 Cookie 通道（支持不公开），只填 Key 则走 API Key 通道。粘贴整行 `KEEP_LOGIN=xxx` 或整条 Cookie 串都能识别。

## 怎么用

1. 相册或文件管理器里选中图片 →「分享」→ 选「**PicGo Tutu**」
2. 应用自动打开并开始上传，完成后直链已复制，结果显示在对应的条目上

三个页签：

- **上传** — 待上传/已完成的图片。每条都有自己的按钮：待上传是「上传」、失败是「重试」、成功是「复制直链」，右侧可「移除」
- **历史** — 最近 100 条上传记录，可复制直链、可删除
- **设置** — 凭据、可见性、域名，以及最下面的诊断面板

## 上传失败怎么办

设置页最下面展开「**诊断与网络自检**」：

- 点「**网络自检**」——分三步测 `解析域名 → TCP 直连端口 → 完整 HTTPS`，一次看清断在哪一层：
  - 第 1 步就失败 → 手机 DNS 解析不了图床域名
  - 第 2 步失败 → 手机网络到不了图床。**重点查 VPN**：Android 的 VPN 能设置「只对部分应用生效」，本应用不在列表里的话流量就不走代理；也试试切换 WiFi / 移动数据
  - 第 3 步失败 → TLS/HTTP 层问题
- 点「**复制全部诊断信息**」——目录路径、凭据状态、每张图的失败原因、自检结果一起复制到剪贴板

错误文案本身也写得比较具体，例如「登录态已失效（KEEP_LOGIN 无效或已过期）」「API Key 无效、缺失或已撤销」「调用频率超出限制」，一般看提示就能定位。

## 功能范围

- 分享单张或多张图片上传
- 两个上传通道：登录 Cookie（可设「不公开」）、API Key（仅公开）
- 上传进度状态、失败重试、直链自动复制、本地历史
- 中文界面

**不做**：应用内选图（入口就是系统分享）、除 tutu 之外的图床、iOS。

## 技术说明

### 与 PicGo 的关系

**这不是 PicGo 的分支，也不是把 PicGo 改造成 Android 版。**

PicGo 是 Electron 应用，桌面主进程那套（`ipcMain`、托盘、全局快捷键、npm 插件系统）在 Android 上无处安放，`picgo` core 本身也是 Node 库。所以这里是**新写的客户端**，只复用了原 PicGo 的 **tutu 图床插件**里那部分纯业务规则：

- 两个通道的 multipart 字段构造（v2 的 `key` + `source`；v3 的 `source` + `client_upload_id` + `visibility` + `Cookie`）
- **直链推导**：上传响应只给 `url_viewer`（`https://tutu.to/image/<id>`，是 HTML 查看页不是图片），原图在 CDN 的 `https://t.tutu.to/img/<id>`
- 错误码映射与「登录态静默降级为游客上传」的识别

### 三层结构

| 层 | 内容 |
|---|---|
| **Rust**（`src-tauri/`） | Tauri v2 后端。7 个命令：`send_multipart`、`probe_host`、`take_pending_share`、`read_file_data_url`、`read_state`、`write_state`、`debug_paths`。另用官方 `tauri-plugin-clipboard-manager` 写剪贴板 |
| **前端**（`dist/`） | 原生 HTML/CSS/ESM，**没有打包步骤**——通过 `withGlobalTauri` 直接用 Tauri 注入的 `window.__TAURI__.core.invoke`。图床业务规则集中在 `dist/tutu.js`，是纯 JS 模块，可以在 Node 里直接单测 |
| **Kotlin**（`android-overlay/MainActivity.kt`） | 约 210 行，只做一件事：接收系统分享、把 `content://` 拷进应用缓存、写队列文件。上传与业务逻辑都不在这里 |

为什么必须有 Kotlin：Android 把 `ACTION_SEND` 交给 **Activity**，Rust 侧拿不到 intent，Tauri 也没有对应 API。这层无法避免（改用 Tauri 的移动端插件机制，底层仍然是 Kotlin）。

### 两个值得记录的设计决定

**上传不走 WebView 的 `fetch`，走原生。** 两个硬原因：一是 tutu 不返回 CORS 头，网页层直连必被拦；二是 `Cookie` 属于浏览器的 forbidden header，网页层根本设不了，而 Cookie 通道正是唯一支持「不公开」的通道。

**`reqwest` 钉在 0.12 而不是最新版。** 0.13 把 rustls 变成默认 TLS 后端，而它依赖的 `rustls-platform-verifier` 在 Android 上要靠 JVM 校验系统证书库——官方要求打包时额外加入一个 Kotlin 组件，Tauri 生成的工程里没有，于是 TLS 握手直接失败，且只报一句 `error sending request`。0.12 的 `rustls-tls` 用内置 Mozilla 根证书 + ring，不依赖平台校验器，开箱可用。

### 目录结构

```
dist/                 前端（静态资源，直接提交，无构建步骤）
  tutu.js             ★ tutu 图床全部业务规则（可在 Node 里单测）
  transport.js        原生通道 / 浏览器调试通道
  app.js              界面与流程编排
src-tauri/            Rust 后端 + tauri.conf.json + capabilities
android-overlay/      MainActivity.kt（接收系统分享）
scripts/
  patch-android.mjs   向 CI 生成的 Android 工程注入定制
  rename-apk.mjs      产物重命名为 应用名-版本号.apk
  test-tutu.mjs       业务逻辑单测（31 项）
  verify-web.mjs      真浏览器端到端（37 项断言）
  mock-tutu.mjs       假图床 + serve.mjs 本地预览
.github/workflows/    android-apk.yml（出包）+ lockfile.yml
```

## 自行构建

本机不需要装 Rust / JDK / Android SDK——编译与出包全部由 GitHub Actions 完成。

```bash
pnpm install
pnpm test      # 31 项业务逻辑单测
pnpm verify    # 37 项真浏览器端到端（用系统 Edge + 假图床）
pnpm serve     # 浏览器里预览界面（配合 pnpm mock）
```

出包：

- 推送 `main` → 构建 **debug** APK 作为 Actions artifact（用于验证能编译）
- 打 `v*` tag → 构建**签名 release** APK 并附到 Release（含 `SHA256SUMS.txt`）

签名需要三个仓库 Secret：`ANDROID_KEY_BASE64`、`ANDROID_KEY_PASSWORD`、`ANDROID_KEY_ALIAS`。

`src-tauri/gen/android` **不进仓库**：`tauri android init` 内部要跑 `cargo metadata`，没有 Rust 工具链就生成不了，所以由 CI 现生成，再用 `scripts/patch-android.mjs` 注入本项目需要的定制（分享 intent-filter、MainActivity、图标、SDK/NDK 版本钉死、签名配置、裁剪调试符号）。

## 已知限制

- **仅 Android、仅 tutu 图床**（加图床只需新增一个 `dist/<name>.js` + 复用传输层）
- **没有应用内选图**：入口就是系统分享
- **凭据以明文存在应用私有目录**的 `state.json` 里（与 PicGo 桌面版的 `data.json` 同级），未接入 Android Keystore
- release 包经过 R8 精简；若遇异常可先用 debug 包对比

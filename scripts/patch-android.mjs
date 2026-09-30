#!/usr/bin/env node
/**
 * 把本仓库的 Android 定制注入 `tauri android init` 生成的工程。
 *
 * 为什么要有这个脚本：`gen/android` 是生成物，而生成它的命令需要 cargo（本机没有 Rust
 * 时跑不了），所以它不提交进仓库、每次都由 CI 现生成。我们对它做的两处改动
 * （收分享的 MainActivity、清单里的 intent-filter）就必须在生成之后注入。
 *
 * 这个脚本刻意**不宽容**：锚点对不上就报错退出。宁可 CI 红一次，也不要静默产出一个
 * 收不到系统分享的包 —— 那种故障在真机上只表现为「分享过去界面毫无反应」。
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GEN_ANDROID = join(ROOT, 'src-tauri', 'gen', 'android')
const APP_DIR = join(GEN_ANDROID, 'app', 'src', 'main')
const OVERLAY = join(ROOT, 'android-overlay')

/** 清单和 Kotlin 里插入内容的标记，用于幂等判断。 */
const MARKER = 'picgo-tutu: share intake'
const APP_LABEL = 'PicGo Tutu'

function fail(message) {
  console.error(`\n[patch-android] ✗ ${message}\n`)
  process.exit(1)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const tauriConfig = readJson(join(ROOT, 'src-tauri', 'tauri.conf.json'))
const identifier = tauriConfig.identifier
if (!identifier) fail('tauri.conf.json 里没有 identifier')

if (!existsSync(GEN_ANDROID)) {
  fail(
    `找不到 ${GEN_ANDROID}\n` +
      '请先运行 `npx tauri android init --ci`（该命令需要 cargo）。'
  )
}

// ---------------------------------------------------------------------------
// 1. 覆盖 MainActivity.kt（收 ACTION_SEND）
// ---------------------------------------------------------------------------

const packageDir = join(APP_DIR, 'java', ...identifier.split('.'))
const mainActivityPath = join(packageDir, 'MainActivity.kt')

if (!existsSync(mainActivityPath)) {
  fail(
    `找不到生成出来的 ${mainActivityPath}\n` +
      'Tauri 改了 Android 模板布局？请核对 gen/android 的实际结构后再改这个脚本。'
  )
}

const generated = readFileSync(mainActivityPath, 'utf8')
if (!generated.includes('TauriActivity')) {
  fail(
    `生成的 MainActivity.kt 里没有 TauriActivity，模板结构与预期不符：\n${mainActivityPath}\n` +
      '不要盲目覆盖，先看清楚它现在长什么样。'
  )
}

copyFileSync(join(OVERLAY, 'MainActivity.kt'), mainActivityPath)
console.log(`[patch-android] ✓ 覆盖 MainActivity.kt（收分享）`)

// ---------------------------------------------------------------------------
// 2. 往清单里加 intent-filter
// ---------------------------------------------------------------------------

const manifestPath = join(APP_DIR, 'AndroidManifest.xml')
if (!existsSync(manifestPath)) fail(`找不到 ${manifestPath}`)

let manifest = readFileSync(manifestPath, 'utf8')

if (manifest.includes(MARKER)) {
  console.log('[patch-android] • 清单里已有分享 intent-filter，跳过')
} else {
  if (!manifest.includes('android.permission.INTERNET')) {
    fail('清单里没有 INTERNET 权限，模板结构与预期不符')
  }
  if (!/android:launchMode="singleTask"/.test(manifest)) {
    fail(
      '主 Activity 不是 singleTask。没有它，App 在后台时收到分享会新开一个实例，' +
        'onNewIntent 不会被调用（分享会静默丢失）。请先弄清模板为什么变了。'
    )
  }

  const mainActivityRegex = /(<activity\b[\s\S]*?android:name="\.MainActivity"[\s\S]*?)(<\/activity>)/
  if (!mainActivityRegex.test(manifest)) {
    fail('在清单里定位不到 .MainActivity 这段，无法插入 intent-filter')
  }

  const filters = `
            <!-- ${MARKER} -->
            <!-- 系统相册/文件管理器「分享」单张图片进来 -->
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="image/*" />
            </intent-filter>

            <!-- 多选分享 -->
            <intent-filter>
                <action android:name="android.intent.action.SEND_MULTIPLE" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="image/*" />
            </intent-filter>
`

  manifest = manifest.replace(mainActivityRegex, (_match, head, close) => `${head}${filters}\n        ${close}`)
  writeFileSync(manifestPath, manifest)
  console.log('[patch-android] ✓ 清单已加入 SEND / SEND_MULTIPLE(image/*)')
}

// ---------------------------------------------------------------------------
// 3. 应用名（productName 是 PicGoTutu，桌面标签用更易读的写法）
// ---------------------------------------------------------------------------

const stringsPath = join(APP_DIR, 'res', 'values', 'strings.xml')
if (!existsSync(stringsPath)) fail(`找不到 ${stringsPath}`)

let strings = readFileSync(stringsPath, 'utf8')
const before = strings
strings = strings.replace(
  /(<string name="app_name">)[\s\S]*?(<\/string>)/,
  `$1${APP_LABEL}$2`
)
if (strings === before && !strings.includes(APP_LABEL)) {
  fail('strings.xml 里没有 app_name，无法设置应用名')
}
if (strings !== before) {
  writeFileSync(stringsPath, strings)
  console.log(`[patch-android] ✓ 应用名设为「${APP_LABEL}」`)
}

// ---------------------------------------------------------------------------
// 4. 注入应用图标
// ---------------------------------------------------------------------------

// `tauri icon` 产出的 src-tauri/icons/android/ 目录结构正好镜像 Android 的 res/。
// 不去猜 `tauri android init` 会不会自动采用它 —— 无条件拷过去，结果才是确定的。
const iconsSource = join(ROOT, 'src-tauri', 'icons', 'android')
if (!existsSync(iconsSource)) {
  fail('缺少 src-tauri/icons/android，请先跑 `pnpm run icon` 生成图标')
}

const resDir = join(APP_DIR, 'res')

/** 自己递归而不是用 readdirSync(recursive)/Dirent.parentPath：后者要 Node 20.12+。 */
function copyTree(fromDir, toDir) {
  let count = 0
  for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
    const from = join(fromDir, entry.name)
    const to = join(toDir, entry.name)
    if (entry.isDirectory()) {
      count += copyTree(from, to)
    } else if (entry.isFile()) {
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
      count += 1
    }
  }
  return count
}

const copiedIcons = copyTree(iconsSource, resDir)
console.log(`[patch-android] ✓ 注入 ${copiedIcons} 个应用图标文件`)

// ---------------------------------------------------------------------------
// 5. 钉死 NDK 版本
// ---------------------------------------------------------------------------

// Tauri 生成的 app/build.gradle.kts 不写 ndkVersion，于是 AGP 会挑一个它自己的默认值；
// 那个值不一定等于 CI 装的那个，报错是 "NDK at ... did not have a source.properties file"。
// 这里显式钉死，让「CI 安装的」与「AGP 要求的」必然一致。
//
// NDK_VERSION 由 workflow 传入（两边共用一个值）；这里的默认值只是在本地手动跑时的兜底。
const ndkVersion = process.env.NDK_VERSION || '27.2.12479018'
const appGradlePath = join(GEN_ANDROID, 'app', 'build.gradle.kts')

if (!existsSync(appGradlePath)) fail(`找不到 ${appGradlePath}`)

let appGradle = readFileSync(appGradlePath, 'utf8')
if (/^\s*ndkVersion\s*=/m.test(appGradle)) {
  console.log('[patch-android] • gradle 里已指定 ndkVersion，跳过')
} else {
  const compileSdkLine = /^(\s*)compileSdk\s*=.*$/m
  if (!compileSdkLine.test(appGradle)) {
    fail('app/build.gradle.kts 里找不到 compileSdk 行，无法插入 ndkVersion')
  }
  appGradle = appGradle.replace(
    compileSdkLine,
    // 用函数式替换时 $1 不会展开，缩进要从参数里取。
    (line, indent) => `${line}\n${indent}ndkVersion = "${ndkVersion}"`
  )
  writeFileSync(appGradlePath, appGradle)
  console.log(`[patch-android] ✓ 钉死 ndkVersion = ${ndkVersion}`)
}

// ---------------------------------------------------------------------------
// 6. 核对 lib 名（Kotlin 侧要链接 Rust 生成的静态库）
// ---------------------------------------------------------------------------

const gradlePropertiesPath = join(GEN_ANDROID, 'gradle.properties')
if (existsSync(gradlePropertiesPath)) {
  const properties = readFileSync(gradlePropertiesPath, 'utf8')
  const match = properties.match(/tauri_app_lib_name=(\S+)/)
  if (!match) {
    fail('gradle.properties 里没有 tauri_app_lib_name，Tauri 的生成流程变了？')
  }
  console.log(`[patch-android] ✓ tauri_app_lib_name = ${match[1]}`)
}

console.log('[patch-android] 完成')

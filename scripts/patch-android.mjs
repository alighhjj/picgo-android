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
// 5. 钉死 compileSdk / targetSdk / ndkVersion
// ---------------------------------------------------------------------------

// 为什么要钉：
// 1) API 37 目前**没有** `platforms;android-37` 这个包 —— Android 改成带 minor 的
//    版本号后，仓库里只有 android-37.0 / 37.1 / 37.2，而 AGP 找的是 android-37。
//    Tauri 2.12 生成的工程写的是 compileSdk = 37，直接用装不上平台。
//    钉到 36（当前稳定且能装）即可，这个应用的代码只用老 API，不依赖 37 的任何特性。
// 2) 不写 ndkVersion 时 AGP 会挑一个自己的默认值，未必等于 CI 装的那个，报错是
//    "NDK at ... did not have a source.properties file"。
//
// 三个值都由环境变量传入（workflow 与这里共用一个来源），默认值只用于本地手动跑。
const compileSdk = process.env.ANDROID_COMPILE_SDK || '36'
const targetSdk = process.env.ANDROID_TARGET_SDK || '36'
const ndkVersion = process.env.NDK_VERSION || '27.2.12479018'
const appGradlePath = join(GEN_ANDROID, 'app', 'build.gradle.kts')

if (!existsSync(appGradlePath)) fail(`找不到 ${appGradlePath}`)

const compileSdkRe = /^(\s*)compileSdk\s*=.*$/m
const targetSdkRe = /^(\s*)targetSdk\s*=.*$/m
const ndkRe = /^\s*ndkVersion\s*=.*$/m

let appGradle = readFileSync(appGradlePath, 'utf8')
if (!compileSdkRe.test(appGradle)) {
  fail('app/build.gradle.kts 里找不到 compileSdk 行，模板结构与预期不符')
}

// 名字与上面 strings.xml 那段的 before 区分开（重名会让整个脚本 SyntaxError）。
const beforeSdk = {
  compileSdk: appGradle.match(compileSdkRe)?.[0].trim() ?? '(无)',
  targetSdk: appGradle.match(targetSdkRe)?.[0].trim() ?? '(无)'
}
const hasNdk = ndkRe.test(appGradle)

appGradle = appGradle.replace(compileSdkRe, (line, indent) => {
  const pinned = `${indent}compileSdk = ${compileSdk}`
  return hasNdk ? pinned : `${pinned}\n${indent}ndkVersion = "${ndkVersion}"`
})

if (targetSdkRe.test(appGradle)) {
  appGradle = appGradle.replace(targetSdkRe, (_line, indent) => `${indent}targetSdk = ${targetSdk}`)
}

writeFileSync(appGradlePath, appGradle)
console.log(`[patch-android] ✓ SDK 版本：${beforeSdk.compileSdk} → compileSdk = ${compileSdk}`)
console.log(`[patch-android] ✓ SDK 版本：${beforeSdk.targetSdk} → targetSdk = ${targetSdk}`)
console.log(
  `[patch-android] ${hasNdk ? '•' : '✓'} ndkVersion = ${ndkVersion}${hasNdk ? '（已存在，未改动）' : ''}`
)

// ---------------------------------------------------------------------------
// 6. 记录生成结果（只输出信息，不做断言）
// ---------------------------------------------------------------------------

// 这里刻意不校验 tauri_app_lib_name：那是第三方分享插件 README 教用户手工加的属性，
// `tauri android init` 并不会写它 —— 第一版脚本按这个错误前提做了断言，直接把自己
// 卡死了。真正决定 Kotlin 能链接到 Rust 静态库的是下面这个 rust 插件，所以只把它
// 打出来看。
const gradlePropertiesPath = join(GEN_ANDROID, 'gradle.properties')
if (existsSync(gradlePropertiesPath)) {
  const properties = readFileSync(gradlePropertiesPath, 'utf8')
  const libName = properties.match(/tauri_app_lib_name=(\S+)/)
  console.log(`[patch-android] • gradle.properties 里的 lib 名：${libName ? libName[1] : '(未设置，正常)'}`)
}

if (existsSync(appGradlePath)) {
  const appliesRust = /id\(\s*"rust"\s*\)/.test(readFileSync(appGradlePath, 'utf8'))
  console.log(`[patch-android] • app 模块应用 rust 插件：${appliesRust ? '是' : '否（异常，请检查）'}`)
}

console.log('[patch-android] 完成')

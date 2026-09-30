#!/usr/bin/env node
/**
 * 把 CI 产出的 APK 重命名成「应用名-版本号[-debug].apk」。
 *
 * 原生产物名是 app-universal-release.apk / app-universal-debug.apk，所有版本都长一样，
 * 下载到手机后根本分不清是哪个版本。带上应用名与版本号就能一眼区分。
 *
 * 用法：node scripts/rename-apk.mjs
 */

import { readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_APK_DIR = join(ROOT, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk')

function collectApks(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectApks(full, out)
    else if (entry.endsWith('.apk')) out.push(full)
  }
  return out
}

/**
 * 就地重命名目录下的 APK。返回 [{ from, to }]。
 * debug 包保留 -debug 后缀，避免和 release 包同名互相覆盖。
 */
export function renameArtifacts({ dir = DEFAULT_APK_DIR, productName, version }) {
  // 应用名里若有空格等字符，进文件名前清掉
  const safeName = productName.replace(/[^\w.-]+/g, '')
  const results = []

  for (const file of collectApks(dir)) {
    const isDebug = /-debug\.apk$/.test(file)
    const target = join(dirname(file), `${safeName}-${version}${isDebug ? '-debug' : ''}.apk`)

    if (resolve(file) === resolve(target)) continue

    renameSync(file, target)
    results.push({ from: basename(file), to: basename(target) })
  }

  return results
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'))
  const renamed = renameArtifacts({ productName: config.productName, version: config.version })

  if (renamed.length === 0) {
    console.log('[rename-apk] • 没有需要重命名的 APK（可能已经改过了）')
  } else {
    for (const { from, to } of renamed) console.log(`[rename-apk] ✓ ${from} → ${to}`)
  }
}

#!/usr/bin/env node
/**
 * 真浏览器端到端验证。
 *
 * 本机没有 Android SDK、没有 Rust，所以「界面接线」和「multipart 构造」是唯一能真验证
 * 的部分 —— 而它们恰恰是最容易静默出错的地方（DOM 选择器写错、字段名写错、boundary 丢了，
 * 在真机上只表现为「点了没反应」）。这里用 Playwright 起一个真 Chromium，对着 mock 图床
 * 把「分享 → 上传 → 解析直链 → 复制 → 落历史」整条链路跑一遍。
 *
 * 用法：node scripts/verify-web.mjs
 * 可用 PLAYWRIGHT_PATH 指定 playwright 安装位置。
 */

import { createRequire } from 'node:module'
import { startMockTutu } from './mock-tutu.mjs'
import { startStaticServer } from './serve.mjs'

const require = createRequire(import.meta.url)
const PLAYWRIGHT_PATH = process.env.PLAYWRIGHT_PATH || 'd:/code/Motrix/node_modules/playwright'

const checks = []
/** 流程本身没跑完（抛异常）时记在这里，与断言失败区分开。 */
const interruptions = []

function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail })
}

function checkEqual(name, actual, expected) {
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

async function main() {
  let playwright
  try {
    playwright = require(PLAYWRIGHT_PATH)
  } catch (error) {
    console.error(`找不到 Playwright（${PLAYWRIGHT_PATH}）：${error.message}`)
    console.error('设置 PLAYWRIGHT_PATH 指向已安装的 playwright 目录即可。')
    process.exit(2)
  }

  const mock = await startMockTutu({ port: 8787 })
  const web = await startStaticServer({ port: 5173 })

  // 默认用系统自带的 Edge：它和 Android WebView 同为 Chromium 内核，且不需要
  // 下载 Playwright 自带的那份浏览器（本机缓存的版本和 playwright 版本对不上）。
  const channel = process.env.PW_CHANNEL ?? 'msedge'
  const browser = await playwright.chromium.launch({ channel })
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })

  const pageErrors = []
  const page = await context.newPage()
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`)
  })

  try {
    // --- 1. 设置表单能保存 ---------------------------------------------------
    await page.goto(`${web.url}/`)
    await page.click('[data-tab="settings"]')
    await page.fill('#settings-form input[name="key"]', 'KEY123')
    await page.fill('#settings-form input[name="apiHost"]', mock.url)
    await page.fill('#settings-form input[name="cdnHost"]', 'https://t.tutu.to')
    await page.click('#settings-form button[type="submit"]')
    await page.waitForSelector('#toast:not([hidden])')
    checkEqual('设置表单保存后有提示', (await page.textContent('#toast')).trim(), '设置已保存')

    // --- 2. 分享进来 → 自动上传 → 直链推导（v2 通道）------------------------
    await page.goto(`${web.url}/?devShare=/__test/share.png`)
    await page.waitForSelector('#result-list .link', { timeout: 15000 })
    const v2Link = (await page.textContent('#result-list .link')).trim()
    check('v2：从 url_viewer 推导出的直链正确', v2Link === 'https://t.tutu.to/img/mock1', `实际 ${v2Link}`)

    const v2 = mock.record.at(-1)
    checkEqual('v2：打到 /api/2/upload', v2.path, '/api/2/upload')
    check('v2：multipart 带 boundary', v2.boundary.length > 0, `content-type=${v2.contentType}`)
    checkEqual('v2：key 字段正确', v2.fields.key, 'KEY123')
    checkEqual('v2：文件字段名是 source', v2.file?.name, 'source')
    checkEqual('v2：文件名透传', v2.file?.filename, 'share.png')
    checkEqual('v2：Content-Type 用系统给的真实 MIME', v2.file?.contentType, 'image/png')
    check('v2：文件确实有内容', (v2.file?.size ?? 0) > 0, `size=${v2.file?.size}`)
    checkEqual('v2：不存在的 anonymousUpload 不该被发出去', v2.fields.anonymousUpload, undefined)

    // --- 3. 历史里能查到 -----------------------------------------------------
    await page.click('[data-tab="history"]')
    await page.waitForSelector('#history .card')
    checkEqual('历史记录 1 条', await page.locator('#history .card').count(), 1)
    check(
      '历史里的直链与结果一致',
      (await page.textContent('#history .link')).trim() === v2Link
    )

    // --- 4. v3 通道：填 Cookie 后自动切换 ------------------------------------
    await page.click('[data-tab="settings"]')
    await page.fill('#settings-form input[name="cookie"]', 'KEEP_LOGIN=sess-1')
    await page.selectOption('#settings-form select[name="visibility"]', 'unlisted')
    await page.click('#settings-form button[type="submit"]')
    await page.waitForSelector('#toast:not([hidden])')

    await page.goto(`${web.url}/?devShare=/__test/share.png`)
    await page.waitForSelector('#result-list .link', { timeout: 15000 })
    const v3Link = (await page.textContent('#result-list .link')).trim()
    checkEqual('v3：直接用 img_url', v3Link, 'https://t.tutu.to/img/mock2')

    const v3 = mock.record.at(-1)
    checkEqual('v3：打到 /api/v3/uploads', v3.path, '/api/v3/uploads')
    checkEqual('v3：visibility 透传', v3.fields.visibility, 'unlisted')
    check('v3：带 client_upload_id', /^up_/.test(v3.fields.client_upload_id ?? ''), `值=${v3.fields.client_upload_id}`)
    checkEqual('v3：不发 key 字段', v3.fields.key, undefined)
    // 浏览器的 fetch 不允许设置 Cookie 头（forbidden header），所以这里只能断言
    // 「浏览器模式下发不出去」—— 这正是上传最终必须走原生通道的理由之一。
    // Cookie 到底有没有带上，由 test-tutu.mjs 在业务逻辑层断言。
    check(
      'v3：浏览器确实设不了 Cookie 头（已知限制，原生通道不受影响）',
      v3.cookie === '',
      `实际收到 cookie="${v3.cookie}"`
    )

    // --- 5. 错误路径：图床报错要原样显示给用户 --------------------------------
    await page.click('[data-tab="settings"]')
    await page.fill('#settings-form input[name="cookie"]', '')
    await page.fill('#settings-form input[name="key"]', 'bad')
    await page.click('#settings-form button[type="submit"]')
    await page.waitForSelector('#toast:not([hidden])')

    await page.goto(`${web.url}/?devShare=/__test/share.png`)
    await page.waitForSelector('#queue .card[data-status="error"]', { timeout: 15000 })
    const errorText = await page.textContent('#queue .card[data-status="error"] .sub')
    check('错误路径：显示 API Key 无效的原因', errorText.includes('API Key 无效'), `实际：${errorText}`)
    check('错误路径：不显示成功结果', (await page.locator('#result-list .link').count()) === 0)

    // --- 6. 诊断与网络自检面板 -----------------------------------------------
    // 真机出问题时用户拿不到 logcat，所以这个面板是唯一的取证入口，必须验。
    await page.click('[data-tab="settings"]')
    await page.click('#diagnostics > summary')
    await page.waitForSelector('#run-probe', { state: 'visible' })
    await page.click('#run-probe')
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#diagnostics-out')
        return el && el.textContent.includes('网络自检') && el.textContent.includes('HTTPS 请求')
      },
      { timeout: 15000 }
    )

    const diagText = await page.textContent('#diagnostics-out')
    check('诊断面板：带出缓存目录等路径信息', diagText.includes('缓存目录'), diagText.slice(0, 140))
    check(
      '诊断面板：自检包含三步（解析域名 / TCP / HTTPS）',
      diagText.includes('解析域名') && diagText.includes('TCP 连接') && diagText.includes('HTTPS 请求')
    )
    check('诊断面板：带出队列里的错误文案', diagText.includes('API Key 无效'), diagText.slice(-160))

    await page.click('#copy-diagnostics')
    await page.waitForSelector('#toast:not([hidden])')
    checkEqual('复制诊断信息有提示', (await page.textContent('#toast')).trim(), '诊断信息已复制')

    // --- 7. 没有未捕获异常 ---------------------------------------------------
    check('页面无 JS 异常', pageErrors.length === 0, pageErrors.join(' | '))
  } catch (error) {
    // 失败时把现场打出来：这类「界面没反应」的问题只看异常栈是查不出来的。
    console.error(`\n验证中断：${error.message}\n`)
    console.error('--- 页面可见文本 ---')
    console.error(await page.evaluate(() => document.body.innerText).catch(() => '(读取失败)'))
    console.error('--- 队列 DOM ---')
    console.error(await page.evaluate(() => document.querySelector('#queue')?.innerHTML ?? '(无)').catch(() => '(读取失败)'))
    console.error('--- 已保存的配置 ---')
    console.error(await page.evaluate(() => window.localStorage.getItem('picgo-tutu:state')).catch(() => '(读取失败)'))
    console.error('--- mock 收到的请求 ---')
    console.error(JSON.stringify(mock.record, null, 2))
    console.error('--- 页面错误 ---')
    console.error(pageErrors.join('\n') || '(无)')
    problems.push({ name: '流程中断', detail: error.message })
  } finally {
    await browser.close()
    await web.close()
    await mock.close()
  }

  const failed = checks.filter((item) => !item.ok)
  console.log(`\n浏览器端到端：${checks.length - failed.length}/${checks.length} 通过`)
  for (const item of failed) {
    console.error(`  ✗ ${item.name}${item.detail ? ` —— ${item.detail}` : ''}`)
  }
  // 流程中断也必须算失败：否则会打出绿色的对勾，给出一个假的通过信号。
  if (failed.length > 0 || interruptions.length > 0) {
    if (interruptions.length > 0) console.error(`  ✗ 流程未能跑完：${interruptions.join(' | ')}`)
    process.exit(1)
  }
  console.log('✓ 界面接线与 multipart 构造均已验证')
}

await main()

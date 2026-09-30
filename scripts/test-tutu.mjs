#!/usr/bin/env node
/**
 * tutu 业务逻辑的单测。
 *
 * 这些断言存在的理由：Rust 和 Kotlin 在本机都编译不了（没有工具链、没有 SDK），
 * 只有 JS 这一层能在本地跑。把最易错的部分（multipart 字段、v2/v3 两种响应、
 * 直链推导、错误映射）钉在这里，CI 就不必为了这类问题白跑一轮十分钟的构建。
 */

import assert from 'node:assert/strict'
import {
  CHANNEL_V2,
  CHANNEL_V3,
  DEFAULT_CDN_HOST,
  DEFAULT_HOST,
  buildClientUploadId,
  buildUploadRequest,
  guessContentType,
  normalizeCookie,
  normalizeCdnHost,
  normalizeHost,
  normalizeVisibility,
  parseV2Response,
  parseV3Response,
  resolveDirectUrl,
  uploadImage,
  validateConfig
} from '../dist/tutu.js'

let passed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push({ name, error })
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push({ name, error })
  }
}

const baseConfig = { apiHost: '', cdnHost: '', key: 'KEY123', cookie: '', visibility: 'public' }

// --- 归一化 ---------------------------------------------------------------

test('normalizeHost 空值回落默认域名', () => {
  assert.equal(normalizeHost(''), DEFAULT_HOST)
  assert.equal(normalizeHost('   '), DEFAULT_HOST)
  assert.equal(normalizeHost(undefined), DEFAULT_HOST)
})

test('normalizeHost 去掉尾部斜杠', () => {
  assert.equal(normalizeHost('https://tutu.to///'), 'https://tutu.to')
})

test('normalizeCdnHost 空值回落默认 CDN', () => {
  assert.equal(normalizeCdnHost(''), DEFAULT_CDN_HOST)
  assert.equal(normalizeCdnHost('https://t.tutu.to/'), 'https://t.tutu.to')
})

test('normalizeCookie 接受裸值 / 键值对 / 整条 Cookie 头', () => {
  assert.equal(normalizeCookie('abc123'), 'abc123')
  assert.equal(normalizeCookie('KEEP_LOGIN=abc123'), 'abc123')
  assert.equal(normalizeCookie('foo=1; KEEP_LOGIN=abc123; bar=2'), 'abc123')
  assert.equal(normalizeCookie('  '), '')
  assert.equal(normalizeCookie(undefined), '')
})

test('normalizeVisibility 只认 unlisted，其余一律 public', () => {
  assert.equal(normalizeVisibility('unlisted'), 'unlisted')
  assert.equal(normalizeVisibility('unlisted '), 'public')
  assert.equal(normalizeVisibility('private'), 'public')
  assert.equal(normalizeVisibility(undefined), 'public')
})

test('guessContentType 按扩展名，未知回落 octet-stream', () => {
  assert.equal(guessContentType('a.PNG'), 'image/png')
  assert.equal(guessContentType('a.jpg'), 'image/jpeg')
  assert.equal(guessContentType('noext'), 'application/octet-stream')
})

test('buildClientUploadId 形状与网页版一致', () => {
  for (let i = 0; i < 50; i += 1) {
    assert.match(buildClientUploadId(), /^up_[0-9a-z]+_[a-z0-9]{5}$/)
  }
})

// --- 请求构造 -------------------------------------------------------------

test('v2 通道：端点、key 字段、Cookie 不参与', () => {
  const request = buildUploadRequest(baseConfig, { path: '/tmp/a.png', name: 'a.png', size: 10 })
  assert.equal(request.channel, CHANNEL_V2)
  assert.equal(request.url, `${DEFAULT_HOST}/api/2/upload`)
  assert.equal(request.headers.Cookie, undefined)
  assert.deepEqual(request.fields, [{ name: 'key', value: 'KEY123' }])
  assert.equal(request.file.name, 'source')
  assert.equal(request.file.fileName, 'a.png')
})

test('v2 通道：anonymousUpload 为真才发字段，且值是字符串 "1"', () => {
  const off = buildUploadRequest({ ...baseConfig, anonymousUpload: false }, { path: '/a.jpg', name: 'a.jpg' })
  assert.equal(off.fields.some((f) => f.name === 'anonymousUpload'), false)

  const on = buildUploadRequest({ ...baseConfig, anonymousUpload: true }, { path: '/a.jpg', name: 'a.jpg' })
  assert.deepEqual(
    on.fields.find((f) => f.name === 'anonymousUpload'),
    { name: 'anonymousUpload', value: '1' }
  )
})

test('v3 通道：填了 Cookie 就切换，带 Cookie 头与三个字段', () => {
  const request = buildUploadRequest(
    { ...baseConfig, cookie: 'KEEP_LOGIN=xyz', visibility: 'unlisted' },
    { path: '/tmp/a.jpg', name: 'a.jpg', size: 1 }
  )
  assert.equal(request.channel, CHANNEL_V3)
  assert.equal(request.url, `${DEFAULT_HOST}/api/v3/uploads`)
  assert.equal(request.headers.Cookie, 'KEEP_LOGIN=xyz')
  assert.equal(request.fields.find((f) => f.name === 'visibility').value, 'unlisted')
  assert.match(request.fields.find((f) => f.name === 'client_upload_id').value, /^up_/)
  // v3 不发 key
  assert.equal(request.fields.some((f) => f.name === 'key'), false)
})

test('v3 通道：非法 visibility 必须落回 public（否则会误公开用户的图）', () => {
  const request = buildUploadRequest(
    { ...baseConfig, cookie: 'v', visibility: 'secret' },
    { path: '/a.jpg', name: 'a.jpg' }
  )
  assert.equal(request.fields.find((f) => f.name === 'visibility').value, 'public')
})

test('优先使用系统给的真实 MIME，缺失才按扩展名猜', () => {
  const withMime = buildUploadRequest(baseConfig, {
    path: '/a.jpg',
    name: 'a.jpg',
    mimeType: 'image/png'
  })
  assert.equal(withMime.file.mimeType, 'image/png')

  const withoutExt = buildUploadRequest(baseConfig, { path: '/a', name: 'photo' })
  assert.equal(withoutExt.file.mimeType, 'application/octet-stream')
})

test('没有文件名时兜一个带扩展名的名字', () => {
  const request = buildUploadRequest(baseConfig, { path: '/a', mimeType: 'image/webp' })
  assert.match(request.file.fileName, /^tutu-\d+-[a-z0-9]{6}\.webp$/)
})

test('没凭据时构造请求直接抛错，错误信息指导用户怎么填', () => {
  assert.throws(
    () => buildUploadRequest({ ...baseConfig, key: '' }, { path: '/a.jpg', name: 'a.jpg' }),
    /未配置凭据/
  )
})

test('validateConfig 报告使用的通道', () => {
  assert.deepEqual(validateConfig(baseConfig), { ok: true, channel: CHANNEL_V2 })
  assert.equal(validateConfig({ ...baseConfig, cookie: 'x' }).channel, CHANNEL_V3)
  assert.equal(validateConfig({ key: '', cookie: '' }).ok, false)
})

// --- 直链推导 -------------------------------------------------------------

test('resolveDirectUrl 从 url_viewer 推导 CDN 直链', () => {
  const lookup = resolveDirectUrl({ image: { url_viewer: 'https://tutu.to/image/nEcZ' } }, DEFAULT_CDN_HOST)
  assert.equal(lookup.url, `${DEFAULT_CDN_HOST}/img/nEcZ`)
  assert.match(lookup.source, /derived from/)
})

test('resolveDirectUrl 遇到真实直链字段时优先用它', () => {
  const lookup = resolveDirectUrl(
    { image: { display_url: 'https://t.tutu.to/img/aaa', url_viewer: 'https://tutu.to/image/bbb' } },
    DEFAULT_CDN_HOST
  )
  assert.equal(lookup.url, 'https://t.tutu.to/img/aaa')
  assert.equal(lookup.source, 'image.display_url')
})

test('resolveDirectUrl 尊重自定义 cdnHost', () => {
  const lookup = resolveDirectUrl({ url_viewer: 'https://tutu.to/image/xyz' }, 'https://cdn.example.com/')
  assert.equal(lookup.url, 'https://cdn.example.com/img/xyz')
})

test('resolveDirectUrl 认不出时 source 为 none 并带回候选字段', () => {
  const lookup = resolveDirectUrl({ image: { note: 'no url here' } }, DEFAULT_CDN_HOST)
  assert.equal(lookup.url, undefined)
  assert.equal(lookup.source, 'none')
})

// --- v2 响应解读 ----------------------------------------------------------

test('v2 成功：从 url_viewer 推导直链', () => {
  const result = parseV2Response(
    { status: 200, rawBody: JSON.stringify({ status_code: 200, image: { url_viewer: 'https://tutu.to/image/abc' } }) },
    DEFAULT_CDN_HOST
  )
  assert.equal(result.url, `${DEFAULT_CDN_HOST}/img/abc`)
  assert.equal(result.channel, CHANNEL_V2)
})

test('v2 错误码 230 带出「API Key 无效」的提示', () => {
  assert.throws(
    () => parseV2Response({ status: 200, rawBody: JSON.stringify({ error: { code: 230, message: 'bad key' } }) }, DEFAULT_CDN_HOST),
    (error) => error.message.includes('code 230') && error.message.includes('API Key 无效') && error.message.includes('bad key')
  )
})

test('v2 HTTP 500 也算失败', () => {
  assert.throws(
    () => parseV2Response({ status: 500, rawBody: '<html>oops</html>' }, DEFAULT_CDN_HOST),
    /HTTP 500/
  )
})

test('v2 成功但解析不出直链时明确报出来，而不是给个坏链接', () => {
  assert.throws(
    () => parseV2Response({ status: 200, rawBody: JSON.stringify({ image: { foo: 'bar' } }) }, DEFAULT_CDN_HOST),
    /未解析到图片直链/
  )
})

// --- v3 响应解读 ----------------------------------------------------------

test('v3 成功：直接用 img_url', () => {
  const result = parseV3Response({
    status: 200,
    rawBody: JSON.stringify({ ok: true, id: 'x', img_url: 'https://t.tutu.to/img/zzz', visibility: 'unlisted' })
  })
  assert.equal(result.url, 'https://t.tutu.to/img/zzz')
  assert.equal(result.channel, CHANNEL_V3)
  assert.equal(result.visibility, 'unlisted')
})

test('v3 会话失效会静默降级成游客上传，必须识别出来而不是报成功', () => {
  assert.throws(
    () =>
      parseV3Response({
        status: 200,
        rawBody: JSON.stringify({ ok: true, img_url: 'https://t.tutu.to/img/g', guest_session_id: 'guest-1' })
      }),
    /登录态已失效/
  )
})

test('v3 字符串错误码带出提示', () => {
  assert.throws(
    () => parseV3Response({ status: 200, rawBody: JSON.stringify({ code: 'RATE_LIMITED', message: 'slow down' }) }),
    /调用频率超出限制/
  )
})

test('v3 缺 img_url 也算失败', () => {
  assert.throws(() => parseV3Response({ status: 200, rawBody: JSON.stringify({ ok: true }) }), /HTTP 200/)
})

// --- 端到端（假传输层） ---------------------------------------------------

function fakeTransport(response) {
  const calls = []
  return {
    calls,
    async sendMultipart(request) {
      calls.push(request)
      return response
    }
  }
}

await testAsync('uploadImage：v2 全链路把字段交给传输层并回填直链', async () => {
  const transport = fakeTransport({
    status: 200,
    rawBody: JSON.stringify({ image: { url_viewer: 'https://tutu.to/image/e2e' } })
  })

  const result = await uploadImage({
    transport,
    config: baseConfig,
    file: { path: '/tmp/e2e.png', name: 'e2e.png', mimeType: 'image/png', size: 1234 }
  })

  assert.equal(result.url, `${DEFAULT_CDN_HOST}/img/e2e`)
  assert.equal(transport.calls.length, 1)
  const call = transport.calls[0]
  assert.equal(call.url, `${DEFAULT_HOST}/api/2/upload`)
  assert.deepEqual(call.fields, [{ name: 'key', value: 'KEY123' }])
  assert.equal(call.file.path, '/tmp/e2e.png')
  assert.equal(call.file.mimeType, 'image/png')
  assert.equal(call.file.name, 'source')
})

await testAsync('uploadImage：v3 全链路带上 Cookie 头', async () => {
  const transport = fakeTransport({
    status: 200,
    rawBody: JSON.stringify({ ok: true, img_url: 'https://t.tutu.to/img/v3' })
  })

  const result = await uploadImage({
    transport,
    config: { ...baseConfig, cookie: 'KEEP_LOGIN=sess', visibility: 'unlisted' },
    file: { path: '/tmp/v3.jpg', name: 'v3.jpg', size: 10 }
  })

  assert.equal(result.url, 'https://t.tutu.to/img/v3')
  assert.equal(transport.calls[0].headers.Cookie, 'KEEP_LOGIN=sess')
})

await testAsync('uploadImage：没有文件路径时拒绝', async () => {
  const transport = fakeTransport({ status: 200, rawBody: '{}' })
  await assert.rejects(() => uploadImage({ transport, config: baseConfig, file: {} }), /没有可上传的图片数据/)
})

await testAsync('uploadImage：超过 50MB 在发请求之前就拒绝', async () => {
  const transport = fakeTransport({ status: 200, rawBody: '{}' })
  await assert.rejects(
    () =>
      uploadImage({
        transport,
        config: baseConfig,
        file: { path: '/big.jpg', name: 'big.jpg', size: 51 * 1024 * 1024 }
      }),
    /图片过大/
  )
  assert.equal(transport.calls.length, 0, '不该真的发出请求')
})

// --- 汇总 -----------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 个断言失败（通过 ${passed}）\n`)
  for (const { name, error } of failures) {
    console.error(`━━ ${name}`)
    console.error(`${error.message}\n`)
  }
  process.exit(1)
}

console.log(`✓ tutu 业务逻辑单测通过（${passed} 项）`)

/**
 * TUTU 兔兔图床的全部业务逻辑：请求构造、响应解析、直链推导、错误映射。
 *
 * 这个文件是 `picgo-plugin-tutu` 的 Web 移植版，刻意不含任何 Node / DOM API，
 * 因此既能在 WebView 里跑，也能在 Node 里直接 import 做单测。
 *
 * 传输层由外部注入（见 `transport.js`）：Kotlin 插件负责发 multipart 与读文件，
 * 本文件只负责「发什么」和「怎么解读回来的东西」。
 */

export const DEFAULT_HOST = 'https://tutu.to'
export const DEFAULT_CDN_HOST = 'https://t.tutu.to'
export const CDN_IMAGE_PATH = 'img'
export const SESSION_COOKIE_NAME = 'KEEP_LOGIN'

/** API Key 通道：账号上传，永远公开（v2 没有 visibility 参数）。 */
export const UPLOAD_PATH = '/api/2/upload'
/** Cookie 通道：网页版同款接口，是唯一支持 visibility 的通道。 */
export const V3_UPLOAD_PATH = '/api/v3/uploads'

export const VISIBILITY_PUBLIC = 'public'
export const VISIBILITY_UNLISTED = 'unlisted'

/** 单文件上限。原生侧要先把 content:// 拷进缓存，超限直接在拷贝前拒绝。 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024

export const CHANNEL_V2 = 'v2-key'
export const CHANNEL_V3 = 'v3-cookie'

const CONTENT_TYPE_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}

const EXT_BY_CONTENT_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp'
}

/** v2 的文档化错误码（https://tutu.to/docs）。 */
const ERROR_CODE_HINTS = {
  230: 'API Key 无效、缺失或已撤销',
  231: 'API Key 已被禁用，请到设置页重新生成',
  250: '调用频率超出限制（分/时/日三窗口）',
  130: '上传来源无效（文件为空或 URL 抓取失败）',
  500: '服务端内部错误，请稍后重试'
}

/** v3 用的是扁平字符串码，不是 v2 的数字码。 */
const V3_ERROR_HINTS = {
  INVALID_SOURCE: '文件为空或格式无法识别',
  UNSUPPORTED_FORMAT: '不支持的图片格式',
  MISSING_PUBLIC_ID: '服务端未返回图片 ID',
  RATE_LIMITED: '调用频率超出限制，请稍后重试'
}

/**
 * 可选的直链字段名。当前 API 一个都不返回（已在真实端点验证过），但支持它们
 * 的成本极低 —— 万一 TUTU 以后补上就自动生效。`display_url` 是 TUTU 自家网页版
 * 对 `https://t.tutu.to/img/<id>` 的叫法。
 */
const DIRECT_URL_KEYS = [
  'url',
  'display_url',
  'direct_url',
  'url_direct',
  'image_url',
  'public_url',
  'link'
]

export const DEFAULT_CONFIG = {
  apiHost: DEFAULT_HOST,
  cdnHost: DEFAULT_CDN_HOST,
  key: '',
  cookie: '',
  visibility: VISIBILITY_PUBLIC,
  anonymousUpload: false
}

function isRecord (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHttpUrl (value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function safeJsonParse (text) {
  if (isRecord(text)) return text
  if (typeof text !== 'string' || text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function formatBytes (bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function normalizeHost (host) {
  const value = (host ?? '').trim()
  if (!value) return DEFAULT_HOST
  return value.replace(/\/+$/, '')
}

export function normalizeCdnHost (host) {
  const value = (host ?? '').trim()
  if (!value) return DEFAULT_CDN_HOST
  return value.replace(/\/+$/, '')
}

/**
 * 只有 `unlisted` 算不公开。其他任何值都必须显式落回 `public`，
 * 因为服务端对未知值会静默按 `public` 处理。
 */
export function normalizeVisibility (value) {
  return value === VISIBILITY_UNLISTED ? VISIBILITY_UNLISTED : VISIBILITY_PUBLIC
}

/**
 * 接受裸 cookie 值、`KEEP_LOGIN=...` 这种键值对、或整条浏览器 `Cookie:` 头，
 * 统一取出值本身。
 */
export function normalizeCookie (raw) {
  const value = (raw ?? '').trim()
  if (!value) return ''
  const match = value.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;\\s]+)`))
  if (match) return match[1].trim()
  return value
}

export function guessContentType (fileName) {
  const name = fileName ?? ''
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex === -1) return 'application/octet-stream'
  return CONTENT_TYPE_BY_EXT[name.slice(dotIndex).toLowerCase()] ?? 'application/octet-stream'
}

/** 与网页版生成规则一致：`up_<base36 时间>_<5 位随机>`。 */
export function buildClientUploadId () {
  return `up_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`
}

/** 没有原始文件名时兜一个，扩展名从 mime 推。 */
export function buildFileName (name, mimeType) {
  const trimmed = (name ?? '').trim()
  if (trimmed) return trimmed
  const ext = EXT_BY_CONTENT_TYPE[mimeType] ?? '.png'
  return `tutu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
}

/** 有 KEEP_LOGIN 走 v3（唯一能设不公开的通道），否则回落到 v2 API Key。 */
export function selectChannel (config) {
  return normalizeCookie(config?.cookie) ? CHANNEL_V3 : CHANNEL_V2
}

function lastPathSegment (url) {
  const cleaned = url.trim().replace(/[?#].*$/, '').replace(/\/+$/, '')
  const segments = cleaned.split('/')
  const id = segments[segments.length - 1]
  return id || undefined
}

/**
 * 上传响应只带 `url_viewer`（`https://tutu.to/image/<id>`），那是个 HTML 查看页、
 * 不是图片链接。原图在 CDN 上：`https://t.tutu.to/img/<id>`（已验证 HTTP 200 +
 * image/png），所以这里推导出来。如果哪天 API 真返回了直链字段，直链优先。
 */
export function resolveDirectUrl (body, cdnHost) {
  const containers = []
  if (isRecord(body)) {
    if (isRecord(body.image)) containers.push({ scope: 'image', value: body.image })
    if (isRecord(body.data)) containers.push({ scope: 'data', value: body.data })
    containers.push({ scope: 'root', value: body })
  }

  const candidates = []
  for (const { scope, value } of containers) {
    for (const [key, entry] of Object.entries(value)) {
      if (isHttpUrl(entry)) candidates.push(`${scope}.${key}=${entry}`)
    }
  }

  for (const { scope, value } of containers) {
    for (const key of DIRECT_URL_KEYS) {
      if (isHttpUrl(value[key])) {
        return { url: value[key], source: `${scope}.${key}`, candidates }
      }
    }
  }

  const viewerUrl = containers.map(({ value }) => value.url_viewer).find(isHttpUrl)
  if (viewerUrl) {
    const id = lastPathSegment(viewerUrl)
    if (id) {
      const base = normalizeCdnHost(cdnHost)
      return {
        url: `${base}/${CDN_IMAGE_PATH}/${id}`,
        source: `derived from ${viewerUrl}`,
        candidates
      }
    }
  }

  return { source: 'none', candidates }
}

export function validateConfig (config) {
  const channel = selectChannel(config)
  if (channel === CHANNEL_V2 && !(config?.key ?? '').trim()) {
    return {
      ok: false,
      error:
        '[Tutu] 未配置凭据：请填写「登录 Cookie（KEEP_LOGIN）」（推荐，可设不公开）或「API Key」'
    }
  }
  return { ok: true, channel }
}

/**
 * 构造一次上传请求。纯函数、无副作用 —— 单测直接断言这里。
 *
 * 返回的 `file.path` 是原生侧能读到的本地文件路径（content:// 已被拷贝到
 * 应用缓存），实际读取由传输层完成。
 */
export function buildUploadRequest (config, file) {
  const check = validateConfig(config)
  if (!check.ok) throw new Error(check.error)

  const channel = check.channel
  const fileName = buildFileName(file?.name, file?.mimeType)
  // 优先用系统给的真实 MIME：文件名可能没有扩展名，或者扩展名与内容不符
  // （比如截图工具导出成 .jpg 其实是 png），只有拿不到时才按扩展名猜。
  const mimeType = (file?.mimeType ?? '').trim() || guessContentType(fileName)
  // 键名/结构必须与 Rust 侧的 MultipartRequest（serde camelCase）逐字对应：
  //   { url, headers, fields:[{name,value}], file:{name,path,fileName,mimeType}, timeoutMs? }
  // 这里曾经叫 fileField，导致传输层读不到文件 —— 是本机浏览器端到端测试抓出来的。
  const filePart = { name: 'source', path: file.path, fileName, mimeType }

  if (channel === CHANNEL_V3) {
    return {
      channel,
      url: `${normalizeHost(config.apiHost)}${V3_UPLOAD_PATH}`,
      headers: {
        Accept: 'application/json',
        Cookie: `${SESSION_COOKIE_NAME}=${normalizeCookie(config.cookie)}`
      },
      fields: [
        { name: 'client_upload_id', value: buildClientUploadId() },
        // 只发这两个已知值：服务端对未知值会静默变成 public，
        // 那会把用户想藏起来的图暴露出去。
        { name: 'visibility', value: normalizeVisibility(config.visibility) }
      ],
      file: filePart
    }
  }

  const fields = [{ name: 'key', value: (config.key ?? '').trim() }]
  if (config.anonymousUpload) {
    // 可选字段：为 false 时整个省略，而不是发一个假值。
    fields.push({ name: 'anonymousUpload', value: '1' })
  }

  return {
    channel,
    url: `${normalizeHost(config.apiHost)}${UPLOAD_PATH}`,
    headers: { Accept: 'application/json' },
    fields,
    file: filePart
  }
}

/**
 * 解读 v2（API Key）通道的响应。成功时返回直链，失败时抛出带中文解释的错误。
 */
export function parseV2Response (response, cdnHost) {
  const { status, rawBody } = response
  const body = safeJsonParse(rawBody)
  const parsed = isRecord(body) ? body : undefined
  const errorCode = parsed?.error?.code
  const statusCode = parsed?.status_code
  const failed =
    status >= 400 ||
    errorCode !== undefined ||
    (typeof statusCode === 'number' && statusCode >= 400)

  if (failed) {
    const hint = errorCode !== undefined ? ERROR_CODE_HINTS[errorCode] : undefined
    const message = parsed?.error?.message ?? parsed?.success?.message ?? '未知错误'
    const codePart = errorCode !== undefined ? ` code ${errorCode}` : ''
    throw new Error(
      `[Tutu] 上传失败（HTTP ${status}${codePart}）：${message}${hint ? `（${hint}）` : ''}`
    )
  }

  const lookup = resolveDirectUrl(body, cdnHost)
  if (!lookup.url) {
    const seen = lookup.candidates.length > 0 ? lookup.candidates.join(' | ') : '(无 http 字段)'
    throw new Error(
      `[Tutu] 上传成功但未解析到图片直链，请在日志中确认响应字段。候选：${seen}；原始：${String(rawBody).slice(0, 400)}`
    )
  }

  return { url: lookup.url, urlSource: lookup.source, channel: CHANNEL_V2 }
}

/**
 * 解读 v3（Cookie 会话）通道的响应。这个通道直接返回 `img_url`。
 */
export function parseV3Response (response) {
  const { status, rawBody } = response
  const body = safeJsonParse(rawBody)
  const parsed = isRecord(body) ? body : undefined
  const code = typeof parsed?.code === 'string' ? parsed.code : undefined
  const imgUrl = typeof parsed?.img_url === 'string' && parsed.img_url ? parsed.img_url : undefined

  if (status >= 400 || parsed?.ok === false || code !== undefined || !imgUrl) {
    const hint = code !== undefined ? V3_ERROR_HINTS[code] : undefined
    const message = parsed?.message ?? '未知错误'
    const codePart = code !== undefined ? ` ${code}` : ''
    throw new Error(`[Tutu] 上传失败（HTTP ${status}${codePart}）：${message}${hint ? `（${hint}）` : ''}`)
  }

  // 会话失效时会静默降级成游客上传，而且照样返回 200 —— 所以要主动识别，
  // 不能报一个假的成功。
  const guestSession = typeof parsed?.guest_session_id === 'string' ? parsed.guest_session_id : ''
  if (guestSession) {
    throw new Error(
      '[Tutu] 登录态已失效（KEEP_LOGIN 无效或已过期），本次被当作游客上传（7 天后可能失效）。' +
        `请在浏览器重新登录并重新获取 cookie。已产生的游客图：${imgUrl}`
    )
  }

  return {
    url: imgUrl,
    urlSource: 'img_url',
    channel: CHANNEL_V3,
    visibility: typeof parsed?.visibility === 'string' ? parsed.visibility : undefined
  }
}

/**
 * 完整的一次上传：构造请求 → 交给传输层 → 解读响应。
 *
 * @param {{ sendMultipart: (req: object) => Promise<{status: number, rawBody: string}> }} transport
 */
export async function uploadImage ({ transport, config, file, onProgress }) {
  if (!file?.path) {
    throw new Error('[Tutu] 没有可上传的图片数据')
  }
  if (Number.isFinite(file.size) && file.size > MAX_FILE_BYTES) {
    throw new Error(
      `[Tutu] 图片过大（${formatBytes(file.size)}），上限 ${formatBytes(MAX_FILE_BYTES)}`
    )
  }

  const request = buildUploadRequest(config, file)
  const response = await transport.sendMultipart(request, onProgress)

  return request.channel === CHANNEL_V3
    ? { ...parseV3Response(response), channel: CHANNEL_V3 }
    : { ...parseV2Response(response, config.cdnHost), channel: CHANNEL_V2 }
}

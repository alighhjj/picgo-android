/**
 * 传输层：把「原生能力」封在一个薄接口后面。
 *
 * 原生（Tauri / Android）：走 Rust 命令。没有 CORS 限制，也能自由设置 Cookie 头。
 * 浏览器（本机调试）：退化成 fetch + FormData + localStorage，用来对着 mock 图床
 * 把整条业务链路跑通 —— 除了原生传输本身，其余代码路径完全一致。
 */

const ERROR_PREFIX = '[Tauri]'

function hasTauri() {
  return typeof window !== 'undefined' && typeof window.__TAURI__?.core?.invoke === 'function'
}

function invoke(command, args) {
  return window.__TAURI__.core.invoke(command, args)
}

/**
 * 浏览器调试用的「假分享」入口：`?devShare=<url>` 会被当成一张刚分享进来的图片。
 * 这样在没有真机、没有 Android SDK 的情况下也能验证「分享 → 上传 → 复制」。
 */
function mimeFromUrl(url) {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'bmp') return 'image/bmp'
  return 'image/jpeg'
}

function devShareFiles() {
  if (hasTauri() || typeof window === 'undefined') return []
  const raw = new URLSearchParams(window.location.search).get('devShare')
  if (!raw) return []
  return raw.split(',').map((url, index) => ({
    path: url,
    name: decodeURIComponent(url.split('/').pop() || `dev-${index}.jpg`),
    mime: mimeFromUrl(url),
    // 大小未知，交给真实读取；界面会显示「大小未知」而不是编一个数字。
    size: 0
  }))
}

async function blobFromUrl(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`读取本地文件失败：HTTP ${response.status}`)
  return response.blob()
}

async function blobToDataUrl(blob) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取文件内容失败'))
    reader.readAsDataURL(blob)
  })
}

const nativeTransport = {
  kind: 'native',

  async sendMultipart(request) {
    return await invoke('send_multipart', { request })
  },

  async takePendingShare() {
    return await invoke('take_pending_share')
  },

  async readFileDataUrl(path) {
    return await invoke('read_file_data_url', { path })
  },

  async readState() {
    return await invoke('read_state')
  },

  async writeState(json) {
    await invoke('write_state', { json })
  },

  async copyText(text) {
    // 官方剪贴板插件。没引它的 JS 包，直接打命令名，省掉打包步骤。
    await invoke('plugin:clipboard-manager|write_text', { text })
  },

  async debugPaths() {
    return await invoke('debug_paths')
  }
}

const webTransport = {
  kind: 'web',

  /**
   * 浏览器里用标准 FormData 发。注意这条路径**不能**用来验证 tutu：
   * tutu 不发 CORS 头，浏览器直连必被拦。它只用来对着本机 mock 图床跑通链路。
   */
  async sendMultipart(request) {
    const form = new FormData()
    for (const field of request.fields) form.append(field.name, field.value)

    const blob = await blobFromUrl(request.file.path)
    form.append(request.file.name, blob, request.file.fileName)

    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: form
    })
    return { status: response.status, rawBody: await response.text() }
  },

  async takePendingShare() {
    return devShareFiles()
  },

  async readFileDataUrl(path) {
    return await blobToDataUrl(await blobFromUrl(path))
  },

  async readState() {
    return window.localStorage.getItem('picgo-tutu:state') || ''
  },

  async writeState(json) {
    window.localStorage.setItem('picgo-tutu:state', json)
  },

  async copyText(text) {
    if (!navigator.clipboard) throw new Error('当前环境没有剪贴板权限')
    await navigator.clipboard.writeText(text)
  },

  async debugPaths() {
    return {
      cacheDir: '(浏览器调试模式)',
      dataDir: '(浏览器调试模式，配置存在 localStorage)',
      pendingSharePath: '(浏览器调试模式，用 ?devShare=<url> 模拟分享)',
      pendingShareExists: devShareFiles().length > 0
    }
  }
}

export function createTransport() {
  return hasTauri() ? nativeTransport : webTransport
}

export function transportLabel(transport) {
  return transport.kind === 'native' ? 'Android 原生' : '浏览器调试'
}

export { ERROR_PREFIX }

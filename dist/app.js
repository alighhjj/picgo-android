/**
 * 界面与流程编排。业务规则在 tutu.js，平台能力在 transport.js，这里只把它们串起来。
 *
 * 主流程：分享进来 → 取队列 → 自动上传 → 复制直链 → 落历史。
 */

import { createTransport, transportLabel } from './transport.js'
import { loadState, saveState, pushHistory } from './storage.js'
import {
  CHANNEL_V3,
  MAX_FILE_BYTES,
  VISIBILITY_PUBLIC,
  VISIBILITY_UNLISTED,
  formatBytes,
  selectChannel,
  uploadImage,
  validateConfig
} from './tutu.js'

const transport = createTransport()

let state = { config: {}, history: [] }
let queue = []
let busy = false
let seq = 0

const dom = {
  tabs: [...document.querySelectorAll('[data-tab]')],
  views: [...document.querySelectorAll('[data-view]')],
  transport: document.querySelector('#transport-label'),
  queue: document.querySelector('#queue'),
  queueEmpty: document.querySelector('#queue-empty'),
  uploadAll: document.querySelector('#upload-all'),
  clearQueue: document.querySelector('#clear-queue'),
  resultEmpty: document.querySelector('#result-empty'),
  resultList: document.querySelector('#result-list'),
  history: document.querySelector('#history'),
  historyEmpty: document.querySelector('#history-empty'),
  historyCount: document.querySelector('#history-count'),
  settingsForm: document.querySelector('#settings-form'),
  settingsHint: document.querySelector('#settings-hint'),
  diagnostics: document.querySelector('#diagnostics'),
  diagnosticsOut: document.querySelector('#diagnostics-out'),
  toast: document.querySelector('#toast')
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function showToast(message, tone = 'ok') {
  dom.toast.textContent = message
  dom.toast.dataset.tone = tone
  dom.toast.hidden = false
  window.clearTimeout(showToast.timer)
  showToast.timer = window.setTimeout(() => {
    dom.toast.hidden = true
  }, 3200)
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

function switchTab(name) {
  for (const tab of dom.tabs) tab.classList.toggle('is-active', tab.dataset.tab === name)
  for (const view of dom.views) view.hidden = view.dataset.view !== name
}

async function copyLink(url) {
  try {
    await transport.copyText(url)
    showToast('直链已复制')
  } catch (error) {
    console.error('复制失败', error)
    showToast('复制失败，请长按链接手动复制', 'warn')
  }
}

// ---------------------------------------------------------------------------
// 待上传队列
// ---------------------------------------------------------------------------

function renderQueue() {
  dom.queueEmpty.hidden = queue.length > 0
  dom.uploadAll.disabled = busy || queue.length === 0
  dom.clearQueue.hidden = queue.length === 0
  dom.queue.replaceChildren(...queue.map(renderQueueItem))
}

function renderQueueItem(item) {
  const row = document.createElement('div')
  row.className = 'card row'
  row.dataset.status = item.status

  const thumb = document.createElement('div')
  thumb.className = 'thumb'
  if (item.previewUrl) {
    const img = document.createElement('img')
    img.src = item.previewUrl
    img.alt = ''
    thumb.append(img)
  } else {
    thumb.textContent = '🖼'
  }

  const meta = document.createElement('div')
  meta.className = 'grow'
  const name = document.createElement('p')
  name.className = 'name'
  name.textContent = item.name
  const status = document.createElement('p')
  status.className = 'sub'
  status.textContent = describeStatus(item)
  meta.append(name, status)

  row.append(thumb, meta)
  return row
}

function describeStatus(item) {
  const size = item.size > 0 ? formatBytes(item.size) : '大小未知'
  switch (item.status) {
    case 'uploading':
      return `${size} · ${item.stage ?? '上传中…'}`
    case 'done':
      return `${size} · 已上传，直链已复制`
    case 'error':
      return `${size} · ${item.error}`
    default:
      return `${size} · 等待上传`
  }
}

async function enqueue(files) {
  const added = []
  for (const file of files) {
    // 同一个路径已经在队列里就别重复加（分享队列在冷/热启动间可能被读两次）。
    if (queue.some((item) => item.path === file.path)) continue

    const item = {
      id: ++seq,
      path: file.path,
      name: file.name || 'shared.jpg',
      mimeType: file.mime || 'image/jpeg',
      size: Number(file.size) || 0,
      status: 'pending',
      error: '',
      stage: '',
      url: ''
    }
    queue.push(item)
    added.push(item)
  }

  if (added.length > 0) {
    renderQueue()
    for (const item of added) {
      if (item.size > MAX_FILE_BYTES) {
        item.status = 'error'
        item.error = `超过 ${formatBytes(MAX_FILE_BYTES)} 上限`
        continue
      }
      try {
        item.previewUrl = await transport.readFileDataUrl(item.path)
      } catch {
        // 预览失败不影响上传，只是没有缩略图。
      }
    }
    renderQueue()
  }

  return added
}

/**
 * 冷启动时 Kotlin 是同步拷文件的，但热启动/系统延迟等情况下文件可能晚一点才落地，
 * 所以这里重试几次再放弃。取不到就退出，不无限轮询。
 */
async function refreshPendingShare() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const files = await transport.takePendingShare()
    if (files.length > 0) {
      const added = await enqueue(files)
      switchTab('upload')
      if (added.length > 0 && validateConfig(state.config).ok) {
        await uploadAll()
      }
      return added.length
    }
    await new Promise((resolve) => window.setTimeout(resolve, 400))
  }
  return 0
}

async function uploadAll() {
  if (busy) return
  const check = validateConfig(state.config)
  if (!check.ok) {
    showToast('先在「设置」里填好凭据', 'warn')
    switchTab('settings')
    return
  }

  busy = true
  dom.uploadAll.disabled = true
  let succeeded = 0

  for (const item of queue) {
    if (item.status === 'done') continue

    item.status = 'uploading'
    item.error = ''
    item.stage = '正在上传…'
    renderQueue()

    try {
      const result = await uploadImage({
        transport,
        config: state.config,
        file: { path: item.path, name: item.name, mimeType: item.mimeType, size: item.size }
      })

      item.status = 'done'
      item.url = result.url
      item.stage = ''
      succeeded += 1

      pushHistory(state, {
        url: result.url,
        name: item.name,
        size: item.size,
        at: Date.now(),
        channel: result.channel,
        visibility: result.visibility
      })

      await copyLink(result.url)
    } catch (error) {
      item.status = 'error'
      item.stage = ''
      // tutu.js 抛出来的已经是给人看的中文说明，直接用。
      item.error = error?.message ?? String(error)
    }
    renderQueue()
  }

  busy = false
  try {
    await saveState(transport, state)
  } catch (error) {
    showToast(`历史保存失败：${error?.message ?? error}`, 'warn')
  }
  renderHistory()
  renderUploadResult()
  renderQueue()
  if (succeeded > 0) switchTab('result')
}

function renderUploadResult() {
  const done = queue.filter((item) => item.status === 'done')
  // 只切换「空状态」的显隐，不能去动视图本身的 hidden —— 那是 switchTab 管的，
  // 两边都写 hidden 会互相覆盖。
  dom.resultEmpty.hidden = done.length > 0
  if (done.length === 0) {
    dom.resultList.replaceChildren()
    return
  }

  dom.resultList.replaceChildren(
    ...done.map((item) => {
      const card = document.createElement('div')
      card.className = 'card'

      const link = document.createElement('a')
      link.className = 'link'
      link.href = item.url
      link.target = '_blank'
      link.rel = 'noreferrer'
      link.textContent = item.url

      const actions = document.createElement('div')
      actions.className = 'actions'
      const copy = document.createElement('button')
      copy.type = 'button'
      copy.textContent = '复制直链'
      copy.addEventListener('click', () => copyLink(item.url))
      actions.append(copy)

      card.append(link, actions)
      return card
    })
  )
}

// ---------------------------------------------------------------------------
// 历史
// ---------------------------------------------------------------------------

function renderHistory() {
  dom.historyCount.textContent = state.history.length > 0 ? `共 ${state.history.length} 条` : ''
  dom.historyEmpty.hidden = state.history.length > 0
  dom.history.replaceChildren(...state.history.map(renderHistoryItem))
}

function renderHistoryItem(entry) {
  const card = document.createElement('div')
  card.className = 'card'

  const head = document.createElement('div')
  head.className = 'row'
  const thumb = document.createElement('img')
  thumb.className = 'thumb'
  thumb.src = entry.url
  thumb.alt = ''
  thumb.loading = 'lazy'
  const meta = document.createElement('div')
  meta.className = 'grow'
  const name = document.createElement('p')
  name.className = 'name'
  name.textContent = entry.name
  const sub = document.createElement('p')
  sub.className = 'sub'
  sub.textContent = `${formatTime(entry.at)} · ${formatBytes(entry.size)} · ${
    entry.channel === CHANNEL_V3 ? 'Cookie 通道' : 'API Key 通道'
  }`
  meta.append(name, sub)
  head.append(thumb, meta)

  const link = document.createElement('a')
  link.className = 'link'
  link.href = entry.url
  link.target = '_blank'
  link.rel = 'noreferrer'
  link.textContent = entry.url

  const actions = document.createElement('div')
  actions.className = 'actions'
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = '复制'
  copy.addEventListener('click', () => copyLink(entry.url))
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'ghost'
  remove.textContent = '删除'
  remove.addEventListener('click', async () => {
    state.history = state.history.filter((item) => item.url !== entry.url)
    await saveState(transport, state)
    renderHistory()
  })
  actions.append(copy, remove)

  card.append(head, link, actions)
  return card
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

function renderSettings() {
  const form = dom.settingsForm
  form.apiHost.value = state.config.apiHost
  form.cdnHost.value = state.config.cdnHost
  form.key.value = state.config.key
  form.cookie.value = state.config.cookie
  form.visibility.value = state.config.visibility
  form.anonymousUpload.checked = Boolean(state.config.anonymousUpload)
  updateSettingsHint()
}

function updateSettingsHint() {
  const channel = selectChannel(state.config)
  const lines = []
  if (channel === CHANNEL_V3) {
    lines.push('当前走「登录 Cookie」通道：支持设为不公开，图片保存在账号下。')
  } else {
    lines.push('当前走「API Key」通道：只能公开上传。填了 Cookie 就会自动切到 Cookie 通道。')
  }
  lines.push(
    'Cookie 获取：浏览器登录 tutu.to → F12 → Application → Cookies → 复制 KEEP_LOGIN 的值。'
  )
  lines.push('API Key 获取：https://tutu.to/settings?tab=api')
  dom.settingsHint.textContent = lines.join('\n')
}

async function onSubmitSettings(event) {
  event.preventDefault()
  const form = dom.settingsForm
  state.config = {
    apiHost: form.apiHost.value.trim(),
    cdnHost: form.cdnHost.value.trim(),
    key: form.key.value.trim(),
    cookie: form.cookie.value.trim(),
    visibility: form.visibility.value === VISIBILITY_UNLISTED ? VISIBILITY_UNLISTED : VISIBILITY_PUBLIC,
    anonymousUpload: form.anonymousUpload.checked
  }
  try {
    await saveState(transport, state)
    updateSettingsHint()
    showToast('设置已保存')
  } catch (error) {
    showToast(`保存失败：${error?.message ?? error}`, 'warn')
  }
}

// ---------------------------------------------------------------------------
// 诊断
// ---------------------------------------------------------------------------

async function runDiagnostics() {
  try {
    const info = await transport.debugPaths()
    const check = validateConfig(state.config)
    dom.diagnosticsOut.textContent = [
      `运行环境：${transportLabel(transport)}`,
      `缓存目录：${info.cacheDir}`,
      `数据目录：${info.dataDir}`,
      `分享队列文件：${info.pendingSharePath}`,
      `队列文件存在：${info.pendingShareExists ? '是' : '否'}`,
      `凭据：${check.ok ? `已配置（${check.channel}）` : '未配置'}`,
      `队列中待上传：${queue.length} 张`,
      `历史记录：${state.history.length} 条`
    ].join('\n')
  } catch (error) {
    dom.diagnosticsOut.textContent = `诊断失败：${error?.message ?? error}`
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function init() {
  dom.transport.textContent = transportLabel(transport)

  state = await loadState(transport)
  renderSettings()
  renderHistory()
  renderQueue()
  renderUploadResult()

  for (const tab of dom.tabs) {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab))
  }
  dom.uploadAll.addEventListener('click', uploadAll)
  dom.clearQueue.addEventListener('click', () => {
    queue = []
    renderQueue()
    renderUploadResult()
  })
  dom.settingsForm.addEventListener('submit', onSubmitSettings)
  dom.settingsForm.addEventListener('input', () => {
    // 让提示里的「当前通道」随输入即时变化，不用等保存。
    updateSettingsHint()
  })
  dom.diagnostics.addEventListener('toggle', () => {
    if (dom.diagnostics.open) runDiagnostics()
  })

  await refreshPendingShare()

  // 热启动：App 已在运行时又分享进来一张，系统会把它带到前台。
  if (typeof window.__TAURI__?.event?.listen === 'function') {
    window.__TAURI__.event.listen('tauri://focus', () => {
      refreshPendingShare().catch((error) => console.error('读取分享队列失败', error))
    })
  }

  if (queue.length === 0) {
    switchTab(validateConfig(state.config).ok ? 'upload' : 'settings')
  }
}

init().catch((error) => {
  console.error('初始化失败', error)
  showToast(`初始化失败：${error?.message ?? error}`, 'warn')
})

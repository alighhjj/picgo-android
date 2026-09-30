#!/usr/bin/env node
/**
 * 假图床：收 multipart，按 tutu 的响应形状回包。
 *
 * 存在的理由：tutu 不发 CORS 头，浏览器直连必被拦，所以「分享 → 上传 → 解析 → 复制」
 * 这条链路没法对着真站验证。这个 mock 让整条链路（除了原生传输本身）都能在本机跑通，
 * 并且把收到的 multipart 原样记录下来 —— 这是验证「字段名、文件名、Content-Type、
 * boundary 都对」的唯一办法。
 *
 * 触发错误的约定（方便验证错误路径）：
 *   key=bad        → v2 回 code 230（API Key 无效）
 *   Cookie 含 expired → v3 回 guest_session_id（登录态失效）
 *
 * 单独跑：node scripts/mock-tutu.mjs   （默认 8787 端口）
 */

import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

/** 轻量 multipart 解析：只取我们需要断言的东西，不做完整实现。 */
function parseMultipart(rawBody, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '')
  const boundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? '').trim()
  if (!boundary) return { boundary: '', fields: {}, file: null }

  // 用 latin1 转字符串：字节偏移与字符串下标 1:1，长度即字节数。
  const text = rawBody.toString('latin1')
  const segments = text.split(`--${boundary}`)

  const fields = {}
  let file = null

  for (const segment of segments) {
    const headerEnd = segment.indexOf('\r\n\r\n')
    if (headerEnd < 0) continue

    const headers = segment.slice(0, headerEnd)
    let body = segment.slice(headerEnd + 4)
    // 每个 part 结尾自带 \r\n（最后一个还多一个 --）
    if (body.endsWith('\r\n')) body = body.slice(0, -2)
    if (body.endsWith('--')) body = body.slice(0, -2)

    const disposition = /content-disposition:\s*form-data;\s*name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(headers)
    if (!disposition) continue

    const name = disposition[1]
    const filename = disposition[2]
    const partType = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? ''

    if (filename !== undefined) {
      file = { name, filename, contentType: partType, size: body.length }
    } else {
      fields[name] = body
    }
  }

  return { boundary, fields, file }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

let counter = 0

function createHandler(record) {
  return async (request, response) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors)
      response.end()
      return
    }

    const body = await readBody(request)
    const contentType = request.headers['content-type'] ?? ''
    const parsed = parseMultipart(body, contentType)
    const id = `mock${(counter += 1).toString(36)}`

    record.push({
      path: request.url,
      cookie: request.headers.cookie ?? '',
      accept: request.headers.accept ?? '',
      contentType,
      boundary: parsed.boundary,
      fields: parsed.fields,
      file: parsed.file,
      bytes: body.length
    })

    const json = (payload) => {
      response.writeHead(200, { ...cors, 'Content-Type': 'application/json' })
      response.end(JSON.stringify(payload))
    }

    // 根路径给个正常响应：网络自检会打这里，回 404 会在浏览器控制台留下
    // "Failed to load resource: 404"，被端到端测试当成页面异常。
    if (request.url === '/' || request.url === '') {
      json({ service: 'mock-tutu', hint: '把「API 域名」填成本地址即可' })
      return
    }

    if (request.url?.startsWith('/api/2/upload')) {
      if (parsed.fields.key === 'bad') {
        json({ error: { code: 230, message: 'Invalid API key' } })
        return
      }
      json({
        status_code: 200,
        image: {
          // 真实 API 只给这个 HTML 查看页，直链要靠 CDN 域名推导。
          url_viewer: `https://tutu.to/image/${id}`
        }
      })
      return
    }

    if (request.url?.startsWith('/api/v3/uploads')) {
      if ((request.headers.cookie ?? '').includes('expired')) {
        json({ ok: true, img_url: `https://t.tutu.to/img/${id}`, guest_session_id: 'guest-1' })
        return
      }
      json({
        ok: true,
        id,
        img_url: `https://t.tutu.to/img/${id}`,
        visibility: parsed.fields.visibility ?? 'public'
      })
      return
    }

    response.writeHead(404, cors)
    response.end('not found')
  }
}

export function startMockTutu({ port = 8787 } = {}) {
  const record = []
  const server = createServer(createHandler(record))

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        record,
        close: () => new Promise((done) => server.close(done))
      })
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mock = await startMockTutu({ port: Number(process.env.PORT) || 8787 })
  console.log(`mock tutu 已启动：${mock.url}`)
  console.log('把应用里的「API 域名」填成上面这个地址即可（浏览器调试模式）')
}

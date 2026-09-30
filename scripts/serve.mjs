#!/usr/bin/env node
/**
 * 本机静态服务器：把 dist/ 跑起来，用于在浏览器里验证界面与整条上传链路。
 *
 * 顺带提供一个测试图片 `/__test/share.png`，配合 `?devShare=` 就能在没有真机的情况下
 * 模拟「从相册分享一张图进来」。
 *
 * 用法：
 *   终端 1: node scripts/mock-tutu.mjs
 *   终端 2: node scripts/serve.mjs
 *   浏览器: http://localhost:5173/?devShare=/__test/share.png
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const FIXTURES = join(ROOT, 'scripts', 'fixtures')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
}

export function startStaticServer({ port = 5173 } = {}) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`)

    if (url.pathname === '/favicon.ico') {
      // 浏览器会自动来要图标；回 204 而不是 404，免得在验证时被当成页面错误。
      response.writeHead(204)
      response.end()
      return
    }

    if (url.pathname === '/__test/share.png' || url.pathname === '/__test/share-large.png') {
      // 大图专门用来验布局：预览若没约束尺寸，它会把卡片撑变形。
      const name = url.pathname.endsWith('share-large.png') ? 'dev-share-large.png' : 'dev-share.png'
      const png = await readFile(join(FIXTURES, name))
      response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
      response.end(png)
      return
    }

    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
    // 防路径穿越：规范化后必须仍在 dist/ 内。
    const target = normalize(join(DIST, relative))
    if (!target.startsWith(DIST)) {
      response.writeHead(403)
      response.end('forbidden')
      return
    }

    try {
      const content = await readFile(target)
      response.writeHead(200, {
        'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store'
      })
      response.end(content)
    } catch {
      response.writeHead(404)
      response.end('not found')
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done))
      })
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 5173
  const server = await startStaticServer({ port })
  console.log(`界面已启动：${server.url}`)
  console.log(`模拟分享一张图：${server.url}/?devShare=/__test/share.png`)
  console.log('（记得另一个终端先跑 node scripts/mock-tutu.mjs，并把「API 域名」填成它的地址）')
}

#!/usr/bin/env bun

import path from 'path'
import { existsSync, watch } from 'fs'
import { DeskHost } from './server/desk-host.js'
import {
  clearScannerBounds,
  detectScannerDocument,
  getScannerRuntimeConfig,
  saveScannerBounds,
  scanScannerDocument,
} from './services/scanner.js'
import type { ServerMessage } from './ui/shared/protocol.js'

const args = process.argv.slice(2)
const debounceMs = (() => {
  const idx = args.indexOf('--debounce')
  return idx !== -1 ? parseInt(args[idx + 1] ?? '2000', 10) : 2000
})()
const logLevel = args.includes('--verbose') ? 'verbose' : 'normal'
const isDev = args.includes('--dev')
const port = (() => {
  const fromEnv = process.env.DESK_PORT
  if (fromEnv) return Number.parseInt(fromEnv, 10)
  const idx = args.indexOf('--port')
  return idx !== -1 ? parseInt(args[idx + 1] ?? '4312', 10) : 4312
})()

const host = new DeskHost({ debounceMs, logLevel: logLevel as 'normal' | 'verbose' | 'silent' })
const BunRuntime = Bun as any

const webEntry = path.join(import.meta.dirname, 'ui', 'web', 'main.tsx')
const webBuildDir = path.join(import.meta.dirname, '.web-build')

async function buildWebAssets() {
  const result = await BunRuntime.build({
    entrypoints: [webEntry],
    outdir: webBuildDir,
    target: 'browser',
    sourcemap: 'none',
    minify: false,
    naming: 'assets/[name].[ext]',
  })
  if (!result.success) {
    const log = (result.logs as Array<{ message: string }>).map((entry) => entry.message).join('\n')
    throw new Error(`Web asset build failed:\n${log}`)
  }
}

function html(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Seashell Desk</title>
    <link rel="stylesheet" href="/assets/main.css" />
    <script type="module" src="/assets/main.js"></script>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>`
}

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.js') return 'text/javascript; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.map') return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

function logServer(message: string): void {
  process.stderr.write(`[desk-server] ${message}\n`)
}

function parseScannerQuad(raw: string): [[number, number], [number, number], [number, number], [number, number]] {
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed) || parsed.length != 4) {
    throw new Error('quad must be a JSON array of four [x, y] points')
  }

  const points = parsed.map((point) => {
    if (!Array.isArray(point) || point.length !== 2 || !point.every((value) => typeof value === 'number')) {
      throw new Error('quad points must be numeric [x, y] pairs')
    }
    return [
      Math.max(0, Math.min(1, point[0] as number)),
      Math.max(0, Math.min(1, point[1] as number)),
    ] as [number, number]
  })

  return points as [[number, number], [number, number], [number, number], [number, number]]
}

await buildWebAssets()
host.start()
const scannerRuntime = getScannerRuntimeConfig()
logServer(`Scanner config gemini_fallback_threshold=${scannerRuntime.geminiFallbackThreshold}`)

const server = BunRuntime.serve({
  port,
  fetch(req: Request, bunServer: any) {
    const url = new URL(req.url)

    if (url.pathname === '/ws') {
      if (bunServer.upgrade(req, { data: { connectedAt: Date.now() } })) {
        return new Response(null)
      }
      return new Response('Upgrade failed', { status: 400 })
    }

    if (url.pathname === '/api/snapshot' && req.method === 'GET') {
      return jsonResponse(host.getSnapshot())
    }

    if (url.pathname === '/api/message' && req.method === 'POST') {
      return req.json()
        .then((body: unknown) => {
          if (typeof body !== 'object' || body === null) {
            return new Response('Invalid body', { status: 400 })
          }
          const { agentRelPath, message } = body as { agentRelPath?: unknown; message?: unknown }
          if (typeof agentRelPath !== 'string' || typeof message !== 'string') {
            return new Response('agentRelPath and message are required', { status: 400 })
          }
          host.sendMessage(agentRelPath, message)
          return jsonResponse({ ok: true })
        })
        .catch(() => new Response('Invalid JSON', { status: 400 }))
    }

    if (url.pathname === '/api/input/photo' && req.method === 'POST') {
      return req.formData()
        .then(async (formData) => {
          const photo = formData.get('photo')
          const filenameBase = formData.get('filenameBase')

          if (!(photo instanceof File)) {
            return new Response('photo is required', { status: 400 })
          }
          if (photo.size === 0) {
            return new Response('photo must not be empty', { status: 400 })
          }

          const bytes = new Uint8Array(await photo.arrayBuffer())
          const saved = host.saveInputFile(bytes, {
            filenameBase: typeof filenameBase === 'string' ? filenameBase : undefined,
            extension: photo.type === 'image/png' ? 'png' : 'jpg',
          })
          return jsonResponse(saved)
        })
        .catch(() => new Response('Invalid form data', { status: 400 }))
    }

    if (url.pathname === '/api/scanner/detect' && req.method === 'POST') {
      const requestId = crypto.randomUUID().slice(0, 8)
      const startedAt = Date.now()
      logServer(`[scanner-detect:${requestId}] request received`)
      return req.formData()
        .then(async (formData) => {
          const photo = formData.get('photo')
          if (!(photo instanceof File)) {
            logServer(`[scanner-detect:${requestId}] invalid request: missing photo file`)
            return new Response('photo is required', { status: 400 })
          }
          if (photo.size === 0) {
            logServer(`[scanner-detect:${requestId}] invalid request: empty photo`)
            return new Response('photo must not be empty', { status: 400 })
          }

          const mimeType = photo.type || 'image/jpeg'
          const bytes = new Uint8Array(await photo.arrayBuffer())
          logServer(`[scanner-detect:${requestId}] processing mime=${mimeType} bytes=${bytes.byteLength}`)
          const detection = await detectScannerDocument(bytes, mimeType)
          logServer(`[scanner-detect:${requestId}] success source=${detection.source} confidence=${detection.confidence.toFixed(3)} elapsed_ms=${Date.now() - startedAt}`)
          return jsonResponse(detection)
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          logServer(`[scanner-detect:${requestId}] failure elapsed_ms=${Date.now() - startedAt} error=${message}`)
          return new Response(message || 'Document detection failed', { status: 500 })
        })
    }

    if (url.pathname === '/api/scanner/scan' && req.method === 'POST') {
      const requestId = crypto.randomUUID().slice(0, 8)
      const startedAt = Date.now()
      logServer(`[scanner-scan:${requestId}] request received`)
      return req.formData()
        .then(async (formData) => {
          const photo = formData.get('photo')
          const quadRaw = formData.get('quad')

          if (!(photo instanceof File)) {
            return new Response('photo is required', { status: 400 })
          }
          if (typeof quadRaw !== 'string') {
            return new Response('quad is required', { status: 400 })
          }
          const quad = parseScannerQuad(quadRaw)
          const mimeType = photo.type || 'image/jpeg'
          const bytes = new Uint8Array(await photo.arrayBuffer())
          logServer(`[scanner-scan:${requestId}] processing mime=${mimeType} bytes=${bytes.byteLength}`)
          const result = scanScannerDocument(bytes, mimeType, quad)
          logServer(`[scanner-scan:${requestId}] success width=${result.width} height=${result.height} elapsed_ms=${Date.now() - startedAt}`)
          return jsonResponse(result)
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          logServer(`[scanner-scan:${requestId}] failure elapsed_ms=${Date.now() - startedAt} error=${message}`)
          return new Response(message || 'Document scan failed', { status: 500 })
        })
    }

    if (url.pathname === '/api/scanner/save-bounds' && req.method === 'POST') {
      const requestId = crypto.randomUUID().slice(0, 8)
      const startedAt = Date.now()
      logServer(`[scanner-bounds:${requestId}] request received`)
      return req.formData()
        .then(async (formData) => {
          const photo = formData.get('photo')
          const quadRaw = formData.get('quad')

          if (!(photo instanceof File)) {
            return new Response('photo is required', { status: 400 })
          }
          if (typeof quadRaw !== 'string') {
            return new Response('quad is required', { status: 400 })
          }

          const quad = parseScannerQuad(quadRaw)
          const mimeType = photo.type || 'image/jpeg'
          const bytes = new Uint8Array(await photo.arrayBuffer())
          const result = saveScannerBounds(bytes, mimeType, quad)
          logServer(`[scanner-bounds:${requestId}] saved elapsed_ms=${Date.now() - startedAt}`)
          return jsonResponse(result)
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          logServer(`[scanner-bounds:${requestId}] failure elapsed_ms=${Date.now() - startedAt} error=${message}`)
          return new Response(message || 'Saving scanner bounds failed', { status: 500 })
        })
    }

    if (url.pathname === '/api/scanner/clear-bounds' && req.method === 'POST') {
      const requestId = crypto.randomUUID().slice(0, 8)
      const startedAt = Date.now()
      logServer(`[scanner-bounds-clear:${requestId}] request received`)
      return Promise.resolve()
        .then(() => {
          const result = clearScannerBounds()
          logServer(`[scanner-bounds-clear:${requestId}] cleared=${result.cleared} elapsed_ms=${Date.now() - startedAt}`)
          return jsonResponse(result)
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          logServer(`[scanner-bounds-clear:${requestId}] failure elapsed_ms=${Date.now() - startedAt} error=${message}`)
          return new Response(message || 'Clearing scanner bounds failed', { status: 500 })
        })
    }

    if (url.pathname.startsWith('/assets/')) {
      const rel = url.pathname.replace(/^\/+/, '')
      const filePath = path.join(webBuildDir, rel)
      if (!filePath.startsWith(webBuildDir) || !existsSync(filePath)) {
        return new Response('Not found', { status: 404 })
      }
      return new Response(BunRuntime.file(filePath), {
        headers: { 'content-type': guessMime(filePath) },
      })
    }

    if (url.pathname === '/' || url.pathname.startsWith('/app')) {
      return new Response(html(), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    return new Response('Not found', { status: 404 })
  },
  websocket: {
    open(ws: any) {
      ws.subscribe('desk')
      const message: ServerMessage = { type: 'snapshot', snapshot: host.getSnapshot() }
      ws.send(JSON.stringify(message))
    },
    message() {
      // client messages are handled over HTTP POST for now
    },
  },
})

host.on('event', (event) => {
  const message: ServerMessage = { type: 'event', event }
  server.publish('desk', JSON.stringify(message))
})

process.stderr.write(`[desk-server] Listening on http://localhost:${port}\n`)

if (isDev) {
  const webSrcDir = path.join(import.meta.dirname, 'ui', 'web')
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null
  watch(webSrcDir, { recursive: true }, (_event, filename) => {
    if (rebuildTimer) return
    rebuildTimer = setTimeout(async () => {
      rebuildTimer = null
      logServer(`[dev] ${filename ?? 'file'} changed — rebuilding web assets...`)
      try {
        await buildWebAssets()
        logServer('[dev] Rebuild complete — reloading clients')
        server.publish('desk', JSON.stringify({ type: 'reload' }))
      } catch (err) {
        logServer(`[dev] Rebuild failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }, 150)
  })
  logServer(`[dev] Watching ${webSrcDir}`)
}

function shutdown() {
  host.stop()
  server.stop()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)


#!/usr/bin/env bun

import path from 'path'
import { existsSync } from 'fs'
import { DeskHost } from './server/desk-host.js'
import type { ServerMessage } from './ui/shared/protocol.js'

const args = process.argv.slice(2)
const debounceMs = (() => {
  const idx = args.indexOf('--debounce')
  return idx !== -1 ? parseInt(args[idx + 1] ?? '2000', 10) : 2000
})()
const logLevel = args.includes('--verbose') ? 'verbose' : 'normal'
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

await buildWebAssets()
host.start()

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

function shutdown() {
  host.stop()
  server.stop()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)


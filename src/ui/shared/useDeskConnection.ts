import { useEffect, useMemo, useState } from 'react'
import { applyDeskEvent, createInitialSnapshot } from './reducer.js'
import type { DeskSnapshot, ServerMessage } from './protocol.js'

interface UseDeskConnectionOptions {
  baseUrl: string
}

interface UseDeskConnectionResult {
  snapshot: DeskSnapshot | null
  connected: boolean
  error: string | null
  sendMessage: (agentRelPath: string, message: string) => Promise<void>
  uploadInputPhoto: (photo: Blob, options?: { filenameBase?: string }) => Promise<{ filename: string; relativePath: string; sizeBytes: number }>
  detectScannerDocument: (photo: Blob) => Promise<{
    quad: [[number, number], [number, number], [number, number], [number, number]] | null
    confidence: number
    source: string
    imageWidth: number
    imageHeight: number
    usedFallback: boolean
  }>
  scanScannerDocument: (
    photo: Blob,
    options: { quad: [[number, number], [number, number], [number, number], [number, number]] },
  ) => Promise<{ imageBase64: string; mimeType: 'image/jpeg'; width: number; height: number }>
  saveScannerBounds: (
    photo: Blob,
    quad: [[number, number], [number, number], [number, number], [number, number]],
  ) => Promise<{ saved: boolean }>
  clearScannerBounds: () => Promise<{ cleared: boolean }>
}

function httpToWs(baseUrl: string): string {
  if (baseUrl.startsWith('https://')) return baseUrl.replace('https://', 'wss://')
  if (baseUrl.startsWith('http://')) return baseUrl.replace('http://', 'ws://')
  return `ws://${baseUrl}`
}

export function useDeskConnection({ baseUrl }: UseDeskConnectionOptions): UseDeskConnectionResult {
  const [snapshot, setSnapshot] = useState<DeskSnapshot | null>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let isStopped = false

    const connect = async () => {
      try {
        const response = await fetch(`${baseUrl}/api/snapshot`)
        if (!response.ok) throw new Error(`Snapshot request failed (${response.status})`)
        const initial = (await response.json()) as DeskSnapshot
        setSnapshot(initial)
        setError(null)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
      }

      ws = new WebSocket(`${httpToWs(baseUrl)}/ws`)
      ws.onopen = () => {
        setConnected(true)
        setError(null)
      }
      ws.onclose = () => {
        setConnected(false)
        if (isStopped) return
        reconnectTimer = setTimeout(connect, 1000)
      }
      ws.onerror = () => {
        setConnected(false)
      }
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as ServerMessage
          if (message.type === 'reload') {
            window.location.reload()
            return
          }
          if (message.type === 'snapshot') {
            setSnapshot(message.snapshot)
            return
          }
          setSnapshot((prev) => {
            if (!prev) return null
            return applyDeskEvent(prev, message.event)
          })
        } catch {
          // ignore malformed payloads
        }
      }
    }

    connect().catch(() => {
      // initial connection errors are already surfaced in state
    })

    return () => {
      isStopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
    }
  }, [baseUrl])

  const api = useMemo(() => ({
    async sendMessage(agentRelPath: string, message: string) {
      const response = await fetch(`${baseUrl}/api/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentRelPath, message }),
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `Send failed (${response.status})`)
      }
    },
    async uploadInputPhoto(photo: Blob, options?: { filenameBase?: string }) {
      const formData = new FormData()
      formData.append('photo', photo, 'camera-capture.jpg')
      if (options?.filenameBase) {
        formData.append('filenameBase', options.filenameBase)
      }

      const response = await fetch(`${baseUrl}/api/input/photo`, {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `Photo upload failed (${response.status})`)
      }
      return response.json() as Promise<{ filename: string; relativePath: string; sizeBytes: number }>
    },
    async detectScannerDocument(photo: Blob) {
      const formData = new FormData()
      formData.append('photo', photo, 'camera-capture.jpg')

      const response = await fetch(`${baseUrl}/api/scanner/detect`, {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `Document detection failed (${response.status})`)
      }
      return response.json() as Promise<{
        quad: [[number, number], [number, number], [number, number], [number, number]] | null
        confidence: number
        source: string
        imageWidth: number
        imageHeight: number
        usedFallback: boolean
      }>
    },
    async scanScannerDocument(photo: Blob, options: {
      quad: [[number, number], [number, number], [number, number], [number, number]]
    }) {
      const formData = new FormData()
      formData.append('photo', photo, 'camera-capture.jpg')
      formData.append('quad', JSON.stringify(options.quad))

      const response = await fetch(`${baseUrl}/api/scanner/scan`, {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `Document scan failed (${response.status})`)
      }
      return response.json() as Promise<{ imageBase64: string; mimeType: 'image/jpeg'; width: number; height: number }>
    },
    async saveScannerBounds(photo: Blob, quad: [[number, number], [number, number], [number, number], [number, number]]) {
      const formData = new FormData()
      formData.append('photo', photo, 'camera-capture.jpg')
      formData.append('quad', JSON.stringify(quad))

      const response = await fetch(`${baseUrl}/api/scanner/save-bounds`, {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `Saving scanner bounds failed (${response.status})`)
      }
      return response.json() as Promise<{ saved: boolean }>
    },
    async clearScannerBounds() {
      const response = await fetch(`${baseUrl}/api/scanner/clear-bounds`, {
        method: 'POST',
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `Clearing scanner bounds failed (${response.status})`)
      }
      return response.json() as Promise<{ cleared: boolean }>
    },
  }), [baseUrl])

  return {
    snapshot,
    connected,
    error,
    sendMessage: api.sendMessage,
    uploadInputPhoto: api.uploadInputPhoto,
    detectScannerDocument: api.detectScannerDocument,
    scanScannerDocument: api.scanScannerDocument,
    saveScannerBounds: api.saveScannerBounds,
    clearScannerBounds: api.clearScannerBounds,
  }
}

export function emptySnapshot(deskRoot = ''): DeskSnapshot {
  return createInitialSnapshot(deskRoot)
}


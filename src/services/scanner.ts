import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import path from 'path'
import { detectDocumentQuadWithGemini } from './gemini.js'

const SRC_ROOT = path.resolve(import.meta.dirname, '..')
const PYTHON = path.join(SRC_ROOT, '🐍', 'bin', 'python3')
const CAPTURE_SCRIPT = path.join(SRC_ROOT, 'camera', 'capture.py')
const TMP_DIR = path.join(SRC_ROOT, 'camera', '.tmp')
const GEMINI_FALLBACK_THRESHOLD = 0.55

export type ScannerQuad = [[number, number], [number, number], [number, number], [number, number]]

interface ScannerScriptError {
  error: string
}

interface ScannerDetectPayload {
  quad: ScannerQuad | null
  confidence: number
  source: string
  image_width: number
  image_height: number
}

interface ScannerScanPayload {
  path: string
  width: number
  height: number
  transformed: boolean
}

interface SaveBoundsPayload {
  saved: boolean
  normalized_quad: ScannerQuad
  image_width: number
  image_height: number
}

interface ClearBoundsPayload {
  cleared: boolean
}

export interface ScannerDetectResult {
  quad: ScannerQuad | null
  confidence: number
  source: string
  imageWidth: number
  imageHeight: number
  usedFallback: boolean
}

export interface ScannerScanResult {
  imageBase64: string
  mimeType: 'image/jpeg'
  width: number
  height: number
}

function logScanner(message: string): void {
  process.stderr.write(`[scanner] ${message}\n`)
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/webp') return 'webp'
  return 'jpg'
}

function makeTempPath(prefix: string, extension: string): string {
  mkdirSync(TMP_DIR, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(TMP_DIR, `${prefix}-${timestamp}-${crypto.randomUUID().slice(0, 8)}.${extension}`)
}

function quadToArg(quad: ScannerQuad): string {
  return quad.map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`).join(';')
}

function runScannerScript<T>(args: string[]): T {
  if (!existsSync(PYTHON)) {
    throw new Error(`Python venv not found at ${PYTHON}`)
  }
  if (!existsSync(CAPTURE_SCRIPT)) {
    throw new Error(`Capture script not found at ${CAPTURE_SCRIPT}`)
  }

  const startedAt = Date.now()
  const result = spawnSync(PYTHON, [CAPTURE_SCRIPT, ...args], {
    cwd: path.join(SRC_ROOT, 'camera'),
    encoding: 'utf8',
    timeout: 120_000,
  })
  logScanner(`python args=${JSON.stringify(args)} exit=${result.status ?? -1} elapsed_ms=${Date.now() - startedAt}`)

  if (result.error) {
    throw result.error
  }
  if (!result.stdout) {
    throw new Error(result.stderr?.trim() || 'Scanner script returned no output')
  }

  let parsed: T | ScannerScriptError
  try {
    parsed = JSON.parse(result.stdout.trim()) as T | ScannerScriptError
  } catch (error) {
    throw new Error(`Invalid scanner JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
    throw new Error(parsed.error)
  }
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `Scanner script failed (${result.status})`)
  }
  return parsed as T
}

function withTempInput<T>(imageBytes: Uint8Array, mimeType: string, fn: (inputPath: string) => T): T {
  const inputPath = makeTempPath('scanner-input', extensionForMimeType(mimeType))
  writeFileSync(inputPath, imageBytes)
  try {
    return fn(inputPath)
  } finally {
    try { unlinkSync(inputPath) } catch { /* best effort */ }
  }
}

export function getScannerRuntimeConfig(): { geminiFallbackThreshold: number } {
  return { geminiFallbackThreshold: GEMINI_FALLBACK_THRESHOLD }
}

export async function detectScannerDocument(
  imageBytes: Uint8Array,
  mimeType: string,
): Promise<ScannerDetectResult> {
  const initial = withTempInput(imageBytes, mimeType, (inputPath) => {
    const payload = runScannerScript<ScannerDetectPayload>([
      '--input-image', inputPath,
      '--detect-document',
    ])

    return {
      quad: payload.quad,
      confidence: payload.confidence,
      source: payload.source,
      imageWidth: payload.image_width,
      imageHeight: payload.image_height,
      usedFallback: false,
    } satisfies ScannerDetectResult
  })

  const shouldUseGeminiFallback =
    (!initial.quad || initial.confidence < GEMINI_FALLBACK_THRESHOLD) &&
    !!process.env['GEMINI_API_KEY']

  if (!shouldUseGeminiFallback) {
    return initial
  }

  logScanner(`opencv confidence=${initial.confidence.toFixed(3)} source=${initial.source}; trying Gemini fallback`)
  try {
    const detection = await detectDocumentQuadWithGemini(imageBytes, mimeType)
    if (!detection.quad) return initial

    return {
      quad: detection.quad,
      confidence: Math.max(initial.confidence, detection.confidence),
      source: 'gemini_quad_fallback',
      imageWidth: initial.imageWidth,
      imageHeight: initial.imageHeight,
      usedFallback: true,
    }
  } catch (error) {
    logScanner(`Gemini fallback failed: ${error instanceof Error ? error.message : String(error)}`)
    return initial
  }
}

export function scanScannerDocument(
  imageBytes: Uint8Array,
  mimeType: string,
  quad: ScannerQuad,
): ScannerScanResult {
  return withTempInput(imageBytes, mimeType, (inputPath) => {
    const outputPath = makeTempPath('scanner-output', 'jpg')
    try {
      const payload = runScannerScript<ScannerScanPayload>([
        '--input-image', inputPath,
        '--scan-document',
        '--quad', quadToArg(quad),
        '--output', outputPath,
      ])

      const imageBase64 = readFileSync(outputPath).toString('base64')
      return {
        imageBase64,
        mimeType: 'image/jpeg',
        width: payload.width,
        height: payload.height,
      }
    } finally {
      try { unlinkSync(outputPath) } catch { /* best effort */ }
    }
  })
}

export function saveScannerBounds(
  imageBytes: Uint8Array,
  mimeType: string,
  quad: ScannerQuad,
): SaveBoundsPayload {
  return withTempInput(imageBytes, mimeType, (inputPath) =>
    runScannerScript<SaveBoundsPayload>([
      '--input-image', inputPath,
      '--save-bounds',
      '--quad', quadToArg(quad),
    ]),
  )
}

export function clearScannerBounds(): { cleared: boolean } {
  const payload = runScannerScript<ClearBoundsPayload>([
    '--clear-bounds',
  ])
  return { cleared: payload.cleared }
}

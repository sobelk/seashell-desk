interface GeminiPart {
  text?: string
}

interface GeminiCandidate {
  content?: {
    parts?: GeminiPart[]
  }
}

interface GeminiGenerateResponse {
  candidates?: GeminiCandidate[]
  error?: {
    message?: string
  }
}

interface GeminiListModelsResponse {
  models?: Array<{ name?: string }>
  error?: { message?: string }
}

export interface GeminiQuadDetection {
  quad: [[number, number], [number, number], [number, number], [number, number]] | null
  confidence: number
}

const GEMINI_MODEL = process.env['GEMINI_MODEL'] || 'gemini-2.5-flash'
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`
const GEMINI_MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_TIMEOUT_MS = Number.parseInt(process.env['GEMINI_TIMEOUT_MS'] ?? '60000', 10) || 60_000
const GEMINI_PREFLIGHT_TIMEOUT_MS = Number.parseInt(process.env['GEMINI_PREFLIGHT_TIMEOUT_MS'] ?? '15000', 10) || 15_000

function logGemini(message: string): void {
  process.stderr.write(`[gemini] ${message}\n`)
}

let preflightStatus: 'unknown' | 'ok' | 'failed' = 'unknown'
let preflightPromise: Promise<void> | null = null

function withTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  }
}

async function runGeminiPreflight(apiKey: string): Promise<void> {
  logGemini(`preflight start model=${GEMINI_MODEL} timeout_ms=${GEMINI_PREFLIGHT_TIMEOUT_MS}`)
  logGemini(`preflight api_key_present=${apiKey.length > 0} api_key_length=${apiKey.length}`)

  const modelsTimeout = withTimeout(GEMINI_PREFLIGHT_TIMEOUT_MS)
  let modelsResponse: Response
  try {
    modelsResponse = await fetch(GEMINI_MODELS_ENDPOINT, {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey },
      signal: modelsTimeout.signal,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Preflight models request timed out after ${GEMINI_PREFLIGHT_TIMEOUT_MS}ms`)
    }
    throw error
  } finally {
    modelsTimeout.cancel()
  }

  let modelsPayload: GeminiListModelsResponse = {}
  try {
    modelsPayload = (await modelsResponse.json()) as GeminiListModelsResponse
  } catch {
    modelsPayload = {}
  }
  if (!modelsResponse.ok) {
    throw new Error(modelsPayload.error?.message || `Preflight models request failed (${modelsResponse.status})`)
  }

  const available = modelsPayload.models ?? []
  const targetName = `models/${GEMINI_MODEL}`
  const hasTargetModel = available.some((model) => model.name === targetName)
  logGemini(`preflight models_count=${available.length} target_model_present=${hasTargetModel}`)
  if (!hasTargetModel) {
    throw new Error(`Configured model not listed by API: ${targetName}`)
  }

  const pingTimeout = withTimeout(GEMINI_PREFLIGHT_TIMEOUT_MS)
  let pingResponse: Response
  try {
    pingResponse = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      signal: pingTimeout.signal,
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: 'Reply with exactly: OK' }],
          },
        ],
        generationConfig: {
          maxOutputTokens: 8,
        },
      }),
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Preflight ping timed out after ${GEMINI_PREFLIGHT_TIMEOUT_MS}ms`)
    }
    throw error
  } finally {
    pingTimeout.cancel()
  }

  let pingPayload: GeminiGenerateResponse = {}
  try {
    pingPayload = (await pingResponse.json()) as GeminiGenerateResponse
  } catch {
    pingPayload = {}
  }
  if (!pingResponse.ok) {
    throw new Error(pingPayload.error?.message || `Preflight ping failed (${pingResponse.status})`)
  }

  const pingText = pingPayload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join(' ').trim()
  logGemini(`preflight ping_text="${pingText || '(empty)'}"`)
}

async function ensureGeminiPreflight(apiKey: string): Promise<void> {
  if (preflightStatus === 'ok') return
  if (!preflightPromise) {
    preflightPromise = runGeminiPreflight(apiKey)
      .then(() => {
        preflightStatus = 'ok'
        logGemini('preflight success')
      })
      .catch((error) => {
        preflightStatus = 'failed'
        const message = error instanceof Error ? error.message : String(error)
        logGemini(`preflight failed: ${message}`)
        throw error
      })
      .finally(() => {
        preflightPromise = null
      })
  }
  await preflightPromise
}

export function getGeminiRuntimeConfig(): { model: string; timeoutMs: number; preflightTimeoutMs: number } {
  return {
    model: GEMINI_MODEL,
    timeoutMs: GEMINI_TIMEOUT_MS,
    preflightTimeoutMs: GEMINI_PREFLIGHT_TIMEOUT_MS,
  }
}

function extractJsonText(rawText: string): string {
  const trimmed = rawText.trim()
  if (!trimmed.startsWith('```')) return trimmed

  const lines = trimmed.split('\n')
  const startIdx = lines.findIndex((line) => line.trim().startsWith('```'))
  if (startIdx === -1) return trimmed
  const remaining = lines.slice(startIdx + 1)
  const endIdx = remaining.findIndex((line) => line.trim() === '```')
  return (endIdx === -1 ? remaining : remaining.slice(0, endIdx)).join('\n').trim()
}

function parseQuadDetection(rawText: string): GeminiQuadDetection {
  const parsed = JSON.parse(extractJsonText(rawText)) as unknown
  if (!parsed || typeof parsed !== 'object') return { quad: null, confidence: 0 }

  const record = parsed as Record<string, unknown>
  const quad = record.quad
  const confidence = typeof record.confidence === 'number' ? Math.max(0, Math.min(1, record.confidence)) : 0

  if (!Array.isArray(quad) || quad.length !== 4) {
    return { quad: null, confidence }
  }

  const normalized = quad.map((point) => {
    if (!Array.isArray(point) || point.length !== 2 || !point.every((value) => typeof value === 'number')) {
      return null
    }
    return [
      Math.max(0, Math.min(1, point[0] as number)),
      Math.max(0, Math.min(1, point[1] as number)),
    ] as [number, number]
  })

  if (normalized.some((point) => point === null)) {
    return { quad: null, confidence }
  }

  return {
    quad: normalized as [[number, number], [number, number], [number, number], [number, number]],
    confidence,
  }
}

export async function detectDocumentQuadWithGemini(
  imageBytes: Uint8Array,
  mimeType: string,
): Promise<GeminiQuadDetection> {
  const startMs = Date.now()
  const apiKey = process.env['GEMINI_API_KEY']
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set')
  }

  await ensureGeminiPreflight(apiKey)
  logGemini(`request start model=${GEMINI_MODEL} mime=${mimeType} bytes=${imageBytes.byteLength}`)

  let response: Response
  const timeout = withTimeout(GEMINI_TIMEOUT_MS)
  try {
    response = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      signal: timeout.signal,
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: mimeType,
                  data: Buffer.from(imageBytes).toString('base64'),
                },
              },
              {
                text: [
                  'Detect the single most prominent document-like object in this image.',
                  'A document-like object can be a sheet of paper, letter, receipt, envelope, printed page, or similar flat paper item.',
                  'Return exactly one JSON object with these keys:',
                  '- "quad": either null or four normalized points [[x, y], [x, y], [x, y], [x, y]] ordered top-left, top-right, bottom-right, bottom-left',
                  '- "confidence": a number between 0 and 1',
                  'Do not return a bounding box, mask, prose, or markdown.',
                  'If no document-like object is present, return {"quad": null, "confidence": 0}.',
                ].join('\n'),
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          thinkingConfig: {
            thinkingBudget: 0,
          },
        },
      }),
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      logGemini(`request timeout after ${GEMINI_TIMEOUT_MS}ms`)
      throw new Error(`Document detection timed out after ${Math.round(GEMINI_TIMEOUT_MS / 1000)}s`)
    }
    logGemini(`request transport error: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  } finally {
    timeout.cancel()
  }
  logGemini(`response received status=${response.status} in ${Date.now() - startMs}ms`)

  let payload: GeminiGenerateResponse = {}
  try {
    payload = (await response.json()) as GeminiGenerateResponse
  } catch {
    logGemini('response body was not valid JSON')
    payload = {}
  }
  if (!response.ok) {
    logGemini(`request failed status=${response.status} message=${payload.error?.message ?? 'unknown'}`)
    throw new Error(payload.error?.message || `Gemini request failed (${response.status})`)
  }

  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('\n').trim()
  if (!text) {
    logGemini('response had no candidate text')
    return { quad: null, confidence: 0 }
  }

  const detection = parseQuadDetection(text)
  logGemini(`parsed quad_present=${detection.quad ? 'yes' : 'no'} confidence=${detection.confidence}`)
  return detection
}

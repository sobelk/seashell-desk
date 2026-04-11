/**
 * Camera tool — captures photos from the Arducam desk camera.
 *
 * Shells out to src/camera/capture.py via the local 🐍 venv.
 * The Python script handles camera init, frame stacking, optional
 * perspective correction, grayscale conversion, and resize.
 */

import { execSync } from 'child_process'
import { existsSync, mkdirSync, copyFileSync, unlinkSync, readFileSync } from 'fs'
import path from 'path'

const SRC_ROOT = path.resolve(import.meta.dirname, '..')
const DESK_ROOT = path.resolve(SRC_ROOT, '..', 'desk')
const PYTHON = path.join(SRC_ROOT, '🐍', 'bin', 'python3')
const CAPTURE_SCRIPT = path.join(SRC_ROOT, 'camera', 'capture.py')

export type CameraToolName = 'capture_photo'

export const cameraTools = [
  {
    name: 'capture_photo',
    description:
      'Take a photograph using the desk camera. Returns the photo as an image ' +
      'attachment you can inspect directly. The photo is always dropped into ' +
      'desk/input/ for triage processing. Use this to see what is physically ' +
      'on the desk — documents, mail, packages, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        filename: {
          type: 'string',
          description:
            'Optional filename (without extension). Defaults to a timestamp. ' +
            'Extension is always .jpg.',
        },
        use_bounds: {
          type: 'boolean',
          description:
            'Apply saved perspective correction to crop and flatten the document ' +
            'area. Default false.',
        },
        high_res: {
          type: 'boolean',
          description:
            'Capture at 4656x3496 (slow, ~10fps). Default uses 1920x1080.',
        },
      },
      required: [],
    },
  },
] as const

interface CaptureResult {
  path: string
  width: number
  height: number
  size_bytes: number
  capture_resolution: string
  stacked_frames: number
  transformed: boolean
  grayscale: boolean
  error?: undefined
}

interface CaptureError {
  error: string
}

export function runCameraTool(
  toolName: CameraToolName,
  input: unknown,
): unknown {
  if (toolName !== 'capture_photo') return { error: `Unknown camera tool: ${toolName}` }

  const opts = (input ?? {}) as {
    filename?: string
    use_bounds?: boolean
    high_res?: boolean
  }

  if (!existsSync(PYTHON)) {
    return { error: `Python venv not found at ${PYTHON}. Run: python3 -m venv src/🐍 && src/🐍/bin/pip install -r src/camera/requirements.txt` }
  }
  if (!existsSync(CAPTURE_SCRIPT)) {
    return { error: `Capture script not found at ${CAPTURE_SCRIPT}` }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const baseName = opts.filename ?? `desk-photo-${timestamp}`
  const tmpDir = path.join(SRC_ROOT, 'camera', '.tmp')
  mkdirSync(tmpDir, { recursive: true })
  const outputPath = path.join(tmpDir, `${baseName}.jpg`)

  try {
    const args = [
      PYTHON, CAPTURE_SCRIPT,
      '--output', outputPath,
      '--stack', '3',
      '--max-dimension', '2000',
      '--jpeg-quality', '90',
    ]
    if (opts.use_bounds) args.push('--use-bounds')
    if (opts.high_res) args.push('--high')

    const stdout = execSync(args.join(' '), {
      cwd: path.join(SRC_ROOT, 'camera'),
      timeout: 45_000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const result: CaptureResult | CaptureError = JSON.parse(stdout.trim())
    if ('error' in result) {
      return { error: `Camera: ${result.error}` }
    }

    if (!existsSync(outputPath)) {
      return { error: 'Capture script succeeded but output file missing' }
    }

    // Read for inline return
    const imageData = readFileSync(outputPath)
    const base64Data = imageData.toString('base64')
    const sizeKb = Math.round(imageData.length / 1024)

    // Always drop to input/ for triage
    const inputDir = path.join(DESK_ROOT, 'input')
    mkdirSync(inputDir, { recursive: true })
    copyFileSync(outputPath, path.join(inputDir, `${baseName}.jpg`))
    const inputRelPath = `input/${baseName}.jpg`

    // Cleanup
    try { unlinkSync(outputPath) } catch { /* best effort */ }

    return {
      _rawContent: [
        {
          type: 'text',
          text: [
            `Photo captured: ${result.width}x${result.height} (${sizeKb} KB)`,
            `Source: ${result.capture_resolution}, ${result.stacked_frames} frames stacked`,
            result.transformed ? 'Perspective correction applied' : '',
            `Dropped to: ${inputRelPath}`,
          ].filter(Boolean).join('\n'),
        },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: base64Data },
        },
      ],
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { error: `Camera capture failed: ${msg}` }
  }
}

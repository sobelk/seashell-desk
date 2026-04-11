/**
 * capture — take a photo with the desk camera from the command line.
 *
 * Usage:
 *   bun run capture                     # capture and drop into desk/input/
 *   bun run capture --name my-document  # custom filename
 *   bun run capture --bounds            # apply saved perspective correction
 *   bun run capture --high              # high-res mode (4656x3496)
 *
 * Photos are always dropped into desk/input/ for triage processing.
 */

import { execSync } from 'child_process'
import { existsSync, mkdirSync, copyFileSync, unlinkSync } from 'fs'
import path from 'path'

const SRC_ROOT = path.resolve(import.meta.dirname)
const DESK_ROOT = path.resolve(SRC_ROOT, '..', 'desk')
const PYTHON = path.join(SRC_ROOT, '🐍', 'bin', 'python3')
const CAPTURE_SCRIPT = path.join(SRC_ROOT, 'camera', 'capture.py')

if (!existsSync(PYTHON)) {
  process.stderr.write(`Python venv not found. Run:\n  python3 -m venv src/🐍 && src/🐍/bin/pip install -r src/camera/requirements.txt\n`)
  process.exit(1)
}

const args = process.argv.slice(2)
const useBounds = args.includes('--bounds')
const highRes = args.includes('--high')
const nameIdx = args.indexOf('--name')
const customName = nameIdx !== -1 ? args[nameIdx + 1] : null

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const baseName = customName ?? `desk-photo-${timestamp}`
const tmpDir = path.join(SRC_ROOT, 'camera', '.tmp')
mkdirSync(tmpDir, { recursive: true })
const tmpPath = path.join(tmpDir, `${baseName}.jpg`)

process.stderr.write('Capturing photo...\n')

try {
  const cmdArgs = [
    PYTHON, CAPTURE_SCRIPT,
    '--output', tmpPath,
    '--stack', '3',
    '--max-dimension', '2000',
    '--jpeg-quality', '90',
  ]
  if (useBounds) cmdArgs.push('--use-bounds')
  if (highRes) cmdArgs.push('--high')

  const stdout = execSync(cmdArgs.join(' '), {
    cwd: path.join(SRC_ROOT, 'camera'),
    timeout: 60_000,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],  // stderr to terminal
  })

  const result = JSON.parse(stdout.trim())
  if (result.error) {
    process.stderr.write(`Error: ${result.error}\n`)
    process.exit(1)
  }

  if (!existsSync(tmpPath)) {
    process.stderr.write('Capture succeeded but output file missing.\n')
    process.exit(1)
  }

  // Always drop to input/ for triage processing
  const inputDir = path.join(DESK_ROOT, 'input')
  mkdirSync(inputDir, { recursive: true })
  const inputPath = path.join(inputDir, `${baseName}.jpg`)
  copyFileSync(tmpPath, inputPath)
  process.stderr.write(`Dropped: input/${baseName}.jpg\n`)

  // Cleanup tmp
  try { unlinkSync(tmpPath) } catch { /* best effort */ }

  process.stdout.write(inputPath + '\n')
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`Capture failed: ${msg}\n`)
  process.exit(1)
}

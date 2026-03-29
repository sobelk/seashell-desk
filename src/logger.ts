/**
 * RunLogger — writes a JSONL log file for each agent run.
 *
 * Logs are written to logs/{YYYY-MM-DD}/{agentName}/{HH-MM-SS}.jsonl at the
 * repo root. Each line is a JSON object with a `ts` timestamp and `type` field.
 *
 * Binary tool outputs (e.g. base64 images from read_file) are stripped so
 * log files stay a manageable size.
 */

import { mkdirSync, createWriteStream } from 'fs'
import type { WriteStream } from 'fs'
import path from 'path'
import type { RoundData } from './runner.js'
import type { FileChange } from './watcher-core.js'

const REPO_ROOT = path.resolve(path.join(import.meta.dirname, '..'))
const LOGS_ROOT = path.join(REPO_ROOT, 'logs')

// Strip binary payloads from tool outputs before logging
function sanitizeOutput(output: unknown): unknown {
  if (output !== null && typeof output === 'object' && '_rawContent' in output) {
    const raw = (output as { _rawContent: unknown[] })._rawContent
    const kind = Array.isArray(raw) ? raw.find((b: unknown) => typeof b === 'object' && b !== null && 'type' in (b as object) && (b as { type: string }).type !== 'text') : null
    const type = kind !== null && typeof kind === 'object' && 'type' in (kind as object) ? (kind as { type: string }).type : 'binary'
    return { _stripped: true, kind: type }
  }
  return output
}

function sanitizeRound(round: RoundData): Record<string, unknown> {
  return {
    ...round,
    toolCalls: round.toolCalls.map((tc) => ({
      ...tc,
      output: sanitizeOutput(tc.output),
    })),
  }
}

export class RunLogger {
  private readonly stream: WriteStream
  readonly logPath: string

  constructor(agentName: string, startTime = new Date()) {
    const date = startTime.toISOString().slice(0, 10)
    const time = startTime.toISOString().slice(11, 19).replace(/:/g, '-')
    const dir = path.join(LOGS_ROOT, date, agentName)
    mkdirSync(dir, { recursive: true })
    this.logPath = path.join(dir, `${time}.jsonl`)
    this.stream = createWriteStream(this.logPath, { flags: 'a' })
  }

  private write(entry: Record<string, unknown>) {
    this.stream.write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  }

  logStart(agentPath: string, changes: FileChange[]) {
    this.write({
      type: 'run:start',
      agentPath,
      changes: changes.map((c) => `${c.event}: ${c.path}`),
    })
  }

  logRound(data: RoundData) {
    this.write({ type: 'round', ...sanitizeRound(data) })
  }

  logDone(rounds: number, hitLimit: boolean, response: string) {
    this.write({ type: 'run:done', rounds, hitLimit, response })
    this.stream.end()
  }

  logError(error: string) {
    this.write({ type: 'run:error', error })
    this.stream.end()
  }
}

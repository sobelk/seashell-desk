#!/usr/bin/env bun
/**
 * CLI watcher — thin wrapper around DeskWatcher that logs events to stderr.
 *
 * Usage:
 *   bun run watch
 *   bun run watch --debounce 3000   # quiet period in ms (default 2000)
 *   bun run watch --verbose         # verbose agent logging
 *   bun run watch --no-run          # watch events only; don't run agents
 */

import path from 'path'
import { DeskWatcher, type FileChange } from './watcher-core.js'

const args = process.argv.slice(2)
const debounceMs = (() => {
  const idx = args.indexOf('--debounce')
  return idx !== -1 ? parseInt(args[idx + 1] ?? '2000', 10) : 2000
})()
const logLevel = args.includes('--verbose') ? 'verbose' : 'normal'
const noRun = args.includes('--no-run')

function ts() { return new Date().toISOString().slice(11, 19) }
function log(msg: string) { process.stderr.write(`[${ts()}] ${msg}\n`) }

const watcher = new DeskWatcher({ debounceMs, logLevel, noRun })

function rel(absPath: string) {
  return path.relative(watcher.deskRoot, absPath)
}

watcher.on('fs', (change: FileChange, agentPath: string | null, suppressed: boolean) => {
  if (suppressed) {
    log(`[fs]   suppress (self-loop)  ${change.path}`)
  } else if (agentPath) {
    log(`[fs]   ${change.event.padEnd(8)} ${change.path}  →  ${rel(agentPath)}`)
  } else {
    log(`[fs]   no agent  ${change.event.padEnd(8)} ${change.path}`)
  }
})

watcher.on('queue', (running: string | null, queued: string[]) => {
  const parts: string[] = []
  if (running) parts.push(`running: ${rel(running)}`)
  if (queued.length > 0) parts.push(`queued: ${queued.map(rel).join(', ')}`)
  if (parts.length > 0) log(`[queue] ${parts.join(' | ')}`)
})

watcher.on('agent:start', (agentPath: string, changes: FileChange[]) => {
  log(`\n[run]  ── ${rel(agentPath)} (${changes.length} change(s)) ──`)
  for (const c of changes) log(`[run]    ${c.event.padEnd(8)} ${c.path}`)
})

watcher.on('agent:log', (_agentPath: string, message: string) => {
  process.stderr.write(message + '\n')
})

watcher.on('agent:done', (agentPath: string, rounds: number, hitLimit: boolean, response: string) => {
  if (hitLimit) log(`[run]  ⚠ Hit round limit (${rounds} rounds)`)
  log(`[run]  ── ${rel(agentPath)} done (${rounds} rounds) ──\n`)
  if (response) process.stdout.write(response + '\n')
})

watcher.on('agent:error', (agentPath: string, error: string) => {
  log(`[run]  ── ${rel(agentPath)} error: ${error} ──\n`)
})

log(`[watch] Watching ${watcher.deskRoot}`)
log(`[watch] Debounce: ${debounceMs}ms | Logging: ${logLevel} | Run agents: ${!noRun}`)

watcher.start()

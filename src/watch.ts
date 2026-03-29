#!/usr/bin/env bun
/**
 * File watcher — monitors the entire desk/ directory and runs the nearest
 * AGENT.md in response to file changes.
 *
 * Architecture:
 *   - Every file change triggers a lookup for the nearest ancestor AGENT.md
 *   - That agent is added to a run queue (deduplicated)
 *   - Agents are debounced: a 2s quiet period elapses before the run starts
 *   - Agents run sequentially — only one runs at a time
 *   - Changes arriving while an agent is running are injected into its next
 *     turn rather than requeuing it
 *   - Changes caused by the running agent itself (tracked via tool callbacks)
 *     are suppressed so agents don't re-trigger on their own writes
 *
 * Usage:
 *   bun run watch
 *   bun run watch --debounce 3000   # quiet period in ms (default 2000)
 *   bun run watch --verbose         # verbose agent logging
 *   bun run watch --no-run          # watch and log events only; don't run agents
 */

import { watch, existsSync } from 'fs'
import path from 'path'
import { GoogleAuth } from './services/google-auth.js'
import { GmailService } from './services/gmail.js'
import { CalendarService } from './services/calendar.js'
import { gmailTools, runGmailTool, type GmailToolName } from './tools/gmail.js'
import { calendarTools, runCalendarTool, type CalendarToolName } from './tools/calendar.js'
import { taskTools, runTaskTool, type TaskToolName } from './tools/tasks.js'
import { filesystemTools, runFilesystemTool, type FilesystemToolName } from './tools/filesystem.js'
import { runAgent, type ToolDefinition } from './runner.js'
import { buildSystemPrompt } from './prompt.js'

const DESK_ROOT = path.resolve(path.join(import.meta.dirname, '..', 'desk'))

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const DEBOUNCE_MS = (() => {
  const idx = args.indexOf('--debounce')
  return idx !== -1 ? parseInt(args[idx + 1] ?? '2000', 10) : 2000
})()
const LOG_LEVEL = args.includes('--verbose') ? 'verbose' : 'normal'
const NO_RUN = args.includes('--no-run')

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function ts() { return new Date().toISOString().slice(11, 19) }
function log(msg: string) { process.stdout.write(`[${ts()}] ${msg}\n`) }

// ---------------------------------------------------------------------------
// Files to ignore — changes to these never trigger agents
// ---------------------------------------------------------------------------

const ALWAYS_IGNORE = new Set([
  'TRIAGE_LOG.md',
  '.DS_Store',
])

function isIgnored(relPath: string): boolean {
  const base = path.basename(relPath)
  if (base === 'AGENT.md') return true           // don't re-run on agent edits
  if (ALWAYS_IGNORE.has(base)) return true
  if (relPath.startsWith('.git/')) return true
  return false
}

// ---------------------------------------------------------------------------
// Find the nearest AGENT.md to a changed path
// ---------------------------------------------------------------------------

function findClosestAgent(changedAbsPath: string): string | null {
  let dir = path.dirname(changedAbsPath)
  while (dir.startsWith(DESK_ROOT)) {
    const candidate = path.join(dir, 'AGENT.md')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// ---------------------------------------------------------------------------
// Change event
// ---------------------------------------------------------------------------

export interface FileChange {
  event: 'added' | 'removed' | 'modified'
  path: string   // relative to desk/
  ts: string
}

function describeChanges(changes: FileChange[]): string {
  const lines = changes.map((c) => {
    const icon = c.event === 'added' ? '+' : c.event === 'removed' ? '-' : '~'
    return `  ${icon} ${c.path}`
  })
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

interface QueueEntry {
  /** Changes that triggered this agent (grows during debounce) */
  changes: FileChange[]
  /** Debounce timer — null once the agent has been promoted to runOrder */
  debounceTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Changes that arrived while the current agent was running and should be
 * injected into its next turn. Cleared when consumed.
 */
let runningInjection: FileChange[] = []

/** The AGENT.md path currently executing */
let runningAgent: string | null = null

/** Set of desk/-relative paths written by the running agent */
const originatedPaths = new Set<string>()

/** Ordered list of agent paths waiting to run (post-debounce) */
const runOrder: string[] = []

/** All agents currently known to the queue (debouncing or waiting) */
const entries = new Map<string, QueueEntry>()

// ---------------------------------------------------------------------------
// Queue operations
// ---------------------------------------------------------------------------

function onDebounceExpired(agentMdPath: string) {
  const entry = entries.get(agentMdPath)
  if (!entry) return
  entry.debounceTimer = null

  if (runningAgent) {
    // Promote to run queue — will execute after current run finishes
    if (!runOrder.includes(agentMdPath)) {
      runOrder.push(agentMdPath)
      log(`[queue] Queued ${rel(agentMdPath)} (${entry.changes.length} change(s))`)
    }
  } else {
    runOrder.push(agentMdPath)
    runNext()
  }
}

function enqueue(agentMdPath: string, change: FileChange) {
  // Already running — inject into next turn instead of queuing
  if (runningAgent === agentMdPath) {
    runningInjection.push(change)
    log(`[queue] Injecting change into running agent: ${change.event} ${change.path}`)
    return
  }

  const existing = entries.get(agentMdPath)
  if (existing) {
    // Add change to existing entry; reset debounce timer
    existing.changes.push(change)
    if (existing.debounceTimer !== null) {
      clearTimeout(existing.debounceTimer)
      existing.debounceTimer = setTimeout(() => onDebounceExpired(agentMdPath), DEBOUNCE_MS)
    }
    log(`[queue] +change  ${rel(agentMdPath)}  ${change.event} ${change.path}`)
    return
  }

  // New entry — start debounce
  const timer = setTimeout(() => onDebounceExpired(agentMdPath), DEBOUNCE_MS)
  entries.set(agentMdPath, { changes: [change], debounceTimer: timer })
  log(`[queue] Debounce ${rel(agentMdPath)}  ${change.event} ${change.path}`)
}

function runNext() {
  if (runningAgent || runOrder.length === 0) return

  const agentMdPath = runOrder.shift()!
  const entry = entries.get(agentMdPath)
  if (!entry) { runNext(); return }

  entries.delete(agentMdPath)
  runningAgent = agentMdPath
  runningInjection = []
  originatedPaths.clear()

  log(`\n[run]  ── ${rel(agentMdPath)} (${entry.changes.length} change(s)) ──`)
  for (const c of entry.changes) {
    log(`[run]    ${c.event.padEnd(8)} ${c.path}`)
  }

  runAgentFor(agentMdPath, entry.changes)
    .then(() => {
      log(`[run]  ── ${rel(agentMdPath)} done ──\n`)
    })
    .catch((err: unknown) => {
      log(`[run]  ── ${rel(agentMdPath)} error: ${err instanceof Error ? err.message : String(err)} ──\n`)
    })
    .finally(() => {
      runningAgent = null
      runningInjection = []
      originatedPaths.clear()
      runNext()
    })
}

// ---------------------------------------------------------------------------
// Agent runner
// ---------------------------------------------------------------------------

const allTools: ToolDefinition[] = [
  ...filesystemTools,
  ...taskTools,
  ...gmailTools,
  ...calendarTools,
]

const gmailToolNames = new Set<string>(gmailTools.map((t) => t.name))
const calendarToolNames = new Set<string>(calendarTools.map((t) => t.name))
const taskToolNames = new Set<string>(taskTools.map((t) => t.name))
const filesystemToolNames = new Set<string>(filesystemTools.map((t) => t.name))

let googleAuth: GoogleAuth | null = null
let gmailService: GmailService | null = null
let calendarService: CalendarService | null = null

function getGoogleAuth() { return (googleAuth ??= GoogleAuth.fromEnv()) }
function getGmailService() { return (gmailService ??= new GmailService(getGoogleAuth())) }
function getCalendarService() { return (calendarService ??= new CalendarService(getGoogleAuth())) }

async function toolExecutor(toolName: string, input: unknown): Promise<unknown> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  if (filesystemToolNames.has(toolName)) return runFilesystemTool(toolName as any, input)
  if (taskToolNames.has(toolName)) return runTaskTool(toolName as any, input)
  if (gmailToolNames.has(toolName)) return runGmailTool(getGmailService(), toolName as any, input)
  if (calendarToolNames.has(toolName)) return runCalendarTool(getCalendarService(), toolName as any, input)
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { error: `Unknown tool: ${toolName}` }
}

/** Track paths written by the running agent so we can suppress those fs events */
function onToolExecuted(toolName: string, input: unknown, output: unknown) {
  if (typeof input !== 'object' || input === null) return
  const inp = input as Record<string, unknown>

  const track = (p: unknown) => {
    if (typeof p === 'string') {
      // Normalize to desk-relative path
      const abs = path.isAbsolute(p) ? p : path.join(DESK_ROOT, p)
      originatedPaths.add(path.relative(DESK_ROOT, abs))
    }
  }

  if (toolName === 'write_file') track(inp.path)
  if (toolName === 'copy_file') track(inp.dst)
  if (toolName === 'delete_file') track(inp.path)
  if (toolName === 'make_directory') track(inp.path)
  if (toolName === 'gmail_get_attachment') track(inp.output_path)
  if (toolName === 'create_task' || toolName === 'complete_task') {
    // Tasks are written to two paths — track both from the result
    if (typeof output === 'object' && output !== null && 'paths' in output) {
      const paths = (output as { paths: unknown }).paths
      if (Array.isArray(paths)) paths.forEach(track)
    }
  }
  if (toolName === 'gmail_process_inbox') {
    // Written to desk/input/ — track each
    if (typeof output === 'object' && output !== null && 'written' in output) {
      const written = (output as { written: unknown }).written
      if (Array.isArray(written)) {
        written.forEach((f: unknown) => {
          if (typeof f === 'string') track(`input/${f}`)
        })
      }
    }
  }
}


function buildInitialMessage(changes: FileChange[]): string {
  return [
    'The following file changes occurred in your directory:',
    '',
    describeChanges(changes),
    '',
    'Review these changes and take any necessary actions according to your instructions.',
  ].join('\n')
}

async function runAgentFor(agentMdPath: string, changes: FileChange[]) {
  if (NO_RUN) {
    log(`[run]  --no-run set, skipping`)
    return
  }

  const systemPrompt = buildSystemPrompt(agentMdPath)
  const message = buildInitialMessage(changes)

  // Capture and drain pending injection at the start of each round
  function getPendingInjection(): string | null {
    if (runningInjection.length === 0) return null
    const pending = [...runningInjection]
    runningInjection = []
    const text = [
      '[New file changes in your directory while you were running]',
      describeChanges(pending),
    ].join('\n')
    log(`[run]  Injecting ${pending.length} pending change(s) into agent context`)
    return text
  }

  const result = await runAgent({
    systemPrompt,
    tools: allTools,
    toolExecutor,
    message,
    logLevel: LOG_LEVEL,
    onToolExecuted,
    getPendingInjection,
    maxRounds: 80,
  })

  if (result.hitLimit) {
    log(`[run]  ⚠ Hit round limit (${result.rounds} rounds)`)
  }

  if (result.response) {
    console.log(result.response)
  }
}

// ---------------------------------------------------------------------------
// FS watcher
// ---------------------------------------------------------------------------

function rel(absPath: string) {
  return path.relative(DESK_ROOT, absPath)
}

function inferEvent(filename: string): FileChange['event'] {
  // 'rename' fires for both create and delete; check existence
  return existsSync(filename) ? 'added' : 'removed'
}

log(`[watch] Watching ${DESK_ROOT}`)
log(`[watch] Debounce: ${DEBOUNCE_MS}ms | Logging: ${LOG_LEVEL} | Run agents: ${!NO_RUN}`)

watch(DESK_ROOT, { recursive: true, persistent: true }, (eventType, filename) => {
  if (!filename) return

  const absPath = path.join(DESK_ROOT, filename)
  const relPath = filename.replace(/\\/g, '/') // normalize on Windows

  if (isIgnored(relPath)) return

  // Suppress self-loops: the running agent wrote this file AND it falls within
  // its own scope. Cross-agent writes (handoffs) are intentional and must
  // be allowed through so the destination agent gets queued.
  if (originatedPaths.has(relPath)) {
    const closestAgent = findClosestAgent(absPath)
    if (closestAgent === runningAgent) {
      log(`[fs]   suppress (self-loop)  ${relPath}`)
      return
    }
    // Different agent's territory — this is a handoff, fall through
  }

  const event: FileChange['event'] =
    eventType === 'rename' ? inferEvent(absPath) : 'modified'

  const change: FileChange = { event, path: relPath, ts: new Date().toISOString() }

  const agentMdPath = findClosestAgent(absPath)
  if (!agentMdPath) {
    log(`[fs]   no agent  ${event.padEnd(8)} ${relPath}`)
    return
  }

  log(`[fs]   ${event.padEnd(8)} ${relPath}  →  ${rel(agentMdPath)}`)
  enqueue(agentMdPath, change)
})

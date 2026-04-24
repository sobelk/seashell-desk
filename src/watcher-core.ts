/**
 * DeskWatcher — core watch/queue/run logic as a reusable EventEmitter.
 *
 * Events:
 *   'fs'                  (change: FileChange, agentPath: string | null, suppressed: boolean)
 *   'queue'               (running: string | null, queued: string[])
 *   'agent:start'         (agentPath: string, changes: FileChange[])
 *   'agent:log'           (agentPath: string, message: string)
 *   'agent:stream:start'  (agentPath: string, streamId: string)
 *   'agent:stream:delta'  (agentPath: string, streamId: string, delta: string)
 *   'agent:stream:end'    (agentPath: string, streamId: string)
 *   'agent:done'          (agentPath: string, rounds: number, hitLimit: boolean, response: string)
 *   'agent:error'         (agentPath: string, error: string)
 *   'user:message'        (agentPath: string, message: string)
 *   'system-file'         (change: FileChange)  // AGENT.md / SCOPE.md / SYSTEM.md /
 *                                               //   MEMORY.md / JOURNAL.md add/remove/modify
 */

import { EventEmitter } from 'events'
import { watch, existsSync, readdirSync, readFileSync, statSync } from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { GoogleAuth } from './services/google-auth.js'
import { GmailService } from './services/gmail.js'
import { CalendarService } from './services/calendar.js'
import { gmailTools, runGmailTool, type GmailToolName } from './tools/gmail.js'
import { calendarTools, runCalendarTool, type CalendarToolName } from './tools/calendar.js'
import { taskTools, runTaskTool, type TaskToolName } from './tools/tasks.js'
import { filesystemTools, runFilesystemTool, type FilesystemToolName } from './tools/filesystem.js'
import { cameraTools, runCameraTool, type CameraToolName } from './tools/camera.js'
import { runAgent, type ToolDefinition } from './runner.js'
import { buildSystemPrompt } from './prompt.js'
import { RunLogger } from './logger.js'

const DESK_ROOT = path.resolve(path.join(import.meta.dirname, '..', 'desk'))

export interface FileChange {
  event: 'added' | 'removed' | 'modified'
  path: string  // relative to desk/
  ts: string
}

export interface DeskWatcherOptions {
  debounceMs?: number
  logLevel?: 'silent' | 'normal' | 'verbose'
  noRun?: boolean
}

interface QueueEntry {
  changes: FileChange[]
  directMessage?: string
  debounceTimer: ReturnType<typeof setTimeout> | null
}

// Normalize Unicode space variants to ASCII space so LLMs can reproduce filenames
// faithfully in tool calls. macOS uses U+202F (NARROW NO-BREAK SPACE) before AM/PM
// in screenshot names; U+00A0 (NO-BREAK SPACE) also appears in some app exports.
function normalizeFilename(p: string): string {
  return p.replace(/[\u00a0\u202f\u2009\u2007\u2008]/g, ' ')
}

const ALWAYS_IGNORE = new Set(['TRIAGE_LOG.md', '.DS_Store'])

/**
 * System-level markdown files that configure an agent. Changes to these are
 * surfaced via a dedicated `system-file` event so the UI can refresh, but they
 * do NOT enqueue an agent run (we don't want editing AGENT.md to trigger the
 * agent to re-process itself).
 */
const SYSTEM_LEVEL_FILES = new Set(['AGENT.md', 'SCOPE.md', 'SYSTEM.md', 'MEMORY.md', 'JOURNAL.md'])

function isSystemLevelFile(relPath: string): boolean {
  return SYSTEM_LEVEL_FILES.has(path.basename(relPath))
}

function isIgnored(relPath: string): boolean {
  const base = path.basename(relPath)
  if (ALWAYS_IGNORE.has(base)) return true
  if (relPath.startsWith('.git/')) return true
  return false
}

function describeChanges(changes: FileChange[]): string {
  return changes.map((c) => `  ${c.event}: ${c.path}`).join('\n')
}

// ---------------------------------------------------------------------------
// File inlining — include content of added files in the trigger message
// ---------------------------------------------------------------------------

const TEXT_EXTS = new Set([
  '.txt', '.md', '.csv', '.json', '.yaml', '.yml',
  '.toml', '.xml', '.html', '.htm', '.log', '.conf', '.ini', '.env',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.sh',
])
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif'])
const DOCUMENT_EXTS = new Set(['.pdf'])

// Maximum characters of text to inline; beyond this we show a truncation note.
const MAX_INLINE_CHARS = 8000

/**
 * For a single added file, return a human-readable inline block describing its
 * content (for text) or its metadata (for binary/image/document types).
 */
function inlineFile(relPath: string): string {
  const absPath = path.join(DESK_ROOT, relPath)
  if (!existsSync(absPath)) return `  (file no longer present)`

  let size = 0
  try { size = statSync(absPath).size } catch { /* ignore */ }

  const ext = path.extname(relPath).toLowerCase()

  if (TEXT_EXTS.has(ext)) {
    try {
      const content = readFileSync(absPath, 'utf8')
      if (content.length <= MAX_INLINE_CHARS) {
        return `\`\`\`\n${content}\n\`\`\``
      }
      return `\`\`\`\n${content.slice(0, MAX_INLINE_CHARS)}\n\`\`\`\n(truncated — ${content.length - MAX_INLINE_CHARS} more characters; use read_file to see the rest)`
    } catch {
      return `  (could not read file: ${relPath})`
    }
  }

  if (IMAGE_EXTS.has(ext)) {
    return `  [image file — ${(size / 1024).toFixed(0)} KB; use read_file to inspect]`
  }

  if (DOCUMENT_EXTS.has(ext)) {
    return `  [document file — ${(size / 1024).toFixed(0)} KB; use read_file to inspect]`
  }

  return `  [binary file — ${(size / 1024).toFixed(0)} KB; extension: ${ext || 'none'}]`
}

/**
 * Build the trigger message for a file-change-triggered agent run.
 * Added files in the agent's input/ directory have their content inlined.
 */
function buildTriggerMessage(agentMdPath: string, changes: FileChange[]): string {
  const agentDir = path.dirname(agentMdPath)
  const inputDir = path.join(agentDir, 'input')
  const isInputDir = existsSync(path.join(DESK_ROOT, 'input', 'AGENT.md')) &&
    agentMdPath === path.join(DESK_ROOT, 'input', 'AGENT.md')

  const lines: string[] = [
    'The following file changes occurred in your directory:',
    '',
    describeChanges(changes),
  ]

  // Inline content for added files that live in:
  //   - the agent's own input/ subdirectory
  //   - the top-level input/ directory (for the triage agent)
  const added = changes.filter((c) => c.event === 'added')
  const toInline = added.filter((c) => {
    const absPath = path.join(DESK_ROOT, c.path)
    const parentDir = path.dirname(absPath)
    if (isInputDir) {
      // Triage agent: inline everything added to desk/input/
      return path.dirname(absPath) === path.join(DESK_ROOT, 'input')
    }
    // Project agent: inline files added to its input/ subdirectory
    return parentDir === inputDir
  })

  if (toInline.length > 0) {
    lines.push('', '---', '', 'File contents:')
    for (const change of toInline) {
      lines.push('', `**${change.path}**`, '', inlineFile(change.path))
    }
  }

  lines.push('', 'Review these changes and take any necessary actions according to your instructions.')
  return lines.join('\n')
}

export class DeskWatcher extends EventEmitter {
  private readonly debounceMs: number
  private readonly logLevel: 'silent' | 'normal' | 'verbose'
  private readonly noRun: boolean

  private runningAgent: string | null = null
  private runningInjection: FileChange[] = []
  private readonly originatedPaths = new Set<string>()
  private readonly runOrder: string[] = []
  private readonly entries = new Map<string, QueueEntry>()
  private readonly sessionConversations = new Map<string, Anthropic.MessageParam[]>()

  private googleAuth: GoogleAuth | null = null
  private gmailService: GmailService | null = null
  private calendarService: CalendarService | null = null

  private watcher: ReturnType<typeof watch> | null = null

  constructor(options: DeskWatcherOptions = {}) {
    super()
    this.debounceMs = options.debounceMs ?? 2000
    this.logLevel = options.logLevel ?? 'normal'
    this.noRun = options.noRun ?? false
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  start(): void {
    // Boot check: if files already exist in input/, schedule triage immediately
    const inputDir = path.join(DESK_ROOT, 'input')
    try {
      const inputFiles = readdirSync(inputDir).filter(
        (f) => f !== 'AGENT.md' && f !== 'TRIAGE_LOG.md' && !f.startsWith('.'),
      )
      if (inputFiles.length > 0) {
        const agentMdPath = path.join(inputDir, 'AGENT.md')
        if (existsSync(agentMdPath)) {
          for (const f of inputFiles) {
            this.enqueue(agentMdPath, {
              event: 'added',
              path: `input/${f}`,
              ts: new Date().toISOString(),
            })
          }
        }
      }
    } catch { /* input/ may not exist */ }

    this.watcher = watch(DESK_ROOT, { recursive: true, persistent: true }, (eventType, filename) => {
      if (!filename) return
      const absPath = path.join(DESK_ROOT, filename)
      const relPath = normalizeFilename(filename.replace(/\\/g, '/'))

      // System-level files (AGENT.md, SCOPE.md, SYSTEM.md, MEMORY.md, JOURNAL.md)
      // get a dedicated event so the UI can refresh on-the-fly. They are NOT
      // enqueued for agent runs to avoid an editing feedback loop.
      if (isSystemLevelFile(relPath)) {
        const event: FileChange['event'] =
          eventType === 'rename' ? (existsSync(absPath) ? 'added' : 'removed') : 'modified'
        this.emit('system-file', { event, path: relPath, ts: new Date().toISOString() })
        return
      }

      if (isIgnored(relPath)) return

      // Suppress self-loops; allow cross-agent handoffs
      if (this.originatedPaths.has(relPath)) {
        const closestAgent = this.findClosestAgent(absPath)
        if (closestAgent === this.runningAgent) {
          this.emit('fs', { event: 'modified', path: relPath, ts: new Date().toISOString() }, null, true)
          return
        }
      }

      const event: FileChange['event'] =
        eventType === 'rename' ? (existsSync(absPath) ? 'added' : 'removed') : 'modified'
      const change: FileChange = { event, path: relPath, ts: new Date().toISOString() }
      const agentMdPath = this.findClosestAgent(absPath)

      this.emit('fs', change, agentMdPath, false)

      if (agentMdPath) this.enqueue(agentMdPath, change)
    })
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
  }

  get deskRoot(): string { return DESK_ROOT }

  /** Scans DESK_ROOT recursively for directories containing an AGENT.md.
   *  Returns paths relative to DESK_ROOT (e.g. ['', 'projects/finance'], sorted).
   *  The empty string '' represents the root desk/ agent if DESK_ROOT/AGENT.md exists.
   */
  getAgentPaths(): string[] {
    const results: string[] = []
    const scan = (dir: string, relDir: string) => {
      try {
        const entries = readdirSync(dir, { withFileTypes: true })
        const hasAgent = entries.some((e) => e.isFile() && e.name === 'AGENT.md')
        if (hasAgent) results.push(relDir)
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const childRel = relDir ? `${relDir}/${entry.name}` : entry.name
            scan(path.join(dir, entry.name), childRel)
          }
        }
      } catch { /* ignore unreadable dirs */ }
    }
    scan(DESK_ROOT, '')
    return results.sort()
  }

  /** Send a direct user message to the agent at agentRelPath (relative to DESK_ROOT). */
  sendMessage(agentRelPath: string, userMessage: string): void {
    const normalized = agentRelPath.replace(/^\/+|\/+$/g, '')
    const agentMdPath = path.join(DESK_ROOT, normalized, 'AGENT.md')

    if (!existsSync(agentMdPath)) {
      this.emit('agent:error', agentMdPath, `No AGENT.md found at: ${agentMdPath}`)
      return
    }

    this.emit('user:message', agentMdPath, userMessage)

    if (this.runningAgent === agentMdPath) {
      const existing = this.entries.get(agentMdPath)
      if (existing) {
        existing.directMessage = userMessage
      } else {
        this.entries.set(agentMdPath, { changes: [], directMessage: userMessage, debounceTimer: null })
        this.runOrder.push(agentMdPath)
      }
      return
    }

    this.entries.set(agentMdPath, { changes: [], directMessage: userMessage, debounceTimer: null })
    this.runOrder.push(agentMdPath)
    this.emitQueue()
    this.runNext()
  }

  // ---------------------------------------------------------------------------
  // Queue
  // ---------------------------------------------------------------------------

  private emitQueue() {
    this.emit('queue', this.runningAgent, [...this.runOrder])
  }

  private onDebounceExpired(agentMdPath: string) {
    const entry = this.entries.get(agentMdPath)
    if (!entry) return
    entry.debounceTimer = null

    if (this.runningAgent) {
      if (!this.runOrder.includes(agentMdPath)) {
        this.runOrder.push(agentMdPath)
        this.emitQueue()
      }
    } else {
      this.runOrder.push(agentMdPath)
      this.runNext()
    }
  }

  private enqueue(agentMdPath: string, change: FileChange) {
    if (this.runningAgent === agentMdPath) {
      this.runningInjection.push(change)
      return
    }

    const existing = this.entries.get(agentMdPath)
    if (existing) {
      // Deduplicate by path: last event for a given path wins
      const idx = existing.changes.findIndex((c) => c.path === change.path)
      if (idx !== -1) existing.changes.splice(idx, 1)
      existing.changes.push(change)
      if (existing.debounceTimer !== null) {
        clearTimeout(existing.debounceTimer)
        existing.debounceTimer = setTimeout(() => this.onDebounceExpired(agentMdPath), this.debounceMs)
      }
      return
    }

    const timer = setTimeout(() => this.onDebounceExpired(agentMdPath), this.debounceMs)
    this.entries.set(agentMdPath, { changes: [change], debounceTimer: timer })
    this.emitQueue()
  }

  private runNext() {
    if (this.runningAgent || this.runOrder.length === 0) return

    const agentMdPath = this.runOrder.shift()!
    const entry = this.entries.get(agentMdPath)
    if (!entry) { this.runNext(); return }

    this.entries.delete(agentMdPath)
    this.runningAgent = agentMdPath
    this.runningInjection = []
    this.originatedPaths.clear()
    this.emitQueue()

    this.emit('agent:start', agentMdPath, entry.changes)

    this.runAgentFor(agentMdPath, entry)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        this.emit('agent:error', agentMdPath, msg)
        // logger.logError is called inside runAgentFor's own catch if needed;
        // errors that escape entirely (e.g. prompt build failure) are emitted here
      })
      .finally(() => {
        this.runningAgent = null
        this.runningInjection = []
        this.originatedPaths.clear()
        this.emitQueue()
        this.runNext()
      })
  }

  // ---------------------------------------------------------------------------
  // Tool executor
  // ---------------------------------------------------------------------------

  private getGoogleAuth() { return (this.googleAuth ??= GoogleAuth.fromEnv()) }
  private getGmailService() { return (this.gmailService ??= new GmailService(this.getGoogleAuth())) }
  private getCalendarService() { return (this.calendarService ??= new CalendarService(this.getGoogleAuth())) }

  private readonly gmailToolNames = new Set<string>(gmailTools.map((t) => t.name))
  private readonly calendarToolNames = new Set<string>(calendarTools.map((t) => t.name))
  private readonly taskToolNames = new Set<string>(taskTools.map((t) => t.name))
  private readonly filesystemToolNames = new Set<string>(filesystemTools.map((t) => t.name))
  private readonly cameraToolNames = new Set<string>(cameraTools.map((t) => t.name))

  private readonly allTools: ToolDefinition[] = [
    ...filesystemTools,
    ...taskTools,
    ...gmailTools,
    ...calendarTools,
    ...cameraTools,
  ]

  private async toolExecutor(toolName: string, input: unknown): Promise<unknown> {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    if (this.filesystemToolNames.has(toolName)) return runFilesystemTool(toolName as any, input)
    if (this.taskToolNames.has(toolName)) return runTaskTool(toolName as any, input)
    if (this.gmailToolNames.has(toolName)) return runGmailTool(this.getGmailService(), toolName as any, input)
    if (this.calendarToolNames.has(toolName)) return runCalendarTool(this.getCalendarService(), toolName as any, input)
    if (this.cameraToolNames.has(toolName)) return runCameraTool(toolName as CameraToolName, input)
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return { error: `Unknown tool: ${toolName}` }
  }

  private trackPath(p: unknown) {
    if (typeof p === 'string') {
      const abs = path.isAbsolute(p) ? p : path.join(DESK_ROOT, p)
      this.originatedPaths.add(path.relative(DESK_ROOT, abs))
    }
  }

  // Called synchronously before tool execution — pre-tracks paths we know will be touched
  private preTrackToolInput(toolName: string, input: unknown) {
    if (typeof input !== 'object' || input === null) return
    const inp = input as Record<string, unknown>
    if (toolName === 'write_file') this.trackPath(inp.path)
    if (toolName === 'copy_file') { this.trackPath(inp.src); this.trackPath(inp.dst) }
    if (toolName === 'delete_file') this.trackPath(inp.path)
    if (toolName === 'make_directory') this.trackPath(inp.path)
    if (toolName === 'gmail_get_attachment') this.trackPath(inp.output_path)
  }

  // Called after tool execution — tracks paths from tool output (e.g. task file paths)
  private trackToolOutput(toolName: string, _input: unknown, output: unknown) {
    if (toolName === 'create_task' || toolName === 'update_task') {
      if (typeof output === 'object' && output !== null && 'paths' in output) {
        const paths = (output as { paths: unknown }).paths
        if (Array.isArray(paths)) paths.forEach((p) => this.trackPath(p))
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Agent runner
  // ---------------------------------------------------------------------------

  private async runAgentFor(agentMdPath: string, entry: QueueEntry) {
    if (this.noRun) return

    const { changes, directMessage } = entry
    const agentName = path.relative(DESK_ROOT, path.dirname(agentMdPath)).replace(/\//g, '-') || 'root'
    const logger = new RunLogger(agentName)
    logger.logStart(agentMdPath, changes)

    const systemPrompt = buildSystemPrompt(agentMdPath)
    const message = directMessage
      ? directMessage
      : buildTriggerMessage(agentMdPath, changes)

    const getPendingInjection = (): string | null => {
      if (this.runningInjection.length === 0) return null
      const pending = [...this.runningInjection]
      this.runningInjection = []
      return [
        '[New file changes in your directory while you were running]',
        describeChanges(pending),
      ].join('\n')
    }

    const priorMessages = this.sessionConversations.get(agentMdPath)

    const result = await runAgent({
      systemPrompt,
      tools: this.allTools,
      toolExecutor: (name, input) => this.toolExecutor(name, input),
      message,
      priorMessages,
      logLevel: this.logLevel,
      onLog: (msg) => this.emit('agent:log', agentMdPath, msg),
      onWaiting: (waiting) => this.emit('agent:waiting', agentMdPath, waiting),
      onToolStart: (name, input) => this.preTrackToolInput(name, input),
      onToolExecuted: (name, input, output) => this.trackToolOutput(name, input, output),
      onRound: (data) => logger.logRound(data),
      onTextStart: (streamId) => this.emit('agent:stream:start', agentMdPath, streamId),
      onTextDelta: (streamId, delta) => this.emit('agent:stream:delta', agentMdPath, streamId, delta),
      onTextEnd: (streamId) => this.emit('agent:stream:end', agentMdPath, streamId),
      getPendingInjection,
      maxRounds: 80,
    })

    this.sessionConversations.set(agentMdPath, result.messages)
    logger.logDone(result.rounds, result.hitLimit, result.response)
    this.emit('agent:done', agentMdPath, result.rounds, result.hitLimit, result.response)
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private findClosestAgent(changedAbsPath: string): string | null {
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
}

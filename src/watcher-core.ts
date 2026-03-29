/**
 * DeskWatcher — core watch/queue/run logic as a reusable EventEmitter.
 *
 * Events:
 *   'fs'           (change: FileChange, agentPath: string | null, suppressed: boolean)
 *   'queue'        (running: string | null, queued: string[])
 *   'agent:start'  (agentPath: string, changes: FileChange[])
 *   'agent:log'    (agentPath: string, message: string)
 *   'agent:done'   (agentPath: string, rounds: number, hitLimit: boolean, response: string)
 *   'agent:error'  (agentPath: string, error: string)
 */

import { EventEmitter } from 'events'
import { watch, existsSync, readdirSync } from 'fs'
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
  debounceTimer: ReturnType<typeof setTimeout> | null
}

const ALWAYS_IGNORE = new Set(['TRIAGE_LOG.md', '.DS_Store'])

function isIgnored(relPath: string): boolean {
  const base = path.basename(relPath)
  if (base === 'AGENT.md') return true
  if (ALWAYS_IGNORE.has(base)) return true
  if (relPath.startsWith('.git/')) return true
  return false
}

function describeChanges(changes: FileChange[]): string {
  return changes.map((c) => {
    const icon = c.event === 'added' ? '+' : c.event === 'removed' ? '-' : '~'
    return `  ${icon} ${c.path}`
  }).join('\n')
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
      const relPath = filename.replace(/\\/g, '/')
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

    this.runAgentFor(agentMdPath, entry.changes)
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

  private readonly allTools: ToolDefinition[] = [
    ...filesystemTools,
    ...taskTools,
    ...gmailTools,
    ...calendarTools,
  ]

  private async toolExecutor(toolName: string, input: unknown): Promise<unknown> {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    if (this.filesystemToolNames.has(toolName)) return runFilesystemTool(toolName as any, input)
    if (this.taskToolNames.has(toolName)) return runTaskTool(toolName as any, input)
    if (this.gmailToolNames.has(toolName)) return runGmailTool(this.getGmailService(), toolName as any, input)
    if (this.calendarToolNames.has(toolName)) return runCalendarTool(this.getCalendarService(), toolName as any, input)
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return { error: `Unknown tool: ${toolName}` }
  }

  private trackToolOutput(toolName: string, input: unknown, output: unknown) {
    if (typeof input !== 'object' || input === null) return
    const inp = input as Record<string, unknown>
    const track = (p: unknown) => {
      if (typeof p === 'string') {
        const abs = path.isAbsolute(p) ? p : path.join(DESK_ROOT, p)
        this.originatedPaths.add(path.relative(DESK_ROOT, abs))
      }
    }
    if (toolName === 'write_file') track(inp.path)
    if (toolName === 'copy_file') track(inp.dst)
    if (toolName === 'delete_file') track(inp.path)
    if (toolName === 'make_directory') track(inp.path)
    if (toolName === 'gmail_get_attachment') track(inp.output_path)
    if (toolName === 'create_task' || toolName === 'complete_task') {
      if (typeof output === 'object' && output !== null && 'paths' in output) {
        const paths = (output as { paths: unknown }).paths
        if (Array.isArray(paths)) paths.forEach(track)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Agent runner
  // ---------------------------------------------------------------------------

  private async runAgentFor(agentMdPath: string, changes: FileChange[]) {
    if (this.noRun) return

    const agentName = path.relative(DESK_ROOT, path.dirname(agentMdPath)).replace(/\//g, '-') || 'root'
    const logger = new RunLogger(agentName)
    logger.logStart(agentMdPath, changes)

    const systemPrompt = buildSystemPrompt(agentMdPath)
    const message = [
      'The following file changes occurred in your directory:',
      '',
      describeChanges(changes),
      '',
      'Review these changes and take any necessary actions according to your instructions.',
    ].join('\n')

    const getPendingInjection = (): string | null => {
      if (this.runningInjection.length === 0) return null
      const pending = [...this.runningInjection]
      this.runningInjection = []
      return [
        '[New file changes in your directory while you were running]',
        describeChanges(pending),
      ].join('\n')
    }

    const result = await runAgent({
      systemPrompt,
      tools: this.allTools,
      toolExecutor: (name, input) => this.toolExecutor(name, input),
      message,
      logLevel: this.logLevel,
      onLog: (msg) => this.emit('agent:log', agentMdPath, msg),
      onWaiting: (waiting) => this.emit('agent:waiting', agentMdPath, waiting),
      onToolExecuted: (name, input, output) => this.trackToolOutput(name, input, output),
      onRound: (data) => logger.logRound(data),
      getPendingInjection,
      maxRounds: 80,
    })

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

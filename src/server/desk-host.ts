import { EventEmitter } from 'events'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import path from 'path'
import { DeskWatcher, type FileChange } from '../watcher-core.js'
import { applyDeskEvent, createInitialSnapshot } from '../ui/shared/reducer.js'
import type { DeskEvent, DeskSnapshot, TaskItem } from '../ui/shared/protocol.js'
import { parseTaskContent, sortTasksByUrgency } from '../ui/shared/tasks.js'

interface DeskHostOptions {
  debounceMs?: number
  logLevel?: 'silent' | 'normal' | 'verbose'
}

function makeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function sanitizeBaseName(name: string | undefined, fallback: string): string {
  if (!name) return fallback
  const sanitized = name
    .trim()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
  return sanitized || fallback
}

function sanitizeExtension(extension: string | undefined): string {
  const normalized = (extension ?? 'jpg').replace(/^\.+/, '').toLowerCase()
  return normalized && /^[a-z0-9]+$/.test(normalized) ? normalized : 'jpg'
}

export class DeskHost extends EventEmitter {
  private readonly watcher: DeskWatcher
  private snapshot: DeskSnapshot
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private refreshDebounce: ReturnType<typeof setTimeout> | null = null

  constructor(options: DeskHostOptions = {}) {
    super()
    this.watcher = new DeskWatcher({
      debounceMs: options.debounceMs,
      logLevel: options.logLevel ?? 'normal',
    })
    this.snapshot = createInitialSnapshot(this.watcher.deskRoot)
  }

  start() {
    this.attachWatcherEvents()
    this.watcher.start()
    this.refreshDerivedState()
    // Low-frequency fallback refresh; most updates are event-driven.
    this.refreshTimer = setInterval(() => this.refreshDerivedState(), 15000)
  }

  stop() {
    this.watcher.stop()
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = null
    if (this.refreshDebounce) clearTimeout(this.refreshDebounce)
    this.refreshDebounce = null
  }

  getSnapshot(): DeskSnapshot {
    return this.snapshot
  }

  sendMessage(agentRelPath: string, message: string) {
    this.watcher.sendMessage(agentRelPath, message)
  }

  saveInputFile(
    contents: Uint8Array,
    options: { filenameBase?: string; extension?: string } = {},
  ): { filename: string; relativePath: string; sizeBytes: number } {
    const inputDir = path.join(this.watcher.deskRoot, 'input')
    mkdirSync(inputDir, { recursive: true })

    const baseName = sanitizeBaseName(options.filenameBase, `desk-photo-${makeTimestamp()}`)
    const extension = sanitizeExtension(options.extension)
    let filename = `${baseName}.${extension}`
    let counter = 1

    while (existsSync(path.join(inputDir, filename))) {
      filename = `${baseName}-${counter}.${extension}`
      counter += 1
    }

    writeFileSync(path.join(inputDir, filename), contents)

    return {
      filename,
      relativePath: `input/${filename}`,
      sizeBytes: contents.byteLength,
    }
  }

  private applyAndEmit(event: DeskEvent) {
    this.snapshot = applyDeskEvent(this.snapshot, event)
    this.emit('event', event)
  }

  private attachWatcherEvents() {
    this.watcher.on('fs', (change: FileChange, agentPath: string | null, suppressed: boolean) => {
      // The UI only consumes actionable fs events tied to an agent.
      if (!suppressed && agentPath) {
        this.applyAndEmit({ type: 'fs', change, agentPath, suppressed })
      }

      const rel = change.path
      if (rel.startsWith('input/') || rel.startsWith('tasks/') || rel.includes('/tasks/')) {
        this.scheduleRefresh()
      }
    })
    this.watcher.on('queue', (running: string | null, queued: string[]) => {
      this.applyAndEmit({ type: 'queue', running, queued })
    })
    this.watcher.on('agent:start', (agentPath: string, changes: FileChange[]) => {
      this.applyAndEmit({ type: 'agent:start', agentPath, changes })
    })
    this.watcher.on('agent:log', (agentPath: string, message: string) => {
      this.applyAndEmit({ type: 'agent:log', agentPath, message })
    })
    this.watcher.on('agent:waiting', (agentPath: string, waiting: boolean) => {
      this.applyAndEmit({ type: 'agent:waiting', agentPath, waiting })
    })
    this.watcher.on('agent:done', (agentPath: string, rounds: number, hitLimit: boolean, response: string) => {
      this.applyAndEmit({ type: 'agent:done', agentPath, rounds, hitLimit, response })
    })
    this.watcher.on('agent:error', (agentPath: string, error: string) => {
      this.applyAndEmit({ type: 'agent:error', agentPath, error })
    })
    this.watcher.on('user:message', (agentPath: string, message: string) => {
      this.applyAndEmit({ type: 'user:message', agentPath, message })
    })
  }

  private scheduleRefresh() {
    if (this.refreshDebounce) return
    this.refreshDebounce = setTimeout(() => {
      this.refreshDebounce = null
      this.refreshDerivedState()
    }, 400)
  }

  private refreshDerivedState() {
    const nextInputFiles = this.loadInputFiles()
    this.applyIfChanged(this.snapshot.inputFiles, nextInputFiles, () => ({
      type: 'input:files',
      files: nextInputFiles,
    }))

    const nextTasks = this.loadTasks()
    this.applyIfChanged(this.snapshot.tasks, nextTasks, () => ({
      type: 'tasks:update',
      tasks: nextTasks,
    }))

    const nextAgentPaths = this.watcher.getAgentPaths()
    this.applyIfChanged(this.snapshot.agentPaths, nextAgentPaths, () => ({
      type: 'agents:update',
      agentPaths: nextAgentPaths,
    }))
  }

  private applyIfChanged<T>(
    current: T[],
    next: T[],
    makeEvent: () => DeskEvent,
  ) {
    if (current.length === next.length && current.every((item, idx) => JSON.stringify(item) === JSON.stringify(next[idx]))) {
      return
    }
    this.applyAndEmit(makeEvent())
  }

  private loadInputFiles(): string[] {
    const inputDir = path.join(this.watcher.deskRoot, 'input')
    if (!existsSync(inputDir)) return []
    try {
      return readdirSync(inputDir).filter(
        (f) => f !== 'AGENT.md' && f !== 'TRIAGE_LOG.md' && !f.startsWith('.'),
      )
    } catch {
      return []
    }
  }

  private loadTasks(): TaskItem[] {
    const tasksDir = path.join(this.watcher.deskRoot, 'tasks')
    if (!existsSync(tasksDir)) return []

    try {
      const loaded = readdirSync(tasksDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
          const fullPath = path.join(tasksDir, f)
          const content = readFileSync(fullPath, 'utf8')
          return parseTaskContent(f, content)
        })
        .filter((task): task is TaskItem => task !== null)
      return sortTasksByUrgency(loaded)
    } catch {
      return []
    }
  }
}


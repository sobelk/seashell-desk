import type { AgentState, DeskEvent, DeskSnapshot, FileChange } from './protocol.js'

const MAX_LOG_LINES = 2000
const MAX_CHANGES_PER_AGENT = 20

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/')
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function joinPath(...parts: string[]): string {
  return parts
    .map((part, idx) => idx === 0 ? trimTrailingSlash(normalizeSlashes(part)) : normalizeSlashes(part).replace(/^\/+|\/+$/g, ''))
    .filter((part) => part.length > 0)
    .join('/')
}

function relativePath(base: string, target: string): string {
  const baseNorm = trimTrailingSlash(normalizeSlashes(base))
  const targetNorm = normalizeSlashes(target)
  if (targetNorm === baseNorm) return ''
  if (targetNorm.startsWith(`${baseNorm}/`)) return targetNorm.slice(baseNorm.length + 1)
  return targetNorm
}

export function agentDisplayName(agentMdPath: string, deskRoot: string): string {
  const rel = relativePath(deskRoot, agentMdPath)
  if (rel === 'input/AGENT.md') return 'triage'
  const parts = rel.split('/')
  return parts[parts.length - 2] ?? rel
}

export function isTriage(agentMdPath: string, deskRoot: string): boolean {
  return normalizeSlashes(agentMdPath) === joinPath(deskRoot, 'input', 'AGENT.md')
}

export function appendLog(logs: string[], line: string): string[] {
  const incoming = line.split('\n').filter((l) => l.length > 0)
  const next = [...logs, ...incoming]
  return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next
}

export function createInitialSnapshot(deskRoot: string): DeskSnapshot {
  return {
    deskRoot,
    triage: {
      path: joinPath(deskRoot, 'input', 'AGENT.md'),
      name: 'triage',
      logs: [],
      active: false,
      waiting: false,
    },
    project: null,
    queueRunning: null,
    queueWaiting: [],
    queueChanges: {},
    inputFiles: [],
    tasks: [],
    agentPaths: [],
  }
}

function addQueueChange(
  queueChanges: Record<string, FileChange[]>,
  agentPath: string,
  change: FileChange,
): Record<string, FileChange[]> {
  const existing = queueChanges[agentPath] ?? []
  const next = [...existing, change]
  return {
    ...queueChanges,
    [agentPath]: next.length > MAX_CHANGES_PER_AGENT ? next.slice(-MAX_CHANGES_PER_AGENT) : next,
  }
}

function pruneQueueChanges(
  queueChanges: Record<string, FileChange[]>,
  running: string | null,
  queued: string[],
): Record<string, FileChange[]> {
  const active = new Set([...(running ? [running] : []), ...queued])
  const next: Record<string, FileChange[]> = {}
  for (const key of Object.keys(queueChanges)) {
    if (active.has(key)) next[key] = queueChanges[key] ?? []
  }
  return next
}

function applyToAgent(
  snapshot: DeskSnapshot,
  agentPath: string,
  triageUpdater: (agent: AgentState) => AgentState,
  projectUpdater: (agent: AgentState | null) => AgentState | null,
): DeskSnapshot {
  if (isTriage(agentPath, snapshot.deskRoot)) {
    return { ...snapshot, triage: triageUpdater(snapshot.triage) }
  }
  return { ...snapshot, project: projectUpdater(snapshot.project) }
}

export function applyDeskEvent(snapshot: DeskSnapshot, event: DeskEvent): DeskSnapshot {
  if (event.type === 'queue') {
    return {
      ...snapshot,
      queueRunning: event.running,
      queueWaiting: event.queued,
      queueChanges: pruneQueueChanges(snapshot.queueChanges, event.running, event.queued),
    }
  }

  if (event.type === 'fs') {
    if (event.suppressed || !event.agentPath) return snapshot
    return {
      ...snapshot,
      queueChanges: addQueueChange(snapshot.queueChanges, event.agentPath, event.change),
    }
  }

  if (event.type === 'agent:start') {
    return applyToAgent(
      snapshot,
      event.agentPath,
      (triage) => ({ ...triage, active: true, waiting: false }),
      () => ({
        path: event.agentPath,
        name: agentDisplayName(event.agentPath, snapshot.deskRoot),
        logs: [],
        active: true,
        waiting: false,
      }),
    )
  }

  if (event.type === 'agent:log') {
    return applyToAgent(
      snapshot,
      event.agentPath,
      (triage) => ({ ...triage, logs: appendLog(triage.logs, event.message) }),
      (project) => {
        if (!project || project.path !== event.agentPath) return project
        return { ...project, logs: appendLog(project.logs, event.message) }
      },
    )
  }

  if (event.type === 'agent:waiting') {
    return applyToAgent(
      snapshot,
      event.agentPath,
      (triage) => ({ ...triage, waiting: event.waiting }),
      (project) => {
        if (!project || project.path !== event.agentPath) return project
        return { ...project, waiting: event.waiting }
      },
    )
  }

  if (event.type === 'agent:done') {
    const suffix = event.hitLimit ? ` [hit round limit after ${event.rounds} rounds]` : ''
    return applyToAgent(
      snapshot,
      event.agentPath,
      (triage) => {
        const logs = event.response ? appendLog(triage.logs, event.response + suffix) : triage.logs
        return { ...triage, active: false, waiting: false, logs }
      },
      (project) => {
        if (!project || project.path !== event.agentPath) return project
        const logs = event.response ? appendLog(project.logs, event.response + suffix) : project.logs
        return { ...project, active: false, waiting: false, logs }
      },
    )
  }

  if (event.type === 'agent:error') {
    const msg = `[error] ${event.error}`
    return applyToAgent(
      snapshot,
      event.agentPath,
      (triage) => ({ ...triage, active: false, waiting: false, logs: appendLog(triage.logs, msg) }),
      (project) => {
        if (!project || project.path !== event.agentPath) return project
        return { ...project, active: false, waiting: false, logs: appendLog(project.logs, msg) }
      },
    )
  }

  if (event.type === 'user:message') {
    const line = `[user] ${event.message}`
    return applyToAgent(
      snapshot,
      event.agentPath,
      (triage) => ({ ...triage, logs: appendLog(triage.logs, line) }),
      (project) => {
        if (!project || project.path !== event.agentPath) {
          return {
            path: event.agentPath,
            name: agentDisplayName(event.agentPath, snapshot.deskRoot),
            logs: [line],
            active: false,
            waiting: false,
          }
        }
        return { ...project, logs: appendLog(project.logs, line) }
      },
    )
  }

  if (event.type === 'input:files') return { ...snapshot, inputFiles: event.files }
  if (event.type === 'tasks:update') return { ...snapshot, tasks: event.tasks }
  if (event.type === 'agents:update') return { ...snapshot, agentPaths: event.agentPaths }

  return snapshot
}


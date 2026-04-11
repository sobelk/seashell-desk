export interface FileChange {
  event: 'added' | 'removed' | 'modified'
  path: string
  ts: string
}

export interface TaskItem {
  id: string
  title: string
  urgency: 'critical' | 'high' | 'medium' | 'low'
}

export interface AgentState {
  path: string
  name: string
  logs: string[]
  active: boolean
  waiting: boolean
}

export interface DeskSnapshot {
  deskRoot: string
  triage: AgentState
  project: AgentState | null
  queueRunning: string | null
  queueWaiting: string[]
  queueChanges: Record<string, FileChange[]>
  inputFiles: string[]
  tasks: TaskItem[]
  agentPaths: string[]
}

export type DeskEvent =
  | { type: 'fs'; change: FileChange; agentPath: string | null; suppressed: boolean }
  | { type: 'queue'; running: string | null; queued: string[] }
  | { type: 'agent:start'; agentPath: string; changes: FileChange[] }
  | { type: 'agent:log'; agentPath: string; message: string }
  | { type: 'agent:waiting'; agentPath: string; waiting: boolean }
  | { type: 'agent:done'; agentPath: string; rounds: number; hitLimit: boolean; response: string }
  | { type: 'agent:error'; agentPath: string; error: string }
  | { type: 'user:message'; agentPath: string; message: string }
  | { type: 'input:files'; files: string[] }
  | { type: 'tasks:update'; tasks: TaskItem[] }
  | { type: 'agents:update'; agentPaths: string[] }

export type ServerMessage =
  | { type: 'snapshot'; snapshot: DeskSnapshot }
  | { type: 'event'; event: DeskEvent }


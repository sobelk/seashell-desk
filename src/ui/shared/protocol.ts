export interface FileChange {
  event: 'added' | 'removed' | 'modified'
  path: string
  ts: string
}

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low'
export type TaskStatus = 'open' | 'done' | 'ignored'

export interface TaskItem {
  id: string
  title: string
  priority: TaskPriority
  status: TaskStatus
  created: string
  due: string
  ownerPath: string
  relativePath: string
}

export interface AgentStreamingState {
  streamId: string
  /** Index into `AgentState.logs` of the line currently being streamed. */
  logIndex: number
}

export interface AgentState {
  path: string
  name: string
  logs: string[]
  active: boolean
  waiting: boolean
  /** Non-null while an agent text block is actively streaming into `logs`. */
  streaming: AgentStreamingState | null
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
  // Streaming LLM text from the runner. Clients should render a new (empty)
  // agent log entry on `start`, append each `delta.text` to that entry, and
  // treat `end` as a finalization marker (no content change).
  | { type: 'agent:stream:start'; agentPath: string; streamId: string }
  | { type: 'agent:stream:delta'; agentPath: string; streamId: string; delta: string }
  | { type: 'agent:stream:end'; agentPath: string; streamId: string }
  | { type: 'user:message'; agentPath: string; message: string }
  | { type: 'input:files'; files: string[] }
  | { type: 'tasks:update'; tasks: TaskItem[] }
  | { type: 'agents:update'; agentPaths: string[] }
  | { type: 'agent-files:changed'; change: FileChange }

export type ServerMessage =
  | { type: 'snapshot'; snapshot: DeskSnapshot }
  | { type: 'event'; event: DeskEvent }
  | { type: 'reload' }


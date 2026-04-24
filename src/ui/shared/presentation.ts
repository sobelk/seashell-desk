import type { TaskItem } from './protocol.js'

export type LineKind = 'agent' | 'tool' | 'error' | 'user' | 'other'

export function classifyLine(line: string): LineKind {
  if (line.startsWith('[tool]')) return 'tool'
  if (line.startsWith('[agent]')) return 'agent'
  if (line.startsWith('[error]')) return 'error'
  if (line.startsWith('[user]')) return 'user'
  return 'other'
}

export function priorityBadge(priority: TaskItem['priority']): string {
  if (priority === 'critical') return '!!'
  if (priority === 'high') return ' !'
  return '  '
}


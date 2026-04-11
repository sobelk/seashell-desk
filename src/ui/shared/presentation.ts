import type { TaskItem } from './protocol.js'

export type LineKind = 'agent' | 'tool' | 'error' | 'user' | 'other'

export function classifyLine(line: string): LineKind {
  if (line.startsWith('[tool]')) return 'tool'
  if (line.startsWith('[agent]')) return 'agent'
  if (line.startsWith('[error]')) return 'error'
  if (line.startsWith('[user]')) return 'user'
  return 'other'
}

export function urgencyBadge(urgency: TaskItem['urgency']): string {
  if (urgency === 'critical') return '!!'
  if (urgency === 'high') return ' !'
  return '  '
}


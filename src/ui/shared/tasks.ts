import type { TaskItem } from './protocol.js'

const URGENCY_ORDER: Record<TaskItem['urgency'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

function basename(fileName: string): string {
  const normalized = fileName.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts[parts.length - 1] ?? fileName
}

export function parseTaskContent(fileName: string, content: string): TaskItem | null {
  const titleMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m)
  const urgencyMatch = content.match(/^urgency:\s*(.+)$/m)
  const statusMatch = content.match(/^status:\s*(.+)$/m)
  if (statusMatch?.[1]?.trim() === 'done') return null
  if (!titleMatch) return null

  const rawUrgency = urgencyMatch?.[1]?.trim()
  const urgency: TaskItem['urgency'] =
    rawUrgency === 'critical' || rawUrgency === 'high' || rawUrgency === 'medium' || rawUrgency === 'low'
      ? rawUrgency
      : 'medium'

  return {
    id: basename(fileName),
    title: titleMatch[1]?.trim() ?? '',
    urgency,
  }
}

export function sortTasksByUrgency(tasks: TaskItem[]): TaskItem[] {
  return [...tasks].sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency])
}


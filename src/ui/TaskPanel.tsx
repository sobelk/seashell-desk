import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { readdirSync, readFileSync, existsSync } from 'fs'
import path from 'path'

interface Task {
  id: string
  title: string
  urgency: 'critical' | 'high' | 'medium' | 'low'
}

interface Props {
  deskRoot: string
  height: number
}

function parseTask(filePath: string): Task | null {
  try {
    const content = readFileSync(filePath, 'utf8')
    const titleMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m)
    const urgencyMatch = content.match(/^urgency:\s*(.+)$/m)
    const statusMatch = content.match(/^status:\s*(.+)$/m)
    if (statusMatch?.[1]?.trim() === 'done') return null
    if (!titleMatch) return null
    return {
      id: path.basename(filePath),
      title: titleMatch[1]?.trim() ?? '',
      urgency: (urgencyMatch?.[1]?.trim() ?? 'medium') as Task['urgency'],
    }
  } catch {
    return null
  }
}

function urgencyColor(u: Task['urgency']): string {
  if (u === 'critical') return 'red'
  if (u === 'high') return 'yellow'
  if (u === 'medium') return 'cyan'
  return 'gray'
}

function urgencyBadge(u: Task['urgency']): string {
  if (u === 'critical') return '!!'
  if (u === 'high') return ' !'
  if (u === 'medium') return '  '
  return '  '
}

export function TaskPanel({ deskRoot, height }: Props) {
  const [tasks, setTasks] = useState<Task[]>([])

  useEffect(() => {
    const refresh = () => {
      const tasksDir = path.join(deskRoot, 'tasks')
      if (!existsSync(tasksDir)) { setTasks([]); return }
      try {
        const loaded = readdirSync(tasksDir)
          .filter((f) => f.endsWith('.md'))
          .map((f) => parseTask(path.join(tasksDir, f)))
          .filter((t): t is Task => t !== null)
          .sort((a, b) => {
            const order = { critical: 0, high: 1, medium: 2, low: 3 }
            return order[a.urgency] - order[b.urgency]
          })
        setTasks(loaded)
      } catch { setTasks([]) }
    }
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => clearInterval(timer)
  }, [deskRoot])

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      flexGrow={1}
      height={height}
      overflow="hidden"
    >
      <Text bold>Tasks ({tasks.length})</Text>
      {tasks.length === 0
        ? <Text color="gray" dimColor>  (none)</Text>
        : tasks.map((t) => (
          <Text key={t.id} color={urgencyColor(t.urgency)} wrap="truncate">
            {urgencyBadge(t.urgency)} {t.title}
          </Text>
        ))
      }
    </Box>
  )
}

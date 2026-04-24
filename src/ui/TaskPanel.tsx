import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { readdirSync, readFileSync, existsSync } from 'fs'
import path from 'path'
import { priorityBadge } from './shared/presentation.js'
import { parseTaskContent, sortTasksByCreatedDesc } from './shared/tasks.js'
import type { TaskItem } from './shared/protocol.js'

interface Props {
  deskRoot: string
  height: number
}

function priorityColor(priority: TaskItem['priority']): string {
  if (priority === 'critical') return 'red'
  if (priority === 'high') return 'yellow'
  if (priority === 'medium') return 'cyan'
  return 'gray'
}

function collectTasks(dir: string, deskRoot: string, relDir = ''): TaskItem[] {
  const tasks: TaskItem[] = []
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        tasks.push(...collectTasks(fullPath, deskRoot, relPath))
        continue
      }
      if (!entry.isFile() || !relPath.endsWith('.md')) continue

      const ownerPath = relPath.includes('/tasks/') ? relPath.slice(0, relPath.indexOf('/tasks/')) : ''
      if (!ownerPath || !existsSync(path.join(deskRoot, ownerPath, 'AGENT.md'))) continue

      try {
        const task = parseTaskContent(relPath, readFileSync(fullPath, 'utf8'))
        if (task) tasks.push(task)
      } catch {
        // Ignore unreadable task files.
      }
    }
  } catch {
    return []
  }
  return tasks
}

export function TaskPanel({ deskRoot, height }: Props) {
  const [tasks, setTasks] = useState<TaskItem[]>([])

  useEffect(() => {
    const refresh = () => {
      if (!existsSync(deskRoot)) { setTasks([]); return }
      setTasks(sortTasksByCreatedDesc(collectTasks(deskRoot, deskRoot)))
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
          <Text key={t.relativePath} color={priorityColor(t.priority)} wrap="truncate">
            {priorityBadge(t.priority)} {t.title}
          </Text>
        ))
      }
    </Box>
  )
}

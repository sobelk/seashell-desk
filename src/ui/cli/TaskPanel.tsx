import React from 'react'
import { Box, Text } from 'ink'
import { priorityBadge } from '../shared/presentation.js'
import type { TaskItem } from '../shared/protocol.js'

interface Props {
  tasks: TaskItem[]
  height: number
}

function priorityColor(priority: TaskItem['priority']): string {
  if (priority === 'critical') return 'red'
  if (priority === 'high') return 'yellow'
  if (priority === 'medium') return 'cyan'
  return 'gray'
}

export function TaskPanel({ tasks, height }: Props) {
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


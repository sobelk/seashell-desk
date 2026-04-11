import React from 'react'
import { Box, Text } from 'ink'
import { urgencyBadge } from '../shared/presentation.js'
import type { TaskItem } from '../shared/protocol.js'

interface Props {
  tasks: TaskItem[]
  height: number
}

function urgencyColor(urgency: TaskItem['urgency']): string {
  if (urgency === 'critical') return 'red'
  if (urgency === 'high') return 'yellow'
  if (urgency === 'medium') return 'cyan'
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
          <Text key={t.id} color={urgencyColor(t.urgency)} wrap="truncate">
            {urgencyBadge(t.urgency)} {t.title}
          </Text>
        ))
      }
    </Box>
  )
}


import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'

interface Props {
  title: string
  logs: string[]
  width: number
  height: number
  active: boolean
  waiting: boolean
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(t)
  }, [active])
  return SPINNER_FRAMES[frame] ?? '⠋'
}

// Classify a log line for display styling
type LineKind = 'agent' | 'tool' | 'error' | 'other'

function classifyLine(line: string): LineKind {
  if (line.startsWith('[tool]')) return 'tool'
  if (line.startsWith('[agent]')) return 'agent'
  if (line.startsWith('[error]')) return 'error'
  return 'other'
}

function LogLine({ line }: { line: string }) {
  const kind = classifyLine(line)

  if (kind === 'tool') {
    // Strip the [tool] prefix and render muted
    const body = line.slice('[tool]'.length)
    return (
      <Text color="gray" dimColor wrap="truncate">
        {'  '}{body.trimStart()}
      </Text>
    )
  }

  if (kind === 'agent') {
    // Strip the [agent] prefix — this is the agent's narration
    const body = line.slice('[agent]'.length).trimStart()
    return <Text wrap="truncate">{body}</Text>
  }

  if (kind === 'error') {
    return <Text color="red" wrap="truncate">{line}</Text>
  }

  return <Text color="gray" wrap="truncate">{line}</Text>
}

export function AgentRow({ title, logs, width, height, active, waiting }: Props) {
  const spinner = useSpinner(waiting)
  // Reserve: top border (1) + title row (1) + bottom border (1)
  const bodyHeight = Math.max(1, height - 3)
  const visible = logs.slice(-bodyHeight)

  const statusIndicator = waiting
    ? <Text color="yellow">  {spinner}</Text>
    : active
      ? <Text color="green">  ●</Text>
      : null

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={active || waiting ? 'green' : 'gray'}
      width={width}
      height={height}
      overflow="hidden"
    >
      <Box>
        <Text bold color={active || waiting ? 'green' : 'white'}>{title}</Text>
        {statusIndicator}
      </Box>
      <Box flexDirection="column" overflow="hidden">
        {visible.map((line, i) => (
          <LogLine key={i} line={line} />
        ))}
      </Box>
    </Box>
  )
}
